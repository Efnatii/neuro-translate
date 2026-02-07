(function initRequestRunner() {
  if (globalThis.ntRequestRunner) return;

  const DEFAULT_RATE_LIMIT_RETRIES = 6;
  const DEFAULT_TRANSIENT_RETRIES = 3;

  const shouldLogJson = () =>
    typeof globalThis.ntJsonLogEnabled === 'function' && globalThis.ntJsonLogEnabled();

  const emitJsonLog = (eventObject) => {
    if (!shouldLogJson()) return;
    if (typeof globalThis.ntJsonLog === 'function') {
      globalThis.ntJsonLog(eventObject);
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const classifyError = (status) => {
    if (status === 429) return 'rate_limited';
    if (status === 408 || status >= 500) return 'transient';
    return 'fatal';
  };

  const normalizeEndpoint = (apiBaseUrl = '') => {
    const lower = String(apiBaseUrl || '').toLowerCase();
    if (lower.endsWith('/v1/responses')) return 'responses';
    return 'chat_completions';
  };

  const isUnsupportedParamError = (status, errorPayload, errorText, paramName) => {
    if (typeof globalThis.isUnsupportedParamError === 'function') {
      return globalThis.isUnsupportedParamError(status, errorPayload, errorText, paramName);
    }
    if (status !== 400) return false;
    const message = String(errorPayload?.error?.message || errorPayload?.message || errorText || '').toLowerCase();
    const needle = String(paramName || '').toLowerCase();
    return message.includes(needle);
  };

  const dropUnsupportedFields = (requestPayload, status, errorPayload, errorText) => {
    const dropped = [];
    if (!requestPayload || typeof requestPayload !== 'object') return dropped;
    const jsonSchema = requestPayload?.response_format?.json_schema;
    if (jsonSchema?.strict !== undefined && isUnsupportedParamError(status, errorPayload, errorText, 'strict')) {
      delete jsonSchema.strict;
      dropped.push('response_format.json_schema.strict');
    }
    if (
      requestPayload.prompt_cache_retention !== undefined &&
      isUnsupportedParamError(status, errorPayload, errorText, 'prompt_cache_retention')
    ) {
      delete requestPayload.prompt_cache_retention;
      dropped.push('prompt_cache_retention');
    }
    if (
      requestPayload.prompt_cache_key !== undefined &&
      isUnsupportedParamError(status, errorPayload, errorText, 'prompt_cache_key')
    ) {
      delete requestPayload.prompt_cache_key;
      if (requestPayload.prompt_cache_retention !== undefined) {
        delete requestPayload.prompt_cache_retention;
      }
      dropped.push('prompt_cache_key');
    }
    if (requestPayload.prediction !== undefined && isUnsupportedParamError(status, errorPayload, errorText, 'prediction')) {
      delete requestPayload.prediction;
      dropped.push('prediction');
    }
    return dropped;
  };

  class RequestRunner {
    async run(opSpec) {
      const spec = opSpec || {};
      const requestId = spec?.meta?.requestId || spec.requestId || '';
      const apiBaseUrl = spec.apiBaseUrl || '';
      const endpoint = spec.endpoint || normalizeEndpoint(apiBaseUrl);
      const modelPreferred = spec.modelPreferred || spec.model || '';
      const opType = spec.opType || 'unknown';
      const requestPayload = spec.requestPayload || {};
      const apiKey = spec.apiKey || '';
      const signal = spec.signal;
      const estimatedTokens = spec?.meta?.estimatedTokens || null;
      const urlHost = spec?.meta?.urlHost || '';
      const batchSize = spec?.meta?.batchSize || null;
      const throughputController = spec.throughputController || globalThis.ntThroughputController || null;
      const throughputKey = spec.throughputKey || `${opType}::${modelPreferred || 'unknown'}`;
      let resolvedModel = modelPreferred;
      if (globalThis.ntModelRouter?.selectModel && modelPreferred) {
        const selection = globalThis.ntModelRouter.selectModel({
          type: opType,
          preferredModel: modelPreferred,
          allowedModels: spec.allowedModels || [],
          operationType: opType,
          requestId,
          estimatedTokens,
          host: urlHost
        });
        const parsed = typeof globalThis.parseModelSpec === 'function'
          ? globalThis.parseModelSpec(selection?.chosenSpec || modelPreferred)
          : { id: selection?.chosenSpec || modelPreferred };
        resolvedModel = parsed?.id || selection?.chosenSpec || modelPreferred;
      }
      if (requestPayload && resolvedModel) {
        requestPayload.model = resolvedModel;
      }
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
      let response = null;
      let responseText = '';
      let responseData = null;
      let lastStatus = 0;
      let droppedCompatFields = false;
      let rateLimitAttempts = 0;
      let transientAttempts = 0;
      let attempt = 0;
      while (true) {
        attempt += 1;
        const fetchStartedAt = Date.now();
        emitJsonLog({
          kind: 'runner.request',
          ts: fetchStartedAt,
          requestId,
          opType,
          model: resolvedModel,
          endpoint,
          batchSize,
          cacheKeyUsed: requestPayload.prompt_cache_key || '',
          retentionUsed: requestPayload.prompt_cache_retention || '',
          reasoningEffort: requestPayload.reasoning_effort || '',
          predictionUsed: Boolean(requestPayload.prediction)
        });
        try {
          if (throughputController) {
            await throughputController.acquire(throughputKey);
          }
          response = await fetch(apiBaseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestPayload),
            signal
          });
          lastStatus = response.status;
          responseText = await response.clone().text();
          const durationMs = Date.now() - fetchStartedAt;
          emitJsonLog({
            kind: 'runner.response',
            ts: Date.now(),
            requestId,
            opType,
            model: resolvedModel,
            status: response.status,
            latencyMs: durationMs,
            usageSummary: null
          });
          if (response.ok) {
            try {
              responseData = await response.json();
            } catch (error) {
              responseData = null;
            }
            return {
              response,
              responseText,
              responseData,
              status: response.status,
              ok: response.ok,
              responseHeaders: Array.from(response.headers.entries()),
              modelUsed: resolvedModel,
              durationMs
            };
          }
          let errorPayload = null;
          try {
            errorPayload = JSON.parse(responseText);
          } catch (error) {
            errorPayload = null;
          }
          const compatDrops = dropUnsupportedFields(requestPayload, response.status, errorPayload, responseText);
          if (response.status === 400 && compatDrops.length && !droppedCompatFields) {
            droppedCompatFields = true;
            compatDrops.forEach((fieldName) => {
              emitJsonLog({
                kind: 'runner.compat.dropped_field',
                ts: Date.now(),
                requestId,
                fieldName,
                endpoint,
                model: resolvedModel
              });
            });
            continue;
          }
          const classification = classifyError(response.status);
          if (classification === 'rate_limited' && rateLimitAttempts < DEFAULT_RATE_LIMIT_RETRIES) {
            rateLimitAttempts += 1;
            const retryAfterMs = typeof globalThis.parseRetryAfterMs === 'function'
              ? globalThis.parseRetryAfterMs(response, errorPayload)
              : null;
            const delayMs = typeof globalThis.calculateRetryDelayMs === 'function'
              ? globalThis.calculateRetryDelayMs(rateLimitAttempts, retryAfterMs)
              : Math.min(30000, 1000 * Math.pow(2, rateLimitAttempts));
            await sleep(delayMs);
            continue;
          }
          if (classification === 'transient' && transientAttempts < DEFAULT_TRANSIENT_RETRIES) {
            transientAttempts += 1;
            const delayMs = typeof globalThis.calculateRetryDelayMs === 'function'
              ? globalThis.calculateRetryDelayMs(transientAttempts, null)
              : Math.min(20000, 800 * Math.pow(2, transientAttempts));
            await sleep(delayMs);
            continue;
          }
          const error = new Error(`Request failed: ${response.status} ${responseText || ''}`);
          error.status = response.status;
          error.responseText = responseText;
          error.response = response;
          throw error;
        } catch (error) {
          const classification = error?.name === 'AbortError' ? 'transient' : null;
          if (classification === 'transient' && transientAttempts < DEFAULT_TRANSIENT_RETRIES) {
            transientAttempts += 1;
            const delayMs = typeof globalThis.calculateRetryDelayMs === 'function'
              ? globalThis.calculateRetryDelayMs(transientAttempts, null)
              : Math.min(20000, 800 * Math.pow(2, transientAttempts));
            await sleep(delayMs);
            continue;
          }
          throw error;
        } finally {
          if (throughputController) {
            const outcome =
              response && response.ok
                ? 'success'
                : lastStatus === 429
                  ? 'rate_limited'
                  : lastStatus === 408 || lastStatus >= 500
                    ? 'transient_error'
                    : 'fatal_error';
            throughputController.release(throughputKey, outcome);
          }
        }
      }
    }

    parseStructured(opSpec, raw) {
      const expected = opSpec?.expected || {};
      const expectedCount = Number.isFinite(expected.count) ? expected.count : null;
      const expectedIds = Array.isArray(expected.ids) ? expected.ids : null;
      let parsed = null;
      if (typeof globalThis.parseJsonObjectFlexible === 'function') {
        parsed = globalThis.parseJsonObjectFlexible(raw, opSpec?.opType || 'response');
      } else {
        parsed = JSON.parse(raw);
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('structured-output-invalid');
      }
      if (expectedCount != null) {
        const items = parsed.translations || parsed.items || parsed.edits;
        if (Array.isArray(items) && items.length !== expectedCount) {
          const error = new Error('count_mismatch');
          error.code = 'count_mismatch';
          throw error;
        }
      }
      if (expectedIds) {
        const items = parsed.items || parsed.edits || [];
        const ids = Array.isArray(items)
          ? items.map((item) => String(item?.id ?? ''))
          : [];
        const extra = ids.filter((id) => id && !expectedIds.includes(id));
        if (extra.length) {
          const error = new Error('id_mismatch');
          error.code = 'id_mismatch';
          throw error;
        }
      }
      return parsed;
    }
  }

  globalThis.ntRequestRunner = new RequestRunner();
}());
