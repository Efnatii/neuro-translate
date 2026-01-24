const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const PUNCTUATION_TOKEN_HINT =
  'Tokens like ⟦PUNC_DQUOTE⟧ replace double quotes; keep them unchanged, in place, and with exact casing.';
const MODEL_PRICE_PER_M_TOKEN = {
  'gpt-5-nano': 0.45,
  'gpt-4.1-nano': 0.5,
  'gpt-4o-mini': 0.75,
  'gpt-4.1-mini': 2,
  'gpt-5-mini': 2.25,
  'gpt-4.1': 10,
  'gpt-5.1': 11.25,
  'gpt-5': 11.25,
  'gpt-5.1-chat-latest': 11.25,
  'gpt-5-chat-latest': 11.25,
  'gpt-4o': 12.5,
  'gpt-5.2': 15.75,
  'gpt-5.2-chat-latest': 15.75,
  'gpt-4o-2024-05-13': 20
};

function applyPromptCaching(messages, apiBaseUrl = OPENAI_API_URL) {
  if (apiBaseUrl !== OPENAI_API_URL) return messages;
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
  return {
    prompt_tokens: Number.isFinite(promptTokens) ? promptTokens : null,
    completion_tokens: Number.isFinite(completionTokens) ? completionTokens : null,
    total_tokens: Number.isFinite(totalTokens) ? totalTokens : null
  };
}

function calculateUsageCost(usage, model) {
  const normalized = normalizeUsage(usage);
  if (!normalized?.total_tokens) return null;
  const pricePerM = MODEL_PRICE_PER_M_TOKEN?.[model];
  if (!Number.isFinite(pricePerM)) return null;
  return (normalized.total_tokens / 1_000_000) * pricePerM;
}

const PROMPT_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set();
const PROMPT_CACHE_KEY_UNSUPPORTED_MODELS = new Set();

function isUnsupportedParamError(status, errorPayload, errorText, paramName) {
  if (status !== 400) return false;
  const apiParam = errorPayload?.error?.param || errorPayload?.param || '';
  const apiMsg = errorPayload?.error?.message || errorPayload?.message || errorText || '';
  const msg = String(apiMsg || '').toLowerCase();
  const p = String(apiParam || '').toLowerCase();
  const needle = String(paramName || '').toLowerCase();
  return p === needle || msg.includes(needle);
}

function applyPromptCacheParams(requestPayload, apiBaseUrl, model, cacheKey) {
  if (!requestPayload || typeof requestPayload !== 'object') return;
  if (apiBaseUrl !== OPENAI_API_URL) return;

  if (cacheKey && typeof cacheKey === 'string' && model && !PROMPT_CACHE_KEY_UNSUPPORTED_MODELS.has(model)) {
    requestPayload.prompt_cache_key = cacheKey;
  }
}

function stripUnsupportedPromptCacheParams(requestPayload, model, status, errorPayload, errorText) {
  if (!requestPayload || typeof requestPayload !== 'object') return { changed: false };

  let changed = false;

  if (
    requestPayload.prompt_cache_retention !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'prompt_cache_retention')
  ) {
    if (model) PROMPT_CACHE_RETENTION_UNSUPPORTED_MODELS.add(model);
    delete requestPayload.prompt_cache_retention;
    changed = true;
  }

  if (
    requestPayload.prompt_cache_key !== undefined &&
    isUnsupportedParamError(status, errorPayload, errorText, 'prompt_cache_key')
  ) {
    if (model) PROMPT_CACHE_KEY_UNSUPPORTED_MODELS.add(model);
    delete requestPayload.prompt_cache_key;
    if (requestPayload.prompt_cache_retention !== undefined) delete requestPayload.prompt_cache_retention;
    changed = true;
  }

  return { changed };
}
