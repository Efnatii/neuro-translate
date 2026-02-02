(() => {
  if (globalThis.__NT_JSON_LOGGER__) return;
  const loggerState = { enabled: false };
  globalThis.__NT_JSON_LOGGER__ = loggerState;

  const createSafeReplacer = () => {
    const seen = new WeakSet();
    return (_key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack
        };
      }
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
        seen.add(value);
      }
      return value;
    };
  };

  const updateEnabled = (value) => {
    loggerState.enabled = Boolean(value);
  };

  globalThis.ntJsonLogEnabled = () => loggerState.enabled;
  globalThis.ntJsonLog = (eventObject, level = 'log') => {
    if (!loggerState.enabled) return;
    const method = console[level] ? level : 'log';
    console[method](JSON.stringify(eventObject, createSafeReplacer()));
  };
  globalThis.ntConsoleLog = (level, eventObjectOrArgs) => {
    if (!globalThis.ntJsonLogEnabled?.()) return;
    if (typeof globalThis.ntJsonLog !== 'function') return;
    const normalizedLevel = typeof level === 'string' ? level : 'log';
    if (eventObjectOrArgs && typeof eventObjectOrArgs === 'object' && !Array.isArray(eventObjectOrArgs)) {
      globalThis.ntJsonLog(eventObjectOrArgs, normalizedLevel);
      return;
    }
    const args = Array.isArray(eventObjectOrArgs) ? eventObjectOrArgs : [eventObjectOrArgs];
    globalThis.ntJsonLog({ kind: 'console', level: normalizedLevel, args }, normalizedLevel);
  };

  if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
    chrome.storage.local.get({ ntConsoleJsonLogEnabled: false }, (result) => {
      updateEnabled(result?.ntConsoleJsonLogEnabled);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes?.ntConsoleJsonLogEnabled) return;
      updateEnabled(changes.ntConsoleJsonLogEnabled.newValue);
    });
  }
})();

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const PUNCTUATION_TOKEN_HINT =
  'Tokens like ⟦PUNC_DQUOTE⟧ replace double quotes; keep them unchanged, in place, and with exact casing.';
function isExtendedPromptCacheRetentionSupported(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  const normalized = modelId.split(':')[0].trim();
  return (
    normalized === 'gpt-5.2' ||
    normalized === 'gpt-5.1' ||
    normalized === 'gpt-5' ||
    normalized === 'gpt-4.1'
  );
}
function createModelRegistry() {
  const entries = [];
  const baseModelIds = [];
  const byKey = {};
  const byId = {};
  const addEntry = (entry, includeInBaseList = false) => {
    const sum_1M = entry.inputPrice + entry.outputPrice;
    const sum_1M_cached =
      entry.cachedInputPrice != null
        ? entry.cachedInputPrice + entry.outputPrice
        : null;
    const normalized = {
      id: entry.id,
      tier: entry.tier,
      inputPrice: entry.inputPrice,
      cachedInputPrice: entry.cachedInputPrice ?? null,
      outputPrice: entry.outputPrice,
      sum_1M,
      sum_1M_cached,
      supportsFlex: entry.tier === 'flex',
      supportsPromptCacheRetention24h: isExtendedPromptCacheRetentionSupported(entry.id),
      supportsPromptCacheKey: true,
      supportsServiceTierParam: true,
      supportsTextJsonSchema: true
    };
    entries.push(normalized);
    const key = `${normalized.id}:${normalized.tier}`;
    byKey[key] = normalized;
    if (!byId[normalized.id]) {
      byId[normalized.id] = [];
    }
    byId[normalized.id].push(normalized);
    if (includeInBaseList && !baseModelIds.includes(normalized.id)) {
      baseModelIds.push(normalized.id);
    }
  };

  [
    { id: 'gpt-5.2', tier: 'standard', inputPrice: 1.75, cachedInputPrice: 0.175, outputPrice: 14.0 },
    { id: 'gpt-5.1', tier: 'standard', inputPrice: 1.25, cachedInputPrice: 0.125, outputPrice: 10.0 },
    { id: 'gpt-5', tier: 'standard', inputPrice: 1.25, cachedInputPrice: 0.125, outputPrice: 10.0 },
    { id: 'gpt-5-mini', tier: 'standard', inputPrice: 0.25, cachedInputPrice: 0.025, outputPrice: 2.0 },
    { id: 'gpt-5-nano', tier: 'standard', inputPrice: 0.05, cachedInputPrice: 0.005, outputPrice: 0.4 },
    { id: 'gpt-5.2-pro', tier: 'standard', inputPrice: 21.0, cachedInputPrice: null, outputPrice: 168.0 },
    { id: 'gpt-5-pro', tier: 'standard', inputPrice: 15.0, cachedInputPrice: null, outputPrice: 120.0 },
    { id: 'gpt-4.1', tier: 'standard', inputPrice: 2.0, cachedInputPrice: 0.5, outputPrice: 8.0 },
    { id: 'gpt-4.1-mini', tier: 'standard', inputPrice: 0.4, cachedInputPrice: 0.1, outputPrice: 1.6 },
    { id: 'gpt-4.1-nano', tier: 'standard', inputPrice: 0.1, cachedInputPrice: 0.025, outputPrice: 0.4 },
    { id: 'gpt-4o', tier: 'standard', inputPrice: 2.5, cachedInputPrice: 1.25, outputPrice: 10.0 },
    { id: 'gpt-4o-mini', tier: 'standard', inputPrice: 0.15, cachedInputPrice: 0.075, outputPrice: 0.6 },
    { id: 'o3', tier: 'standard', inputPrice: 2.0, cachedInputPrice: 0.5, outputPrice: 8.0 },
    { id: 'o3-deep-research', tier: 'standard', inputPrice: 10.0, cachedInputPrice: 2.5, outputPrice: 40.0 },
    { id: 'o4-mini', tier: 'standard', inputPrice: 1.1, cachedInputPrice: 0.275, outputPrice: 4.4 },
    { id: 'o4-mini-deep-research', tier: 'standard', inputPrice: 2.0, cachedInputPrice: 0.5, outputPrice: 8.0 },
    { id: 'o3-mini', tier: 'standard', inputPrice: 1.1, cachedInputPrice: 0.55, outputPrice: 4.4 },
    { id: 'o1-mini', tier: 'standard', inputPrice: 1.1, cachedInputPrice: 0.55, outputPrice: 4.4 }
  ].forEach((entry) => addEntry(entry, true));

  [
    { id: 'gpt-5.2', tier: 'flex', inputPrice: 0.875, cachedInputPrice: 0.0875, outputPrice: 7.0 },
    { id: 'gpt-5.1', tier: 'flex', inputPrice: 0.625, cachedInputPrice: 0.0625, outputPrice: 5.0 },
    { id: 'gpt-5', tier: 'flex', inputPrice: 0.625, cachedInputPrice: 0.0625, outputPrice: 5.0 },
    { id: 'gpt-5-mini', tier: 'flex', inputPrice: 0.125, cachedInputPrice: 0.0125, outputPrice: 1.0 },
    { id: 'gpt-5-nano', tier: 'flex', inputPrice: 0.025, cachedInputPrice: 0.0025, outputPrice: 0.2 },
    { id: 'o3', tier: 'flex', inputPrice: 1.0, cachedInputPrice: 0.25, outputPrice: 4.0 },
    { id: 'o4-mini', tier: 'flex', inputPrice: 0.55, cachedInputPrice: 0.138, outputPrice: 2.2 }
  ].forEach((entry) => addEntry(entry));

  const sortedBaseModelIds = [...baseModelIds].sort((left, right) => {
    const leftEntry = byKey[`${left}:standard`] || byKey[`${left}:flex`];
    const rightEntry = byKey[`${right}:standard`] || byKey[`${right}:flex`];
    const leftCost = leftEntry?.sum_1M ?? 0;
    const rightCost = rightEntry?.sum_1M ?? 0;
    return rightCost - leftCost;
  });

  return {
    entries,
    baseModelIds: sortedBaseModelIds,
    byId,
    byKey
  };
}

function getModelRegistry() {
  if (!globalThis.__NT_MODEL_REGISTRY__) {
    globalThis.__NT_MODEL_REGISTRY__ = createModelRegistry();
  }
  return globalThis.__NT_MODEL_REGISTRY__;
}

globalThis.__NT_MODEL_REGISTRY__ ||= createModelRegistry();

function getModelEntry(modelId, tier = 'standard') {
  if (!modelId) return null;
  const registry = getModelRegistry();
  const byKey = registry?.byKey || {};
  if (tier) {
    return byKey[`${modelId}:${tier}`] || null;
  }
  return byKey[`${modelId}:standard`] || byKey[`${modelId}:flex`] || null;
}

function getBaseModelIds() {
  const registry = getModelRegistry();
  return Array.isArray(registry?.baseModelIds) ? [...registry.baseModelIds] : [];
}

globalThis.__NT_parseModelSpec__ ||= function parseModelSpec(spec) {
  if (!spec || typeof spec !== 'string') {
    return { id: '', tier: 'standard' };
  }
  const trimmed = spec.trim();
  if (!trimmed) {
    return { id: '', tier: 'standard' };
  }
  const [id, tierRaw] = trimmed.split(':');
  const tier = tierRaw === 'flex' || tierRaw === 'standard' ? tierRaw : 'standard';
  return { id, tier };
};

globalThis.__NT_formatModelSpec__ ||= function formatModelSpec(id, tier) {
  if (!id) return '';
  const normalizedTier = tier === 'flex' || tier === 'standard' ? tier : 'standard';
  return `${id}:${normalizedTier}`;
};

globalThis.__NT_getModelCapabilityRank__ ||= function getModelCapabilityRank(modelId) {
  if (!modelId) return 0;
  const normalizedId = typeof modelId === 'string' ? modelId.split(':')[0].trim() : modelId;
  if (!normalizedId) return 0;
  if (!globalThis.__NT_CAPABILITY_RANK__) {
    // Heuristic ranks based on official model descriptions + successor relationships (deterministic, not empirical).
    globalThis.__NT_CAPABILITY_RANK__ = {
      'gpt-5.2-pro': 400,
      'gpt-5.2': 380,
      'gpt-5.1': 370,
      'gpt-5-pro': 365,
      'gpt-5': 360,
      'gpt-5-mini': 320,
      'gpt-5-nano': 300,
      'o3-deep-research': 290,
      o3: 280,
      'gpt-4.1': 260,
      'gpt-4o': 250,
      'gpt-4.1-mini': 230,
      'gpt-4o-mini': 220,
      'o3-mini': 210,
      'o4-mini-deep-research': 205,
      'o4-mini': 200,
      'o1-mini': 190,
      'gpt-4.1-nano': 180
    };
  }
  const rankMap = globalThis.__NT_CAPABILITY_RANK__;
  const shouldCheck = globalThis.__NT_DEBUG__ || globalThis.__NT_DEV__;
  if (shouldCheck) {
    const rank = (id) => rankMap[id] ?? 0;
    if (rank('gpt-5.2') <= rank('gpt-5.1')) {
      console.warn('Rank invariant failed: gpt-5.2 must exceed gpt-5.1');
    }
    if (rank('gpt-5.1') <= rank('gpt-5')) {
      console.warn('Rank invariant failed: gpt-5.1 must exceed gpt-5');
    }
    if (rank('gpt-5-pro') <= rank('gpt-5')) {
      console.warn('Rank invariant failed: gpt-5-pro must exceed gpt-5');
    }
    if (rank('gpt-5') <= rank('o3')) {
      console.warn('Rank invariant failed: gpt-5 must exceed o3');
    }
    if (rank('gpt-5-mini') <= rank('o4-mini')) {
      console.warn('Rank invariant failed: gpt-5-mini must exceed o4-mini');
    }
    if (rank('o3-mini') <= rank('o1-mini')) {
      console.warn('Rank invariant failed: o3-mini must exceed o1-mini');
    }
    if (rank('gpt-5.2') <= rank('gpt-5-mini') || rank('gpt-5-mini') <= rank('gpt-5-nano')) {
      console.warn('Rank invariant failed: gpt-5.2 > gpt-5-mini > gpt-5-nano');
    }
    if (rank('gpt-4.1') <= rank('gpt-4.1-mini') || rank('gpt-4.1-mini') <= rank('gpt-4.1-nano')) {
      console.warn('Rank invariant failed: gpt-4.1 > gpt-4.1-mini > gpt-4.1-nano');
    }
    if (rank('o3-deep-research') < rank('o3')) {
      console.warn('Rank invariant failed: o3-deep-research must be >= o3');
    }
    if (rank('o4-mini-deep-research') < rank('o4-mini')) {
      console.warn('Rank invariant failed: o4-mini-deep-research must be >= o4-mini');
    }
  }
  return rankMap[normalizedId] ?? 0;
};

function parseModelSpec(spec) {
  return globalThis.__NT_parseModelSpec__ ? globalThis.__NT_parseModelSpec__(spec) : { id: '', tier: 'standard' };
}

function formatModelSpec(id, tier) {
  return globalThis.__NT_formatModelSpec__ ? globalThis.__NT_formatModelSpec__(id, tier) : '';
}

function getModelCapabilityRank(modelId) {
  return globalThis.__NT_getModelCapabilityRank__ ? globalThis.__NT_getModelCapabilityRank__(modelId) : 0;
}

function getModelParamBlacklist() {
  if (!globalThis.__NT_MODEL_PARAM_BLACKLIST__) {
    globalThis.__NT_MODEL_PARAM_BLACKLIST__ = {};
  }
  return globalThis.__NT_MODEL_PARAM_BLACKLIST__;
}

function getUnsupportedParamsByEndpoint() {
  if (!globalThis.__NT_UNSUPPORTED_PARAMS_BY_ENDPOINT__) {
    globalThis.__NT_UNSUPPORTED_PARAMS_BY_ENDPOINT__ = new Map();
  }
  return globalThis.__NT_UNSUPPORTED_PARAMS_BY_ENDPOINT__;
}

function normalizeBaseUrlHost(apiBaseUrl) {
  if (!apiBaseUrl || typeof apiBaseUrl !== 'string') return '';
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch (error) {
    try {
      return new URL(`https://${trimmed}`).host.toLowerCase();
    } catch (nestedError) {
      return '';
    }
  }
}

function buildUnsupportedParamKey(modelId, apiBaseUrl) {
  if (!modelId) return '';
  const host = normalizeBaseUrlHost(apiBaseUrl);
  if (!host) return '';
  return `${modelId}|${host}`;
}

function isModelParamUnsupported(modelId, paramName, apiBaseUrl) {
  if (!modelId || !paramName) return false;
  const endpointKey = buildUnsupportedParamKey(modelId, apiBaseUrl);
  if (endpointKey) {
    const endpointMap = getUnsupportedParamsByEndpoint();
    const endpointEntry = endpointMap.get(endpointKey);
    if (endpointEntry?.has?.(paramName)) return true;
  }
  const blacklist = getModelParamBlacklist();
  const entry = blacklist[modelId];
  if (!entry) return false;
  if (typeof entry.has === 'function') {
    return entry.has(paramName);
  }
  if (Array.isArray(entry)) {
    return entry.includes(paramName);
  }
  return false;
}

function markModelParamUnsupported(modelId, paramName, apiBaseUrl) {
  if (!modelId || !paramName) return;
  const endpointKey = buildUnsupportedParamKey(modelId, apiBaseUrl);
  if (endpointKey) {
    const endpointMap = getUnsupportedParamsByEndpoint();
    let endpointEntry = endpointMap.get(endpointKey);
    if (!endpointEntry || typeof endpointEntry.add !== 'function') {
      endpointEntry = new Set(Array.isArray(endpointEntry) ? endpointEntry : []);
      endpointMap.set(endpointKey, endpointEntry);
    }
    endpointEntry.add(paramName);
    return;
  }
  const blacklist = getModelParamBlacklist();
  let entry = blacklist[modelId];
  if (!entry || typeof entry.add !== 'function') {
    entry = new Set(Array.isArray(entry) ? entry : []);
    blacklist[modelId] = entry;
  }
  entry.add(paramName);
}

function applyModelRequestParams(requestPayload, modelId, requestOptions = null, apiBaseUrl = null) {
  if (!requestPayload || typeof requestPayload !== 'object') return;
  const tier = requestOptions?.tier || 'standard';
  const entry = getModelEntry(modelId, tier) || getModelEntry(modelId, 'standard');
  const canUseParam = (paramName, supported) =>
    supported && !isModelParamUnsupported(modelId, paramName, apiBaseUrl);
  const supportsCacheRetention = entry?.supportsPromptCacheRetention24h ?? false;
  const supportsCacheKey = entry?.supportsPromptCacheKey ?? true;
  const supportsServiceTier = entry?.supportsServiceTierParam ?? true;
  const supportsSchema = entry?.supportsTextJsonSchema ?? true;

  if (requestOptions?.serviceTier) {
    if (canUseParam('service_tier', supportsServiceTier)) {
      requestPayload.service_tier = requestOptions.serviceTier;
    } else {
      delete requestPayload.service_tier;
    }
  }

  if (requestPayload.prompt_cache_retention !== undefined && !canUseParam('prompt_cache_retention', supportsCacheRetention)) {
    delete requestPayload.prompt_cache_retention;
  }
  if (requestPayload.prompt_cache_key !== undefined && !canUseParam('prompt_cache_key', supportsCacheKey)) {
    delete requestPayload.prompt_cache_key;
  }
  if (requestPayload.response_format !== undefined && !canUseParam('response_format', supportsSchema)) {
    delete requestPayload.response_format;
  }
}
globalThis.__NT_getPromptCacheSupport__ ||= function getPromptCacheSupport(apiBaseUrl, requestOptions = null) {
  const assumeOpenAICompatibleApi = Boolean(requestOptions?.assumeOpenAICompatibleApi);
  const isOpenAICompatibleBase = isOpenAICompatibleBaseUrl(apiBaseUrl, assumeOpenAICompatibleApi);
  return {
    assumeOpenAICompatibleApi,
    isOpenAICompatibleBaseUrl: isOpenAICompatibleBase,
    supportsPromptCachingParams: isOpenAICompatibleBase
  };
};

function getPromptCacheSupport(apiBaseUrl, requestOptions = null) {
  if (globalThis.__NT_getPromptCacheSupport__) {
    return globalThis.__NT_getPromptCacheSupport__(apiBaseUrl, requestOptions);
  }
  const assumeOpenAICompatibleApi = Boolean(requestOptions?.assumeOpenAICompatibleApi);
  const isOpenAICompatibleBase = isOpenAICompatibleBaseUrl(apiBaseUrl, assumeOpenAICompatibleApi);
  return {
    assumeOpenAICompatibleApi,
    isOpenAICompatibleBaseUrl: isOpenAICompatibleBase,
    supportsPromptCachingParams: isOpenAICompatibleBase
  };
}

function applyPromptCaching(messages, apiBaseUrl = OPENAI_API_URL, requestOptions = null) {
  const support = getPromptCacheSupport(apiBaseUrl, requestOptions);
  if (support.isOpenAICompatibleBaseUrl) return messages;
  return messages.map((message) =>
    message.role === 'user' ? { ...message, cache_control: { type: 'ephemeral' } } : message
  );
}

function isHtmlPayload(payload = '') {
  if (typeof payload !== 'string') return false;
  const trimmed = payload.trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.includes('<html');
}

function parseRetryAfterMsFromMessage(message = '') {
  if (typeof message !== 'string' || !message.trim()) return null;
  const retryMatch = message.match(/try again in\s*([\d.]+)\s*(ms|msec|millis|s|sec|secs|seconds)/i);
  if (retryMatch) {
    const value = Number(retryMatch[1]);
    if (Number.isNaN(value)) return null;
    const unit = retryMatch[2].toLowerCase();
    if (unit.startsWith('m')) return Math.round(value);
    return Math.round(value * 1000);
  }

  const retryMsMatch = message.match(/retry(?:ing)? in\s*([\d.]+)\s*(ms|msec|millis|s|sec|secs|seconds)/i);
  if (retryMsMatch) {
    const value = Number(retryMsMatch[1]);
    if (Number.isNaN(value)) return null;
    const unit = retryMsMatch[2].toLowerCase();
    if (unit.startsWith('m')) return Math.round(value);
    return Math.round(value * 1000);
  }

  return null;
}

function isContextOverflowErrorMessage(message = '') {
  if (typeof message !== 'string') return false;
  const normalized = message.toLowerCase();
  return (
    normalized.includes('context length') ||
    normalized.includes('maximum context') ||
    normalized.includes('context window') ||
    normalized.includes('token limit') ||
    normalized.includes('too many tokens') ||
    normalized.includes('maximum tokens') ||
    normalized.includes('input is too long')
  );
}

function parseRetryAfterMs(response, errorPayload) {
  const retryAfterHeader = response?.headers?.get?.('Retry-After');
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      const deltaMs = asDate - Date.now();
      if (deltaMs > 0) return deltaMs;
    }
  }

  const retryAfterSeconds =
    errorPayload?.error?.retry_after ??
    errorPayload?.error?.retry_after_seconds ??
    errorPayload?.retry_after ??
    errorPayload?.retry_after_seconds;
  if (typeof retryAfterSeconds === 'number' && retryAfterSeconds >= 0) {
    return Math.round(retryAfterSeconds * 1000);
  }

  const retryAfterMs = errorPayload?.error?.retry_after_ms ?? errorPayload?.retry_after_ms;
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.round(retryAfterMs);
  }

  const message =
    errorPayload?.error?.message ||
    errorPayload?.message ||
    errorPayload?.error?.detail ||
    errorPayload?.detail ||
    '';
  const retryAfterFromMessageMs = parseRetryAfterMsFromMessage(message);
  if (typeof retryAfterFromMessageMs === 'number' && retryAfterFromMessageMs >= 0) {
    return Math.round(retryAfterFromMessageMs);
  }

  return null;
}

function calculateRetryDelayMs(attempt, retryAfterMs) {
  const baseDelayMs = 1000;
  const exponentialDelayMs = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitterMs = Math.floor(Math.random() * 250);
  const computedDelayMs = exponentialDelayMs + jitterMs;
  const fallbackDelayMs = retryAfterMs ? Math.max(retryAfterMs, computedDelayMs) : computedDelayMs;
  return Math.min(fallbackDelayMs, 30000);
}

function sleep(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens);
  const completionTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens);
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);
  const cachedTokens = Number(
    usage?.prompt_tokens_details?.cached_tokens ??
      usage?.input_tokens_details?.cached_tokens ??
      usage?.prompt_tokens_details?.cachedTokens ??
      usage?.input_tokens_details?.cachedTokens ??
      usage?.cached_tokens ??
      usage?.cachedTokens
  );
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : null,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : null,
    prompt_tokens_details: {
      cached_tokens: Number.isFinite(cachedTokens) ? cachedTokens : 0
    }
  };
}

const PROMPT_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set();
const PROMPT_CACHE_KEY_UNSUPPORTED_MODELS = new Set();

function getPromptCacheKey(stage, variant = '') {
  const normalizedStage = typeof stage === 'string' ? stage.trim().toLowerCase() : '';
  const normalizedVariant = typeof variant === 'string' ? variant.trim().toLowerCase() : '';
  if (normalizedStage === 'translate' || normalizedStage === 'translation') {
    return 'neuro-translate:translate:v2';
  }
  if (normalizedStage === 'proofread') {
    return 'neuro-translate:proofread:v2';
  }
  if (normalizedStage === 'context') {
    if (normalizedVariant === 'short') {
      return 'neuro-translate:context-short:v1';
    }
    return 'neuro-translate:context:v1';
  }
  return '';
}

function isUnsupportedParamError(status, errorPayload, errorText, paramName) {
  if (status !== 400) return false;
  const apiParam = errorPayload?.error?.param || errorPayload?.param || '';
  const apiMsg = errorPayload?.error?.message || errorPayload?.message || errorText || '';
  const msg = String(apiMsg || '').toLowerCase();
  const p = String(apiParam || '').toLowerCase();
  const needle = String(paramName || '').toLowerCase();
  return p === needle || msg.includes(needle);
}

function isOpenAICompatibleBaseUrl(apiBaseUrl, assumeOpenAICompatibleApi = false) {
  if (assumeOpenAICompatibleApi) return true;
  if (!apiBaseUrl || typeof apiBaseUrl !== 'string') return false;
  const trimmed = apiBaseUrl.trim();
  if (!trimmed) return false;
  let host = '';
  let path = '';
  try {
    const parsed = new URL(trimmed);
    host = parsed.hostname.toLowerCase();
    path = parsed.pathname.toLowerCase();
  } catch (error) {
    try {
      const parsed = new URL(`https://${trimmed}`);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname.toLowerCase();
    } catch (nestedError) {
      const lower = trimmed.toLowerCase();
      if (lower.includes('openai.com')) return true;
      return lower.endsWith('/v1/chat/completions') || lower.endsWith('/v1/responses');
    }
  }
  if (host.includes('openai.com')) return true;
  return path.endsWith('/v1/chat/completions') || path.endsWith('/v1/responses');
}

function getPromptCacheUnsupportedKey(model, apiBaseUrl) {
  if (!model) return '';
  const host = normalizeBaseUrlHost(apiBaseUrl);
  return host ? `${model}|${host}` : model;
}

function isPromptCacheParamUnsupported(paramSet, model, apiBaseUrl) {
  if (!paramSet || !model) return false;
  const key = getPromptCacheUnsupportedKey(model, apiBaseUrl);
  return key ? paramSet.has(key) : false;
}

function markPromptCacheParamUnsupported(paramSet, model, apiBaseUrl) {
  if (!paramSet || !model) return;
  const key = getPromptCacheUnsupportedKey(model, apiBaseUrl);
  if (key) {
    paramSet.add(key);
  }
}

function applyPromptCacheParams(requestPayload, apiBaseUrl, model, cacheKey, requestOptions = null) {
  if (!requestPayload || typeof requestPayload !== 'object') return;
  if (!isOpenAICompatibleBaseUrl(apiBaseUrl, requestOptions?.assumeOpenAICompatibleApi)) return;

  const entry = getModelEntry(model);
  const supportsCacheKey = entry?.supportsPromptCacheKey ?? true;
  const supportsCacheRetention = isExtendedPromptCacheRetentionSupported(model);
  if (
    cacheKey &&
    typeof cacheKey === 'string' &&
    model &&
    supportsCacheKey &&
    !isPromptCacheParamUnsupported(PROMPT_CACHE_KEY_UNSUPPORTED_MODELS, model, apiBaseUrl) &&
    !isModelParamUnsupported(model, 'prompt_cache_key', apiBaseUrl)
  ) {
    requestPayload.prompt_cache_key = cacheKey;
  }
  if (
    model &&
    supportsCacheRetention &&
    !isPromptCacheParamUnsupported(PROMPT_CACHE_RETENTION_UNSUPPORTED_MODELS, model, apiBaseUrl) &&
    !isModelParamUnsupported(model, 'prompt_cache_retention', apiBaseUrl)
  ) {
    requestPayload.prompt_cache_retention = '24h';
  }
}

function stripUnsupportedPromptCacheParams(requestPayload, model, status, errorPayload, errorText, apiBaseUrl) {
  if (!requestPayload || typeof requestPayload !== 'object') return { changed: false, removedParams: [] };

  let changed = false;
  const removedParams = [];

  if (
    requestPayload.prompt_cache_retention !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'prompt_cache_retention')
  ) {
    if (model) markPromptCacheParamUnsupported(PROMPT_CACHE_RETENTION_UNSUPPORTED_MODELS, model, apiBaseUrl);
    if (model) markModelParamUnsupported(model, 'prompt_cache_retention', apiBaseUrl);
    delete requestPayload.prompt_cache_retention;
    changed = true;
    removedParams.push('prompt_cache_retention');
  }

  if (
    requestPayload.prompt_cache_key !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'prompt_cache_key')
  ) {
    if (model) markPromptCacheParamUnsupported(PROMPT_CACHE_KEY_UNSUPPORTED_MODELS, model, apiBaseUrl);
    if (model) markModelParamUnsupported(model, 'prompt_cache_key', apiBaseUrl);
    delete requestPayload.prompt_cache_key;
    if (requestPayload.prompt_cache_retention !== undefined) delete requestPayload.prompt_cache_retention;
    changed = true;
    removedParams.push('prompt_cache_key');
  }

  return { changed, removedParams };
}

function stripUnsupportedRequestParams(requestPayload, model, status, errorPayload, errorText, apiBaseUrl) {
  if (!requestPayload || typeof requestPayload !== 'object') {
    return { changed: false, removedParams: [] };
  }

  const removedParams = [];
  let changed = false;

  const promptResult = stripUnsupportedPromptCacheParams(
    requestPayload,
    model,
    status,
    errorPayload,
    errorText,
    apiBaseUrl
  );
  if (promptResult.changed) {
    changed = true;
    if (Array.isArray(promptResult.removedParams)) {
      removedParams.push(...promptResult.removedParams);
    }
  }

  if (
    requestPayload.service_tier !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'service_tier')
  ) {
    if (model) markModelParamUnsupported(model, 'service_tier', apiBaseUrl);
    delete requestPayload.service_tier;
    changed = true;
    removedParams.push('service_tier');
  }

  if (
    requestPayload.response_format !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'response_format')
  ) {
    if (model) markModelParamUnsupported(model, 'response_format', apiBaseUrl);
    delete requestPayload.response_format;
    changed = true;
    removedParams.push('response_format');
  }

  if (
    requestPayload.max_tokens !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'max_tokens')
  ) {
    const previousMaxTokens = requestPayload.max_tokens;
    delete requestPayload.max_tokens;
    if (requestPayload.max_completion_tokens === undefined) {
      requestPayload.max_completion_tokens = previousMaxTokens;
      removedParams.push('max_tokens->max_completion_tokens');
    } else {
      removedParams.push('max_tokens');
    }
    if (model) markModelParamUnsupported(model, 'max_tokens', apiBaseUrl);
    changed = true;
  }

  if (
    requestPayload.max_completion_tokens !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'max_completion_tokens')
  ) {
    const previousMaxCompletionTokens = requestPayload.max_completion_tokens;
    delete requestPayload.max_completion_tokens;
    if (requestPayload.max_tokens === undefined) {
      requestPayload.max_tokens = previousMaxCompletionTokens;
      removedParams.push('max_completion_tokens->max_tokens');
    } else {
      removedParams.push('max_completion_tokens');
    }
    if (model) markModelParamUnsupported(model, 'max_completion_tokens', apiBaseUrl);
    changed = true;
  }

  if (changed && (globalThis.__NT_DEBUG__ || globalThis.__NT_DEV__)) {
    console.debug('stripUnsupportedRequestParams', {
      model,
      status,
      removedParams,
      apiBaseUrl
    });
  }
  return { changed, removedParams };
}
