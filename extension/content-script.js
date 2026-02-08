(() => {
  const hasChrome = typeof chrome !== 'undefined' && chrome;
  const runtime = hasChrome && chrome.runtime ? chrome.runtime : null;
  const storageLocal = hasChrome && chrome.storage && chrome.storage.local ? chrome.storage.local : null;

  if (!runtime || typeof runtime.sendMessage !== 'function' || !runtime.onMessage || !storageLocal) {
    console.error(
      'Neuro Translate: extension APIs unavailable in this context. Content script will not initialize.',
      {
        hasChrome: Boolean(hasChrome),
        hasRuntime: Boolean(runtime),
        hasStorageLocal: Boolean(storageLocal)
      }
    );
    return;
  }

  if (globalThis.__neuroTranslateContentScriptLoaded) {
    return;
  }
  globalThis.__neuroTranslateContentScriptLoaded = true;

  (() => {
    let enabled = false;

    const safeJsonStringify = (value) => {
      const seen = new WeakSet();
      return JSON.stringify(value, (_key, currentValue) => {
        if (typeof currentValue === 'bigint') return currentValue.toString();
        if (currentValue === undefined) return null;
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack
          };
        }
        if (typeof currentValue === 'object' && currentValue !== null) {
          if (seen.has(currentValue)) {
            return '[Circular]';
          }
          seen.add(currentValue);
        }
        return currentValue;
      });
    };

    const updateEnabled = (value) => {
      enabled = Boolean(value);
    };

    const normalizeJsonEvent = (eventObject) => {
      if (!eventObject || typeof eventObject !== 'object') return eventObject;
      if (!eventObject.fields || typeof eventObject.fields !== 'object') return eventObject;
      const normalized = { ...eventObject, ...eventObject.fields };
      if (normalized.kind === 'throughput.429' && normalized.concurrencyLimit == null) {
        normalized.concurrencyLimit = normalized.newConcurrencyLimit ?? null;
      }
      delete normalized.fields;
      return normalized;
    };

    const handleHealthEvent = (eventObject) => {
      const kind = eventObject?.kind;
      if (kind === 'ui_pipeline.summary') {
        recordHealthUiSummary(eventObject);
      }
      if (kind === 'dedup.summary') {
        recordHealthDedupSummary(eventObject);
      }
    };

    globalThis.ntPageJsonLogEnabled = () => enabled;
    globalThis.ntPageJsonLog = (eventObject, level = 'log') => {
      if (!enabled) return;
      const normalized = normalizeJsonEvent(eventObject);
      handleHealthEvent(normalized);
      const serialized = safeJsonStringify(normalized);
      if (serialized === undefined) return;
      const method = console[level] ? level : 'log';
      console[method](serialized);
    };

    storageLocal.get({ ntConsoleJsonLogEnabled: false }, (result) => {
      updateEnabled(result?.ntConsoleJsonLogEnabled);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes?.ntConsoleJsonLogEnabled) return;
      updateEnabled(changes.ntConsoleJsonLogEnabled.newValue);
    });
  })();

let cancelRequested = false;
let translationError = null;
let translationProgress = { completedBlocks: 0, totalBlocks: 0 };
let currentTabIdForProgress = null;
let activeJobControl = null;
let translationInProgress = false;
let translationCallCount = 0;
let inFlightBlockCount = 0;
let activeTranslationEntries = [];
let originalSnapshot = [];
let translationVisible = false;
let latestContextSummary = '';
let latestShortContextSummary = '';
let shortContextPromise = null;
const blockBudget = new Map();
const contextState = {
  full: {
    status: 'empty',
    signature: '',
    text: '',
    promise: null
  },
  short: {
    status: 'empty',
    signature: '',
    text: '',
    promise: null
  }
};
let debugEntries = [];
let debugState = null;
let debugSessionId = '';
let debugPersistTimer = null;
let debugPersistInFlight = false;
let debugPersistDirty = false;
const DEBUG_PERSIST_DEBOUNCE_MS = 250;
const DEBUG_PERSIST_MAX_INTERVAL_MS = 2000;
let debugLastPersistAt = 0;
let debugBroadcastWarningSentAt = 0;
let debugStorageWarningSentAt = 0;
const HEALTH_WINDOW_MS = 5 * 60 * 1000;
const HEALTH_TPM_WINDOW_MS = 60 * 1000;
const HEALTH_BATCH_SAMPLE_LIMIT = 50;
const HEALTH_EVENT_LIMIT = 300;
let tpmLimiter = null;
let tpmSettings = null;
let pagePlan = null;
let pagePlanHints = null;
let schedulerModels = {
  translationModel: '',
  contextModel: '',
  proofreadModel: ''
};

const STORAGE_KEY = 'pageTranslations';
const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const CONTEXT_CACHE_KEY = 'contextCacheByPage';
const RATE_LIMIT_RETRY_ATTEMPTS = 2;
const SHORT_CONTEXT_MAX_CHARS = 800;
const TRANSLATION_MAX_TOKENS_PER_REQUEST = 2600;
const TRANSLATION_MICROBATCH_TARGET_TOKENS = 1200;
let translationMicrobatchTargetTokens = TRANSLATION_MICROBATCH_TARGET_TOKENS;
let translationMicrobatchMaxItems = 0;
const IN_FLIGHT_WATCHDOG_INTERVAL_MS = 30000;
const IN_FLIGHT_WATCHDOG_GRACE_MS = 60000;
const PROOFREAD_SUSPICIOUS_RATIO = 0.35;
const DEBUG_PREVIEW_MAX_CHARS = 2000;
const DEBUG_RAW_MAX_CHARS = 50000;
const DEBUG_CALLS_TOTAL_LIMIT = 1200;
const DEBUG_EVENTS_LIMIT = 200;
const DEBUG_PAYLOADS_PER_ENTRY_LIMIT = 120;
const MAX_BLOCK_RETRIES = 15;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const BLOCK_FALLBACK_TIMEOUT_LIMIT = 2;
const BLOCK_FALLBACK_ATTEMPT_LIMIT = 6;
const BLOCK_FALLBACK_ELAPSED_LIMIT_MS = 10 * 60 * 1000;
const NT_SETTINGS_RESPONSE_TYPE = 'NT_SETTINGS_RESPONSE';
const NT_RPC_PORT_NAME = 'NT_RPC_PORT';
const BLOCK_KEY_ATTR = 'data-nt-block-key';
const TRANSLATED_ATTR = 'data-nt-translated';
const PROOFREAD_ATTR = 'data-nt-proofread';
const NT_SETTINGS = globalThis.NT_SETTINGS || {};
const DEFAULT_TPM_LIMITS_BY_MODEL = NT_SETTINGS.DEFAULT_TPM_LIMITS_BY_MODEL || { default: 200000 };
const DEFAULT_OUTPUT_RATIO_BY_ROLE = NT_SETTINGS.DEFAULT_OUTPUT_RATIO_BY_ROLE || {
  translation: 0.6,
  context: 0.4,
  proofread: 0.5
};
const DEFAULT_TPM_SAFETY_BUFFER_TOKENS = Number.isFinite(NT_SETTINGS.DEFAULT_TPM_SAFETY_BUFFER_TOKENS)
  ? NT_SETTINGS.DEFAULT_TPM_SAFETY_BUFFER_TOKENS
  : 100;
const DEFAULT_STATE = NT_SETTINGS.DEFAULT_STATE || {
  apiKey: '',
  openAiOrganization: '',
  openAiProject: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  translationModelList: ['gpt-4.1-mini:standard'],
  contextModelList: ['gpt-4.1-mini:standard'],
  proofreadModelList: ['gpt-4.1-mini:standard'],
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  batchTurboMode: 'off',
  proofreadMode: 'auto',
  singleBlockConcurrency: false,
  assumeOpenAICompatibleApi: false,
  blockLengthLimit: 1200,
  tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
  outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
  tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
};
if (!tpmSettings) {
  tpmSettings = {
    outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
    safetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
  };
}
const CALL_TAGS = {
  TRANSLATE_BASE_FULL: 'TRANSLATE_BASE_FULL',
  TRANSLATE_RETRY_FULL: 'TRANSLATE_RETRY_FULL',
  TRANSLATE_FOLLOWUP_SHORT: 'TRANSLATE_FOLLOWUP_SHORT',
  TRANSLATE_OVERFLOW_FALLBACK: 'TRANSLATE_OVERFLOW_FALLBACK',
  TRANSLATE_UI: 'TRANSLATE_UI',
  TRANSLATE_DEDUP_SHORT: 'TRANSLATE_DEDUP_SHORT',
  PROOFREAD_BASE_FULL: 'PROOFREAD_BASE_FULL',
  PROOFREAD_RETRY_FULL: 'PROOFREAD_RETRY_FULL',
  PROOFREAD_REWRITE_SHORT: 'PROOFREAD_REWRITE_SHORT',
  PROOFREAD_NOISE_SHORT: 'PROOFREAD_NOISE_SHORT',
  PROOFREAD_OVERFLOW_FALLBACK: 'PROOFREAD_OVERFLOW_FALLBACK',
  PIPELINE_TRACE: 'PIPELINE_TRACE',
  UI_BROADCAST_SKIPPED: 'UI_BROADCAST_SKIPPED',
  STORAGE_DROPPED: 'STORAGE_DROPPED'
};
const SUPPORTED_MODEL_IDS = new Set([
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.2-pro',
  'gpt-5-pro',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o3-deep-research',
  'o4-mini',
  'o4-mini-deep-research',
  'o3-mini',
  'o1-mini'
]);
const UI_KEYWORDS = [
  'log in',
  'login',
  'sign in',
  'sign up',
  'next',
  'previous',
  'prev',
  'search',
  'follow',
  'settings',
  'menu',
  'home',
  'back',
  'submit',
  'cancel',
  'save',
  'share',
  'more'
];
function parseModelSpec(spec) {
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
}

function formatModelSpec(id, tier) {
  if (!id) return '';
  const normalizedTier = tier === 'flex' || tier === 'standard' ? tier : 'standard';
  return `${id}:${normalizedTier}`;
}

function getBlockBudgetEntry(blockKey) {
  if (!blockKey) return null;
  let entry = blockBudget.get(blockKey);
  if (!entry) {
    entry = {
      startedAtMs: Date.now(),
      attemptsTotal: 0,
      timeouts: 0,
      fallbackEnabled: false
    };
    blockBudget.set(blockKey, entry);
  }
  return entry;
}

function evaluateBlockFallback(entry, blockKey) {
  if (!entry || entry.fallbackEnabled) return false;
  const elapsedMs = Date.now() - entry.startedAtMs;
  const reasons = [];
  if (entry.timeouts >= BLOCK_FALLBACK_TIMEOUT_LIMIT) reasons.push('timeouts');
  if (entry.attemptsTotal >= BLOCK_FALLBACK_ATTEMPT_LIMIT) reasons.push('attempts');
  if (elapsedMs >= BLOCK_FALLBACK_ELAPSED_LIMIT_MS) reasons.push('elapsed');
  if (!reasons.length) return false;
  entry.fallbackEnabled = true;
  globalThis.ntPageJsonLog?.({
    kind: 'block.fallback.enabled',
    ts: Date.now(),
    fields: {
      blockKey,
      reason: reasons.join('|'),
      attemptsTotal: entry.attemptsTotal,
      timeouts: entry.timeouts,
      elapsedMs
    }
  });
  return true;
}

function getRequestBlockKeys(requestMeta) {
  if (!requestMeta || typeof requestMeta !== 'object') return [];
  if (Array.isArray(requestMeta.batchBlockKeys) && requestMeta.batchBlockKeys.length) {
    return requestMeta.batchBlockKeys.filter(Boolean);
  }
  if (requestMeta.blockKey) return [requestMeta.blockKey];
  return [];
}

function recordBlockAttempt(blockKeys) {
  let fallbackEnabled = false;
  blockKeys.forEach((blockKey) => {
    const entry = getBlockBudgetEntry(blockKey);
    if (!entry) return;
    entry.attemptsTotal += 1;
    if (evaluateBlockFallback(entry, blockKey)) {
      fallbackEnabled = true;
    }
    if (entry.fallbackEnabled) {
      fallbackEnabled = true;
    }
  });
  return fallbackEnabled;
}

function recordBlockTimeout(blockKeys) {
  let fallbackEnabled = false;
  blockKeys.forEach((blockKey) => {
    const entry = getBlockBudgetEntry(blockKey);
    if (!entry) return;
    entry.timeouts += 1;
    if (evaluateBlockFallback(entry, blockKey)) {
      fallbackEnabled = true;
    }
    if (entry.fallbackEnabled) {
      fallbackEnabled = true;
    }
  });
  recordHealthTimeout();
  return fallbackEnabled;
}

function initHealthState() {
  return {
    requestsSent: 0,
    responsesOk: 0,
    errorsTotal: 0,
    requestEvents: [],
    rateLimitedEvents: [],
    timeoutEvents: [],
    retryEvents: [],
    tpmEvents: [],
    promptTokensTotal: 0,
    completionTokensTotal: 0,
    cachedTokensTotal: 0,
    promptCacheRetentionUsed: false,
    batchSizesTranslate: [],
    batchSizesProofread: [],
    proofreadCallsTotal: 0,
    proofreadDeltaEditsTotal: 0,
    proofreadDeltaUnchangedTotal: 0,
    proofreadItemsTotal: 0,
    uiTmHit: 0,
    uiTmMiss: 0,
    docDedupSavingsRatio: null,
    backoffUntilMs: 0
  };
}

function getHealthState() {
  if (!debugState) return null;
  if (!debugState.health || typeof debugState.health !== 'object') {
    debugState.health = initHealthState();
  }
  return debugState.health;
}

function trimHealthEvents(health) {
  if (!health) return;
  const now = Date.now();
  const trimByWindow = (list, windowMs) =>
    Array.isArray(list) ? list.filter((event) => now - event.ts <= windowMs).slice(-HEALTH_EVENT_LIMIT) : [];
  health.requestEvents = trimByWindow(health.requestEvents, HEALTH_WINDOW_MS);
  health.rateLimitedEvents = trimByWindow(health.rateLimitedEvents, HEALTH_WINDOW_MS);
  health.timeoutEvents = trimByWindow(health.timeoutEvents, HEALTH_WINDOW_MS);
  health.retryEvents = trimByWindow(health.retryEvents, HEALTH_WINDOW_MS);
  health.tpmEvents = trimByWindow(health.tpmEvents, HEALTH_TPM_WINDOW_MS);
  health.batchSizesTranslate = Array.isArray(health.batchSizesTranslate)
    ? health.batchSizesTranslate.slice(-HEALTH_BATCH_SAMPLE_LIMIT)
    : [];
  health.batchSizesProofread = Array.isArray(health.batchSizesProofread)
    ? health.batchSizesProofread.slice(-HEALTH_BATCH_SAMPLE_LIMIT)
    : [];
}

function recordHealthRequest() {
  const health = getHealthState();
  if (!health) return;
  const now = Date.now();
  health.requestsSent += 1;
  health.requestEvents.push({ ts: now, ok: null });
  trimHealthEvents(health);
  schedulePersistDebugState('health:request');
}

function recordHealthResponse(ok) {
  const health = getHealthState();
  if (!health) return;
  const now = Date.now();
  if (ok) {
    health.responsesOk += 1;
  }
  health.requestEvents.push({ ts: now, ok: Boolean(ok) });
  trimHealthEvents(health);
  schedulePersistDebugState('health:response');
}

function recordHealthError(type) {
  const health = getHealthState();
  if (!health) return;
  const now = Date.now();
  health.errorsTotal += 1;
  health.requestEvents.push({ ts: now, ok: false });
  if (type === 'rate_limited') {
    health.rateLimitedEvents.push({ ts: now });
  }
  if (type === 'timeout') {
    health.timeoutEvents.push({ ts: now });
  }
  trimHealthEvents(health);
  schedulePersistDebugState(`health:error:${type || 'other'}`);
}

function recordHealthTimeout() {
  const health = getHealthState();
  if (!health) return;
  const now = Date.now();
  health.timeoutEvents.push({ ts: now });
  trimHealthEvents(health);
  schedulePersistDebugState('health:timeout');
}

function recordHealthRetry(delayMs = 0) {
  const health = getHealthState();
  if (!health) return;
  const now = Date.now();
  health.retryEvents.push({ ts: now });
  if (delayMs > 0) {
    health.backoffUntilMs = Math.max(health.backoffUntilMs || 0, now + delayMs);
  }
  trimHealthEvents(health);
  schedulePersistDebugState('health:retry');
}

function recordHealthTokens(payloads) {
  const health = getHealthState();
  if (!health) return;
  const now = Date.now();
  const list = Array.isArray(payloads) ? payloads : [];
  list.forEach((payload) => {
    const usage = payload?.usage || {};
    const promptTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
    const completionTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
    const cachedTokens = Number.isFinite(usage?.prompt_tokens_details?.cached_tokens)
      ? usage.prompt_tokens_details.cached_tokens
      : 0;
    const tokens = promptTokens + completionTokens;
    if (tokens > 0) {
      health.tpmEvents.push({ ts: now, tokens });
    }
    health.promptTokensTotal += promptTokens;
    health.completionTokensTotal += completionTokens;
    health.cachedTokensTotal += cachedTokens;
    if (payload?.prompt_cache_retention || payload?.request?.prompt_cache_retention) {
      health.promptCacheRetentionUsed = true;
    }
  });
  trimHealthEvents(health);
  schedulePersistDebugState('health:tokens');
}

function recordHealthBatchSize(kind, size) {
  const health = getHealthState();
  if (!health || !Number.isFinite(size)) return;
  if (kind === 'proofread') {
    health.batchSizesProofread.push(size);
  } else {
    health.batchSizesTranslate.push(size);
  }
  trimHealthEvents(health);
  schedulePersistDebugState('health:batch');
}

function recordHealthProofreadDelta(edits, total) {
  const health = getHealthState();
  if (!health) return;
  const editsCount = Number.isFinite(edits) ? edits : 0;
  const totalCount = Number.isFinite(total) ? total : 0;
  health.proofreadDeltaEditsTotal += editsCount;
  health.proofreadDeltaUnchangedTotal += Math.max(0, totalCount - editsCount);
  health.proofreadItemsTotal += totalCount;
  schedulePersistDebugState('health:proofread-delta');
}

function recordHealthUiSummary(fields) {
  const health = getHealthState();
  if (!health) return;
  health.uiTmHit = Number.isFinite(fields?.tmHits) ? fields.tmHits : health.uiTmHit;
  health.uiTmMiss = Number.isFinite(fields?.tmMisses) ? fields.tmMisses : health.uiTmMiss;
  schedulePersistDebugState('health:ui-summary');
}

function recordHealthDedupSummary(fields) {
  const health = getHealthState();
  if (!health) return;
  if (typeof fields?.dedupSavingsRatio === 'number') {
    health.docDedupSavingsRatio = fields.dedupSavingsRatio;
  }
  schedulePersistDebugState('health:dedup-summary');
}

function isTimeoutLikeError(error) {
  if (!error) return false;
  if (error?.name === 'AbortError') return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('timeout') || message.includes('timed out') || message.includes('abort');
}

function isTimeoutLikeResponse(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.isTimeout) return true;
  return isTimeoutLikeError(response.error);
}

function isRateLimitLikeError(error) {
  const status = error?.status;
  if (status === 429 || status === 503) return true;
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('429') || message.includes('rate') || message.includes('too many');
}
const pendingSettingsRequests = new Map();
let ntRpcPort = null;
const RPC_HEARTBEAT_INTERVAL_MS = 20000;
const RPC_PORT_ROTATE_MS = 1800000;
let rpcHeartbeatTimer = null;
let rpcPortCreatedAt = 0;
const ntRpcPending = new Map();
let translationStartInProgress = false;
let lastPreflightDebug = null;
const PUNCTUATION_TOKENS = new Map([
  ['«', '⟦PUNC_LGUILLEMET⟧'],
  ['»', '⟦PUNC_RGUILLEMET⟧'],
  ['“', '⟦PUNC_LDQUOTE⟧'],
  ['”', '⟦PUNC_RDQUOTE⟧'],
  ['"', '⟦PUNC_DQUOTE⟧']
]);

restoreFromMemory();

try {
  runtime.sendMessage({ type: 'NT_CONTENT_READY', url: location.href });
} catch (error) {
  console.warn('Failed to notify background about content readiness.', error);
}

runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'NT_PING') {
    if (typeof sendResponse === 'function') {
      sendResponse({
        ok: true,
        type: 'NT_PONG',
        timestamp: Date.now(),
        url: location.href,
        visible: translationVisible,
        inFlightCount: inFlightBlockCount
      });
    }
    return true;
  }

  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelTranslation();
  }

  if (message?.type === 'NT_CMD_START') {
    if (translationInProgress || translationStartInProgress) {
      if (typeof sendResponse === 'function') {
        sendResponse({ ok: false, message: 'already_running', code: 'already_running' });
      }
      return true;
    }
    translationStartInProgress = true;
    const jobId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    if (typeof sendResponse === 'function') {
      sendResponse({ ok: true, started: true, jobId, url: location.href });
    }
    void startTranslationFromPopup({
      jobId,
      mode: typeof message?.mode === 'string' ? message.mode : 'page'
    });
    return true;
  }

  if (message?.type === 'NT_CMD_STOP') {
    Promise.resolve()
      .then(() => stopTranslation('stop'))
      .then(() => {
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: true });
        }
      })
      .catch((error) => {
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: false, message: error?.message || String(error) });
        }
      });
    return true;
  }

  if (message?.type === 'NT_CMD_RESET') {
    Promise.resolve()
      .then(() => resetTranslationState({
        resetContext: Boolean(message?.resetContext),
        resetMemory: Boolean(message?.resetMemory)
      }))
      .then(() => {
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: true });
        }
      })
      .catch((error) => {
        if (typeof sendResponse === 'function') {
          sendResponse({ ok: false, message: error?.message || String(error) });
        }
      });
    return true;
  }

  if (message?.type === 'START_TRANSLATION') {
    startTranslation();
  }

  if (message?.type === 'SET_TRANSLATION_VISIBILITY') {
    setTranslationVisibility(Boolean(message.visible));
  }

  if (message?.type === 'RECALCULATE_BLOCKS') {
    const limit = message.blockLengthLimit;
    Promise.resolve()
      .then(() => recalculateBlockCount(limit))
      .then((result) => {
        if (typeof sendResponse === 'function') {
          sendResponse(result);
        }
      });
    return true;
  }

  if (message?.type === 'GET_TRANSLATION_VISIBILITY') {
    Promise.resolve()
      .then(async () => {
        const storedEntries = activeTranslationEntries.length
          ? []
          : await getStoredTranslations(location.href);
        const hasTranslations = Boolean(
          activeTranslationEntries.length > 0 ||
          storedEntries.length > 0
        );
        if (typeof sendResponse === 'function') {
          sendResponse({ visible: translationVisible, hasTranslations });
        }
      });
    return true;
  }

  if (message?.type === NT_SETTINGS_RESPONSE_TYPE && typeof message.requestId === 'string') {
    const entry = pendingSettingsRequests.get(message.requestId);
    if (entry) {
      pendingSettingsRequests.delete(message.requestId);
      clearTimeout(entry.timeoutId);
      entry.resolve(message.settings && typeof message.settings === 'object' ? message.settings : null);
    }
  }
});

function storageLocalGet(keysOrDefaults, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    let hasCompleted = false;
    const timeoutId = setTimeout(() => {
      if (hasCompleted) return;
      hasCompleted = true;
      reject(new Error('storageLocalGet timeout'));
    }, timeoutMs);
    try {
      chrome.storage.local.get(keysOrDefaults, (items) => {
        if (hasCompleted) return;
        hasCompleted = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        if (!items || typeof items !== 'object') {
          resolve({});
          return;
        }
        resolve(items);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function getTpmLimitForModel(model, tpmLimitsByModel) {
  if (!tpmLimitsByModel || typeof tpmLimitsByModel !== 'object') {
    return DEFAULT_TPM_LIMITS_BY_MODEL.default;
  }
  const fallback = tpmLimitsByModel.default ?? DEFAULT_TPM_LIMITS_BY_MODEL.default;
  return tpmLimitsByModel[model] ?? fallback;
}

function buildMissingKeyReason(roleLabel, model) {
  return `Перевод недоступен: укажите OpenAI API ключ для модели ${model} (${roleLabel}).`;
}

function truncateText(value = '', maxChars = DEBUG_PREVIEW_MAX_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!maxChars || text.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, maxChars)}…`, truncated: true };
}

function smartTruncate(value = '', maxChars = SHORT_CONTEXT_MAX_CHARS) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (!maxChars || text.length <= maxChars) {
    return text;
  }
  const candidate = text.slice(0, maxChars);
  const newlineIndex = candidate.lastIndexOf('\n');
  const sentenceIndex = candidate.lastIndexOf('. ');
  const spaceIndex = candidate.lastIndexOf(' ');
  let cutIndex = Math.max(newlineIndex, sentenceIndex, spaceIndex);
  if (cutIndex <= 0) {
    cutIndex = maxChars;
  } else if (cutIndex === sentenceIndex) {
    cutIndex += 1;
  }
  const trimmed = text.slice(0, cutIndex).trimEnd();
  return `${trimmed || candidate.trimEnd()}…`;
}

function normalizeShortContext(text, { url, mode } = {}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= SHORT_CONTEXT_MAX_CHARS) return trimmed;
  const truncated = smartTruncate(trimmed, SHORT_CONTEXT_MAX_CHARS);
  if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
    globalThis.ntPageJsonLog(
      {
        kind: 'context.short.truncated',
        ts: Date.now(),
        fields: {
          beforeChars: trimmed.length,
          afterChars: truncated.length,
          limit: SHORT_CONTEXT_MAX_CHARS,
          url: url || location.href,
          mode: mode || 'SHORT'
        }
      },
      'log'
    );
  }
  return truncated;
}

function serializeRawValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
}

function buildRawPayload(value) {
  const serialized = serializeRawValue(value);
  const trimmed = truncateText(serialized, DEBUG_RAW_MAX_CHARS);
  return {
    rawText: trimmed.text,
    previewText: serialized,
    rawTruncated: trimmed.truncated,
    previewTruncated: false
  };
}

function sendBackgroundMessageSafe(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: 'empty-response' });
      });
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) });
    }
  });
}

async function storeDebugRawSafe(record) {
  if (!record?.id) {
    if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
      globalThis.ntPageJsonLog(
        {
          kind: 'debug.raw.store',
          ts: Date.now(),
          pageUrl: location.href,
          recordId: record?.id ?? null,
          stage: record?.stage ?? record?.value?.type ?? null,
          entryIndex: record?.entryIndex ?? null,
          ok: false,
          error: 'missing-id'
        },
        'log'
      );
    }
    return { ok: false, error: 'missing-id' };
  }
  const startedAt = Date.now();
  let timeoutId;
  const timeoutMs = 1200;
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ ok: false, error: 'raw-store-timeout' }), timeoutMs);
  });
  const response = await Promise.race([
    sendBackgroundMessageSafe({ type: 'DEBUG_STORE_RAW', record }),
    timeoutPromise
  ]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }
  const durationMs = Date.now() - startedAt;
  if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
    globalThis.ntPageJsonLog(
      {
        kind: 'debug.raw.store',
        ts: Date.now(),
        pageUrl: location.href,
        recordId: record.id,
        stage: record?.stage ?? record?.value?.type ?? null,
        entryIndex: record?.entryIndex ?? null,
        ok: Boolean(response?.ok),
        error: response?.ok ? null : response?.error || 'raw-store-failed',
        durationMs
      },
      'log'
    );
  }
  if (!response?.ok) {
    appendDebugEvent(CALL_TAGS.STORAGE_DROPPED, response?.error || 'raw-store-failed');
  }
  return response;
}

async function fetchDebugRawSafe(rawId) {
  if (!rawId) return null;
  const response = await sendBackgroundMessageSafe({ type: 'DEBUG_GET_RAW', rawId });
  if (!response?.ok) {
    return null;
  }
  return response.record || null;
}

async function notifyDebugUpdate() {
  const response = await sendBackgroundMessageSafe({ type: 'DEBUG_NOTIFY', sourceUrl: location.href });
  if (!response?.delivered) {
    const now = Date.now();
    if (now - debugBroadcastWarningSentAt > 30000) {
      debugBroadcastWarningSentAt = now;
      appendDebugEvent(CALL_TAGS.UI_BROADCAST_SKIPPED, 'debug-ui-not-connected');
    }
  }
}

async function readSettingsFromStorage() {
  const stored = await storageLocalGet({ ...DEFAULT_STATE });
  const safeStored = stored && typeof stored === 'object' ? stored : {};
  const merged = { ...DEFAULT_STATE, ...safeStored };
  const previousModels = {
    translationModel: merged.translationModel,
    contextModel: merged.contextModel,
    proofreadModel: merged.proofreadModel,
    translationModelList: merged.translationModelList,
    contextModelList: merged.contextModelList,
    proofreadModelList: merged.proofreadModelList
  };
  const normalizeModelList = (list, fallback) => {
    const rawList = Array.isArray(list)
      ? list
      : typeof list === 'string'
        ? [list]
        : [];
    const normalized = [];
    rawList.forEach((modelSpec) => {
      if (!modelSpec || typeof modelSpec !== 'string' || modelSpec.startsWith('deepseek')) {
        return;
      }
      const parsed = parseModelSpec(modelSpec);
      if (!parsed.id) return;
      if (!SUPPORTED_MODEL_IDS.has(parsed.id)) return;
      if (parsed.tier !== 'flex' && parsed.tier !== 'standard') return;
      const spec = formatModelSpec(parsed.id, parsed.tier);
      if (!normalized.includes(spec)) {
        normalized.push(spec);
      }
    });
    if (!normalized.length) {
      normalized.push(formatModelSpec(fallback, 'standard'));
    }
    return normalized;
  };
  const areModelListsEqual = (left, right) => {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  };
  const fallbackTranslationModel = merged.translationModel || DEFAULT_STATE.translationModel;
  const fallbackContextModel = merged.contextModel || DEFAULT_STATE.contextModel;
  const fallbackProofreadModel = merged.proofreadModel || DEFAULT_STATE.proofreadModel;
  merged.translationModelList = normalizeModelList(
    merged.translationModelList || merged.translationModel,
    fallbackTranslationModel
  );
  merged.contextModelList = normalizeModelList(
    merged.contextModelList || merged.contextModel,
    fallbackContextModel
  );
  merged.proofreadModelList = normalizeModelList(
    merged.proofreadModelList || merged.proofreadModel,
    fallbackProofreadModel
  );
  merged.translationModel = parseModelSpec(merged.translationModelList[0]).id || fallbackTranslationModel;
  merged.contextModel = parseModelSpec(merged.contextModelList[0]).id || fallbackContextModel;
  merged.proofreadModel = parseModelSpec(merged.proofreadModelList[0]).id || fallbackProofreadModel;
  if (
    merged.translationModel !== previousModels.translationModel ||
    merged.contextModel !== previousModels.contextModel ||
    merged.proofreadModel !== previousModels.proofreadModel ||
    !areModelListsEqual(merged.translationModelList, previousModels.translationModelList) ||
    !areModelListsEqual(merged.contextModelList, previousModels.contextModelList) ||
    !areModelListsEqual(merged.proofreadModelList, previousModels.proofreadModelList)
  ) {
    try {
      await chrome.storage.local.set({
        translationModel: merged.translationModel,
        contextModel: merged.contextModel,
        proofreadModel: merged.proofreadModel,
        translationModelList: merged.translationModelList,
        contextModelList: merged.contextModelList,
        proofreadModelList: merged.proofreadModelList
      });
    } catch (error) {
      console.warn('Failed to normalize stored model ids.', error);
    }
  }
  return merged;
}

function buildSettingsFromState(state) {
  if (!state || typeof state !== 'object') {
    return {
      allowed: false,
      disallowedReason:
        'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.',
      apiKey: DEFAULT_STATE.apiKey,
      translationModel: DEFAULT_STATE.translationModel,
      contextModel: DEFAULT_STATE.contextModel,
      proofreadModel: DEFAULT_STATE.proofreadModel,
      translationModelList: DEFAULT_STATE.translationModelList,
      contextModelList: DEFAULT_STATE.contextModelList,
      proofreadModelList: DEFAULT_STATE.proofreadModelList,
      contextGenerationEnabled: DEFAULT_STATE.contextGenerationEnabled,
      proofreadEnabled: DEFAULT_STATE.proofreadEnabled,
      batchTurboMode: DEFAULT_STATE.batchTurboMode,
      proofreadMode: DEFAULT_STATE.proofreadMode,
      singleBlockConcurrency: DEFAULT_STATE.singleBlockConcurrency,
      assumeOpenAICompatibleApi: DEFAULT_STATE.assumeOpenAICompatibleApi,
      blockLengthLimit: DEFAULT_STATE.blockLengthLimit,
      tpmLimitsByRole: {
        translation: getTpmLimitForModel(DEFAULT_STATE.translationModel, DEFAULT_STATE.tpmLimitsByModel),
        context: getTpmLimitForModel(DEFAULT_STATE.contextModel, DEFAULT_STATE.tpmLimitsByModel),
        proofread: getTpmLimitForModel(DEFAULT_STATE.proofreadModel, DEFAULT_STATE.tpmLimitsByModel)
      },
      outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
      tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
    };
  }
  const translationModel = parseModelSpec(
    Array.isArray(state.translationModelList) && state.translationModelList.length
      ? state.translationModelList[0]
      : state.translationModel
  ).id || state.translationModel;
  const contextModel = parseModelSpec(
    Array.isArray(state.contextModelList) && state.contextModelList.length
      ? state.contextModelList[0]
      : state.contextModel
  ).id || state.contextModel;
  const proofreadModel = parseModelSpec(
    Array.isArray(state.proofreadModelList) && state.proofreadModelList.length
      ? state.proofreadModelList[0]
      : state.proofreadModel
  ).id || state.proofreadModel;
  const tpmLimitsByRole = {
    translation: getTpmLimitForModel(translationModel, state.tpmLimitsByModel),
    context: getTpmLimitForModel(contextModel, state.tpmLimitsByModel),
    proofread: getTpmLimitForModel(proofreadModel, state.tpmLimitsByModel)
  };
  const hasApiKey = Boolean(state.apiKey);
  let disallowedReason = null;
  if (!hasApiKey) {
    disallowedReason = buildMissingKeyReason('перевод', translationModel);
  }
  return {
    allowed: hasApiKey,
    disallowedReason,
    apiKey: state.apiKey,
    translationModel,
    contextModel,
    proofreadModel,
    translationModelList: state.translationModelList,
    contextModelList: state.contextModelList,
    proofreadModelList: state.proofreadModelList,
    contextGenerationEnabled: state.contextGenerationEnabled,
    proofreadEnabled: state.proofreadEnabled,
    batchTurboMode: state.batchTurboMode || DEFAULT_STATE.batchTurboMode,
    proofreadMode: state.proofreadMode || DEFAULT_STATE.proofreadMode,
    singleBlockConcurrency: Boolean(state.singleBlockConcurrency),
    assumeOpenAICompatibleApi: Boolean(state.assumeOpenAICompatibleApi),
    blockLengthLimit: state.blockLengthLimit,
    tpmLimitsByRole,
    outputRatioByRole: state.outputRatioByRole || DEFAULT_OUTPUT_RATIO_BY_ROLE,
    tpmSafetyBufferTokens:
      Number.isFinite(state.tpmSafetyBufferTokens) && state.tpmSafetyBufferTokens >= 0
        ? state.tpmSafetyBufferTokens
        : DEFAULT_TPM_SAFETY_BUFFER_TOKENS
  };
}

function logStartEvent(kind, payload = {}) {
  const entry = {
    kind,
    ts: Date.now(),
    url: location.href,
    ...payload
  };
  if (typeof globalThis.ntPageJsonLog === 'function') {
    globalThis.ntPageJsonLog(entry, 'log');
  } else {
    console.info('[NT]', kind, entry);
  }
}

async function startTranslationFromPopup({ mode = 'page', jobId } = {}) {
  logStartEvent('start.cmd.received', { mode, jobId });
  let tabId = null;
  try {
    tabId = await getActiveTabId();
    currentTabIdForProgress = tabId || currentTabIdForProgress;
    if (tabId) {
      await sendBackgroundMessageSafe({
        type: 'NT_PROGRESS_PULSE',
        tabId,
        channel: 'page',
        reason: 'start_cmd'
      });
    }
    const started = await startTranslation('popup', { logStart: true, startJobId: jobId, mode });
    logStartEvent('start.pipeline.end', { ok: Boolean(started), jobId });
  } catch (error) {
    logStartEvent('start.pipeline.end', { ok: false, jobId, error: error?.message || String(error) });
    reportLastError('start', 'start_failed', error);
  } finally {
    translationStartInProgress = false;
    if (tabId) {
      await sendBackgroundMessageSafe({
        type: 'NT_PROGRESS_PULSE',
        tabId,
        channel: 'page',
        reason: 'job_finished'
      });
    }
  }
}

async function startTranslation(triggerSource = 'manual', options = {}) {
  const logStart = Boolean(options?.logStart);
  const startJobId = options?.startJobId || null;
  if (translationInProgress) {
    reportProgress('Перевод уже выполняется', translationProgress.completedBlocks, translationProgress.totalBlocks);
    return false;
  }

  let settings = await requestSettings();
  if (!settings?.allowed) {
    await delay(500);
    settings = await requestSettings();
  }
  if (!settings?.allowed) {
    reportProgress(
      settings?.disallowedReason || 'Перевод недоступен для этой страницы',
      translationProgress.completedBlocks,
      translationProgress.totalBlocks
    );
    return false;
  }

  if (!translationVisible) {
    await setTranslationVisibility(true);
  }

  const tabIdForProgress = await getActiveTabId();
  currentTabIdForProgress = tabIdForProgress || null;

  if (logStart) {
    logStartEvent('start.plan.begin', { jobId: startJobId });
  }
  configureTpmLimiter(settings);
  schedulerModels = {
    translationModel: settings.translationModel || '',
    contextModel: settings.contextModel || '',
    proofreadModel: settings.proofreadModel || ''
  };
  try {
    const planId = createRequestId();
    const plan = globalThis.ntPagePreflight?.buildPagePlan?.(
      document,
      settings.targetLanguage || 'ru',
      settings
    );
    if (plan) {
      pagePlan = { ...plan, planId };
      pagePlanHints = plan.hints || null;
      lastPreflightDebug = plan.debug || null;
      if (currentTabIdForProgress && lastPreflightDebug) {
        void sendBackgroundMessageSafe({
          type: 'NT_REPORT_PREFLIGHT',
          tabId: currentTabIdForProgress,
          debug: lastPreflightDebug
        });
      }
      globalThis.ntPageJsonLog?.({
        kind: 'preflight.summary',
        ts: Date.now(),
        host: plan.host || location.host || '',
        totals: plan.totals || {},
        hints: plan.hints || {}
      });
      if (logStart) {
        logStartEvent('start.plan.ready', {
          jobId: startJobId,
          totalBlocks: Number.isFinite(plan?.totals?.blocks) ? plan.totals.blocks : null
        });
      }
      if (currentTabIdForProgress && Number.isFinite(plan?.totals?.blocks)) {
        const totalBlocks = plan.totals.blocks;
        void sendBackgroundMessageSafe({
          type: 'NT_SET_TOTAL',
          tabId: currentTabIdForProgress,
          channel: 'page',
          reason: totalBlocks > 0 ? 'plan_ready' : 'no_candidates',
          totals: {
            total: totalBlocks,
            done: 0,
            failed: 0,
            inFlight: 0,
            queued: totalBlocks
          }
        });
        if (totalBlocks === 0) {
          let topReason = 'none';
          let topCount = 0;
          if (lastPreflightDebug?.filtered && typeof lastPreflightDebug.filtered === 'object') {
            const ranked = Object.entries(lastPreflightDebug.filtered).sort((a, b) => b[1] - a[1]);
            if (ranked.length) {
              [topReason, topCount] = ranked[0];
            }
          }
          if (logStart) {
            logStartEvent('start.no_candidates', {
              jobId: startJobId,
              reason: 'empty-plan',
              topReason,
              topCount
            });
          }
          void sendBackgroundMessageSafe({
            type: 'NT_REPORT_ERROR',
            tabId: currentTabIdForProgress,
            channel: 'page',
            stage: 'preflight',
            reason: 'no_candidates',
            message: `top=${topReason}(${topCount}) scanned=${lastPreflightDebug?.scannedTextNodes ?? 0} nonEmpty=${lastPreflightDebug?.nonEmptyTextNodes ?? 0}`
          });
          void sendBackgroundMessageSafe({
            type: 'NT_PROGRESS_PULSE',
            tabId: currentTabIdForProgress,
            channel: 'page',
            reason: 'no_candidates',
            queued: 0,
            inFlight: 0
          });
        }
      }
      const tabId = await getActiveTabId();
      if (tabId) {
        await sendRpcRequest(
          { type: 'START_PAGE_PLAN', plan: pagePlan, tabId },
          'START_PAGE_PLAN failed',
          5000
        );
      }
    }
  } catch (error) {
    globalThis.ntPageJsonLog?.({
      kind: 'preflight.error',
      ts: Date.now(),
      error: error?.message || String(error)
    });
  }
  translationInProgress = true;
  try {
    startRpcHeartbeat();
    if (logStart) {
      logStartEvent('start.pipeline.begin', { jobId: startJobId });
    }
    await translatePage(settings, { triggerSource, planHints: pagePlanHints });
    return true;
  } finally {
    translationInProgress = false;
    stopRpcHeartbeat();
    activeJobControl = null;
  }
}

async function requestSettings() {
  const requestId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  let timeoutId;
  const settingsPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      pendingSettingsRequests.delete(requestId);
      resolve(null);
    }, 1500);
    pendingSettingsRequests.set(requestId, { resolve, timeoutId });
  });

  try {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS', requestId, url: location.href }, (ack) => {
      if (chrome.runtime.lastError) {
        const entry = pendingSettingsRequests.get(requestId);
        if (entry) {
          pendingSettingsRequests.delete(requestId);
          clearTimeout(entry.timeoutId);
          entry.resolve(null);
        }
        return;
      }
      if (ack && typeof ack === 'object' && typeof ack.allowed !== 'undefined') {
        const entry = pendingSettingsRequests.get(requestId);
        if (entry) {
          pendingSettingsRequests.delete(requestId);
          clearTimeout(entry.timeoutId);
          entry.resolve(ack);
        }
      }
    });
  } catch (error) {
    const entry = pendingSettingsRequests.get(requestId);
    if (entry) {
      pendingSettingsRequests.delete(requestId);
      clearTimeout(entry.timeoutId);
      entry.resolve(null);
    }
  }

  let settings = await settingsPromise;
  if (settings && typeof settings === 'object') {
    return settings;
  }

  try {
    const state = await readSettingsFromStorage();
    settings = buildSettingsFromState(state);
    try {
      chrome.runtime.sendMessage({
        type: 'SYNC_STATE_CACHE',
        state: {
          apiKey: state.apiKey,
          translationModel: state.translationModel,
          contextModel: state.contextModel,
          proofreadModel: state.proofreadModel,
          contextGenerationEnabled: state.contextGenerationEnabled,
          proofreadEnabled: state.proofreadEnabled,
          batchTurboMode: state.batchTurboMode,
          assumeOpenAICompatibleApi: state.assumeOpenAICompatibleApi,
          blockLengthLimit: state.blockLengthLimit,
          tpmLimitsByModel: state.tpmLimitsByModel,
          outputRatioByRole: state.outputRatioByRole,
          tpmSafetyBufferTokens: state.tpmSafetyBufferTokens
        }
      });
    } catch (error) {
      // ignore
    }
    return settings;
  } catch (error) {
    return {
      allowed: false,
      disallowedReason:
        'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.'
    };
  }
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function computeContextHash(contextText = '') {
  if (!contextText) return 0;
  return computeTextHash(contextText);
}

function deriveContextPolicy(contextMode, contextText, purpose) {
  if (!contextText) {
    return purpose && purpose !== 'main' ? 'minimal' : 'none';
  }
  if (contextMode === 'SHORT') return 'minimal';
  return 'full';
}

function buildRequestMeta(base = {}, overrides = {}) {
  const requestId = overrides.requestId || base.requestId || createRequestId();
  const parentRequestId = overrides.parentRequestId || base.parentRequestId || '';
  const blockKey = overrides.blockKey || base.blockKey || '';
  const stage = overrides.stage || base.stage || '';
  const purpose = overrides.purpose || base.purpose || 'main';
  const attempt = Number.isFinite(overrides.attempt)
    ? overrides.attempt
    : Number.isFinite(base.attempt)
      ? base.attempt
      : 0;
  const triggerSource = overrides.triggerSource || base.triggerSource || '';
  const contextText = overrides.contextText ?? base.contextText ?? '';
  const contextMode = overrides.contextMode || base.contextMode || '';
  const url = overrides.url || base.url || '';
  const contextCacheKey = overrides.contextCacheKey || base.contextCacheKey || '';
  const contextPolicy = deriveContextPolicy(contextMode, contextText, purpose);
  return {
    requestId,
    parentRequestId,
    blockKey,
    stage,
    purpose,
    attempt,
    triggerSource,
    url,
    contextCacheKey,
    contextMode: contextPolicy,
    contextHash: computeContextHash(contextText),
    contextLength: contextText ? contextText.length : 0
  };
}

function annotateRequestMetadata(payloads, meta = {}) {
  if (!Array.isArray(payloads) || !meta) return payloads;
  return payloads.map((payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    return {
      ...payload,
      requestId: payload.requestId || meta.requestId,
      parentRequestId: payload.parentRequestId || meta.parentRequestId || '',
      blockKey: payload.blockKey || meta.blockKey || '',
      stage: payload.stage || meta.stage || '',
      purpose: payload.purpose || meta.purpose || '',
      attempt: Number.isFinite(payload.attempt) ? payload.attempt : meta.attempt,
      triggerSource: payload.triggerSource || meta.triggerSource || '',
      contextMode: payload.contextMode || meta.contextMode || '',
      contextHash: payload.contextHash ?? meta.contextHash ?? null,
      contextLength: payload.contextLength ?? meta.contextLength ?? null,
      batchBlockKeys: payload.batchBlockKeys || meta.batchBlockKeys || [],
      batchBlockCount:
        Number.isFinite(payload.batchBlockCount)
          ? payload.batchBlockCount
          : Number.isFinite(meta.batchBlockCount)
            ? meta.batchBlockCount
            : null
    };
  });
}

function traceRequestInitiator(meta) {
  if (!debugState) return;
  console.debug('Neuro Translate request initiated', meta);
  console.trace('Neuro Translate request trace');
}

function traceBlockLifecycle(entryIndex, stage, message, meta = null) {
  if (!debugState) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  appendDebugEvent(CALL_TAGS.PIPELINE_TRACE, `[${stage}#${entryIndex}] ${message}${suffix}`);
  if (globalThis.__NT_DEBUG__ || globalThis.__NT_DEV__) {
    console.debug('Neuro Translate pipeline', { entryIndex, stage, message, meta });
  }
}

async function translatePage(settings, options = {}) {
  const translationTriggerSource = options?.triggerSource || 'manual';
  const planHints = options?.planHints && typeof options.planHints === 'object' ? options.planHints : null;
  const suggestedBatchSizeTranslate = Number.isFinite(planHints?.suggestedBatchSizeTranslate)
    ? Math.max(1, planHints.suggestedBatchSizeTranslate)
    : null;
  const suggestedBatchSizeProofread = Number.isFinite(planHints?.suggestedBatchSizeProofread)
    ? Math.max(1, planHints.suggestedBatchSizeProofread)
    : null;
  const suggestedConcurrency = Number.isFinite(planHints?.suggestedConcurrency)
    ? Math.max(1, planHints.suggestedConcurrency)
    : null;
  const translationBatchTargetTokens = suggestedBatchSizeTranslate
    ? Math.round(
        TRANSLATION_MICROBATCH_TARGET_TOKENS *
          Math.min(2, 0.5 + suggestedBatchSizeTranslate / 6)
      )
    : TRANSLATION_MICROBATCH_TARGET_TOKENS;
  translationMicrobatchTargetTokens = translationBatchTargetTokens;
  translationMicrobatchMaxItems = suggestedBatchSizeTranslate ? Math.max(1, suggestedBatchSizeTranslate) : 0;
  translationCallCount = 0;
  const textNodes = collectTextNodes(document.body);
  const existingDebugStore = await getTranslationDebugObject();
  const existingDebugEntry = existingDebugStore?.[location.href];
  const existingContextFullPreview =
    settings.contextGenerationEnabled && typeof existingDebugEntry?.contextFull === 'string'
      ? existingDebugEntry.contextFull.trim()
      : settings.contextGenerationEnabled && typeof existingDebugEntry?.context === 'string'
        ? existingDebugEntry.context.trim()
        : '';
  const tabId = await getActiveTabId();
  const nodesWithPath = textNodes.map((node) => ({
    node,
    path: getNodePath(node),
    original: node.nodeValue,
    originalHash: computeTextHash(node.nodeValue || '')
  }));
  const contextCacheSignature = buildContextCacheSignature(nodesWithPath);
  const contextCacheKey =
    settings.contextGenerationEnabled && tabId
      ? `${tabId}::${location.href}::${contextCacheSignature}`
      : '';
  const cachedContextEntry = settings.contextGenerationEnabled
    ? await getContextCacheEntry(contextCacheKey)
    : null;
  const cachedContextFull =
    typeof cachedContextEntry?.contextFull === 'string'
      ? cachedContextEntry.contextFull.trim()
      : typeof cachedContextEntry?.context === 'string'
        ? cachedContextEntry.context.trim()
        : '';
  const cachedContextShort =
    typeof cachedContextEntry?.contextShort === 'string' ? cachedContextEntry.contextShort.trim() : '';
  const existingContextFullRefId = existingDebugEntry?.contextFullRefId || '';
  const existingContextShortRefId = existingDebugEntry?.contextShortRefId || '';
  const existingContextFullRecord = existingContextFullRefId ? await fetchDebugRawSafe(existingContextFullRefId) : null;
  const existingContextShortRecord = existingContextShortRefId
    ? await fetchDebugRawSafe(existingContextShortRefId)
    : null;
  const existingContextFullText =
    cachedContextFull ||
    existingContextFullRecord?.value?.text ||
    existingContextFullPreview;
  const existingContextShortText =
    cachedContextShort ||
    existingContextShortRecord?.value?.text ||
    '';
  const normalizedContextShortText = normalizeShortContext(existingContextShortText, {
    url: location.href,
    mode: 'SHORT'
  });
  const contextSignature = buildContextStateSignature(contextCacheSignature, settings);
  originalSnapshot = nodesWithPath.map(({ path, original, originalHash }) => ({
    path,
    original,
    originalHash
  }));
  activeTranslationEntries = [];
  debugEntries = [];
  debugState = null;
  primeContextState(contextState.full, contextSignature, existingContextFullText);
  primeContextState(contextState.short, contextSignature, normalizedContextShortText);
  latestContextSummary = contextState.full.text || '';
  latestShortContextSummary = contextState.short.text || '';
  shortContextPromise = null;
  await resetTranslationDebugInfo(location.href);

  const textStats = calculateTextLengthStats(nodesWithPath);
  const maxBlockLength = normalizeBlockLength(settings.blockLengthLimit, textStats.averageNodeLength);
  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const blocks = normalizeBlocksByLength(blockGroups, maxBlockLength);
  // Stable block key prevents duplicate jobs when the same block is rescanned.
  const getBlockKey = (block) => {
    const blockElement = block?.[0]?.blockElement;
    const existing = blockElement?.getAttribute?.(BLOCK_KEY_ATTR);
    if (existing) return existing;
    const anchorPath = blockElement ? JSON.stringify(getNodePath(blockElement)) : 'no-anchor';
    const signature = block
      .map(({ path, original, originalHash }) => {
        const hashValue = getOriginalHash(original, originalHash);
        return `${JSON.stringify(path)}::${original}::${hashValue ?? 'nohash'}`;
      })
      .join('||');
    const blockKey = `block_${computeTextHash(`${anchorPath}::${signature}`)}`;
    if (blockElement?.setAttribute) {
      blockElement.setAttribute(BLOCK_KEY_ATTR, blockKey);
    }
    return blockKey;
  };
  const blockKeys = blocks.map((block) => getBlockKey(block));
  translationProgress = { completedBlocks: 0, totalBlocks: blocks.length };
  const initialContextFullStatus = settings.contextGenerationEnabled
    ? latestContextSummary
      ? 'done'
      : 'pending'
    : 'disabled';
  const initialContextShortStatus = settings.contextGenerationEnabled
    ? latestShortContextSummary
      ? 'done'
      : 'pending'
    : 'disabled';
  await initializeDebugState(blocks, settings, {
    initialContextFull: latestContextSummary || existingContextFullText,
    initialContextFullStatus,
    initialContextShort: latestShortContextSummary || normalizedContextShortText,
    initialContextShortStatus
  }, { blockKeys });
  if (latestContextSummary) {
    await updateDebugContextFull(latestContextSummary, 'done');
  }
  if (latestShortContextSummary) {
    await updateDebugContextShort(latestShortContextSummary, 'done');
  }

  if (!blocks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return;
  }

  const uiPipelineStart = Date.now();
  let uiUniqueTextsForPrewarm = [];
  const uiBlockIndices = new Set();
  const uiSegments = [];
  const uiBlocks = [];
  const uiStats = {
    host: location.host || '',
    targetLang: settings.targetLanguage || 'ru',
    uiSegmentsTotal: 0,
    uiUnique: 0,
    tmHits: 0,
    tmMisses: 0,
    uiModelCalls: 0,
    uiProofreadSkipped: 0,
    uiTmSize: 0,
    uiTmEvictions: 0
  };
  blocks.forEach((block, index) => {
    const blockElement = block?.[0]?.blockElement;
    const blockTexts = block.map(({ original }) => original);
    if (!isUiBlock(blockElement, blockTexts)) return;
    uiBlockIndices.add(index);
    uiBlocks.push({ block, index, blockElement });
    uiStats.uiSegmentsTotal += block.length;
    uiStats.uiProofreadSkipped += 1;
    updateDebugEntry(index + 1, {
      uiMode: true,
      proofreadApplied: false,
      proofreadStatus: 'disabled'
    });
    block.forEach((segment, segmentIndex) => {
      uiSegments.push({
        blockIndex: index,
        segmentIndex,
        node: segment.node,
        path: segment.path,
        original: segment.original,
        originalHash: segment.originalHash
      });
    });
  });

  if (uiSegments.length) {
    try {
      const uiMemory = globalThis.ntUiTranslationMemory;
      const uiPreparedTexts = uiSegments.map((segment) => prepareTextForTranslation(segment.original));
      const uiUniqueTexts = [];
      const uiUniqueIndexMap = new Map();
      uiPreparedTexts.forEach((text, index) => {
        const normalizedKey = normalizeUiText(text);
        if (!normalizedKey) return;
        if (!uiUniqueIndexMap.has(normalizedKey)) {
          uiUniqueIndexMap.set(normalizedKey, uiUniqueTexts.length);
          uiUniqueTexts.push(text);
        }
        uiSegments[index].uniqueIndex = uiUniqueIndexMap.get(normalizedKey);
      });
      uiStats.uiUnique = uiUniqueTexts.length;
      uiUniqueTextsForPrewarm = uiUniqueTexts.slice();
      const tmResult = uiMemory
        ? await uiMemory.bulkGet(uiUniqueTexts, uiStats.targetLang, uiStats.host)
        : { translations: Array(uiUniqueTexts.length).fill(null), hits: 0, misses: uiUniqueTexts.length, size: 0, evictions: 0 };
      uiStats.tmHits = tmResult.hits || 0;
      uiStats.tmMisses = tmResult.misses || 0;
      uiStats.uiTmSize = tmResult.size || 0;
      uiStats.uiTmEvictions = tmResult.evictions || 0;

      const translationsByUnique = Array.isArray(tmResult.translations)
        ? [...tmResult.translations]
        : Array(uiUniqueTexts.length).fill(null);
      const missingTexts = [];
      const missingIndices = [];
      translationsByUnique.forEach((translation, index) => {
        if (!translation) {
          missingIndices.push(index);
          missingTexts.push(uiUniqueTexts[index]);
        }
      });

      if (missingTexts.length) {
        const uiBatches = splitTextsByTokenEstimate(
          missingTexts,
          '',
          TRANSLATION_MAX_TOKENS_PER_REQUEST
        );
        uiStats.uiModelCalls = uiBatches.length;
        const uiRequestMeta = buildRequestMeta(
          {
            stage: 'translate',
            purpose: 'ui',
            triggerSource: translationTriggerSource,
            url: location.href,
            blockKey: uiBlocks[0]?.blockElement?.getAttribute?.(BLOCK_KEY_ATTR) || 'ui-batch'
          },
          {
            contextText: '',
            contextMode: 'NONE'
          }
        );
        uiRequestMeta.flags = { ...(uiRequestMeta.flags || {}), uiMode: true };
        const uiContextMeta = {
          contextText: '',
          contextMode: 'NONE',
          contextFullText: '',
          contextShortText: '',
          baseAnswer: '',
          baseAnswerIncluded: false,
          baseAnswerPreview: '',
          tag: CALL_TAGS.TRANSLATE_UI
        };
        const uiResult = await translate(
          missingTexts,
          uiStats.targetLang,
          uiContextMeta,
          false,
          null,
          uiRequestMeta,
          { skipSummaries: true }
        );
        if (uiResult?.success && Array.isArray(uiResult.translations)) {
          uiResult.translations.forEach((translation, idx) => {
            const targetIndex = missingIndices[idx];
            if (targetIndex == null) return;
            translationsByUnique[targetIndex] = translation;
          });
          if (uiMemory) {
            await uiMemory.bulkSet(missingTexts, uiResult.translations, uiStats.targetLang, uiStats.host);
            const tmStats = uiMemory.getStats?.();
            if (tmStats) {
              uiStats.uiTmSize = tmStats.size ?? uiStats.uiTmSize;
              uiStats.uiTmEvictions = tmStats.evictions ?? uiStats.uiTmEvictions;
            }
          }
        }
      }

      const uiBlockTranslations = new Map();
      uiSegments.forEach((segment) => {
        const block = blocks[segment.blockIndex];
        if (!block) return;
        if (!uiBlockTranslations.has(segment.blockIndex)) {
          uiBlockTranslations.set(segment.blockIndex, new Array(block.length).fill(null));
        }
        const translations = uiBlockTranslations.get(segment.blockIndex);
        const uniqueIndex = segment.uniqueIndex;
        const translated = uniqueIndex != null ? translationsByUnique[uniqueIndex] : null;
        const resolvedTranslation = translated || segment.original;
        let formatted = applyOriginalFormatting(segment.original, resolvedTranslation);
        if (segment.node && shouldApplyTranslation(segment.node, segment.original, segment.originalHash)) {
          if (translationVisible) {
            segment.node.nodeValue = formatted;
          }
          updateActiveEntry(segment.path, segment.original, formatted, segment.originalHash);
        }
        translations[segment.segmentIndex] = formatted;
      });

      uiBlockTranslations.forEach((translations, blockIndex) => {
        const block = blocks[blockIndex];
        if (!block) return;
        const translatedSegments = block.map((_segment, index) => translations[index] || block[index].original);
        const blockTranslations = translatedSegments.map((text, index) => {
          const segment = block[index];
          if (segment.node && !shouldApplyTranslation(segment.node, segment.original, segment.originalHash)) {
            return segment.node.nodeValue;
          }
          return text;
        });
        markBlockProcessed(block?.[0]?.blockElement, 'translate');
        translationProgress.completedBlocks += 1;
        updateDebugEntry(blockIndex + 1, {
          translated: formatBlockText(blockTranslations),
          translatedSegments,
          translationStatus: 'done',
          translationCompletedAt: Date.now(),
          doneSegments: translatedSegments.length,
          totalSegments: translatedSegments.length,
          translationRaw: '',
          translationRawRefId: '',
          translationRawTruncated: false,
          translationDebug: [],
          proofread: [],
          proofreadComparisons: [],
          proofreadExecuted: false,
          proofreadStatus: 'disabled',
          proofreadCompletedAt: Date.now()
        });
      });

      if (uiStats.uiProofreadSkipped > 0) {
        globalThis.ntPageJsonLog?.({
          kind: 'ui_proofread_skipped_count',
          ts: Date.now(),
          count: uiStats.uiProofreadSkipped
        });
      }
    } catch (error) {
      uiBlocks.forEach(({ index }) => {
        updateDebugEntry(index + 1, {
          uiMode: false,
          proofreadApplied: settings.proofreadEnabled,
          proofreadStatus: settings.proofreadEnabled ? 'pending' : 'disabled'
        });
      });
      uiBlockIndices.clear();
      uiBlocks.length = 0;
      uiSegments.length = 0;
      globalThis.ntPageJsonLog?.({
        kind: 'ui_pipeline.error',
        ts: Date.now(),
        error: error?.message || String(error)
      });
    }
  }

  const uiElapsedMs = Date.now() - uiPipelineStart;
  if (uiStats.uiSegmentsTotal > 0) {
    globalThis.ntPageJsonLog?.({
      kind: 'ui_pipeline.summary',
      ts: Date.now(),
      fields: {
        host: uiStats.host,
        targetLang: uiStats.targetLang,
        uiSegmentsTotal: uiStats.uiSegmentsTotal,
        uiUnique: uiStats.uiUnique,
        tmHits: uiStats.tmHits,
        tmMisses: uiStats.tmMisses,
        ui_tm_hit: uiStats.tmHits,
        ui_tm_miss: uiStats.tmMisses,
        ui_tm_size: uiStats.uiTmSize,
        ui_tm_evictions: uiStats.uiTmEvictions,
        uiModelCalls: uiStats.uiModelCalls,
        uiProofreadSkipped: uiStats.uiProofreadSkipped,
        uiTmSize: uiStats.uiTmSize,
        uiTmEvictions: uiStats.uiTmEvictions,
        elapsedMs: uiElapsedMs
      }
    });
  }

  const estimateTranslationCallsForBlocks = (candidateBlocks) => {
    if (!Array.isArray(candidateBlocks) || !candidateBlocks.length) return 0;
    return candidateBlocks.reduce((total, block) => {
      const texts = block.map(({ original }) => prepareTextForTranslation(original));
      if (!texts.length) return total;
      const batches = splitTextsByTokenEstimate(
        texts,
        latestContextSummary || '',
        TRANSLATION_MAX_TOKENS_PER_REQUEST
      );
      return total + Math.max(1, batches.length);
    }, 0);
  };

  const nonUiBlocks = blocks.filter((_block, index) => !uiBlockIndices.has(index));
  const translateCallsEstimatedBefore = estimateTranslationCallsForBlocks(nonUiBlocks);
  const dedupStartTime = Date.now();
  const dedupModule = globalThis.ntSegmentDedup;
  const dedupPlan = dedupModule?.buildSegmentDedupPlan
    ? dedupModule.buildSegmentDedupPlan({ blocks, uiBlockIndices })
    : null;
  const dedupStats = dedupPlan?.stats || { totalSegments: 0, uniqueSegments: 0, dedupedSegments: 0 };
  const dedupEntries = dedupPlan?.entries ? Array.from(dedupPlan.entries.values()) : [];
  const dedupEntriesForPrewarm = dedupEntries.slice();
  const dedupTranslationsByKey = new Map();
  const prefilledTranslationsByBlock = blocks.map((block) => new Array(block.length).fill(null));
  const dedupBatchLogState = { lastTs: 0, count: 0 };
  const logDedupBatch = (fields) => {
    const now = Date.now();
    if (dedupBatchLogState.count < 10 || now - dedupBatchLogState.lastTs > 2000) {
      dedupBatchLogState.lastTs = now;
      dedupBatchLogState.count += 1;
      globalThis.ntPageJsonLog?.({
        kind: 'dedup.batch',
        ts: now,
        fields
      });
    }
  };
  const mainTranslateBaseline = translationCallCount;

  if (dedupEntries.length) {
    const dedupEligibleEntries = dedupEntries.filter((entry) => entry.dedupEligible && entry.count >= 2);
    const dedupTexts = dedupEligibleEntries.map((entry) => entry.sourceTextOriginal);
    const dedupKeys = dedupEligibleEntries.map((entry) => entry.key);
    const keepPunctuationTokens = Boolean(settings.proofreadEnabled);
    const translationMemory = globalThis.ntTranslationMemory;
    let missingEntries = dedupEligibleEntries;
    if (translationMemory?.bulkGetByKey && dedupKeys.length) {
      try {
        const tmResult = await translationMemory.bulkGetByKey(
          dedupKeys,
          settings.targetLanguage || 'ru',
          location.host || ''
        );
        const tmTranslations = Array.isArray(tmResult?.translations) ? tmResult.translations : [];
        missingEntries = dedupEligibleEntries.filter((_entry, index) => !tmTranslations[index]);
        tmTranslations.forEach((translation, index) => {
          if (!translation) return;
          const key = dedupKeys[index];
          if (!key) return;
          dedupTranslationsByKey.set(key, translation);
        });
      } catch (error) {
        missingEntries = dedupEligibleEntries;
      }
    }
    const missingTexts = missingEntries.map((entry) => entry.sourceTextOriginal);
    const missingKeys = missingEntries.map((entry) => entry.key);
    if (missingTexts.length) {
      const batches = splitTextsByTokenEstimate(
        missingTexts,
        '',
        TRANSLATION_MAX_TOKENS_PER_REQUEST
      );
      let offset = 0;
      for (const batch of batches) {
        const batchKeys = missingKeys.slice(offset, offset + batch.length);
        offset += batch.length;
        logDedupBatch({
          batchSize: batch.length,
          expectedCount: batch.length,
          usedContextMode: 'SHORT'
        });
        const requestMeta = buildRequestMeta(
          {
            stage: 'translate',
            purpose: 'dedup',
            triggerSource: translationTriggerSource,
            url: location.href,
            blockKey: batchKeys[0] || 'dedup-batch'
          },
          {
            contextText: '',
            contextMode: 'SHORT'
          }
        );
        requestMeta.batchBlockKeys = batchKeys;
        requestMeta.batchBlockCount = batchKeys.length;
        traceRequestInitiator(requestMeta);
        const result = await translate(
          batch,
          settings.targetLanguage || 'ru',
          {
            contextText: '',
            contextMode: 'SHORT',
            contextFullText: '',
            contextShortText: '',
            baseAnswer: '',
            baseAnswerIncluded: false,
            baseAnswerPreview: '',
            tag: CALL_TAGS.TRANSLATE_DEDUP_SHORT
          },
          keepPunctuationTokens,
          null,
          requestMeta,
          { skipSummaries: true }
        );
        if (!result?.success || !Array.isArray(result.translations)) {
          throw new Error(result?.error || 'Не удалось выполнить дедуп перевод.');
        }
        if (result.translations.length !== batch.length) {
          throw new Error(
            `Dedup translation length mismatch: expected ${batch.length}, got ${result.translations.length}`
          );
        }
        result.translations.forEach((translation, index) => {
          const key = batchKeys[index];
          if (!key) return;
          dedupTranslationsByKey.set(key, translation);
        });
      }
    }

    if (translationMemory?.bulkSetByKey && dedupTranslationsByKey.size) {
      const keys = Array.from(dedupTranslationsByKey.keys());
      const values = keys.map((key) => dedupTranslationsByKey.get(key));
      try {
        await translationMemory.bulkSetByKey(keys, values, settings.targetLanguage || 'ru', location.host || '');
      } catch (error) {
        // ignore TM write failures
      }
    }

    dedupEntries.forEach((entry) => {
      if (!entry.dedupEligible) return;
      const translated = dedupTranslationsByKey.get(entry.key);
      if (!translated) return;
      entry.occurrences.forEach(({ blockIndex, segmentIndex }) => {
        const block = blocks[blockIndex];
        const segment = block?.[segmentIndex];
        if (!segment) return;
        const { node, path, original, originalHash } = segment;
        const resolvedTranslation = translated || original;
        let withOriginalFormatting = applyOriginalFormatting(original, resolvedTranslation);
        if (keepPunctuationTokens) {
          withOriginalFormatting = restorePunctuationTokens(withOriginalFormatting);
        }
        prefilledTranslationsByBlock[blockIndex][segmentIndex] = withOriginalFormatting;
        if (node && shouldApplyTranslation(node, original, originalHash)) {
          if (translationVisible) {
            node.nodeValue = withOriginalFormatting;
          }
          updateActiveEntry(path, original, withOriginalFormatting, originalHash);
        }
      });
    });

    prefilledTranslationsByBlock.forEach((prefilled, blockIndex) => {
      const doneSegments = prefilled.filter((value) => value != null).length;
      if (doneSegments > 0) {
        updateDebugEntry(blockIndex + 1, {
          doneSegments,
          totalSegments: prefilled.length
        });
      }
    });
  }

  let dedupSummaryLogged = false;
  const logDedupSummary = () => {
    if (dedupSummaryLogged) return;
    dedupSummaryLogged = true;
    const totalSegments = dedupStats.totalSegments || 0;
    const uniqueSegments = dedupStats.uniqueSegments || 0;
    const dedupedSegments = dedupStats.dedupedSegments || 0;
    const dedupSavingsRatio = totalSegments
      ? Math.max(0, (totalSegments - uniqueSegments) / totalSegments)
      : 0;
    const translateCallsActualAfter = Math.max(0, translationCallCount - mainTranslateBaseline);
    globalThis.ntPageJsonLog?.({
      kind: 'dedup.summary',
      ts: Date.now(),
      fields: {
        host: location.host || '',
        totalSegments,
        uniqueSegments,
        dedupedSegments,
        dedupSavingsRatio,
        translateCallsEstimatedBefore,
        translateCallsActualAfter,
        elapsedMs: Date.now() - dedupStartTime
      }
    });
  };

  const scheduleBatchPrewarm = async () => {
    const batchMode = settings.batchTurboMode || 'off';
    if (batchMode === 'off') return;
    const host = location.host || '';
    const targetLang = settings.targetLanguage || 'ru';
    const maxRequests = 5000;
    const items = [];
    const seenKeys = new Set();
    const normalizeUiKey =
      typeof globalThis.ntNormalizeUiKey === 'function'
        ? globalThis.ntNormalizeUiKey
        : (text) => String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (uiUniqueTextsForPrewarm.length) {
      const uiMemory = globalThis.ntUiTranslationMemory;
      let uiTranslations = [];
      if (uiMemory?.bulkGet) {
        try {
          const tmResult = await uiMemory.bulkGet(uiUniqueTextsForPrewarm, targetLang, host);
          uiTranslations = Array.isArray(tmResult?.translations) ? tmResult.translations : [];
        } catch (error) {
          uiTranslations = [];
        }
      }
      uiUniqueTextsForPrewarm.forEach((text, index) => {
        if (uiTranslations[index]) return;
        const segmentKey = normalizeUiKey(text);
        if (!segmentKey) return;
        const dedupKey = `${segmentKey}::ui`;
        if (seenKeys.has(dedupKey)) return;
        seenKeys.add(dedupKey);
        items.push({ text, segmentKey, source: 'ui' });
      });
    }

    if (batchMode === 'prewarm_dedup_all' && dedupEntriesForPrewarm.length) {
      const translationMemory = globalThis.ntTranslationMemory;
      const dedupCandidates = dedupEntriesForPrewarm
        .filter((entry) => entry?.dedupEligible)
        .filter((entry) => entry.count >= 3 || String(entry?.sourceTextOriginal || '').length <= 60)
        .sort((a, b) => (b.count || 0) - (a.count || 0));
      const keys = dedupCandidates.map((entry) => entry.key);
      let cachedTranslations = [];
      if (translationMemory?.bulkGetByKey) {
        try {
          const tmResult = await translationMemory.bulkGetByKey(keys, targetLang, host);
          cachedTranslations = Array.isArray(tmResult?.translations) ? tmResult.translations : [];
        } catch (error) {
          cachedTranslations = [];
        }
      }
      dedupCandidates.forEach((entry, index) => {
        if (cachedTranslations[index]) return;
        if (!entry?.key || !entry?.sourceTextOriginal) return;
        const dedupKey = `${entry.key}::dedup`;
        if (seenKeys.has(dedupKey)) return;
        seenKeys.add(dedupKey);
        items.push({
          text: entry.sourceTextOriginal,
          segmentKey: entry.key,
          source: 'dedup'
        });
      });
    }

    if (!items.length) {
      globalThis.ntPageJsonLog?.({
        kind: 'batch.prewarm.skipped',
        ts: Date.now(),
        fields: { reason: 'no_candidates' }
      });
      if (currentTabIdForProgress) {
        void sendBackgroundMessageSafe({
          type: 'NT_PROGRESS_PULSE',
          tabId: currentTabIdForProgress,
          channel: 'prewarm',
          reason: 'no_candidates',
          queued: 0,
          inFlight: 0,
          total: 0
        });
      }
      return;
    }
    const limitedItems = items.slice(0, maxRequests);
    if (currentTabIdForProgress) {
      void sendBackgroundMessageSafe({
        type: 'NT_PROGRESS_PULSE',
        tabId: currentTabIdForProgress,
        channel: 'prewarm',
        reason: 'start_prewarm',
        total: limitedItems.length,
        queued: limitedItems.length,
        inFlight: 0
      });
    }
    await sendRpcRequest(
      {
        type: 'START_BATCH_PREWARM',
        host,
        targetLang,
        items: limitedItems,
        mode: batchMode
      },
      'START_BATCH_PREWARM failed',
      5000
    );
  };

  void scheduleBatchPrewarm();
  cancelRequested = false;
  translationError = null;
  reportProgress('Перевод запущен', 0, blocks.length, 0, { reason: 'start' });

  const pageText = settings.contextGenerationEnabled ? buildPageText(nodesWithPath) : '';

  const buildContextRequestMeta = (text, contextMode, overrides = {}) => {
    const baseMeta = {
      stage: 'context',
      purpose: overrides.purpose || (contextMode === 'SHORT' ? 'short' : 'main'),
      triggerSource: overrides.triggerSource || translationTriggerSource,
      url: location.href,
      contextCacheKey
    };
    return buildRequestMeta(baseMeta, {
      contextText: text,
      contextMode
    });
  };

  const buildContextBundle = async () => {
    if (!settings.contextGenerationEnabled) return;
    if (!pageText) {
      await updateDebugContextShort(latestShortContextSummary, 'done');
      await updateDebugContextFull(latestContextSummary, 'done');
      return;
    }

    if (!latestShortContextSummary) {
      // Guard: reuse ready context for the same signature instead of recomputing on each debug refresh.
      const shortResult = getOrBuildContext({
        state: contextState.short,
        signature: contextSignature,
        build: () =>
          requestShortContext(
            pageText,
            settings.targetLanguage || 'ru',
            buildContextRequestMeta(pageText, 'SHORT')
          )
      });
      if (shortResult.started || contextState.short.status === 'building') {
        await updateDebugContextShortStatus('in_progress');
        reportProgress('Генерация SHORT контекста', 0, blocks.length, 0);
      }
      if (shortResult.promise) {
        shortContextPromise = shortResult.promise
          .then(async (shortContext) => {
            latestShortContextSummary = shortContext;
            if (latestShortContextSummary && contextCacheKey) {
              const currentEntry = (await getContextCacheEntry(contextCacheKey)) || {};
              await setContextCacheEntry(contextCacheKey, {
                ...currentEntry,
                contextShort: latestShortContextSummary,
                contextFull: currentEntry.contextFull || currentEntry.context || '',
                signature: contextCacheSignature,
                updatedAt: Date.now()
              });
            }
            await updateDebugContextShort(latestShortContextSummary, 'done');
          })
          .catch(async (error) => {
            console.warn('Short context generation failed, continuing without it.', error);
            await updateDebugContextShort(latestShortContextSummary, 'failed');
          });
      }
    }

    if (!latestContextSummary) {
      const fullResult = getOrBuildContext({
        state: contextState.full,
        signature: contextSignature,
        build: () =>
          requestTranslationContext(
            pageText,
            settings.targetLanguage || 'ru',
            buildContextRequestMeta(pageText, 'FULL')
          )
      });
      if (fullResult.started || contextState.full.status === 'building') {
        await updateDebugContextFullStatus('in_progress');
        reportProgress('Генерация FULL контекста', 0, blocks.length, 0);
      }
      if (fullResult.promise) {
        try {
          latestContextSummary = await fullResult.promise;
          if (latestContextSummary && contextCacheKey) {
            const currentEntry = (await getContextCacheEntry(contextCacheKey)) || {};
            await setContextCacheEntry(contextCacheKey, {
              ...currentEntry,
              contextFull: latestContextSummary,
              contextShort: currentEntry.contextShort || '',
              signature: contextCacheSignature,
              updatedAt: Date.now()
            });
          }
          await updateDebugContextFull(latestContextSummary, 'done');
        } catch (error) {
          console.warn('Context generation failed, continuing without it.', error);
          await updateDebugContextFull(latestContextSummary, 'failed');
        }
      }
    }
  };

  if (
    settings.contextGenerationEnabled &&
    planHints?.suggestedContextMode !== 'NONE' &&
    (!latestShortContextSummary || !latestContextSummary)
  ) {
    await buildContextBundle();
  }

  const buildBaseAnswerPreview = (text) => {
    if (!text) return '';
    const trimmed = text.trim().replace(/\s+/g, ' ');
    if (!trimmed) return '';
    return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
  };

  const findFirstFullCallId = (calls) => {
    const list = Array.isArray(calls) ? calls : [];
    const match = list.find((call) => call?.contextMode === 'FULL');
    return match?.id ?? null;
  };

  const ensureShortContextReadyForTrigger = async (requestMeta) => {
    if (!requestMeta) return;
    if (requestMeta.triggerSource !== 'retry' && requestMeta.triggerSource !== 'validate') return;
    if (!settings.contextGenerationEnabled) return;
    if (latestShortContextSummary) return;
    if (shortContextPromise) {
      await shortContextPromise;
      latestShortContextSummary = contextState.short.text || '';
      if (latestShortContextSummary) return;
    }
    if (!pageText) return;
    const contextRequestMeta = buildContextRequestMeta(pageText, 'SHORT', {
      purpose: requestMeta.purpose || 'retry',
      triggerSource: requestMeta.triggerSource || 'retry'
    });
    const shortResult = getOrBuildContext({
      state: contextState.short,
      signature: contextSignature,
      build: () => requestShortContext(pageText, settings.targetLanguage || 'ru', contextRequestMeta)
    });
    if (shortResult.started || contextState.short.status === 'building') {
      await updateDebugContextShortStatus('in_progress');
    }
    if (!shortResult.promise) return;
    shortContextPromise = shortResult.promise
      .then(async (shortContext) => {
        latestShortContextSummary = shortContext;
        if (latestShortContextSummary && contextCacheKey) {
          const currentEntry = (await getContextCacheEntry(contextCacheKey)) || {};
          await setContextCacheEntry(contextCacheKey, {
            ...currentEntry,
            contextShort: latestShortContextSummary,
            contextFull: currentEntry.contextFull || currentEntry.context || '',
            signature: contextCacheSignature,
            updatedAt: Date.now()
          });
        }
        await updateDebugContextShort(latestShortContextSummary, 'done');
        return latestShortContextSummary;
      })
      .catch(async (error) => {
        console.warn('Short context generation failed, continuing without it.', error);
        await updateDebugContextShort(latestShortContextSummary, 'failed');
        return latestShortContextSummary;
      });
    await shortContextPromise;
  };

  const selectContextForBlock = async (entry, kind, options = {}) => {
    if (!entry) {
      return {
        contextMode: 'FULL',
        contextText: '',
        contextFullText: latestContextSummary || '',
        contextShortText: latestShortContextSummary || '',
        baseAnswer: '',
        baseAnswerIncluded: false,
        baseAnswerPreview: '',
        tag: kind === 'proofread' ? CALL_TAGS.PROOFREAD_BASE_FULL : CALL_TAGS.TRANSLATE_BASE_FULL,
        attemptIndex: 0
      };
    }
    const attemptKey = kind === 'proofread' ? 'proofreadAttemptCount' : 'translateAttemptCount';
    const successKey = kind === 'proofread' ? 'proofreadFullSuccess' : 'translationFullSuccess';
    const baseAnswerKey = kind === 'proofread' ? 'proofreadBaseFullAnswer' : 'translationBaseFullAnswer';
    const attemptCount = Number.isFinite(entry[attemptKey]) ? entry[attemptKey] : 0;
    const baseAnswer = typeof entry[baseAnswerKey] === 'string' ? entry[baseAnswerKey] : '';
    const fullSuccess = Boolean(entry[successKey]) && Boolean(baseAnswer);
    let contextMode = 'FULL';
    let tag = kind === 'proofread' ? CALL_TAGS.PROOFREAD_BASE_FULL : CALL_TAGS.TRANSLATE_BASE_FULL;
    if (options.forceShort) {
      contextMode = 'SHORT';
      tag = kind === 'proofread' ? CALL_TAGS.PROOFREAD_OVERFLOW_FALLBACK : CALL_TAGS.TRANSLATE_OVERFLOW_FALLBACK;
    } else if (!fullSuccess) {
      contextMode = 'FULL';
      if (attemptCount > 0) {
        tag = kind === 'proofread' ? CALL_TAGS.PROOFREAD_RETRY_FULL : CALL_TAGS.TRANSLATE_RETRY_FULL;
      }
    } else {
      contextMode = 'SHORT';
      if (kind === 'proofread') {
        tag = options.followupTag || CALL_TAGS.PROOFREAD_REWRITE_SHORT;
      } else {
        tag = CALL_TAGS.TRANSLATE_FOLLOWUP_SHORT;
      }
    }
    if (!options.forceShort) {
      if (planHints?.suggestedContextMode === 'SHORT' && contextMode === 'FULL') {
        contextMode = 'SHORT';
        if (kind === 'proofread') {
          tag = options.followupTag || CALL_TAGS.PROOFREAD_REWRITE_SHORT;
        } else {
          tag = CALL_TAGS.TRANSLATE_FOLLOWUP_SHORT;
        }
      }
      if (planHints?.suggestedContextMode === 'NONE') {
        contextMode = 'NONE';
      }
    }
    if (contextMode === 'SHORT' && shortContextPromise) {
      await shortContextPromise;
    }
    const contextText =
      contextMode === 'SHORT'
        ? latestShortContextSummary
        : contextMode === 'NONE'
          ? ''
          : latestContextSummary;
    const baseAnswerIncluded =
      contextMode === 'SHORT' && Boolean(baseAnswer) && (!options.forceShort || fullSuccess);
    const baseAnswerPreview = baseAnswerIncluded ? buildBaseAnswerPreview(baseAnswer) : '';
    updateDebugEntry(entry.index, {
      [attemptKey]: attemptCount + 1
    });
    return {
      contextMode,
      contextText: typeof contextText === 'string' ? contextText : '',
      contextFullText: latestContextSummary || '',
      contextShortText: latestShortContextSummary || '',
      baseAnswer,
      baseAnswerIncluded,
      baseAnswerPreview,
      tag,
      attemptIndex: attemptCount
    };
  };

  const peekContextForBlock = async (entry, kind, options = {}) => {
    if (!entry) {
      return {
        contextMode: 'FULL',
        contextText: '',
        contextFullText: latestContextSummary || '',
        contextShortText: latestShortContextSummary || '',
        baseAnswer: '',
        baseAnswerIncluded: false,
        baseAnswerPreview: '',
        tag: kind === 'proofread' ? CALL_TAGS.PROOFREAD_BASE_FULL : CALL_TAGS.TRANSLATE_BASE_FULL,
        attemptIndex: 0
      };
    }
    const attemptKey = kind === 'proofread' ? 'proofreadAttemptCount' : 'translateAttemptCount';
    const successKey = kind === 'proofread' ? 'proofreadFullSuccess' : 'translationFullSuccess';
    const baseAnswerKey = kind === 'proofread' ? 'proofreadBaseFullAnswer' : 'translationBaseFullAnswer';
    const attemptCount = Number.isFinite(entry[attemptKey]) ? entry[attemptKey] : 0;
    const baseAnswer = typeof entry[baseAnswerKey] === 'string' ? entry[baseAnswerKey] : '';
    const fullSuccess = Boolean(entry[successKey]) && Boolean(baseAnswer);
    let contextMode = 'FULL';
    let tag = kind === 'proofread' ? CALL_TAGS.PROOFREAD_BASE_FULL : CALL_TAGS.TRANSLATE_BASE_FULL;
    if (options.forceShort) {
      contextMode = 'SHORT';
      tag = kind === 'proofread' ? CALL_TAGS.PROOFREAD_OVERFLOW_FALLBACK : CALL_TAGS.TRANSLATE_OVERFLOW_FALLBACK;
    } else if (!fullSuccess) {
      contextMode = 'FULL';
      if (attemptCount > 0) {
        tag = kind === 'proofread' ? CALL_TAGS.PROOFREAD_RETRY_FULL : CALL_TAGS.TRANSLATE_RETRY_FULL;
      }
    } else {
      contextMode = 'SHORT';
      if (kind === 'proofread') {
        tag = options.followupTag || CALL_TAGS.PROOFREAD_REWRITE_SHORT;
      } else {
        tag = CALL_TAGS.TRANSLATE_FOLLOWUP_SHORT;
      }
    }
    if (contextMode === 'SHORT' && shortContextPromise) {
      await shortContextPromise;
    }
    const contextText = contextMode === 'SHORT' ? latestShortContextSummary : latestContextSummary;
    const baseAnswerIncluded = contextMode === 'SHORT' && Boolean(baseAnswer) && (!options.forceShort || fullSuccess);
    const baseAnswerPreview = baseAnswerIncluded ? buildBaseAnswerPreview(baseAnswer) : '';
    return {
      contextMode,
      contextText: typeof contextText === 'string' ? contextText : '',
      contextFullText: latestContextSummary || '',
      contextShortText: latestShortContextSummary || '',
      baseAnswer,
      baseAnswerIncluded,
      baseAnswerPreview,
      tag,
      attemptIndex: attemptCount
    };
  };

  const buildContextSignature = (contextMeta) => {
    const contextText = contextMeta?.contextText || '';
    const baseAnswerText = contextMeta?.baseAnswerIncluded ? contextMeta?.baseAnswer || '' : '';
    return [
      contextMeta?.contextMode || '',
      computeTextHash(contextText),
      computeTextHash(baseAnswerText),
      contextMeta?.baseAnswerIncluded ? '1' : '0'
    ].join('|');
  };

  const getPendingSegmentIndices = (item) => {
    const plan = item?.plan;
    if (Array.isArray(plan?.pendingSegmentIndices)) {
      return plan.pendingSegmentIndices;
    }
    return item?.block ? item.block.map((_segment, index) => index) : [];
  };

  const getPreparedTextsForItem = (item) => {
    const pendingIndices = getPendingSegmentIndices(item);
    if (!pendingIndices.length) return [];
    return pendingIndices.map((segmentIndex) =>
      prepareTextForTranslation(item.block[segmentIndex]?.original || '')
    );
  };

  const buildTranslationMicroBatch = async ({ seedItem, seedContext, seedPreparedTexts }) => {
    const batchItems = [seedItem];
    if (seedItem.retryCount > 0 || seedItem.fallbackMode !== 'normal') {
      return { items: batchItems, primaryContext: seedContext };
    }
    const seedSignature = buildContextSignature(seedContext);
    const baseAnswer = seedContext.baseAnswerIncluded ? seedContext.baseAnswer || '' : '';
    const contextEstimateText = [seedContext.contextText, baseAnswer].filter(Boolean).join('\n');
    let currentTokens = estimateTokensForRole('translation', {
      texts: seedPreparedTexts,
      context: contextEstimateText
    });
    const targetTokens = translationBatchTargetTokens;
    const maxTokens = Math.min(
      TRANSLATION_MAX_TOKENS_PER_REQUEST,
      Math.max(targetTokens + 300, Math.round(targetTokens * 1.6))
    );
    if (currentTokens >= maxTokens) {
      return { items: batchItems, primaryContext: seedContext, contextSignature: seedSignature };
    }
    for (let idx = 0; idx < translationQueue.length; idx += 1) {
      const candidate = translationQueue[idx];
      if (!candidate) continue;
      if (candidate.availableAt && candidate.availableAt > Date.now()) continue;
      if (candidate.retryCount > 0 || candidate.fallbackMode !== 'normal') continue;
      const candidateEntry = debugEntries.find((item) => item.index === candidate.index + 1);
      const candidateContext = await peekContextForBlock(candidateEntry, 'translation');
      if (buildContextSignature(candidateContext) !== seedSignature) continue;
      const candidatePreparedTexts = getPreparedTextsForItem(candidate);
      if (!candidatePreparedTexts.length) continue;
      const candidateTokens = estimateTokensForRole('translation', {
        texts: candidatePreparedTexts,
        context: ''
      });
      if (currentTokens + candidateTokens > maxTokens) continue;
      batchItems.push(candidate);
      translationQueue.splice(idx, 1);
      idx -= 1;
      currentTokens += candidateTokens;
      if (targetTokens && currentTokens >= targetTokens) break;
    }
    return { items: batchItems, primaryContext: seedContext, contextSignature: seedSignature };
  };

  const isSimpleDedupBlock = (block) => {
    if (!Array.isArray(block) || !block.length) return false;
    const lengths = block.map(({ original }) => String(original || '').length);
    const total = lengths.reduce((sum, value) => sum + value, 0);
    const avgLen = total / lengths.length;
    const maxLen = Math.max(...lengths);
    return maxLen <= 60 && avgLen <= 40;
  };

  const blockTranslationPlans = blocks.map((block, index) => {
    const prefilled = prefilledTranslationsByBlock?.[index] || new Array(block.length).fill(null);
    const pendingSegmentIndices = [];
    prefilled.forEach((value, segmentIndex) => {
      if (value == null) pendingSegmentIndices.push(segmentIndex);
    });
    const allPrefilled = pendingSegmentIndices.length === 0;
    const uiLike = allPrefilled && isSimpleDedupBlock(block);
    return {
      prefilledTranslations: prefilled,
      pendingSegmentIndices,
      allPrefilled,
      uiLike
    };
  });

  const singleBlockConcurrency = Boolean(settings.singleBlockConcurrency);
  const translationConcurrency = singleBlockConcurrency
    ? 1
    : Math.max(1, Math.min(6, suggestedConcurrency || blocks.length));
  let maxConcurrentTranslationJobs = translationConcurrency;
  let totalBlockRetries = 0;
  let activeTranslationWorkers = 0;
  let activeProofreadWorkers = 0;
  let translationQueueDone = false;
  const translationQueue = [];
  const proofreadQueue = [];
  const queuedBlockElements = new WeakSet();
  const proofreadQueueKeys = new Set();
  const inFlightBlocks = new Map();
  const finalizedBlocks = new Set();
  let inFlightWatchdogTimer = null;
  let proofreadConcurrency = singleBlockConcurrency
    ? 1
    : Math.max(1, Math.min(4, suggestedConcurrency || blocks.length));
  // Duplicate translate/proofread requests could be triggered for the same block; dedupe by jobKey.
  const jobInFlight = new Map();
  const jobCompleted = new Map();
  const cancelActiveJob = async (reason = 'cancelled') => {
    cancelRequested = true;
    translationQueue.length = 0;
    proofreadQueue.length = 0;
    proofreadQueueKeys.clear();
    translationQueueDone = true;
    stopInFlightWatchdog();
    const pending = Array.from(inFlightBlocks.values());
    for (const entry of pending) {
      await finalizeBlock({
        item: entry.item,
        stage: entry.stage,
        status: 'failed',
        reason
      });
    }
  };

  const isBlockProcessed = (blockElement, stage) => {
    if (!blockElement?.getAttribute) return false;
    const attr = stage === 'proofread' ? PROOFREAD_ATTR : TRANSLATED_ATTR;
    return blockElement.getAttribute(attr) === debugSessionId;
  };

  const markBlockProcessed = (blockElement, stage) => {
    if (!blockElement?.setAttribute) return;
    const attr = stage === 'proofread' ? PROOFREAD_ATTR : TRANSLATED_ATTR;
    blockElement.setAttribute(attr, debugSessionId);
  };

  const runJobOnce = (jobKey, execute, isValid) => {
    if (jobCompleted.has(jobKey)) {
      return Promise.resolve(jobCompleted.get(jobKey));
    }
    if (jobInFlight.has(jobKey)) {
      return jobInFlight.get(jobKey);
    }
    const promise = Promise.resolve()
      .then(() => execute())
      .then((result) => {
        if (isValid?.(result)) {
          jobCompleted.set(jobKey, result);
        }
        return result;
      })
      .finally(() => {
        jobInFlight.delete(jobKey);
      });
    jobInFlight.set(jobKey, promise);
    return promise;
  };

  const getInFlightKey = (stage, key) => `${stage}:${key || 'unknown'}`;

  const markBlockInFlight = (item, stage) => {
    if (!item?.key) return;
    const entryKey = getInFlightKey(stage, item.key);
    inFlightBlocks.set(entryKey, {
      key: item.key,
      stage,
      index: item.index,
      blockElement: item.blockElement,
      uiMode: item.uiMode,
      startedAt: Date.now(),
      item
    });
    inFlightBlockCount = inFlightBlocks.size;
  };

  const clearBlockInFlight = (item, stage) => {
    if (!item?.key) return;
    inFlightBlocks.delete(getInFlightKey(stage, item.key));
    inFlightBlockCount = inFlightBlocks.size;
  };

  const isBlockFinalized = (stage, key) => finalizedBlocks.has(getInFlightKey(stage, key));

  const finalizeBlock = async ({ item, stage, status, reason }) => {
    if (!item?.key) return;
    const entryKey = getInFlightKey(stage, item.key);
    if (finalizedBlocks.has(entryKey)) return;
    const entryIndex = item.index + 1;
    const entry = debugEntries.find((debugItem) => debugItem.index === entryIndex);
    if (stage === 'translate') {
      const current = entry?.translationStatus;
      if (current === 'done' || current === 'failed') {
        finalizedBlocks.add(entryKey);
        inFlightBlocks.delete(entryKey);
        inFlightBlockCount = inFlightBlocks.size;
        return;
      }
    }
    if (stage === 'proofread') {
      const current = entry?.proofreadStatus;
      if (current === 'done' || current === 'failed') {
        finalizedBlocks.add(entryKey);
        inFlightBlocks.delete(entryKey);
        inFlightBlockCount = inFlightBlocks.size;
        return;
      }
    }
    const now = Date.now();
    const update = {};
    if (stage === 'translate') {
      update.translationStatus = status;
      update.translationCompletedAt = now;
      if (reason) update.translationLastError = reason;
      if (status === 'failed' || status === 'skipped') {
        update.proofreadStatus = 'disabled';
      }
      traceBlockLifecycle(item.index + 1, 'translate', `status -> ${status}`, {
        blockKey: item.key,
        reason
      });
    } else if (stage === 'proofread') {
      update.proofreadStatus = status;
      update.proofreadCompletedAt = now;
      if (reason) update.proofreadLastError = reason;
      traceBlockLifecycle(item.index + 1, 'proofread', `status -> ${status}`, {
        blockKey: item.key,
        reason
      });
    }
    finalizedBlocks.add(entryKey);
    inFlightBlocks.delete(entryKey);
    inFlightBlockCount = inFlightBlocks.size;
    await updateDebugEntry(entryIndex, update);
    reportProgress('Перевод выполняется');
  };

  const startInFlightWatchdog = () => {
    if (inFlightWatchdogTimer) return;
    inFlightWatchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of inFlightBlocks.values()) {
        const timeoutMs =
          entry.stage === 'proofread'
            ? getRpcTimeoutMs('PROOFREAD_TEXT')
            : getRpcTimeoutMs('TRANSLATE_TEXT');
        const thresholdMs = timeoutMs + IN_FLIGHT_WATCHDOG_GRACE_MS;
        if (now - entry.startedAt <= thresholdMs) continue;
        globalThis.ntPageJsonLog?.({
          kind: 'block.watchdog.timeout',
          ts: now,
          stage: entry.stage,
          blockKey: entry.key,
          elapsedMs: now - entry.startedAt,
          thresholdMs
        });
        void finalizeBlock({
          item: entry.item,
          stage: entry.stage,
          status: 'failed',
          reason: 'watchdog_timeout'
        });
      }
    }, IN_FLIGHT_WATCHDOG_INTERVAL_MS);
  };

  const stopInFlightWatchdog = () => {
    if (!inFlightWatchdogTimer) return;
    clearInterval(inFlightWatchdogTimer);
    inFlightWatchdogTimer = null;
  };

  activeJobControl = { cancel: cancelActiveJob };

  const finalizePrefilledBlock = async ({ block, index, blockElement, uiMode, uiLike }) => {
    const prefilled = prefilledTranslationsByBlock?.[index] || new Array(block.length).fill(null);
    const translatedTexts = block.map((_segment, segmentIndex) => {
      const resolved = prefilled[segmentIndex];
      return resolved == null ? block[segmentIndex].original : resolved;
    });
    const blockTranslations = [];
    block.forEach(({ node, path, original, originalHash }, segmentIndex) => {
      if (!shouldApplyTranslation(node, original, originalHash)) {
        blockTranslations.push(node?.nodeValue ?? '');
        return;
      }
      const withOriginalFormatting = translatedTexts[segmentIndex] || node?.nodeValue || '';
      if (translationVisible) {
        if (node && node.nodeType === Node.TEXT_NODE) {
          node.nodeValue = withOriginalFormatting;
        }
      }
      blockTranslations.push(withOriginalFormatting);
      updateActiveEntry(path, original, withOriginalFormatting, originalHash);
    });
    markBlockProcessed(blockElement, 'translate');
    traceBlockLifecycle(index + 1, 'translate', 'applied to DOM', { visible: translationVisible, dedup: true });
    const translationRawField = await prepareRawTextField('', 'translation_raw');
    await updateDebugEntry(index + 1, {
      translated: formatBlockText(blockTranslations),
      translatedSegments: translatedTexts,
      translationStatus: 'done',
      translationCompletedAt: Date.now(),
      doneSegments: translatedTexts.length,
      totalSegments: translatedTexts.length,
      translationRaw: translationRawField.preview,
      translationRawRefId: translationRawField.refId,
      translationRawTruncated: translationRawField.truncated || translationRawField.rawTruncated,
      translationDebug: [],
      proofreadStatus: settings.proofreadEnabled && !uiMode ? 'pending' : 'disabled',
      proofreadApplied: settings.proofreadEnabled && !uiMode
    });
    traceBlockLifecycle(index + 1, 'translate', 'status -> DONE');
    translationProgress.completedBlocks += 1;
    await maybeQueueProofread({
      block,
      index,
      key: getBlockKey(block),
      blockElement,
      translatedTexts,
      originalTexts: block.map(({ original }) => original),
      uiMode,
      uiLike,
      settings
    });
  };

  const enqueueTranslationBlock = (block, index) => {
    const key = getBlockKey(block);
    const blockElement = block?.[0]?.blockElement;
    const plan = blockTranslationPlans?.[index] || {};
    if (blockElement && queuedBlockElements.has(blockElement)) {
      return false;
    }
    if (isBlockProcessed(blockElement, 'translate')) {
      return false;
    }
    if (plan.allPrefilled) {
      void finalizePrefilledBlock({
        block,
        index,
        blockElement,
        uiMode: uiBlockIndices.has(index),
        uiLike: plan.uiLike
      });
      return false;
    }
    if (blockElement) {
      queuedBlockElements.add(blockElement);
    }
    translationQueue.push({
      block,
      index,
      key,
      blockElement,
      uiMode: uiBlockIndices.has(index),
      uiLike: plan.uiLike,
      plan,
      retryCount: 0,
      availableAt: 0,
      fallbackMode: 'normal'
    });
    return true;
  };

  const enqueueProofreadTask = (task) => {
    if (!task?.key || proofreadQueueKeys.has(task.key) || isBlockProcessed(task.blockElement, 'proofread')) {
      return false;
    }
    proofreadQueueKeys.add(task.key);
    proofreadQueue.push(task);
    return true;
  };

  const isFatalBlockError = (err) => {
    const status = err?.status;
    if (status === 401 || status === 403) return true;
    const message = String(err?.message || err || '').toLowerCase();
    return (
      message.includes('invalid api key') ||
      message.includes('api key') ||
      message.includes('unauthorized') ||
      message.includes('forbidden') ||
      message.includes('401') ||
      message.includes('403')
    );
  };

  const isRateLimitOrOverload = (err) => {
    const status = err?.status;
    if (status === 429 || status === 503) return true;
    const message = String(err?.message || err || '').toLowerCase();
    return message.includes('429') || message.includes('rate') || message.includes('too many');
  };

  const isInvalidResponseShapeError = (err) => {
    const message = String(err?.message || err || '').toLowerCase();
    return message.includes('invalid response shape') || message.includes('length mismatch');
  };

  const translationWorker = async () => {
    while (true) {
      if (cancelRequested) return;
      const seedItem = translationQueue.shift();
      if (!seedItem) {
        return;
      }
      if (seedItem.availableAt && seedItem.availableAt > Date.now()) {
        translationQueue.push(seedItem);
        await delay(Math.min(seedItem.availableAt - Date.now(), 200));
        continue;
      }
      while (activeTranslationWorkers >= maxConcurrentTranslationJobs) {
        if (cancelRequested) return;
        await delay(50);
      }
      activeTranslationWorkers += 1;
      let activeBatchItems = [seedItem];
      try {
        const seedIndex = seedItem.index;
        const seedBlock = seedItem.block;
        const seedPlan = seedItem.plan || blockTranslationPlans?.[seedIndex] || {};
        const seedDebugEntry = debugEntries.find((item) => item.index === seedIndex + 1);
        const seedPendingIndices = Array.isArray(seedPlan.pendingSegmentIndices)
          ? seedPlan.pendingSegmentIndices
          : seedBlock.map((_segment, index) => index);
        const seedPreparedTexts = seedPendingIndices.map((segmentIndex) =>
          prepareTextForTranslation(seedBlock[segmentIndex]?.original || '')
        );
        if (!seedPreparedTexts.length) {
          await finalizeBlock({
            item: seedItem,
            stage: 'translate',
            status: 'skipped',
            reason: 'empty_texts'
          });
          continue;
        }
        const { uniqueTexts: seedUniqueTexts, indexMap: seedIndexMap } = deduplicateTexts(seedPreparedTexts);
        const seedContext = await selectContextForBlock(seedDebugEntry, 'translation');
        const batchPlan = await buildTranslationMicroBatch({
          seedItem,
          seedContext,
          seedPreparedTexts
        });
        const batchContextSignature = batchPlan.contextSignature || buildContextSignature(seedContext);
        const candidates = batchPlan.items || [seedItem];
        const batchItems = [];
        const batchContexts = [];
        const batchEntries = [];
        for (const item of candidates) {
          const entry = debugEntries.find((debugItem) => debugItem.index === item.index + 1);
          const contextMeta = item === seedItem ? seedContext : await selectContextForBlock(entry, 'translation');
          if (buildContextSignature(contextMeta) !== batchContextSignature) {
            translationQueue.push(item);
            continue;
          }
          batchItems.push(item);
          batchContexts.push(contextMeta);
          batchEntries.push(entry);
        }
        if (!batchItems.length) {
          continue;
        }
        activeBatchItems = [...batchItems];
        for (const item of batchItems) {
          await updateDebugEntry(item.index + 1, {
            translationStatus: 'in_progress',
            proofreadStatus: settings.proofreadEnabled && !item.uiMode ? 'pending' : 'disabled',
            proofreadApplied: settings.proofreadEnabled && !item.uiMode,
            translationStartedAt: Date.now()
          });
          markBlockInFlight(item, 'translate');
          traceBlockLifecycle(item.index + 1, 'translate', 'block start', { blockKey: item.key });
        }
        reportProgress('Перевод выполняется');
        const keepPunctuationTokens = Boolean(settings.proofreadEnabled);
        const batchBlockKeys = batchItems.map((item) => item.key);
        const sharedContext = batchContexts[0];
        const baseRequestMeta = {
          blockKey: batchBlockKeys[0],
          stage: 'translate',
          purpose: 'main',
          attempt: sharedContext.attemptIndex,
          triggerSource: translationTriggerSource,
          url: location.href,
          contextCacheKey
        };
        const mainRequestMeta = buildRequestMeta(baseRequestMeta, {
          contextText: sharedContext.contextText,
          contextMode: sharedContext.contextMode
        });
        mainRequestMeta.batchBlockKeys = batchBlockKeys;
        mainRequestMeta.batchBlockCount = batchBlockKeys.length;
        traceRequestInitiator(mainRequestMeta);
        const translateJobKey = batchBlockKeys.length > 1 ? `batch:${batchBlockKeys.join('|')}` : `${seedItem.key}:translate`;
        let result = null;

        if (batchItems.length === 1 && seedItem.fallbackMode === 'single') {
          const fallbackContext = await selectContextForBlock(seedDebugEntry, 'translation', { forceShort: true });
          const perTextTranslations = [];
          for (let textIndex = 0; textIndex < seedUniqueTexts.length; textIndex += 1) {
            const text = seedUniqueTexts[textIndex];
            const perTextRequestMeta = buildRequestMeta(baseRequestMeta, {
              requestId: createRequestId(),
              parentRequestId: mainRequestMeta.requestId,
              purpose: 'single',
              attempt: fallbackContext.attemptIndex,
              triggerSource: 'retry',
              contextText: fallbackContext.contextText,
              contextMode: fallbackContext.contextMode
            });
            perTextRequestMeta.batchBlockKeys = batchBlockKeys;
            perTextRequestMeta.batchBlockCount = batchBlockKeys.length;
            traceRequestInitiator(perTextRequestMeta);
            await ensureShortContextReadyForTrigger(perTextRequestMeta);
            const perTextResult = await translate(
              [text],
              settings.targetLanguage || 'ru',
              {
                contextText: fallbackContext.contextText,
                contextMode: fallbackContext.contextMode,
                baseAnswer: fallbackContext.baseAnswer,
                baseAnswerIncluded: fallbackContext.baseAnswerIncluded,
                baseAnswerPreview: fallbackContext.baseAnswerPreview,
                tag: fallbackContext.tag
              },
              keepPunctuationTokens,
              seedIndex + 1,
              perTextRequestMeta
            );
            if (!perTextResult?.success || perTextResult.translations.length !== 1) {
              throw new Error(perTextResult?.error || 'Не удалось выполнить перевод.');
            }
            const translatedText = perTextResult.translations[0];
            if (!translatedText || !translatedText.trim()) {
              throw new Error('Пустой перевод сегмента.');
            }
            perTextTranslations.push(translatedText);
          }
          result = { success: true, translations: perTextTranslations, rawTranslation: '', debug: [] };
          traceBlockLifecycle(seedIndex + 1, 'translate', 'LLM response received', {
            mode: 'single',
            segments: perTextTranslations.length
          });
        } else {
          const combinedPreparedTexts = [];
          const segmentMap = [];
          batchItems.forEach((item, itemIndex) => {
            const plan = item.plan || blockTranslationPlans?.[item.index] || {};
            const pendingIndices = Array.isArray(plan.pendingSegmentIndices)
              ? plan.pendingSegmentIndices
              : item.block.map((_segment, index) => index);
            pendingIndices.forEach((segmentIndex) => {
              const segment = item.block[segmentIndex];
              combinedPreparedTexts.push(prepareTextForTranslation(segment?.original || ''));
              segmentMap.push({ itemIndex, segmentIndex });
            });
          });
          if (!combinedPreparedTexts.length) {
            for (const item of batchItems) {
              await finalizeBlock({
                item,
                stage: 'translate',
                status: 'skipped',
                reason: 'empty_texts'
              });
            }
            continue;
          }
          const { uniqueTexts, indexMap } = deduplicateTexts(combinedPreparedTexts);
          const perItemTranslations = batchItems.map((item) => {
            const plan = item.plan || blockTranslationPlans?.[item.index] || {};
            const prefilled = Array.isArray(plan.prefilledTranslations)
              ? plan.prefilledTranslations
              : new Array(item.block.length).fill(null);
            return [...prefilled];
          });
          const uniqueToSegments = new Map();
          combinedPreparedTexts.forEach((_text, combinedIndex) => {
            const mapping = segmentMap[combinedIndex];
            const translationIndex = indexMap[combinedIndex];
            if (!mapping || translationIndex == null) return;
            if (!uniqueToSegments.has(translationIndex)) {
              uniqueToSegments.set(translationIndex, []);
            }
            uniqueToSegments.get(translationIndex).push(mapping);
          });
          const applyBatchTranslations = ({ batchTranslations, batchIndices, batchIndex, batchCount }) => {
            const touchedItems = new Set();
            batchTranslations.forEach((translation, localIndex) => {
              const uniqueIndex = batchIndices[localIndex];
              const mappedSegments = uniqueToSegments.get(uniqueIndex) || [];
              mappedSegments.forEach(({ itemIndex, segmentIndex }) => {
                const item = batchItems[itemIndex];
                const segment = item?.block?.[segmentIndex];
                if (!segment) return;
                const { node, path, original, originalHash } = segment;
                const resolvedTranslation = translation || original;
                let withOriginalFormatting = applyOriginalFormatting(original, resolvedTranslation);
                if (keepPunctuationTokens) {
                  withOriginalFormatting = restorePunctuationTokens(withOriginalFormatting);
                }
                perItemTranslations[itemIndex][segmentIndex] = withOriginalFormatting;
                if (node && shouldApplyTranslation(node, original, originalHash)) {
                  if (translationVisible) {
                    node.nodeValue = withOriginalFormatting;
                  }
                  updateActiveEntry(path, original, withOriginalFormatting, originalHash);
                }
                touchedItems.add(itemIndex);
              });
            });
            touchedItems.forEach((itemIndex) => {
              const item = batchItems[itemIndex];
              const translationsForItem = perItemTranslations[itemIndex];
              const doneSegments = translationsForItem.filter((value) => value != null).length;
              const totalSegments = translationsForItem.length;
              updateDebugEntry(item.index + 1, { doneSegments, totalSegments });
              traceBlockLifecycle(item.index + 1, 'translate', 'translate.partial_applied', {
                blockKey: item.key,
                doneSegments,
                totalSegments,
                batchIndex,
                batchCount
              });
            });
          };
          result = await runJobOnce(
            translateJobKey,
            async () => {
              await ensureShortContextReadyForTrigger(mainRequestMeta);
              return translate(
                uniqueTexts,
                settings.targetLanguage || 'ru',
                {
                  contextText: sharedContext.contextText,
                  contextMode: sharedContext.contextMode,
                  baseAnswer: sharedContext.baseAnswer,
                  baseAnswerIncluded: sharedContext.baseAnswerIncluded,
                  baseAnswerPreview: sharedContext.baseAnswerPreview,
                  tag: sharedContext.tag
                },
                keepPunctuationTokens,
                null,
                mainRequestMeta,
                { skipSummaries: true, onBatchApplied: applyBatchTranslations }
              );
            },
            (resolved) => resolved?.success
          );
          if (!result?.success && result?.contextOverflow && sharedContext.contextMode === 'FULL') {
            appendDebugPayload(
              seedIndex + 1,
              'translationDebug',
              buildContextOverflowDebugPayload({
                phase: 'TRANSLATE',
                model: settings.translationModel,
                errorMessage: result?.error || 'fullContext overflow/error',
                contextMode: sharedContext.contextMode,
                contextTextSent: sharedContext.contextText,
                baseAnswerIncluded: sharedContext.baseAnswerIncluded,
                tag: sharedContext.tag,
                requestMeta: mainRequestMeta
              })
            );
            const fallbackContext = await selectContextForBlock(seedDebugEntry, 'translation', { forceShort: true });
            const retryRequestMeta = buildRequestMeta(baseRequestMeta, {
              requestId: createRequestId(),
              parentRequestId: mainRequestMeta.requestId,
              purpose: 'retry',
              attempt: fallbackContext.attemptIndex,
              triggerSource: 'retry',
              contextText: fallbackContext.contextText,
              contextMode: fallbackContext.contextMode
            });
            retryRequestMeta.batchBlockKeys = batchBlockKeys;
            retryRequestMeta.batchBlockCount = batchBlockKeys.length;
            traceRequestInitiator(retryRequestMeta);
            result = await runJobOnce(
              translateJobKey,
              async () => {
                await ensureShortContextReadyForTrigger(retryRequestMeta);
                return translate(
                  uniqueTexts,
                  settings.targetLanguage || 'ru',
                  {
                    contextText: fallbackContext.contextText,
                    contextMode: fallbackContext.contextMode,
                    baseAnswer: fallbackContext.baseAnswer,
                  baseAnswerIncluded: fallbackContext.baseAnswerIncluded,
                  baseAnswerPreview: fallbackContext.baseAnswerPreview,
                  tag: fallbackContext.tag
                },
                keepPunctuationTokens,
                null,
                retryRequestMeta,
                { skipSummaries: true, onBatchApplied: applyBatchTranslations }
              );
            },
            (resolved) => resolved?.success
          );
        }
          if (!result?.success) {
            throw new Error(result?.error || 'Не удалось выполнить перевод.');
          }
          if (result.translations.length !== uniqueTexts.length) {
            throw new Error(
              `Translation length mismatch: expected ${uniqueTexts.length}, got ${result.translations.length}`
            );
          }
          for (const item of batchItems) {
            traceBlockLifecycle(item.index + 1, 'translate', 'LLM response received', {
              batchSize: batchItems.length
            });
          }
          for (const item of batchItems) {
            traceBlockLifecycle(item.index + 1, 'translate', 'parsed OK', { batchSize: batchItems.length });
          }
          combinedPreparedTexts.forEach((_text, combinedIndex) => {
            const mapping = segmentMap[combinedIndex];
            const translationIndex = indexMap[combinedIndex];
            if (!mapping || translationIndex == null) return;
            const resolvedTranslation = result.translations[translationIndex] ?? '';
            const { original } = batchItems[mapping.itemIndex].block[mapping.segmentIndex];
            let formatted = applyOriginalFormatting(original, resolvedTranslation || original);
            if (keepPunctuationTokens) {
              formatted = restorePunctuationTokens(formatted);
            }
            perItemTranslations[mapping.itemIndex][mapping.segmentIndex] = formatted;
          });
          for (let itemIndex = 0; itemIndex < batchItems.length; itemIndex += 1) {
            const item = batchItems[itemIndex];
            if (isBlockFinalized('translate', item.key)) {
              clearBlockInFlight(item, 'translate');
              continue;
            }
            const block = item.block;
            const contextMeta = batchContexts[itemIndex];
            const blockTranslations = [];
            try {
              const translatedTexts = block.map((_segment, segmentIndex) => {
                const translated = perItemTranslations[itemIndex]?.[segmentIndex];
                return translated == null ? block[segmentIndex].original : translated;
              });
              if (translatedTexts.length !== block.length) {
                throw new Error(
                  `Block translation length mismatch: expected ${block.length}, got ${translatedTexts.length}`
                );
              }
              const finalTranslations = translatedTexts;
              block.forEach(({ node, path, original, originalHash }, segmentIndex) => {
                if (!shouldApplyTranslation(node, original, originalHash)) {
                  blockTranslations.push(node.nodeValue);
                  return;
                }
                const withOriginalFormatting = finalTranslations[segmentIndex] || node.nodeValue;
                if (translationVisible) {
                  node.nodeValue = withOriginalFormatting;
                }
                blockTranslations.push(withOriginalFormatting);
                updateActiveEntry(path, original, withOriginalFormatting, originalHash);
              });
              markBlockProcessed(item.blockElement, 'translate');
              traceBlockLifecycle(item.index + 1, 'translate', 'applied to DOM', {
                visible: translationVisible
              });
              const baseTranslationAnswer =
                contextMeta.contextMode === 'FULL' && batchEntries[itemIndex] && !batchEntries[itemIndex].translationBaseFullAnswer
                  ? formatBlockText(finalTranslations)
                  : '';
              const baseTranslationCallId =
                contextMeta.contextMode === 'FULL' && batchEntries[itemIndex] && !batchEntries[itemIndex].translationBaseFullCallId
                  ? findFirstFullCallId(batchEntries[itemIndex]?.translationCalls)
                  : null;
              const translationRawField = await prepareRawTextField(result.rawTranslation || '', 'translation_raw');
              const summarizedDebug = await summarizeDebugPayloads(result.debug || [], {
                entryIndex: item.index + 1,
                stage: 'translation'
              });
              await updateDebugEntry(item.index + 1, {
                translated: formatBlockText(blockTranslations),
                translatedSegments: translatedTexts,
                translationStatus: 'done',
                translationCompletedAt: Date.now(),
                doneSegments: translatedTexts.length,
                totalSegments: translatedTexts.length,
                translationRaw: translationRawField.preview,
                translationRawRefId: translationRawField.refId,
                translationRawTruncated: translationRawField.truncated || translationRawField.rawTruncated,
                translationDebug: summarizedDebug,
                ...(baseTranslationAnswer
                  ? { translationBaseFullAnswer: baseTranslationAnswer, translationFullSuccess: true }
                  : {}),
                ...(baseTranslationCallId ? { translationBaseFullCallId: baseTranslationCallId } : {})
              });
              traceBlockLifecycle(item.index + 1, 'translate', 'status -> DONE');
              translationProgress.completedBlocks += 1;
              clearBlockInFlight(item, 'translate');
              await maybeQueueProofread({
                block,
                index: item.index,
                key: item.key,
                blockElement: item.blockElement,
                translatedTexts,
                originalTexts: block.map(({ original }) => original),
                uiMode: item.uiMode,
                uiLike: item.uiLike,
                settings
              });
            } catch (error) {
              globalThis.ntPageJsonLog?.({
                kind: 'apply.error',
                ts: Date.now(),
                stage: 'translate',
                entryIndex: item.index + 1,
                blockKey: item.key,
                error: error?.message || String(error),
                stack: error?.stack || ''
              });
              throw error;
            }
          }
          continue;
        }

        traceBlockLifecycle(seedIndex + 1, 'translate', 'parsed OK', { batchSize: 1 });
        try {
          if (isBlockFinalized('translate', seedItem.key)) {
            clearBlockInFlight(seedItem, 'translate');
            continue;
          }
          const pendingIndexBySegment = new Map();
          seedPendingIndices.forEach((segmentIndex, pendingIndex) => {
            pendingIndexBySegment.set(segmentIndex, pendingIndex);
          });
          const translatedTexts = seedBlock.map(({ original }, index) => {
            const pendingIndex = pendingIndexBySegment.get(index);
            if (pendingIndex == null) {
              return seedPlan.prefilledTranslations?.[index] || original;
            }
            const translationIndex = seedIndexMap[pendingIndex];
            const translated = translationIndex == null ? original : (result.translations[translationIndex] || original);
            return applyOriginalFormatting(original, translated);
          });
          let finalTranslations = translatedTexts;
          if (keepPunctuationTokens) {
            finalTranslations = finalTranslations.map((text) => restorePunctuationTokens(text));
          }
          const blockTranslations = [];
          seedBlock.forEach(({ node, path, original, originalHash }, index) => {
            let resolvedNode = null;
            if (node && node.nodeType === Node.TEXT_NODE && node.isConnected) {
              resolvedNode = node;
            } else {
              const candidateNode = findNodeByPath(path);
              if (candidateNode && candidateNode.nodeType === Node.TEXT_NODE && candidateNode.isConnected) {
                resolvedNode = candidateNode;
              }
            }
            if (!resolvedNode) {
              blockTranslations.push('');
              return;
            }
            if (!shouldApplyTranslation(resolvedNode, original, originalHash)) {
              blockTranslations.push(resolvedNode?.nodeValue ?? '');
              return;
            }
            const withOriginalFormatting = finalTranslations[index] || resolvedNode.nodeValue;
            if (translationVisible) {
              resolvedNode.nodeValue = withOriginalFormatting;
            }
            blockTranslations.push(withOriginalFormatting);
            updateActiveEntry(path, original, withOriginalFormatting, originalHash);
          });
          markBlockProcessed(seedItem.blockElement, 'translate');
          traceBlockLifecycle(seedIndex + 1, 'translate', 'applied to DOM', { visible: translationVisible });
          const baseTranslationAnswer =
            sharedContext.contextMode === 'FULL' && seedDebugEntry && !seedDebugEntry.translationBaseFullAnswer
              ? formatBlockText(finalTranslations)
              : '';
          const baseTranslationCallId =
            sharedContext.contextMode === 'FULL' && seedDebugEntry && !seedDebugEntry.translationBaseFullCallId
              ? findFirstFullCallId(seedDebugEntry?.translationCalls)
              : null;
          const translationRawField = await prepareRawTextField(result.rawTranslation || '', 'translation_raw');
          await updateDebugEntry(seedIndex + 1, {
            translated: formatBlockText(blockTranslations),
            translatedSegments: translatedTexts,
            translationStatus: 'done',
            translationCompletedAt: Date.now(),
            doneSegments: translatedTexts.length,
            totalSegments: translatedTexts.length,
            translationRaw: translationRawField.preview,
            translationRawRefId: translationRawField.refId,
            translationRawTruncated: translationRawField.truncated || translationRawField.rawTruncated,
            translationDebug: result.debug || [],
            ...(baseTranslationAnswer
              ? { translationBaseFullAnswer: baseTranslationAnswer, translationFullSuccess: true }
              : {}),
            ...(baseTranslationCallId ? { translationBaseFullCallId: baseTranslationCallId } : {})
          });
          traceBlockLifecycle(seedIndex + 1, 'translate', 'status -> DONE');
          translationProgress.completedBlocks += 1;
          clearBlockInFlight(seedItem, 'translate');

          await maybeQueueProofread({
            block: seedBlock,
            index: seedIndex,
            key: seedItem.key,
            blockElement: seedItem.blockElement,
            translatedTexts,
            originalTexts: seedBlock.map(({ original }) => original),
            uiMode: seedItem.uiMode,
            uiLike: seedItem.uiLike,
            settings
          });
        } catch (error) {
          globalThis.ntPageJsonLog?.({
            kind: 'apply.error',
            ts: Date.now(),
            stage: 'translate',
            entryIndex: seedItem.index + 1,
            blockKey: seedItem.key,
            error: error?.message || String(error),
            stack: error?.stack || ''
          });
          throw error;
        }
      } catch (error) {
        console.error('Block translation failed', error);
        reportLastError('translate', 'block', error);
        const policy = globalThis.ntResiliencePolicy;
        const errorType = classifyResilienceError(error);
        if (isFatalBlockError(error)) {
          translationError = error;
          cancelRequested = true;
          for (const item of activeBatchItems) {
            if (policy) {
              const resilienceKey = buildResilienceKey('translate', { blockKey: item.key });
              policy.recordOutcome(resilienceKey, errorType, {
                errorType,
                errorMessage: error?.message || String(error)
              });
            }
            await finalizeBlock({
              item,
              stage: 'translate',
              status: 'failed',
              reason: error?.message || String(error)
            });
          }
        } else {
          if (isInvalidResponseShapeError(error)) {
            for (const item of activeBatchItems) {
              await finalizeBlock({
                item,
                stage: 'translate',
                status: 'failed',
                reason: 'invalid_response_shape'
              });
            }
            continue;
          }
          for (const item of activeBatchItems) {
            if (policy) {
              const resilienceKey = buildResilienceKey('translate', { blockKey: item.key });
              policy.recordOutcome(resilienceKey, errorType, {
                errorType,
                errorMessage: error?.message || String(error)
              });
              if (policy.shouldEscalate(resilienceKey, errorType)) {
                policy.escalate(resilienceKey, errorType);
              }
              const state = policy.getState(resilienceKey);
              if (state?.modeLevel >= 5 || state?.attemptsTotal >= policy.constants.MAX_ATTEMPTS_TOTAL) {
                item.fallbackMode = 'single';
                item.retryCount = 0;
              }
            }
            item.retryCount += 1;
            totalBlockRetries += 1;
            recordHealthRetry();
            if (item.retryCount > MAX_BLOCK_RETRIES) {
              item.fallbackMode = 'single';
              item.retryCount = 0;
            }
            if (isRateLimitOrOverload(error)) {
              maxConcurrentTranslationJobs = Math.max(1, maxConcurrentTranslationJobs - 1);
            }
            const retryBase = Math.max(1, item.retryCount);
            const delayMs = Math.min(
              MAX_RETRY_DELAY_MS,
              BASE_RETRY_DELAY_MS * Math.pow(2, retryBase - 1)
            );
            item.availableAt = Date.now() + delayMs;
            await updateDebugEntry(item.index + 1, {
              translationStatus: 'retrying',
              translationRetryCount: item.retryCount,
              translationLastError: String(error?.message || error)
            });
            clearBlockInFlight(item, 'translate');
            reportProgress(
              'Повтор перевода блока',
              translationProgress.completedBlocks,
              totalBlocks,
              activeTranslationWorkers
            );
            translationQueue.push(item);
          }
          continue;
        }
      } finally {
        activeTranslationWorkers = Math.max(0, activeTranslationWorkers - 1);
      }

      if (translationError) {
        reportProgress(
          'Ошибка перевода',
          translationProgress.completedBlocks,
          totalBlocks,
          activeTranslationWorkers
        );
        return;
      }

      reportProgress(
        'Перевод выполняется',
        translationProgress.completedBlocks,
        totalBlocks,
        activeTranslationWorkers
      );
    }
  };
  const proofreadWorker = async () => {
    while (true) {
      if (cancelRequested) return;
      const task = proofreadQueue.shift();
      if (!task) {
        if (translationQueueDone) return;
        await delay(50);
        continue;
      }

      activeProofreadWorkers += 1;
      try {
        await updateDebugEntry(task.index + 1, { proofreadStatus: 'in_progress', proofreadExecuted: true });
        markBlockInFlight(task, 'proofread');
        traceBlockLifecycle(task.index + 1, 'proofread', 'block start', { blockKey: task.key });
        const debugEntry = debugEntries.find((item) => item.index === task.index + 1);
        const followupTag =
          task.proofreadMode === 'NOISE_CLEANUP' ? CALL_TAGS.PROOFREAD_NOISE_SHORT : CALL_TAGS.PROOFREAD_REWRITE_SHORT;
        const primaryContext = await selectContextForBlock(debugEntry, 'proofread', { followupTag });
        const baseRequestMeta = {
          blockKey: task.key,
          stage: 'proofread',
          purpose: 'main',
          attempt: primaryContext.attemptIndex,
          triggerSource: translationTriggerSource,
          url: location.href,
          contextCacheKey
        };
        const mainRequestMeta = buildRequestMeta(baseRequestMeta, {
          contextText: primaryContext.contextText,
          contextMode: primaryContext.contextMode
        });
        traceRequestInitiator(mainRequestMeta);
        const proofreadJobKey = `${task.key}:proofread`;
        let proofreadResult = await runJobOnce(
          proofreadJobKey,
          async () => {
            await ensureShortContextReadyForTrigger(mainRequestMeta);
            return requestProofreading({
              segments: task.proofreadSegments || task.translatedTexts.map((text, index) => ({ id: String(index), text })),
              sourceBlock: formatBlockText(task.originalTexts),
              translatedBlock: formatBlockText(task.translatedTexts),
              proofreadMode: task.proofreadMode,
              contextMeta: {
                contextText: primaryContext.contextText,
                contextMode: primaryContext.contextMode,
                baseAnswer: primaryContext.baseAnswer,
                baseAnswerIncluded: primaryContext.baseAnswerIncluded,
                baseAnswerPreview: primaryContext.baseAnswerPreview,
                tag: primaryContext.tag
              },
              language: settings.targetLanguage || 'ru',
              debugEntryIndex: task.index + 1,
              requestMeta: mainRequestMeta
            });
          },
          (resolved) => resolved?.success
        );
        if (!proofreadResult?.success && proofreadResult?.contextOverflow && primaryContext.contextMode === 'FULL') {
          appendDebugPayload(
            task.index + 1,
            'proofreadDebug',
            buildContextOverflowDebugPayload({
              phase: 'PROOFREAD',
              model: settings.proofreadModel,
              errorMessage: proofreadResult?.error || 'fullContext overflow/error',
              contextMode: primaryContext.contextMode,
              contextTextSent: primaryContext.contextText,
              baseAnswerIncluded: primaryContext.baseAnswerIncluded,
              tag: primaryContext.tag,
              requestMeta: mainRequestMeta
            })
          );
          const fallbackContext = await selectContextForBlock(debugEntry, 'proofread', {
            forceShort: true,
            followupTag
          });
          const retryRequestMeta = buildRequestMeta(baseRequestMeta, {
            requestId: createRequestId(),
            parentRequestId: mainRequestMeta.requestId,
            purpose: 'retry',
            attempt: fallbackContext.attemptIndex,
            triggerSource: 'retry',
            contextText: fallbackContext.contextText,
            contextMode: fallbackContext.contextMode
          });
          traceRequestInitiator(retryRequestMeta);
          proofreadResult = await runJobOnce(
            proofreadJobKey,
            async () => {
              await ensureShortContextReadyForTrigger(retryRequestMeta);
              return requestProofreading({
                segments: task.proofreadSegments || task.translatedTexts.map((text, index) => ({ id: String(index), text })),
                sourceBlock: formatBlockText(task.originalTexts),
                translatedBlock: formatBlockText(task.translatedTexts),
                proofreadMode: task.proofreadMode,
                contextMeta: {
                  contextText: fallbackContext.contextText,
                  contextMode: fallbackContext.contextMode,
                  baseAnswer: fallbackContext.baseAnswer,
                  baseAnswerIncluded: fallbackContext.baseAnswerIncluded,
                  baseAnswerPreview: fallbackContext.baseAnswerPreview,
                  tag: fallbackContext.tag
                },
                language: settings.targetLanguage || 'ru',
                debugEntryIndex: task.index + 1,
                requestMeta: retryRequestMeta
              });
            },
            (resolved) => resolved?.success
          );
        }
        if (!proofreadResult?.success) {
          throw new Error(proofreadResult?.error || 'Не удалось выполнить вычитку.');
        }
        traceBlockLifecycle(task.index + 1, 'proofread', 'LLM response received');
        const revisedSegments = Array.isArray(proofreadResult.translations)
          ? proofreadResult.translations
          : [];
        const revisionMap = new Map();
        const proofreadWarnings = [];
        (task.proofreadSegments || []).forEach((segment, index) => {
          const revised = revisedSegments[index];
          if (typeof revised !== 'string') return;
          const originalTokens = extractPunctuationTokens(segment.text);
          const revisedTokens = extractPunctuationTokens(revised);
          if (!areTokenMultisetsEqual(originalTokens, revisedTokens)) {
            proofreadWarnings.push(
              `Segment ${segment.id}: punctuation tokens changed, revision ignored.`
            );
            return;
          }
          revisionMap.set(String(segment.id), revised);
        });
        const proofreadSummary = [];
        let finalTranslations = task.translatedTexts.map((text, index) => {
          const revision = revisionMap.get(String(index));
          if (typeof revision === 'string' && revision.trim() && revision.trim() !== text.trim()) {
            proofreadSummary.push({ segmentIndex: index, revisedText: revision });
            return revision;
          }
          return text;
        });
        finalTranslations = finalTranslations.map((text, index) =>
          applyOriginalFormatting(task.originalTexts[index], text)
        );
        finalTranslations = finalTranslations.map((text) => restorePunctuationTokens(text));
        if (finalTranslations.length !== task.block.length) {
          throw new Error(
            `Proofread length mismatch: expected ${task.block.length}, got ${finalTranslations.length}`
          );
        }

        traceBlockLifecycle(task.index + 1, 'proofread', 'parsed OK');
        if (isBlockFinalized('proofread', task.key)) {
          clearBlockInFlight(task, 'proofread');
          continue;
        }
        updatePageWithProofreading(task, finalTranslations);
        markBlockProcessed(task.blockElement, 'proofread');
        traceBlockLifecycle(task.index + 1, 'proofread', 'applied to DOM');

        const rawProofreadPayload = proofreadResult.rawProofread || '';
        const rawProofread =
          typeof rawProofreadPayload === 'string'
            ? rawProofreadPayload
            : JSON.stringify(rawProofreadPayload, null, 2);
        const proofreadRawField = await prepareRawTextField(rawProofread, 'proofread_raw');
        const proofreadDebugPayloads = normalizeProofreadDebugPayloads(
          proofreadResult.debug || [],
          proofreadWarnings
        );
        const proofreadComparisons = buildProofreadComparisons({
          originalTexts: task.originalTexts,
          beforeTexts: task.translatedTexts,
          afterTexts: finalTranslations
        }).filter((comparison) => comparison.changed);
        recordHealthProofreadDelta(proofreadComparisons.length, task.originalTexts.length);
        const baseProofreadAnswer =
          primaryContext.contextMode === 'FULL' && debugEntry && !debugEntry.proofreadBaseFullAnswer
            ? formatBlockText(finalTranslations)
            : '';
        const baseProofreadCallId =
          primaryContext.contextMode === 'FULL' && debugEntry && !debugEntry.proofreadBaseFullCallId
            ? findFirstFullCallId(debugEntry?.proofreadCalls)
            : null;
        await updateDebugEntry(task.index + 1, {
          translated: formatBlockText(finalTranslations),
          translatedSegments: finalTranslations,
          proofreadStatus: 'done',
          proofread: proofreadSummary,
          proofreadRaw: proofreadRawField.preview,
          proofreadRawRefId: proofreadRawField.refId,
          proofreadRawTruncated: proofreadRawField.truncated || proofreadRawField.rawTruncated,
          proofreadDebug: proofreadDebugPayloads,
          proofreadComparisons,
          proofreadCompletedAt: Date.now(),
          ...(baseProofreadAnswer
            ? { proofreadBaseFullAnswer: baseProofreadAnswer, proofreadFullSuccess: true }
            : {}),
          ...(baseProofreadCallId ? { proofreadBaseFullCallId: baseProofreadCallId } : {})
        });
        traceBlockLifecycle(task.index + 1, 'proofread', 'status -> DONE');
        clearBlockInFlight(task, 'proofread');
        reportProgress('Вычитка выполняется');
      } catch (error) {
        console.warn('Proofreading failed, keeping original translations.', error);
        reportLastError('proofread', 'block', error);
        const proofreadComparisons = buildProofreadComparisons({
          originalTexts: task.originalTexts,
          beforeTexts: task.translatedTexts,
          afterTexts: task.translatedTexts
        }).filter((comparison) => comparison.changed);
        recordHealthProofreadDelta(proofreadComparisons.length, task.originalTexts.length);
        await updateDebugEntry(task.index + 1, {
          proofreadStatus: 'failed',
          proofread: [],
          proofreadComparisons,
          proofreadExecuted: true,
          proofreadCompletedAt: Date.now(),
          proofreadLastError: String(error?.message || error)
        });
        clearBlockInFlight(task, 'proofread');
        reportProgress('Вычитка выполняется');
      } finally {
        activeProofreadWorkers = Math.max(0, activeProofreadWorkers - 1);
      }
    }
  };

  let proofreadSelfCheckCompleted = false;

  function runProofreadSelfCheck() {
    if (proofreadSelfCheckCompleted) return;
    proofreadSelfCheckCompleted = true;
    try {
      const original = 'Hello';
      const translated = 'Привет';
      const proofread = 'Здравствуйте';
      const mockEntry = {
        path: [0],
        original,
        originalHash: getOriginalHash(original, null),
        translated
      };
      const mockNode = { nodeValue: translated, nodeType: Node.TEXT_NODE, isConnected: true };
      const applyAllowed = shouldApplyProofreadTranslation(mockNode, mockEntry, original);
      if (applyAllowed) {
        mockNode.nodeValue = proofread;
      }
      const userChangedNode = { nodeValue: 'Мой текст', nodeType: Node.TEXT_NODE, isConnected: true };
      const shouldBlock = shouldApplyProofreadTranslation(userChangedNode, mockEntry, original);
      console.debug('Neuro Translate proofread self-check', {
        applied: mockNode.nodeValue === proofread,
        blocked: !shouldBlock
      });
    } catch (error) {
      console.debug('Neuro Translate proofread self-check failed', error);
    }
  }

  function getActiveTranslationEntry(path, original, originalHash) {
    const entry = activeTranslationEntries.find((item) => isSamePath(item.path, path));
    if (!entry) return null;
    const resolvedOriginalHash = getOriginalHash(original, originalHash);
    if (
      Number.isFinite(resolvedOriginalHash) &&
      Number.isFinite(entry.originalHash) &&
      entry.originalHash !== resolvedOriginalHash
    ) {
      return null;
    }
    return entry;
  }

  function shouldApplyProofreadTranslation(node, entry, original) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.isConnected) return false;
    if (!entry) return false;
    const currentText = node.nodeValue ?? '';
    const storedOriginal = typeof entry.original === 'string' ? entry.original : original;
    const storedTranslated = typeof entry.translated === 'string' ? entry.translated : '';
    return currentText === storedTranslated || currentText === storedOriginal;
  }

  function updatePageWithProofreading(task, finalTranslations) {
    try {
      runProofreadSelfCheck();
      let skipped = 0;
      let applied = 0;
      task.block.forEach(({ node, path, original, originalHash }, index) => {
        let resolvedNode = null;
        if (node && node.nodeType === Node.TEXT_NODE && node.isConnected) {
          resolvedNode = node;
        } else {
          const candidateNode = findNodeByPath(path);
          if (candidateNode && candidateNode.nodeType === Node.TEXT_NODE && candidateNode.isConnected) {
            resolvedNode = candidateNode;
          }
        }
        const entry = getActiveTranslationEntry(path, original, originalHash);
        if (!shouldApplyProofreadTranslation(resolvedNode, entry, original)) {
          skipped += 1;
          return;
        }
        const withOriginalFormatting = finalTranslations[index] || resolvedNode.nodeValue;
        if (translationVisible) {
          resolvedNode.nodeValue = withOriginalFormatting;
        }
        updateActiveEntry(path, original, withOriginalFormatting, originalHash);
        applied += 1;
      });
      if (skipped > 0 && applied === 0) {
        console.info('Proofread skipped: DOM text no longer matches stored translation.', {
          blockIndex: task?.index != null ? task.index + 1 : undefined,
          skipped
        });
      }
    } catch (error) {
      globalThis.ntPageJsonLog?.({
        kind: 'apply.error',
        ts: Date.now(),
        stage: 'proofread',
        entryIndex: task.index + 1,
        blockKey: task.key,
        error: error?.message || String(error),
        stack: error?.stack || ''
      });
      throw error;
    }
  }

  blocks.forEach((block, index) => {
    if (uiBlockIndices.has(index)) return;
    enqueueTranslationBlock(block, index);
  });
  const prefilledBlocksCount = blockTranslationPlans.reduce((sum, plan, index) => {
    if (uiBlockIndices.has(index)) return sum;
    return sum + (plan?.allPrefilled ? 1 : 0);
  }, 0);
  translationProgress.totalBlocks = translationQueue.length + uiBlockIndices.size + prefilledBlocksCount;
  const totalBlocks = translationProgress.totalBlocks;

  if (totalBlocks !== blocks.length) {
    reportProgress('Перевод запущен', translationProgress.completedBlocks, totalBlocks, 0, { reason: 'start' });
  }

  const workers = Array.from({ length: translationConcurrency }, () => translationWorker());
  const proofreadWorkers = settings.proofreadEnabled
    ? Array.from({ length: proofreadConcurrency }, () => proofreadWorker())
    : [];
  startInFlightWatchdog();
  const translationCompletion = Promise.all(workers).then(() => {
    translationQueueDone = true;
  });
  await Promise.all([...proofreadWorkers, translationCompletion]);
  stopInFlightWatchdog();

  if (translationError) {
    updateDebugSessionEndTime();
    await flushPersistDebugState('translatePage:error');
    logDedupSummary();
    reportProgress('Ошибка перевода', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
    reportLastError('translate', 'page', translationError);
    return;
  }

  if (cancelRequested) {
    updateDebugSessionEndTime();
    await flushPersistDebugState('translatePage:cancelled');
    logDedupSummary();
    reportProgress('Перевод отменён', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers, {
      reason: 'cancelled'
    });
    return;
  }

  updateDebugSessionEndTime();
  await flushPersistDebugState('translatePage:completed');
  logDedupSummary();
  reportProgress('Перевод завершён', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
  await flushPersistDebugState('translatePage:before-save');
  await saveTranslationsToMemory(activeTranslationEntries);
}

function buildResilienceKey(opType, requestMeta = null) {
  const blockKey = requestMeta?.blockKey || requestMeta?.batchBlockKeys?.[0] || requestMeta?.requestId || '';
  const host = location.host || '';
  return `${opType || 'unknown'}::${blockKey || host || 'page'}`;
}

function classifyResilienceError(error) {
  const status = error?.status;
  const message = String(error?.message || error || '').toLowerCase();
  if (status === 429 || status === 503 || message.includes('rate limit')) return 'rate_limited';
  if (status === 408 || error?.name === 'AbortError' || message.includes('timeout')) return 'timeout';
  if (message.includes('length mismatch') || message.includes('count mismatch')) return 'count_mismatch';
  if (message.includes('schema') || message.includes('json')) return 'schema';
  if (status >= 500) return 'transient';
  return 'other';
}

function applyResilienceToContext(contextMeta, requestOptions) {
  const resilience = requestOptions?.resilience || {};
  if (!resilience || !contextMeta) return contextMeta;
  const next = { ...contextMeta };
  if (resilience.forceNoContext) {
    return {
      ...next,
      contextText: '',
      contextMode: 'SHORT',
      contextFullText: '',
      contextShortText: '',
      baseAnswer: '',
      baseAnswerIncluded: false,
      baseAnswerPreview: ''
    };
  }
  if (resilience.forceShortContext) {
    const shortText = next.contextShortText || '';
    next.contextText = shortText;
    next.contextMode = 'SHORT';
    next.baseAnswer = '';
    next.baseAnswerIncluded = false;
    next.baseAnswerPreview = '';
  }
  if (Number.isFinite(resilience.maxContextChars) && next.contextText?.length > resilience.maxContextChars) {
    next.contextText = next.contextText.slice(0, resilience.maxContextChars);
  }
  return next;
}

function splitBatchesForResilience(batches, splitDepth = 0) {
  if (!Array.isArray(batches) || splitDepth <= 0) return batches;
  let output = [];
  batches.forEach((batch) => {
    let parts = [batch];
    for (let depth = 0; depth < splitDepth; depth += 1) {
      const next = [];
      parts.forEach((part) => {
        if (!part || part.length <= 1) {
          next.push(part);
          return;
        }
        const midpoint = Math.ceil(part.length / 2);
        next.push(part.slice(0, midpoint));
        next.push(part.slice(midpoint));
      });
      parts = next;
    }
    output = output.concat(parts);
  });
  return output;
}

async function translate(
  texts,
  targetLanguage,
  contextMeta,
  keepPunctuationTokens = false,
  debugEntryIndex = null,
  requestMeta = null,
  debugOptions = null,
  requestOptions = null
) {
  translationCallCount += 1;
  const resolvedContextMeta =
    contextMeta && typeof contextMeta === 'object'
      ? contextMeta
      : {
          contextText: typeof contextMeta === 'string' ? contextMeta : '',
          contextMode: 'FULL',
          contextFullText: typeof contextMeta === 'string' ? contextMeta : '',
          contextShortText: '',
          baseAnswer: '',
          baseAnswerIncluded: false,
          baseAnswerPreview: '',
          tag: CALL_TAGS.TRANSLATE_BASE_FULL
        };
  const policy = globalThis.ntResiliencePolicy;
  const resilienceKey = policy ? buildResilienceKey('translate', requestMeta) : '';
  const policyState = policy?.getState?.(resilienceKey) || null;
  const patchedRequestOptions = policy?.applyModeToOptions
    ? policy.applyModeToOptions(policyState?.modeLevel || 0, requestOptions)
    : requestOptions;
  const resilienceContextMeta = applyResilienceToContext(resolvedContextMeta, patchedRequestOptions);
  const context = resilienceContextMeta.contextText || '';
  const baseAnswer = resilienceContextMeta.baseAnswerIncluded ? resilienceContextMeta.baseAnswer || '' : '';
  const contextEstimateText = [context, baseAnswer].filter(Boolean).join('\n');
  const batches = splitTextsByTokenEstimate(
    Array.isArray(texts) ? texts : [texts],
    contextEstimateText,
    TRANSLATION_MAX_TOKENS_PER_REQUEST
  );
  const splitDepth = patchedRequestOptions?.resilience?.splitDepth || 0;
  const resilientBatches = splitBatchesForResilience(batches, splitDepth);
  const translations = [];
  const rawParts = [];
  const debugParts = [];
  const baseRequestMeta = requestMeta && typeof requestMeta === 'object' ? requestMeta : null;
  const rootRequestId = baseRequestMeta?.requestId || (baseRequestMeta ? createRequestId() : null);
  const summaryOptions = debugOptions && typeof debugOptions === 'object' ? debugOptions : {};
  const entryIndex = Number.isFinite(summaryOptions.entryIndex) ? summaryOptions.entryIndex : debugEntryIndex;
  const shouldSummarize = !summaryOptions.skipSummaries;
  const onBatchApplied = typeof summaryOptions.onBatchApplied === 'function' ? summaryOptions.onBatchApplied : null;
  let batchCursor = 0;

  const logSplitRetry = ({ batchLen, depth, reason, splitSide } = {}) => {
    const payload = {
      kind: 'translate.split_retry',
      ts: Date.now(),
      batchLen: Number.isFinite(batchLen) ? batchLen : null,
      depth: Number.isFinite(depth) ? depth : null,
      reason: reason || 'timeout',
      splitSide: splitSide || null
    };
    if (typeof globalThis.ntPageJsonLog === 'function') {
      globalThis.ntPageJsonLog(payload, 'log');
    } else {
      console.info('Translate split retry', payload);
    }
  };

  const translateBatchWithSplit = async (batch, batchIndices, batchMeta, depth = 0) => {
    const perBatchRequestId = baseRequestMeta ? createRequestId() : null;
    const batchRequestMeta = baseRequestMeta
      ? buildRequestMeta(baseRequestMeta, {
          requestId: perBatchRequestId,
          parentRequestId: rootRequestId,
          contextText: context,
          contextMode: resilienceContextMeta.contextMode
        })
      : null;
    if (batchRequestMeta) {
      batchRequestMeta.batchIndex = batchMeta.batchIndex;
      batchRequestMeta.batchCount = batchMeta.batchCount;
      batchRequestMeta.batchOffset = batchIndices[0];
      if (depth > 0) {
        batchRequestMeta.splitDepth = depth;
        batchRequestMeta.splitSide = batchMeta.splitSide || null;
      }
    }
    const requestBlockKeys = getRequestBlockKeys(baseRequestMeta);
    const fallbackEnabled = recordBlockAttempt(requestBlockKeys);
    const requestMetaForPayload =
      batchRequestMeta && fallbackEnabled
        ? { ...batchRequestMeta, flags: { ...(batchRequestMeta.flags || {}), fallbackMode: true } }
        : batchRequestMeta;
    const estimatedTokens = estimateTokensForRole('translation', {
      texts: batch,
      context: [context, baseAnswer].filter(Boolean).join('\n')
    });
    await ensureTpmBudget('translation', estimatedTokens);
    recordHealthBatchSize('translate', batch.length);
    const schedulerModel = schedulerModels.translationModel || '';
    await requestSchedulerSlot(
      'translation',
      estimatedTokens,
      requestMetaForPayload,
      schedulerModel,
      { batchSize: batch.length, contextMode: resilienceContextMeta.contextMode }
    );
    const requestStartedAt = Date.now();
    let schedulerOutcomeRecorded = false;
    const recordSchedulerOutcomeOnce = async (status) => {
      if (schedulerOutcomeRecorded) return;
      schedulerOutcomeRecorded = true;
      await recordSchedulerOutcome(
        'translation',
        status,
        Date.now() - requestStartedAt,
        requestMetaForPayload,
        schedulerModel
      );
    };
    try {
      const response = await withRateLimitRetry(
        async () => {
          await incrementDebugAiRequestCount();
          const rpcResponse = await sendRuntimeMessage(
            {
              type: 'TRANSLATE_TEXT',
              texts: batch,
              targetLanguage,
              context: {
                text: context,
                mode: resilienceContextMeta.contextMode,
                fullText: resilienceContextMeta.contextFullText || resilienceContextMeta.contextText || '',
                shortText: resilienceContextMeta.contextShortText || '',
                baseAnswer,
                baseAnswerIncluded: resilienceContextMeta.baseAnswerIncluded
              },
              keepPunctuationTokens,
              requestMeta: requestMetaForPayload || undefined,
              requestOptions: patchedRequestOptions || undefined
            },
            'Не удалось выполнить перевод.'
          );
          if (!rpcResponse?.success) {
            if (isTimeoutLikeResponse(rpcResponse)) {
              recordBlockTimeout(requestBlockKeys);
            }
            if (rpcResponse?.contextOverflow) {
              return { success: false, contextOverflow: true, error: rpcResponse.error || 'Контекст не помещается.' };
            }
            if (rpcResponse?.isRuntimeError) {
              return { success: false, error: rpcResponse.error || 'Не удалось выполнить перевод.' };
            }
            const error = new Error(rpcResponse?.error || 'Не удалось выполнить перевод.');
            error.status = rpcResponse?.status;
            error.healthRecorded = true;
            throw error;
          }
          const translations = Array.isArray(rpcResponse.translations) ? rpcResponse.translations : null;
          if (!translations || translations.length !== batch.length) {
            logInvalidRpcResponse({
              stage: 'translate',
              reason: 'invalid_response_shape',
              expectedCount: batch.length,
              receivedCount: translations ? translations.length : null,
              response: rpcResponse
            });
            const invalidError = new Error('Invalid response shape');
            invalidError.isInvalidResponseShape = true;
            throw invalidError;
          }
          return {
            success: true,
            translations,
            rawTranslation: rpcResponse.rawTranslation || '',
            debug: rpcResponse.debug || []
          };
        },
        'Translation'
      );
      if (!response?.success) {
        await recordSchedulerOutcomeOnce(response?.contextOverflow ? 413 : null);
        return {
          ok: false,
          translations: new Array(batch.length).fill(null),
          error: response?.error || '',
          contextOverflow: Boolean(response?.contextOverflow),
          requestMeta: batchRequestMeta
        };
      }
      await recordSchedulerOutcomeOnce(200);
      return {
        ok: true,
        translations: response.translations,
        rawParts: response.rawTranslation ? [response.rawTranslation] : [],
        debugParts: Array.isArray(response.debug) ? response.debug : [],
        requestMeta: batchRequestMeta
      };
    } catch (error) {
      await recordSchedulerOutcomeOnce(Number.isFinite(error?.status) ? error.status : null);
      if (!error?.healthRecorded) {
        recordHealthError(classifyResilienceError(error));
      }
      if (isTimeoutLikeError(error)) {
        recordBlockTimeout(requestBlockKeys);
      }
      if (policy && resilienceKey) {
        const errorType = classifyResilienceError(error);
        policy.recordOutcome(resilienceKey, errorType, {
          errorType,
          errorMessage: error?.message || String(error)
        });
        if (policy.shouldEscalate(resilienceKey, errorType)) {
          policy.escalate(resilienceKey, errorType);
        }
      }
      if (!isTimeoutLikeError(error)) {
        throw error;
      }
      if (batch.length > 1 && depth < 8) {
        logSplitRetry({ batchLen: batch.length, depth, reason: error?.message || 'timeout' });
        const midpoint = Math.ceil(batch.length / 2);
        const leftBatch = batch.slice(0, midpoint);
        const rightBatch = batch.slice(midpoint);
        const leftIndices = batchIndices.slice(0, midpoint);
        const rightIndices = batchIndices.slice(midpoint);
        const leftResult = await translateBatchWithSplit(
          leftBatch,
          leftIndices,
          { ...batchMeta, splitSide: 'L' },
          depth + 1
        );
        const rightResult = await translateBatchWithSplit(
          rightBatch,
          rightIndices,
          { ...batchMeta, splitSide: 'R' },
          depth + 1
        );
        return {
          ok: leftResult.ok && rightResult.ok,
          translations: [...leftResult.translations, ...rightResult.translations],
          rawParts: [...(leftResult.rawParts || []), ...(rightResult.rawParts || [])],
          debugParts: [...(leftResult.debugParts || []), ...(rightResult.debugParts || [])],
          requestMeta: batchRequestMeta
        };
      }
      if (currentTabIdForProgress) {
        reportLastError('translate', 'timeout_split_failed', error);
      }
      return {
        ok: false,
        translations: [null],
        rawParts: [],
        debugParts: [],
        error,
        requestMeta: batchRequestMeta
      };
    } finally {
      if (!schedulerOutcomeRecorded) {
        await recordSchedulerOutcomeOnce(null);
      }
    }
  };

  for (let index = 0; index < resilientBatches.length; index += 1) {
    const batch = resilientBatches[index];
    const batchIndices = batch.map((_text, offset) => batchCursor + offset);
    batchCursor += batch.length;
    const batchResult = await translateBatchWithSplit(
      batch,
      batchIndices,
      { batchIndex: index + 1, batchCount: resilientBatches.length }
    );
    if (batchResult?.contextOverflow) {
      return {
        success: false,
        error: batchResult?.error || 'Не удалось выполнить перевод.',
        contextOverflow: true
      };
    }
    translations.push(...(batchResult?.translations || []));
    const batchContext = context;
    if (onBatchApplied) {
      await onBatchApplied({
        batchTranslations: batchResult?.translations || [],
        batchIndices,
        batchIndex: index + 1,
        batchCount: batches.length
      });
    }
    if (Array.isArray(batchResult?.rawParts) && batchResult.rawParts.length) {
      rawParts.push(...batchResult.rawParts.filter(Boolean));
    }
    if (Array.isArray(batchResult?.debugParts) && batchResult.debugParts.length) {
      const annotated = annotateContextUsage(batchResult.debugParts, {
        contextMode: resilienceContextMeta.contextMode,
        baseAnswerIncluded: resilienceContextMeta.baseAnswerIncluded,
        baseAnswerPreview: resilienceContextMeta.baseAnswerPreview,
        contextTextSent: batchContext,
        tag: resilienceContextMeta.tag
      });
      const withRequestMeta = annotateRequestMetadata(annotated, batchResult?.requestMeta || null);
      if (shouldSummarize) {
        const summarized = await summarizeDebugPayloads(withRequestMeta, {
          entryIndex,
          stage: 'translation'
        });
        debugParts.push(...summarized);
      } else {
        debugParts.push(...withRequestMeta);
      }
    }
    recordAiResponseMetrics(batchResult?.debugParts || []);
  }

  if (policy && resilienceKey) {
    policy.recordOutcome(resilienceKey, 'success');
  }

  return {
    success: true,
    translations,
    rawTranslation: rawParts.filter(Boolean).join('\n\n---\n\n'),
    debug: debugParts
  };
}

async function requestProofreading(payload) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const segmentTexts = segments.map((segment) =>
    typeof segment === 'string' ? segment : segment?.text || ''
  );
  const sourceBlock = payload?.sourceBlock || '';
  const translatedBlock = payload?.translatedBlock || '';
  const proofreadMode = payload?.proofreadMode || '';
  const contextMeta =
    payload?.contextMeta && typeof payload.contextMeta === 'object'
      ? payload.contextMeta
      : {
          contextText: payload?.context || '',
          contextMode: 'FULL',
          contextFullText: payload?.context || '',
          contextShortText: '',
          baseAnswer: '',
          baseAnswerIncluded: false,
          baseAnswerPreview: ''
        };
  const context = contextMeta.contextText || '';
  const requestMeta =
    payload?.requestMeta && typeof payload.requestMeta === 'object' ? payload.requestMeta : null;
  const policy = globalThis.ntResiliencePolicy;
  const resilienceKey = policy ? buildResilienceKey('proofread', requestMeta) : '';
  const policyState = policy?.getState?.(resilienceKey) || null;
  const patchedRequestOptions = policy?.applyModeToOptions
    ? policy.applyModeToOptions(policyState?.modeLevel || 0, payload?.requestOptions || null)
    : payload?.requestOptions || null;
  const resilienceContextMeta = applyResilienceToContext(contextMeta, patchedRequestOptions);
  const baseAnswer = resilienceContextMeta.baseAnswerIncluded ? resilienceContextMeta.baseAnswer || '' : '';
  const resolvedRequestMeta = requestMeta
    ? buildRequestMeta(requestMeta, {
        contextText: resilienceContextMeta.contextText || '',
        contextMode: resilienceContextMeta.contextMode
      })
    : null;
  const estimatedTokens = estimateTokensForRole('proofread', {
    texts: segmentTexts,
    context: [resilienceContextMeta.contextText || '', baseAnswer].filter(Boolean).join('\n'),
    sourceTexts: [sourceBlock, translatedBlock]
  });
  await ensureTpmBudget('proofread', estimatedTokens);
  recordHealthBatchSize('proofread', segments.length);
  const health = getHealthState();
  if (health) {
    health.proofreadCallsTotal += 1;
    schedulePersistDebugState('health:proofread-call');
  }
  const schedulerModel = schedulerModels.proofreadModel || '';
  await requestSchedulerSlot(
    'proofread',
    estimatedTokens,
    resolvedRequestMeta,
    schedulerModel,
    { batchSize: segments.length, contextMode: resilienceContextMeta.contextMode }
  );
  const requestStartedAt = Date.now();
  let schedulerOutcomeRecorded = false;
  const recordSchedulerOutcomeOnce = async (status) => {
    if (schedulerOutcomeRecorded) return;
    schedulerOutcomeRecorded = true;
    await recordSchedulerOutcome(
      'proofread',
      status,
      Date.now() - requestStartedAt,
      resolvedRequestMeta,
      schedulerModel
    );
  };
  try {
    const result = await withRateLimitRetry(
      async () => {
        await incrementDebugAiRequestCount();
        const response = await sendRuntimeMessage(
          {
            type: 'PROOFREAD_TEXT',
            segments,
            sourceBlock,
            translatedBlock,
            proofreadMode,
            context: {
              text: resilienceContextMeta.contextText || '',
              mode: resilienceContextMeta.contextMode,
              fullText: resilienceContextMeta.contextFullText || resilienceContextMeta.contextText || '',
              shortText: resilienceContextMeta.contextShortText || '',
              baseAnswer,
              baseAnswerIncluded: resilienceContextMeta.baseAnswerIncluded
            },
            language: payload?.language || '',
            requestMeta: resolvedRequestMeta || undefined,
            requestOptions: patchedRequestOptions || undefined
          },
          'Не удалось выполнить вычитку.'
        );
        if (!response?.success) {
          if (response?.contextOverflow) {
            return { success: false, contextOverflow: true, error: response.error || 'Контекст не помещается.' };
          }
          if (response?.isRuntimeError) {
            return { success: false, error: response.error || 'Не удалось выполнить вычитку.' };
          }
          const error = new Error(response?.error || 'Не удалось выполнить вычитку.');
          error.status = response?.status;
          error.healthRecorded = true;
          throw error;
        }
        recordAiResponseMetrics(response?.debug || []);
        const annotated = annotateContextUsage(response.debug || [], {
          contextMode: resilienceContextMeta.contextMode,
          baseAnswerIncluded: resilienceContextMeta.baseAnswerIncluded,
          baseAnswerPreview: resilienceContextMeta.baseAnswerPreview,
          contextTextSent: resilienceContextMeta.contextText || '',
          tag: resilienceContextMeta.tag
        });
        const withRequestMeta = annotateRequestMetadata(annotated, resolvedRequestMeta);
        const summarized = await summarizeDebugPayloads(withRequestMeta, {
          entryIndex: payload?.debugEntryIndex,
          stage: 'proofreading'
        });
        const translations = Array.isArray(response.translations) ? response.translations : null;
        if (!translations || translations.length !== segments.length) {
          logInvalidRpcResponse({
            stage: 'proofread',
            reason: 'invalid_response_shape',
            expectedCount: segments.length,
            receivedCount: translations ? translations.length : null,
            response
          });
          const invalidError = new Error('Invalid response shape');
          invalidError.isInvalidResponseShape = true;
          throw invalidError;
        }
        return {
          success: true,
          translations,
          rawProofread: response.rawProofread || '',
          debug: summarized
        };
      },
      'Proofreading'
    );
    await recordSchedulerOutcomeOnce(200);
    if (policy && resilienceKey) {
      policy.recordOutcome(resilienceKey, 'success');
    }
    return result;
  } catch (error) {
    await recordSchedulerOutcomeOnce(Number.isFinite(error?.status) ? error.status : null);
    if (!error?.healthRecorded) {
      recordHealthError(classifyResilienceError(error));
    }
    if (policy && resilienceKey) {
      const errorType = classifyResilienceError(error);
      policy.recordOutcome(resilienceKey, errorType, {
        errorType,
        errorMessage: error?.message || String(error)
      });
      if (policy.shouldEscalate(resilienceKey, errorType)) {
        policy.escalate(resilienceKey, errorType);
      }
    }
    throw error;
  } finally {
    if (!schedulerOutcomeRecorded) {
      await recordSchedulerOutcomeOnce(null);
    }
  }
}

function ensureRpcPort() {
  if (ntRpcPort) return ntRpcPort;
  try {
    ntRpcPort = chrome.runtime.connect({ name: NT_RPC_PORT_NAME });
    rpcPortCreatedAt = Date.now();
    globalThis.ntPageJsonLog?.({
      kind: 'rpc.port.ensure',
      pageUrl: window.location.href,
      rpcPortCreatedAt,
      reason: 'connect',
      ok: true
    });
  } catch (error) {
    console.warn('Failed to connect RPC port', error);
    globalThis.ntPageJsonLog?.({
      kind: 'rpc.port.ensure',
      pageUrl: window.location.href,
      rpcPortCreatedAt,
      reason: 'connect',
      ok: false,
      error: error?.message || String(error)
    });
    ntRpcPort = null;
    return null;
  }

  ntRpcPort.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const rpcId = msg.rpcId;
    if (typeof rpcId !== 'string') return;
    const entry = ntRpcPending.get(rpcId);
    if (!entry) return;
    ntRpcPending.delete(rpcId);
    clearTimeout(entry.timeoutId);
    const durationMs = entry.startedAt ? Date.now() - entry.startedAt : 0;
    globalThis.ntPageJsonLog?.({
      kind: 'rpc.response',
      rpcId,
      type: entry.type,
      response: msg.response,
      durationMs,
      ts: Date.now()
    });
    entry.resolve(msg.response);
  });

  ntRpcPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('RPC port disconnected', err?.message || '');
    globalThis.ntPageJsonLog?.({
      kind: 'rpc.disconnect',
      errorMessage: err?.message || 'RPC port disconnected',
      pendingCount: ntRpcPending.size,
      ts: Date.now()
    });
    for (const [rpcId, entry] of ntRpcPending.entries()) {
      clearTimeout(entry.timeoutId);
      entry.resolve({
        success: false,
        error: err?.message || 'RPC port disconnected',
        isRuntimeError: true,
        rpcUnavailable: true
      });
    }
    ntRpcPending.clear();
    ntRpcPort = null;
    rpcPortCreatedAt = 0;
  });

  return ntRpcPort;
}

function startRpcHeartbeat() {
  if (rpcHeartbeatTimer) return;
  rpcHeartbeatTimer = setInterval(() => {
    sendRpcRequest({ type: 'RPC_HEARTBEAT' }, 'RPC heartbeat failed', 2000, {
      allowRotate: false
    }).then(() => {});
  }, RPC_HEARTBEAT_INTERVAL_MS);
}

function stopRpcHeartbeat() {
  if (!rpcHeartbeatTimer) return;
  clearInterval(rpcHeartbeatTimer);
  rpcHeartbeatTimer = null;
}

function shouldRotateRpcPort(allowRotate = true) {
  return (
    allowRotate &&
    ntRpcPending.size === 0 &&
    rpcPortCreatedAt &&
    Date.now() - rpcPortCreatedAt > RPC_PORT_ROTATE_MS
  );
}

function rotateRpcPort(reason = '') {
  const ageMs = getRpcPortAgeMs();
  const pendingCount = ntRpcPending.size;
  if (ntRpcPort) {
    try {
      ntRpcPort.disconnect();
    } catch (error) {
      // ignore
    }
  }
  ntRpcPort = null;
  rpcPortCreatedAt = 0;
  if (typeof globalThis.ntPageJsonLog === 'function') {
    globalThis.ntPageJsonLog(
      {
        kind: 'rpc.port.rotate',
        pageUrl: window.location.href,
        reason,
        ageMs,
        pendingCount,
        ok: true,
        ts: Date.now()
      },
      'log'
    );
  } else {
    console.info('RPC port rotated', { reason, ageMs, pendingCount });
  }
}

function getRpcPortAgeMs() {
  return rpcPortCreatedAt ? Date.now() - rpcPortCreatedAt : 0;
}

function logRpcTimeout(payload) {
  const event = { kind: 'rpc.timeout', ...payload, ts: Date.now() };
  if (typeof globalThis.ntPageJsonLog === 'function') {
    globalThis.ntPageJsonLog(event, 'log');
  } else {
    console.info('RPC timeout', event);
  }
}

function sendRpcRequest(payload, fallbackError, timeoutMs, options = {}) {
  let rotated = false;
  if (shouldRotateRpcPort(options.allowRotate !== false)) {
    rotateRpcPort('age');
    rotated = true;
  }
  let port = ensureRpcPort();
  if (!port) {
    return Promise.resolve({
      success: false,
      error: fallbackError,
      isRuntimeError: true,
      rpcUnavailable: true,
      rpcRotated: rotated,
      rpcPortAgeMs: getRpcPortAgeMs()
    });
  }
  const rpcId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const requestStartedAt = Date.now();
  globalThis.ntPageJsonLog?.({
    kind: 'rpc.request',
    rpcId,
    type: payload?.type,
    payload,
    pageUrl: window.location.href,
    ts: requestStartedAt
  });
  return new Promise((resolve) => {
    let timeoutId = setTimeout(() => {
      ntRpcPending.delete(rpcId);
      logRpcTimeout({
        rpcId,
        type: payload?.type,
        timeoutMs,
        pendingCount: ntRpcPending.size,
        rpcPortAgeMs: getRpcPortAgeMs()
      });
      resolve({
        success: false,
        error: fallbackError || 'RPC timeout',
        isRuntimeError: true,
        isTimeout: true
      });
    }, timeoutMs);
    ntRpcPending.set(rpcId, { resolve, timeoutId, type: payload?.type, startedAt: requestStartedAt });
    try {
      port.postMessage({ rpcId, ...payload });
    } catch (error) {
      ntRpcPending.delete(rpcId);
      clearTimeout(timeoutId);
      console.warn('RPC postMessage failed', error);
      rotateRpcPort('postMessage-failed');
      rotated = true;
      port = ensureRpcPort();
      if (!port) {
        resolve({
          success: false,
          error: fallbackError,
          isRuntimeError: true,
          rpcUnavailable: true,
          rpcRotated: rotated,
          rpcPortAgeMs: getRpcPortAgeMs()
        });
        return;
      }
      const retryRpcId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const retryStartedAt = Date.now();
      globalThis.ntPageJsonLog?.({
        kind: 'rpc.request',
        rpcId: retryRpcId,
        type: payload?.type,
        payload,
        pageUrl: window.location.href,
        ts: retryStartedAt
      });
      timeoutId = setTimeout(() => {
        ntRpcPending.delete(retryRpcId);
        logRpcTimeout({
          rpcId: retryRpcId,
          type: payload?.type,
          timeoutMs,
          pendingCount: ntRpcPending.size,
          rpcPortAgeMs: getRpcPortAgeMs()
        });
        resolve({
          success: false,
          error: fallbackError || 'RPC timeout',
          isRuntimeError: true,
          isTimeout: true
        });
      }, timeoutMs);
      ntRpcPending.set(retryRpcId, { resolve, timeoutId, type: payload?.type, startedAt: retryStartedAt });
      try {
        port.postMessage({ rpcId: retryRpcId, ...payload });
      } catch (retryError) {
        ntRpcPending.delete(retryRpcId);
        clearTimeout(timeoutId);
        console.warn('RPC postMessage failed', retryError);
        resolve({
          success: false,
          error: fallbackError,
          isRuntimeError: true,
          rpcUnavailable: true,
          rpcRotated: rotated,
          rpcPortAgeMs: getRpcPortAgeMs()
        });
      }
    }
  });
}

function getSchedulerKey(opType, model) {
  return `${opType || 'unknown'}:${model || 'unknown'}`;
}

function getSchedulerQueueType(opType, requestMeta) {
  if (opType === 'proofread') return 'proofread';
  if (opType === 'context') return 'validate';
  const purpose = requestMeta?.purpose || '';
  if (purpose === 'ui') return 'uiTranslate';
  return 'contentTranslate';
}

async function requestSchedulerSlot(opType, estimatedTokens, requestMeta, model, options = {}) {
  const schedulerKey = getSchedulerKey(opType, model);
  const queueType = getSchedulerQueueType(opType, requestMeta);
  const batchSize = Number.isFinite(options?.batchSize) ? options.batchSize : null;
  const contextMode = options?.contextMode || requestMeta?.contextMode || '';
  const maxWaitMs = 30000;
  let waitedMs = 0;
  while (true) {
    const response = await sendRpcRequest(
      {
        type: 'SCHEDULER_REQUEST_SLOT',
        key: schedulerKey,
        estimatedTokens,
        queueType,
        opType,
        batchSize,
        contextMode
      },
      'SCHEDULER_REQUEST_SLOT failed',
      2000
    );
    if (response?.ok && response.allowed) {
      return { allowed: true, key: schedulerKey, queueType };
    }
    const waitMs = Math.min(response?.waitMs || 0, 5000);
    if (!waitMs || waitedMs + waitMs > maxWaitMs) {
      return { allowed: true, key: schedulerKey, queueType };
    }
    waitedMs += waitMs;
    await delay(waitMs + Math.floor(Math.random() * 200));
  }
}

async function recordSchedulerOutcome(opType, status, latencyMs, requestMeta, model) {
  const schedulerKey = getSchedulerKey(opType, model);
  const queueType = getSchedulerQueueType(opType, requestMeta);
  await sendRpcRequest(
    {
      type: 'SCHEDULER_RECORD_OUTCOME',
      key: schedulerKey,
      status,
      latencyMs,
      queueType
    },
    'SCHEDULER_RECORD_OUTCOME failed',
    2000
  );
}

function getRpcTimeoutMs(type) {
  if (type === 'TRANSLATE_TEXT') return 480000;
  if (type === 'GENERATE_CONTEXT') return 180000;
  if (type === 'PROOFREAD_TEXT') return 360000;
  return 30000;
}

async function sendRuntimeMessage(payload, fallbackError) {
  const timeoutMs = getRpcTimeoutMs(payload?.type);
  const rpcResponse = await sendRpcRequest(payload, fallbackError, timeoutMs);
  if (rpcResponse && typeof rpcResponse === 'object') {
    if (rpcResponse.rpcUnavailable) {
      console.warn('Falling back to runtime.sendMessage...', {
        type: payload?.type,
        reason: rpcResponse.error,
        rotated: Boolean(rpcResponse.rpcRotated),
        portAgeMs: rpcResponse.rpcPortAgeMs ?? getRpcPortAgeMs()
      });
      return sendRuntimeMessageLegacy(payload, fallbackError);
    }
    if (rpcResponse.success === false) {
      const errorType = isTimeoutLikeResponse(rpcResponse)
        ? 'timeout'
        : isRateLimitLikeError(rpcResponse)
          ? 'rate_limited'
          : 'other';
      recordHealthError(errorType);
    }
    return rpcResponse;
  }
  return {
    success: false,
    error: fallbackError,
    isRuntimeError: true
  };
}

function sendRuntimeMessageLegacy(payload, fallbackError) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        recordHealthError('other');
        resolve({
          success: false,
          error: runtimeError.message || fallbackError,
          isRuntimeError: true
        });
        return;
      }
      if (response?.success) {
        resolve(response);
        return;
      }
      recordHealthError(isTimeoutLikeResponse(response) ? 'timeout' : isRateLimitLikeError(response) ? 'rate_limited' : 'other');
      resolve({
        success: false,
        error: response?.error || fallbackError
      });
    });
  });
}

function parseRateLimitDelayMs(error) {
  const message = error?.message;
  if (!message) return null;
  const match = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*seconds/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1000, Math.round(seconds * 1000));
}

async function withRateLimitRetry(requestFn, label) {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      const delayMs = parseRateLimitDelayMs(error);
      if (!delayMs || attempt >= RATE_LIMIT_RETRY_ATTEMPTS || cancelRequested) {
        throw error;
      }
      attempt += 1;
      recordHealthRetry(delayMs);
      recordHealthError('rate_limited');
      console.warn(`${label} rate-limited, retrying after ${Math.ceil(delayMs / 1000)}s...`);
      await delay(delayMs);
    }
  }
}

function formatLogDetails(details) {
  if (details === null || details === undefined) return '';
  try {
    const serialized = JSON.stringify(details);
    return serialized ? ` ${serialized}` : '';
  } catch (error) {
    return ` ${String(details)}`;
  }
}

function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PUNCTUATION_TOKEN_REGEX = /⟦PUNC_[A-Z0-9_]+⟧/g;

function extractPunctuationTokens(text = '') {
  if (!text) return [];
  return text.match(PUNCTUATION_TOKEN_REGEX) || [];
}

function areTokenMultisetsEqual(leftTokens = [], rightTokens = []) {
  if (leftTokens.length !== rightTokens.length) return false;
  const counts = new Map();
  leftTokens.forEach((token) => counts.set(token, (counts.get(token) || 0) + 1));
  for (const token of rightTokens) {
    const current = counts.get(token);
    if (!current) return false;
    if (current === 1) {
      counts.delete(token);
    } else {
      counts.set(token, current - 1);
    }
  }
  return counts.size === 0;
}

function normalizeComparisonText(text = '') {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function buildProofreadComparisons({ originalTexts = [], beforeTexts = [], afterTexts = [] }) {
  const total = Math.max(originalTexts.length, beforeTexts.length, afterTexts.length);
  return Array.from({ length: total }, (_, index) => {
    const original = originalTexts[index] || '';
    const beforeDisplay = restorePunctuationTokens(
      applyOriginalFormatting(original, beforeTexts[index] || '')
    );
    const afterDisplay = restorePunctuationTokens(
      applyOriginalFormatting(original, afterTexts[index] || '')
    );
    const changed = normalizeComparisonText(beforeDisplay) !== normalizeComparisonText(afterDisplay);
    return {
      segmentIndex: index,
      before: beforeDisplay,
      after: afterDisplay,
      changed
    };
  });
}

function normalizeProofreadDebugPayloads(payloads, warnings) {
  const normalized = Array.isArray(payloads) ? payloads.map((payload) => ({ ...payload })) : [];
  if (!Array.isArray(warnings) || warnings.length === 0) return normalized;
  if (!normalized.length) {
    return [{ phase: 'PROOFREAD', parseIssues: warnings }];
  }
  const [first, ...rest] = normalized;
  const parseIssues = Array.isArray(first.parseIssues) ? [...first.parseIssues, ...warnings] : warnings;
  return [{ ...first, parseIssues }, ...rest];
}

function restorePunctuationTokens(text = '') {
  let output = text;
  for (const [punctuation, token] of PUNCTUATION_TOKENS.entries()) {
    const tokenRegex = new RegExp(escapeRegex(token), 'gi');
    output = output.replace(tokenRegex, punctuation);
  }
  return output;
}

function getLanguageScript(language = '') {
  const normalized = language.toLowerCase();
  if (normalized.startsWith('ru') || normalized.startsWith('uk') || normalized.startsWith('bg') ||
      normalized.startsWith('sr') || normalized.startsWith('mk')) {
    return 'cyrillic';
  }
  if (normalized.startsWith('ar')) return 'arabic';
  if (normalized.startsWith('he')) return 'hebrew';
  if (normalized.startsWith('hi')) return 'devanagari';
  if (normalized.startsWith('ja')) return 'japanese';
  if (normalized.startsWith('ko')) return 'hangul';
  if (normalized.startsWith('zh')) return 'han';
  return 'latin';
}

function countLettersByScript(text = '', script) {
  if (!text) return 0;
  switch (script) {
    case 'cyrillic':
      return (text.match(/[\p{Script=Cyrillic}]/gu) || []).length;
    case 'arabic':
      return (text.match(/[\p{Script=Arabic}]/gu) || []).length;
    case 'hebrew':
      return (text.match(/[\p{Script=Hebrew}]/gu) || []).length;
    case 'devanagari':
      return (text.match(/[\p{Script=Devanagari}]/gu) || []).length;
    case 'japanese':
      return (text.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu) || []).length;
    case 'hangul':
      return (text.match(/[\p{Script=Hangul}]/gu) || []).length;
    case 'han':
      return (text.match(/[\p{Script=Han}]/gu) || []).length;
    case 'latin':
    default:
      return (text.match(/[\p{Script=Latin}]/gu) || []).length;
  }
}

function countLetters(text = '') {
  return (text.match(/[\p{L}]/gu) || []).length;
}

function hasSuspiciousLanguageMix(text = '', targetLanguage = '') {
  const totalLetters = countLetters(text);
  if (!totalLetters) return false;
  const targetScript = getLanguageScript(targetLanguage);
  const targetLetters = countLettersByScript(text, targetScript);
  const ratio = targetLetters / totalLetters;
  return ratio < 1 - PROOFREAD_SUSPICIOUS_RATIO;
}

function hasProofreadNoise(text = '') {
  if (!text) return false;
  if (/\s{2,}/.test(text)) return true;
  if (/([!?.,])\1{2,}/.test(text)) return true;
  if (/[^\S\n]{2,}/.test(text)) return true;
  if (/[{}<>]{2,}/.test(text)) return true;
  return false;
}

function shouldProofreadSegment(text = '', targetLanguage = '') {
  if (!text) return false;
  return hasProofreadNoise(text) || hasSuspiciousLanguageMix(text, targetLanguage);
}

function detectProofreadMode(segments, targetLanguage = '') {
  const list = Array.isArray(segments) ? segments : [];
  const hasNoise = list.some((segment) =>
    shouldProofreadSegment(typeof segment === 'string' ? segment : segment?.text || '', targetLanguage)
  );
  return hasNoise ? 'NOISE_CLEANUP' : 'READABILITY_REWRITE';
}

function normalizeProofreadMode(mode) {
  if (mode === 'always' || mode === 'never' || mode === 'auto') return mode;
  return 'auto';
}

const proofreadAutoSavings = {
  skippedBatchesCount: 0,
  skippedSegmentsCount: 0,
  proofreadCallsAvoidedEstimate: 0
};

function logProofreadAutoDecision(payload) {
  if (typeof globalThis.ntPageJsonLog !== 'function') return;
  globalThis.ntPageJsonLog(
    {
      kind: 'proofread.auto.decision',
      ts: Date.now(),
      ...payload
    },
    'log'
  );
}

function logProofreadAutoSavings() {
  if (typeof globalThis.ntPageJsonLog !== 'function') return;
  globalThis.ntPageJsonLog(
    {
      kind: 'proofread.auto.savings',
      ts: Date.now(),
      skippedBatchesCount: proofreadAutoSavings.skippedBatchesCount,
      skippedSegmentsCount: proofreadAutoSavings.skippedSegmentsCount,
      proofreadCallsAvoidedEstimate: proofreadAutoSavings.proofreadCallsAvoidedEstimate
    },
    'log'
  );
}

function selectProofreadSegmentsForAuto(decision, proofreadSegments) {
  const scores = Array.isArray(decision?.segmentScores) ? decision.segmentScores : [];
  const totalSegments = proofreadSegments.length;
  const thresholds = decision?.thresholds || {};
  const partialMax = Number.isFinite(thresholds.partialMax) ? thresholds.partialMax : 25;
  if (!scores.length || decision.score > partialMax) {
    return { mode: 'full', segments: proofreadSegments };
  }
  const criticalSegments = scores.filter((entry) => entry.critical);
  if (criticalSegments.length >= Math.ceil(totalSegments * 0.3)) {
    return { mode: 'full', segments: proofreadSegments };
  }
  const ordered = scores
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  const minCount = Math.min(
    totalSegments,
    Math.min(Math.max(3, Math.ceil(totalSegments * 0.2)), 20)
  );
  const selectedIndexes = new Set(
    ordered.slice(0, Math.min(minCount, ordered.length)).map((entry) => entry.index)
  );
  if (!selectedIndexes.size) {
    return { mode: 'full', segments: proofreadSegments };
  }
  const selectedSegments = proofreadSegments.filter((segment, index) => selectedIndexes.has(index));
  return { mode: 'partial', segments: selectedSegments };
}

function decideProofreadBatch({ mode, targetLang, originalTexts, translatedTexts, blockMeta }) {
  const heuristicsFn = globalThis.ntProofreadHeuristics?.shouldProofreadBatch;
  if (typeof heuristicsFn !== 'function') {
    return {
      run: mode !== 'never',
      reasons: ['heuristics_missing'],
      score: 0,
      stats: {},
      segmentScores: [],
      thresholds: { run: 0, partialMax: 0 }
    };
  }
  return heuristicsFn({
    targetLang,
    texts: originalTexts,
    translations: translatedTexts,
    blockMeta
  });
}

async function maybeQueueProofread({
  block,
  index,
  key,
  blockElement,
  translatedTexts,
  originalTexts,
  uiMode,
  uiLike,
  settings
}) {
  if (!settings.proofreadEnabled) {
    return;
  }
  if (uiMode) {
    return;
  }
  const proofreadSegments = translatedTexts.map((text, segmentIndex) => ({ id: String(segmentIndex), text }));
  const proofreadMode = detectProofreadMode(proofreadSegments, settings.targetLanguage || 'ru');
  if (!proofreadSegments.length) {
    await updateDebugEntry(index + 1, {
      proofreadStatus: 'done',
      proofread: [],
      proofreadComparisons: [],
      proofreadExecuted: false,
      proofreadCompletedAt: Date.now()
    });
    return;
  }
  const effectiveMode = normalizeProofreadMode(settings.proofreadMode);
  const decision = decideProofreadBatch({
    mode: effectiveMode,
    targetLang: settings.targetLanguage || 'ru',
    originalTexts,
    translatedTexts,
    blockMeta: { uiMode, uiLike, host: location.host }
  });
  const hasCritical = Array.isArray(decision.segmentScores) && decision.segmentScores.some((entry) => entry.critical);
  let runProofread = false;
  if (effectiveMode === 'always') {
    runProofread = true;
  } else if (effectiveMode === 'never') {
    runProofread = hasCritical;
  } else {
    runProofread = Boolean(decision.run);
  }

  let selectionMode = 'full';
  let selectedSegments = proofreadSegments;
  if (runProofread && effectiveMode === 'auto') {
    const selection = selectProofreadSegmentsForAuto(decision, proofreadSegments);
    selectionMode = selection.mode;
    selectedSegments = selection.segments;
  }
  if (runProofread && !selectedSegments.length) {
    runProofread = false;
    selectionMode = 'none';
  }

  logProofreadAutoDecision({
    mode: effectiveMode,
    run: runProofread,
    score: decision.score || 0,
    reasons: decision.reasons || [],
    totalSegments: proofreadSegments.length,
    selectedSegments: runProofread ? selectedSegments.length : 0,
    uiMode,
    host: location.host
  });

  if (!runProofread) {
    proofreadAutoSavings.skippedBatchesCount += 1;
    proofreadAutoSavings.skippedSegmentsCount += proofreadSegments.length;
    proofreadAutoSavings.proofreadCallsAvoidedEstimate += 1;
    logProofreadAutoSavings();
    await updateDebugEntry(index + 1, {
      proofreadStatus: 'disabled',
      proofreadApplied: false,
      proofread: [],
      proofreadComparisons: [],
      proofreadExecuted: false,
      proofreadCompletedAt: Date.now()
    });
    return;
  }

  if (selectionMode === 'partial') {
    proofreadAutoSavings.skippedSegmentsCount += Math.max(0, proofreadSegments.length - selectedSegments.length);
    logProofreadAutoSavings();
  }

  enqueueProofreadTask({
    block,
    index,
    key,
    blockElement,
    translatedTexts,
    originalTexts,
    proofreadSegments: selectedSegments,
    proofreadMode
  });
}

async function requestTranslationContext(text, targetLanguage, requestMeta = null) {
  const estimatedTokens = estimateTokensForRole('context', {
    texts: [text]
  });
  await ensureTpmBudget('context', estimatedTokens);
  await incrementDebugAiRequestCount();
  const response = await sendRuntimeMessage(
    {
      type: 'GENERATE_CONTEXT',
      text,
      targetLanguage,
      requestMeta: requestMeta || undefined
    },
    'Не удалось сгенерировать контекст.'
  );
  if (!response?.success) {
    if (response?.isRuntimeError) {
      return '';
    }
    throw new Error(response?.error || 'Не удалось сгенерировать контекст.');
  }
  recordAiResponseMetrics(response?.debug || []);
  return response.context || '';
}

async function requestShortContext(text, targetLanguage, requestMeta = null) {
  const estimatedTokens = estimateTokensForRole('context', {
    texts: [text]
  });
  await ensureTpmBudget('context', estimatedTokens);
  await incrementDebugAiRequestCount();
  const response = await sendRuntimeMessage(
    {
      type: 'GENERATE_SHORT_CONTEXT',
      text,
      targetLanguage,
      requestMeta: requestMeta || undefined
    },
    'Не удалось сгенерировать короткий контекст.'
  );
  if (!response?.success) {
    if (response?.isRuntimeError) {
      return '';
    }
    throw new Error(response?.error || 'Не удалось сгенерировать короткий контекст.');
  }
  recordAiResponseMetrics(response?.debug || []);
  return normalizeShortContext(response.context || '', {
    url: requestMeta?.url || location.href,
    mode: 'SHORT'
  });
}

function deduplicateTexts(texts) {
  const uniqueTexts = [];
  const indexMap = [];
  const seen = new Map();

  texts.forEach((text) => {
    if (!seen.has(text)) {
      seen.set(text, uniqueTexts.length);
      uniqueTexts.push(text);
    }
    indexMap.push(seen.get(text));
  });

  return { uniqueTexts, indexMap };
}

function normalizeUiText(text = '') {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function isUiKeywordMatch(text) {
  if (!text) return false;
  const normalized = normalizeUiText(text).toLowerCase();
  if (!normalized) return false;
  return UI_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function isUiBlock(blockElement, blockTexts = []) {
  if (!blockElement) return false;
  const element = blockElement;
  if (
    element.closest?.('header, nav, footer, aside, form, button, select, option, label') ||
    element.closest?.('[role="navigation"],[role="banner"],[role="contentinfo"],[role="menu"],[role="button"]')
  ) {
    return true;
  }

  const idClass = `${element.id || ''} ${element.className || ''}`.toLowerCase();
  if (/(nav|menu|header|footer|sidebar|toolbar)/.test(idClass)) {
    return true;
  }

  const normalizedTexts = blockTexts.map((text) => normalizeUiText(text)).filter(Boolean);
  if (normalizedTexts.some((text) => isUiKeywordMatch(text))) {
    return true;
  }

  const averageLength =
    normalizedTexts.length
      ? normalizedTexts.reduce((sum, text) => sum + text.length, 0) / normalizedTexts.length
      : 0;
  const hasNewlines = blockTexts.some((text) => String(text || '').includes('\n'));
  const punctuationCount = normalizedTexts.reduce(
    (sum, text) => sum + (text.match(/[.!?;:]/g) || []).length,
    0
  );
  if (!hasNewlines && averageLength > 0 && averageLength <= 40 && punctuationCount <= 1) {
    return true;
  }

  return false;
}

function collectTextNodes(root, stats, recordNote) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (stats) {
        stats.scannedTextNodes += 1;
      }
      const value = node.nodeValue ?? '';
      if (!value.length) {
        if (stats?.filtered) stats.filtered.empty += 1;
        return NodeFilter.FILTER_REJECT;
      }
      if (!value.trim()) {
        if (stats?.filtered) stats.filtered.whitespaceOnly += 1;
        return NodeFilter.FILTER_REJECT;
      }
      if (stats) {
        stats.nonEmptyTextNodes += 1;
      }
      const parent = node.parentNode;
      if (!parent) {
        if (stats?.filtered) stats.filtered.other += 1;
        if (typeof recordNote === 'function') recordNote('missing-parent');
        return NodeFilter.FILTER_REJECT;
      }
      const tag = parent.nodeName.toLowerCase();
      if (['script', 'style', 'noscript'].includes(tag)) {
        if (stats?.filtered) stats.filtered.inScriptStyle += 1;
        return NodeFilter.FILTER_REJECT;
      }
      if (['code', 'pre'].includes(tag)) {
        if (stats?.filtered) stats.filtered.nonTranslatableTag += 1;
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}

function groupTextNodesByBlock(nodesWithPath) {
  const blocks = [];
  let currentBlock = null;
  let currentBlockElement = null;

  nodesWithPath.forEach((entry) => {
    const blockElement = findBlockAncestor(entry.node);
    entry.blockElement = blockElement;
    if (blockElement !== currentBlockElement) {
      currentBlockElement = blockElement;
      currentBlock = [];
      blocks.push(currentBlock);
    }
    currentBlock.push(entry);
  });

  return blocks;
}

function findBlockAncestor(node) {
  let current = node.parentNode;
  while (current && current !== document.body) {
    if (isBlockElement(current)) return current;
    current = current.parentNode;
  }
  return document.body;
}

function isBlockElement(element) {
  const tag = element.nodeName.toLowerCase();
  const blockTags = new Set([
    'p',
    'div',
    'section',
    'article',
    'header',
    'footer',
    'aside',
    'main',
    'nav',
    'li',
    'ul',
    'ol',
    'pre',
    'blockquote',
    'figure',
    'figcaption'
  ]);
  if (blockTags.has(tag)) return true;

  const display = window.getComputedStyle(element)?.display || '';
  return ['block', 'flex', 'grid', 'table', 'list-item', 'flow-root'].some((value) => display.includes(value));
}

function calculateTextLengthStats(nodesWithPath) {
  const totalLength = nodesWithPath.reduce(
    (sum, { node }) => sum + (node?.nodeValue?.length || 0),
    0
  );
  const averageNodeLength = nodesWithPath.length ? totalLength / nodesWithPath.length : 0;
  return { totalLength, averageNodeLength };
}

function calculateMaxBlockLength(averageNodeLength) {
  const scaled = averageNodeLength * 6;
  return Math.min(1500, Math.max(800, Math.round(scaled || 0)));
}

function normalizeBlockLength(limit, averageNodeLength) {
  const parsed = Number(limit);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return calculateMaxBlockLength(averageNodeLength);
}

function selectInitialConcurrency(averageBlockLength, blockCount) {
  let concurrency;
  if (averageBlockLength >= 1300) {
    concurrency = 1;
  } else if (averageBlockLength >= 1100) {
    concurrency = 2;
  } else if (averageBlockLength >= 900) {
    concurrency = 3;
  } else {
    concurrency = 4;
  }

  return Math.min(Math.max(concurrency, 1), Math.max(1, blockCount));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configureTpmLimiter(settings = {}) {
  const limitsByRole = settings?.tpmLimitsByRole || {};
  tpmSettings = {
    outputRatioByRole: {
      ...tpmSettings.outputRatioByRole,
      ...(settings?.outputRatioByRole || {})
    },
    safetyBufferTokens: Number.isFinite(settings?.tpmSafetyBufferTokens)
      ? settings.tpmSafetyBufferTokens
      : tpmSettings.safetyBufferTokens
  };
  tpmLimiter = createTpmLimiter(limitsByRole, tpmSettings.safetyBufferTokens);
}

function createTpmLimiter(limitsByRole = {}, safetyBufferTokens = 0) {
  const entriesByRole = new Map();
  const windowMs = 60000;

  const getEntries = (role) => {
    if (!entriesByRole.has(role)) {
      entriesByRole.set(role, []);
    }
    return entriesByRole.get(role);
  };

  const prune = (role, now) => {
    const entries = getEntries(role);
    while (entries.length && entries[0].timestamp <= now - windowMs) {
      entries.shift();
    }
  };

  const getUsedTokens = (role, now) => {
    prune(role, now);
    const entries = getEntries(role);
    return entries.reduce((sum, entry) => sum + entry.tokens, 0);
  };

  const recordUsage = (role, tokens, now) => {
    const entries = getEntries(role);
    entries.push({ timestamp: now, tokens });
  };

  const getNextAvailableDelay = (role, now) => {
    const entries = getEntries(role);
    if (!entries.length) return 0;
    const earliest = entries[0];
    const expiresAt = earliest.timestamp + windowMs;
    return Math.max(25, expiresAt - now + 25);
  };

  const waitForBudget = async (role, tokens) => {
    const limit = Number(limitsByRole?.[role]);
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    const bufferedLimit = Math.max(0, limit - safetyBufferTokens);
    if (tokens > bufferedLimit) {
      recordUsage(role, tokens, Date.now());
      return;
    }

    while (true) {
      const now = Date.now();
      const used = getUsedTokens(role, now);
      if (used + tokens <= bufferedLimit) {
        recordUsage(role, tokens, now);
        return;
      }
      const waitMs = getNextAvailableDelay(role, now);
      await delay(waitMs || 50);
    }
  };

  return { waitForBudget };
}

function estimateTokensForRole(role, { texts = [], context = '', sourceTexts = [] } = {}) {
  const allTexts = Array.isArray(texts) ? texts : [texts];
  const allSources = Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts];
  const inputChars = [context, ...allTexts, ...allSources]
    .filter((item) => typeof item === 'string' && item.length)
    .reduce((sum, item) => sum + item.length, 0);
  const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
  const ratio = Number(tpmSettings?.outputRatioByRole?.[role]);
  const outputRatio = Number.isFinite(ratio) ? ratio : 0.5;
  const estimatedOutput = Math.ceil(inputTokens * outputRatio);
  return inputTokens + estimatedOutput;
}

function splitTextsByTokenEstimate(texts, context, maxTokens) {
  const targetTokens =
    Number.isFinite(translationMicrobatchTargetTokens) && translationMicrobatchTargetTokens > 0
      ? translationMicrobatchTargetTokens
      : TRANSLATION_MICROBATCH_TARGET_TOKENS;
  const maxItems =
    Number.isFinite(translationMicrobatchMaxItems) && translationMicrobatchMaxItems > 0
      ? translationMicrobatchMaxItems
      : 0;
  const batches = [];
  let current = [];
  let currentTokensTotal = 0;
  let currentTokensNoContext = 0;

  texts.forEach((text, index) => {
    if (current.length && maxItems && current.length >= maxItems) {
      batches.push(current);
      current = [];
      currentTokensTotal = 0;
      currentTokensNoContext = 0;
    }
    const nextTotal = estimateTokensForRole('translation', {
      texts: [text],
      context: current.length ? '' : context
    });
    const nextNoCtx = estimateTokensForRole('translation', {
      texts: [text],
      context: ''
    });
    if (current.length && currentTokensTotal + nextTotal > maxTokens) {
      batches.push(current);
      current = [];
      currentTokensTotal = 0;
      currentTokensNoContext = 0;
    }
    current.push(text);
    currentTokensTotal += nextTotal;
    currentTokensNoContext += nextNoCtx;
    const isLast = index === texts.length - 1;
    if (!isLast && maxItems && current.length >= maxItems) {
      batches.push(current);
      current = [];
      currentTokensTotal = 0;
      currentTokensNoContext = 0;
      return;
    }
    if (!isLast && targetTokens && currentTokensNoContext >= targetTokens) {
      batches.push(current);
      current = [];
      currentTokensTotal = 0;
      currentTokensNoContext = 0;
    }
  });

  if (current.length) {
    batches.push(current);
  }

  return batches;
}

async function ensureTpmBudget(role, tokens) {
  if (!tpmLimiter || !Number.isFinite(tokens) || tokens <= 0) {
    return;
  }
  await tpmLimiter.waitForBudget(role, tokens);
}

function recalculateBlockCount(blockLengthLimit) {
  if (translationInProgress) {
    return { updated: false, totalBlocks: translationProgress.totalBlocks || 0 };
  }
  const textNodes = collectTextNodes(document.body);
  const nodesWithPath = textNodes.map((node) => ({
    node,
    path: getNodePath(node),
    original: node.nodeValue,
    originalHash: computeTextHash(node.nodeValue || '')
  }));
  const textStats = calculateTextLengthStats(nodesWithPath);
  const maxBlockLength = normalizeBlockLength(blockLengthLimit, textStats.averageNodeLength);
  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const blocks = normalizeBlocksByLength(blockGroups, maxBlockLength);
  translationProgress = { completedBlocks: 0, totalBlocks: blocks.length };
  if (!blocks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return { updated: true, totalBlocks: 0, message: 'Перевод не требуется' };
  }
  reportProgress('Готово к переводу', 0, blocks.length, 0);
  return { updated: true, totalBlocks: blocks.length, message: 'Готово к переводу' };
}

function normalizeBlocksByLength(blocks, maxLength) {
  const normalized = [];
  blocks.forEach((block) => {
    if (block.length) {
      normalized.push(block);
    }
  });

  return mergeAdjacentBlocksByLength(normalized, maxLength);
}

function mergeAdjacentBlocksByLength(blocks, maxLength) {
  const merged = [];
  let current = [];
  let currentLength = 0;

  blocks.forEach((block) => {
    const blockLength = getBlockLength(block);
    if (!current.length) {
      current = block.slice();
      currentLength = blockLength;
      return;
    }

    if (currentLength + blockLength <= maxLength) {
      current.push(...block);
      currentLength += blockLength;
      return;
    }

    merged.push(current);
    current = block.slice();
    currentLength = blockLength;
  });

  if (current.length) merged.push(current);
  return merged;
}

function getBlockLength(block) {
  return block.reduce((sum, entry) => sum + (entry.node.nodeValue?.length || 0), 0);
}

function buildPageText(nodesWithPath, maxLength) {
  const combined = nodesWithPath
    .map(({ node }) => node?.nodeValue || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!combined) return '';
  if (!maxLength || combined.length <= maxLength) return combined;
  return combined.slice(0, maxLength).trimEnd();
}

function buildHeadingSignature() {
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((node) => node.textContent || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return headings;
}

function buildContextCacheSignature(nodesWithPath) {
  const headingText = buildHeadingSignature();
  const pageSample = buildPageText(nodesWithPath, 2000);
  const signatureSource = [location.href, document.title || '', headingText, pageSample].join('||');
  return computeTextHash(signatureSource);
}

function buildContextStateSignature(contextCacheSignature, settings) {
  return JSON.stringify({
    cache: contextCacheSignature,
    contextModel: settings?.contextModel || '',
    targetLanguage: settings?.targetLanguage || '',
    contextGenerationEnabled: Boolean(settings?.contextGenerationEnabled)
  });
}

function primeContextState(state, signature, text) {
  if (state.signature !== signature) {
    state.signature = signature;
    state.status = 'empty';
    state.text = '';
    state.promise = null;
  }
  if (text) {
    state.status = 'ready';
    state.text = text;
    state.promise = null;
  }
}

function getOrBuildContext({ state, signature, build }) {
  if (state.signature !== signature) {
    state.signature = signature;
    state.status = 'empty';
    state.text = '';
    state.promise = null;
  }
  if (state.status === 'ready') {
    return { started: false, promise: Promise.resolve(state.text), text: state.text };
  }
  if (state.status === 'building' && state.promise) {
    return { started: false, promise: state.promise, text: state.text };
  }
  state.status = 'building';
  state.promise = Promise.resolve()
    .then(() => build())
    .then((text) => {
      state.text = text || '';
      state.status = 'ready';
      state.promise = null;
      return state.text;
    })
    .catch((error) => {
      state.status = 'error';
      state.promise = null;
      throw error;
    });
  return { started: true, promise: state.promise, text: state.text };
}

async function getContextCacheEntry(key) {
  if (!key) return null;
  const store = await new Promise((resolve) => {
    chrome.storage.local.get([CONTEXT_CACHE_KEY], (data) => {
      resolve(data?.[CONTEXT_CACHE_KEY] || {});
    });
  });
  const entry = store[key] || null;
  if (!entry) return null;
  const fullRecord = entry.contextFullRefId ? await fetchDebugRawSafe(entry.contextFullRefId) : null;
  const shortRecord = entry.contextShortRefId ? await fetchDebugRawSafe(entry.contextShortRefId) : null;
  return {
    ...entry,
    contextFull: fullRecord?.value?.text || '',
    contextShort: shortRecord?.value?.text || '',
    context: fullRecord?.value?.text || ''
  };
}

async function setContextCacheEntry(key, entry) {
  if (!key) return;
  const store = await new Promise((resolve) => {
    chrome.storage.local.get([CONTEXT_CACHE_KEY], (data) => {
      resolve(data?.[CONTEXT_CACHE_KEY] || {});
    });
  });
  const contextFullText = typeof entry?.contextFull === 'string' ? entry.contextFull : entry?.context || '';
  const contextShortText = typeof entry?.contextShort === 'string' ? entry.contextShort : '';
  const fullId = contextFullText ? `context:${key}:full` : '';
  const shortId = contextShortText ? `context:${key}:short` : '';
  if (fullId) {
    await storeDebugRawSafe({
      id: fullId,
      ts: Date.now(),
      value: { type: 'context', text: truncateText(contextFullText, DEBUG_RAW_MAX_CHARS).text }
    });
  }
  if (shortId) {
    await storeDebugRawSafe({
      id: shortId,
      ts: Date.now(),
      value: { type: 'context', text: truncateText(contextShortText, DEBUG_RAW_MAX_CHARS).text }
    });
  }
  const previewFull = { text: contextFullText, truncated: false };
  const previewShort = { text: contextShortText, truncated: false };
  store[key] = {
    ...entry,
    contextFull: previewFull.text,
    contextShort: previewShort.text,
    context: previewFull.text,
    contextFullRefId: fullId || entry?.contextFullRefId || '',
    contextShortRefId: shortId || entry?.contextShortRefId || '',
    contextFullTruncated: previewFull.truncated,
    contextShortTruncated: previewShort.truncated
  };
  try {
    await chrome.storage.local.set({ [CONTEXT_CACHE_KEY]: store });
  } catch (error) {
    appendDebugEvent(CALL_TAGS.STORAGE_DROPPED, error?.message || 'context-cache-write-failed');
  }
}

function formatBlockText(texts) {
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

function logInvalidRpcResponse({ stage, reason, expectedCount, receivedCount, response } = {}) {
  const payload = {
    kind: 'rpc.response.invalid',
    ts: Date.now(),
    stage: stage || 'unknown',
    reason: reason || 'invalid_response_shape',
    expectedCount: Number.isFinite(expectedCount) ? expectedCount : null,
    receivedCount: Number.isFinite(receivedCount) ? receivedCount : null,
    responseKeys:
      response && typeof response === 'object' && !Array.isArray(response)
        ? Object.keys(response)
        : null
  };
  if (typeof globalThis.ntPageJsonLog === 'function') {
    globalThis.ntPageJsonLog(payload, 'log');
  } else {
    console.info('RPC response invalid', payload);
  }
}

function buildShortContextFallback(context = '') {
  if (!context) return '';
  const normalized = typeof context === 'string' ? context : String(context ?? '');
  return normalized.trimEnd();
}

function reportLastError(stage, reason, error) {
  if (!currentTabIdForProgress) return;
  const message = error?.message || String(error || '');
  void sendBackgroundMessageSafe({
    type: 'NT_REPORT_ERROR',
    tabId: currentTabIdForProgress,
    channel: 'page',
    stage,
    reason,
    message
  });
}

function reportProgress(message, completedBlocks, totalBlocks, inProgressBlocks = 0, options = {}) {
  const snapshot = getProgressSnapshot();
  const resolvedCompleted = Number.isFinite(snapshot?.completedBlocks)
    ? snapshot.completedBlocks
    : completedBlocks || 0;
  const resolvedTotal = Number.isFinite(snapshot?.totalBlocks) ? snapshot.totalBlocks : totalBlocks || 0;
  const resolvedInProgress = Number.isFinite(snapshot?.inProgressBlocks)
    ? snapshot.inProgressBlocks
    : inProgressBlocks || 0;
  const resolvedFailed = Number.isFinite(snapshot?.failedBlocks) ? snapshot.failedBlocks : 0;
  const resolvedDone = Math.max(0, resolvedCompleted - resolvedFailed);
  const resolvedQueued = Math.max(
    0,
    resolvedTotal - resolvedDone - resolvedFailed - resolvedInProgress
  );
  translationProgress = {
    completedBlocks: resolvedCompleted,
    totalBlocks: resolvedTotal,
    inProgressBlocks: resolvedInProgress
  };
  if (currentTabIdForProgress) {
    void sendBackgroundMessageSafe({
      type: 'NT_SET_TOTAL',
      tabId: currentTabIdForProgress,
      channel: 'page',
      reason: options?.reason,
      totals: {
        total: resolvedTotal,
        done: resolvedDone,
        failed: resolvedFailed,
        inFlight: resolvedInProgress,
        queued: resolvedQueued
      }
    });
  }
  void sendBackgroundMessageSafe({
    type: 'TRANSLATION_PROGRESS',
    message,
    completedBlocks: resolvedCompleted,
    totalBlocks: resolvedTotal,
    inProgressBlocks: resolvedInProgress
  });
}

function annotateContextUsage(payloads, { contextMode, baseAnswerIncluded, baseAnswerPreview, contextTextSent, tag }) {
  return (Array.isArray(payloads) ? payloads : []).map((payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    const existingContextMode = payload.contextMode;
    const contextTypeUsed =
      payload.contextTypeUsed ||
      (typeof existingContextMode === 'string' && ['FULL', 'SHORT'].includes(existingContextMode.toUpperCase())
        ? existingContextMode
        : '') ||
      contextMode;
    return {
      ...payload,
      contextTypeUsed,
      baseAnswerIncluded: payload.baseAnswerIncluded ?? baseAnswerIncluded,
      baseAnswerPreview: payload.baseAnswerPreview ?? baseAnswerPreview,
      contextTextSent: payload.contextTextSent ?? contextTextSent,
      tag: payload.tag || tag
    };
  });
}

function buildContextOverflowDebugPayload({
  phase,
  model,
  errorMessage,
  contextMode,
  contextTextSent,
  baseAnswerIncluded,
  tag,
  requestMeta
}) {
  const payload = {
    phase,
    model: model || '—',
    latencyMs: null,
    usage: null,
    inputChars: contextTextSent?.length || 0,
    outputChars: 0,
    request: null,
    response: errorMessage || 'fullContext overflow/error',
    parseIssues: ['fullContext overflow/error'],
    contextTypeUsed: contextMode,
    baseAnswerIncluded,
    contextTextSent,
    tag
  };
  const [annotated] = annotateRequestMetadata([payload], requestMeta || {});
  return annotated || payload;
}

async function createDebugPayloadSummary(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const entryIndex = Number.isFinite(options.entryIndex) ? options.entryIndex : null;
  const stage = options.stage === 'proofreading' ? 'proofreading' : 'translation';
  const callId = `${debugSessionId || 'session'}:${stage}:${entryIndex ?? 'unknown'}:${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
  const requestPayload = buildRawPayload(payload.request);
  const responsePayload = buildRawPayload(payload.response);
  const contextPayload = buildRawPayload(payload.contextTextSent);
  const hasRaw = Boolean(requestPayload.rawText || responsePayload.rawText || contextPayload.rawText);
  if (hasRaw) {
    await storeDebugRawSafe({
      id: callId,
      ts: Date.now(),
      value: {
        type: 'call',
        request: requestPayload.rawText,
        response: responsePayload.rawText,
        contextTextSent: contextPayload.rawText
      }
    });
  }
  const summary = {
    ...payload,
    request: requestPayload.previewText,
    response: responsePayload.previewText,
    contextTextSent: contextPayload.previewText,
    ts: Date.now(),
    rawRefId: hasRaw ? callId : '',
    requestTruncated: requestPayload.previewTruncated,
    responseTruncated: responsePayload.previewTruncated,
    contextTruncated: contextPayload.previewTruncated,
    rawTruncated: requestPayload.rawTruncated || responsePayload.rawTruncated || contextPayload.rawTruncated
  };
  if (entryIndex) {
    appendCallRecord(entryIndex, stage, summary);
  }
  return summary;
}

async function prepareRawTextField(value, type) {
  const serialized = serializeRawValue(value);
  if (!serialized) {
    return { preview: '', refId: '', truncated: false, rawTruncated: false };
  }
  const payload = buildRawPayload(serialized);
  const refId = `${debugSessionId || 'session'}:${type}:${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await storeDebugRawSafe({
    id: refId,
    ts: Date.now(),
    value: { type, response: payload.rawText }
  });
  return {
    preview: payload.previewText,
    refId,
    truncated: payload.previewTruncated,
    rawTruncated: payload.rawTruncated
  };
}

async function summarizeDebugPayloads(payloads, { entryIndex, stage } = {}) {
  const list = Array.isArray(payloads) ? payloads : [];
  const summarized = [];
  for (const payload of list) {
    summarized.push(await createDebugPayloadSummary(payload, { entryIndex, stage }));
  }
  return summarized;
}

function getProgressSnapshot() {
  if (Array.isArray(debugEntries) && debugEntries.length) {
    return computeTranslationProgress(debugEntries);
  }
  return null;
}

function computeTranslationProgress(entries) {
  const totalBlocks = entries.length;
  let completedBlocks = 0;
  let inProgressBlocks = 0;
  let failedBlocks = 0;

  entries.forEach((entry) => {
    const status = getOverallEntryStatus(entry);
    if (status === 'done') {
      completedBlocks += 1;
    } else if (status === 'in_progress') {
      inProgressBlocks += 1;
    } else if (status === 'failed') {
      failedBlocks += 1;
      completedBlocks += 1;
    }
  });

  return {
    completedBlocks,
    totalBlocks,
    inProgressBlocks,
    failedBlocks
  };
}

function getOverallEntryStatus(entry) {
  if (!entry) return 'pending';
  const translationStatus = normalizeEntryStatus(entry.translationStatus, entry.translated);
  const proofreadApplied = entry.proofreadApplied !== false;
  const proofreadStatus = normalizeEntryStatus(
    entry.proofreadStatus,
    entry.proofread,
    proofreadApplied
  );

  if (translationStatus === 'failed') return 'failed';
  if (proofreadApplied) {
    if (proofreadStatus === 'failed') return 'failed';
    if (translationStatus === 'done' && proofreadStatus === 'done') return 'done';
    if (translationStatus === 'in_progress' || proofreadStatus === 'in_progress') return 'in_progress';
    if (translationStatus === 'done' && proofreadStatus === 'pending') return 'in_progress';
    return 'pending';
  }

  if (translationStatus === 'done') return 'done';
  if (translationStatus === 'in_progress') return 'in_progress';
  return 'pending';
}

function normalizeEntryStatus(status, value, proofreadApplied = true) {
  if (status === 'skipped') return 'done';
  if (status) return status;
  if (proofreadApplied === false) return 'disabled';
  if (Array.isArray(value)) {
    return 'done';
  }
  if (typeof value === 'string' && value.trim()) {
    return 'done';
  }
  return 'pending';
}

async function restoreFromMemory() {
  const stored = await getStoredTranslations(location.href);
  if (!stored?.length) return;

  const restoredSnapshot = [];
  stored.forEach(({ path, translated, original, originalHash }) => {
    const node = findNodeByPath(path);
    if (node) {
      const originalValue = typeof original === 'string' ? original : node.nodeValue;
      const resolvedOriginalHash = getOriginalHash(originalValue, originalHash);
      if (!shouldApplyTranslation(node, originalValue, resolvedOriginalHash)) {
        return;
      }
      activeTranslationEntries.push({
        path,
        original: originalValue,
        originalHash: resolvedOriginalHash,
        translated
      });
      restoredSnapshot.push({ path, original: originalValue, originalHash: resolvedOriginalHash });
      node.nodeValue = translated;
    }
  });
  if (restoredSnapshot.length) {
    originalSnapshot = restoredSnapshot;
    await setTranslationVisibility(true);
  }
}

function getNodePath(node) {
  const path = [];
  let current = node;
  while (current && current !== document.body) {
    const parent = current.parentNode;
    if (!parent) break;
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    path.unshift(index);
    current = parent;
  }
  return path;
}

function findNodeByPath(path) {
  let current = document.body;
  for (const index of path) {
    if (!current?.childNodes?.[index]) return null;
    current = current.childNodes[index];
  }
  return current && current.nodeType === Node.TEXT_NODE ? current : null;
}

function computeTextHash(text = '') {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function getOriginalHash(original, originalHash) {
  if (Number.isFinite(originalHash)) {
    return originalHash;
  }
  if (typeof original === 'string') {
    return computeTextHash(original);
  }
  return null;
}

function shouldApplyTranslation(node, original, originalHash) {
  const currentText = node?.nodeValue ?? '';
  if (typeof original === 'string') {
    return currentText === original;
  }
  if (Number.isFinite(originalHash)) {
    return computeTextHash(currentText) === originalHash;
  }
  return false;
}

function prepareTextForTranslation(text) {
  const { core } = extractWhitespaceAndCore(text);
  return core;
}

function applyOriginalFormatting(original, translated) {
  const { prefix, suffix } = extractWhitespaceAndCore(original);
  const adjustedCase = matchFirstLetterCase(original, translated || '');
  const trimmed = typeof adjustedCase === 'string' ? adjustedCase.trim() : '';
  return `${prefix}${trimmed}${suffix}`;
}

function extractWhitespaceAndCore(text = '') {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return {
    prefix: match?.[1] || '',
    core: match?.[2] || text,
    suffix: match?.[3] || ''
  };
}

function matchFirstLetterCase(original, translated) {
  const desiredCase = getFirstLetterCase(original);
  if (!desiredCase) return translated;

  const match = translated.match(/\p{L}/u);
  if (!match || match.index === undefined) return translated;

  const index = match.index;
  const letter = match[0];

  if (desiredCase === 'upper') {
    const upper = letter.toLocaleUpperCase();
    return upper === letter
      ? translated
      : translated.slice(0, index) + upper + translated.slice(index + 1);
  }

  const lower = letter.toLocaleLowerCase();
  return lower === letter
    ? translated
    : translated.slice(0, index) + lower + translated.slice(index + 1);
}

function getFirstLetterCase(text) {
  const match = text.match(/\p{L}/u);
  if (!match) return null;

  const letter = match[0];
  if (letter === letter.toLocaleUpperCase() && letter !== letter.toLocaleLowerCase()) {
    return 'upper';
  }
  if (letter === letter.toLocaleLowerCase() && letter !== letter.toLocaleUpperCase()) {
    return 'lower';
  }
  return null;
}

function updateActiveEntry(path, original, translated, originalHash) {
  const existingIndex = activeTranslationEntries.findIndex((entry) => isSamePath(entry.path, path));
  const resolvedOriginalHash = getOriginalHash(original, originalHash);
  if (existingIndex >= 0) {
    activeTranslationEntries[existingIndex] = {
      path,
      original,
      originalHash: resolvedOriginalHash,
      translated
    };
  } else {
    activeTranslationEntries.push({
      path,
      original,
      originalHash: resolvedOriginalHash,
      translated
    });
  }
}

function isSamePath(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

async function saveTranslationsToMemory(entries) {
  const filtered = entries.filter(({ translated }) => translated && translated.trim());
  const existing = await getTranslationsObject();
  existing[location.href] = filtered;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: existing });
  } catch (error) {
    console.warn('Failed to persist translations to storage.', error);
  }
}

async function getStoredTranslations(url) {
  const existing = await getTranslationsObject();
  return existing[url] || [];
}

async function clearStoredTranslations(url) {
  const existing = await getTranslationsObject();
  delete existing[url];
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: existing });
  } catch (error) {
    console.warn('Failed to clear stored translations.', error);
  }
}

function limitDebugArray(list, limit) {
  const values = Array.isArray(list) ? list : [];
  if (!limit || values.length <= limit) return values;
  return values.slice(values.length - limit);
}

function trimDebugText(value, limit) {
  const preview = truncateText(value || '', limit || DEBUG_PREVIEW_MAX_CHARS);
  return preview;
}

function pruneDebugPayload(payload, options = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const maxPreviewChars = options.maxPreviewChars || DEBUG_PREVIEW_MAX_CHARS;
  const request = trimDebugText(payload.request || '', maxPreviewChars);
  const response = trimDebugText(payload.response || '', maxPreviewChars);
  const contextTextSent = trimDebugText(payload.contextTextSent || '', maxPreviewChars);
  const next = {
    ...payload,
    request: request.text,
    response: response.text,
    contextTextSent: contextTextSent.text,
    requestTruncated: payload.requestTruncated || request.truncated,
    responseTruncated: payload.responseTruncated || response.truncated,
    contextTruncated: payload.contextTruncated || contextTextSent.truncated
  };
  if (typeof payload.baseAnswerPreview === 'string') {
    next.baseAnswerPreview = trimDebugText(payload.baseAnswerPreview, maxPreviewChars).text;
  }
  return next;
}

function pruneDebugEntry(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return entry;
  const maxPreviewChars = options.maxPreviewChars || DEBUG_PREVIEW_MAX_CHARS;
  const maxPayloads = options.maxPayloads || 20;
  const maxCallsPerEntry = options.maxCallsPerEntry || 20;
  const maxEvents = options.maxEvents || 200;
  const maxComparisons = options.maxComparisons || 30;
  const maxItems = options.maxItems || null;
  const contextFullPreview = trimDebugText(entry.contextFull || entry.context || '', maxPreviewChars);
  const contextShortPreview = trimDebugText(entry.contextShort || '', maxPreviewChars);
  const items = Array.isArray(entry.items) ? entry.items : [];
  const trimmedItems = (maxItems ? limitDebugArray(items, maxItems) : items).map((item) => {
    const nextItem = { ...item };
    const translationRaw = trimDebugText(item.translationRaw || '', maxPreviewChars);
    const proofreadRaw = trimDebugText(item.proofreadRaw || '', maxPreviewChars);
    nextItem.translationRaw = translationRaw.text;
    nextItem.translationRawTruncated = item.translationRawTruncated || translationRaw.truncated;
    nextItem.proofreadRaw = proofreadRaw.text;
    nextItem.proofreadRawTruncated = item.proofreadRawTruncated || proofreadRaw.truncated;
    if (typeof item.fullContextSnapshot === 'string') {
      nextItem.fullContextSnapshot = trimDebugText(item.fullContextSnapshot, maxPreviewChars).text;
    }
    if (typeof item.shortContextSnapshot === 'string') {
      nextItem.shortContextSnapshot = trimDebugText(item.shortContextSnapshot, maxPreviewChars).text;
    }
    delete nextItem.originalSegments;
    delete nextItem.translatedSegments;
    delete nextItem.translationCalls;
    delete nextItem.proofreadCalls;
    if (nextItem.proofreadStatus != null) {
      delete nextItem.proofread;
    }
    if (Array.isArray(item.translationDebug)) {
      nextItem.translationDebug = limitDebugArray(item.translationDebug, maxPayloads).map((payload) =>
        pruneDebugPayload(payload, { maxPreviewChars })
      );
    }
    if (Array.isArray(item.proofreadDebug)) {
      nextItem.proofreadDebug = limitDebugArray(item.proofreadDebug, maxPayloads).map((payload) =>
        pruneDebugPayload(payload, { maxPreviewChars })
      );
    }
    if (Array.isArray(item.proofreadComparisons)) {
      const changedOnly = item.proofreadComparisons.filter((comparison) => comparison?.changed);
      nextItem.proofreadComparisons = limitDebugArray(changedOnly, maxComparisons);
    }
    return nextItem;
  });
  const trimmedEvents = limitDebugArray(entry.events, maxEvents).map((event) => {
    if (!event || typeof event !== 'object') return event;
    const nextEvent = { ...event };
    if (typeof event.message === 'string') {
      nextEvent.message = trimDebugText(event.message, maxPreviewChars).text;
    }
    return nextEvent;
  });
  const trimmedCallHistory = limitDebugArray(entry.callHistory, options.maxCallHistory || 200);
  return {
    ...entry,
    context: contextFullPreview.text,
    contextFull: contextFullPreview.text,
    contextShort: contextShortPreview.text,
    contextFullTruncated: entry.contextFullTruncated || contextFullPreview.truncated,
    contextShortTruncated: entry.contextShortTruncated || contextShortPreview.truncated,
    items: trimmedItems,
    events: trimmedEvents,
    callHistory: trimmedCallHistory
  };
}

async function saveTranslationDebugInfo(url, data) {
  if (!url) return;
  const existing = await getTranslationDebugObject();
  const maxEntries = 5;
  const prunedEntry = pruneDebugEntry(data, {
    maxPreviewChars: DEBUG_PREVIEW_MAX_CHARS,
    maxPayloads: 20,
    maxCallsPerEntry: 20,
    maxEvents: 200,
    maxComparisons: 30,
    maxCallHistory: 200
  });
  existing[url] = prunedEntry;
  const entries = Object.entries(existing).map(([key, value]) => ({
    key,
    updatedAt: Number.isFinite(value?.updatedAt) ? value.updatedAt : 0
  }));
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  const keepKeys = new Set([url]);
  for (const entry of entries) {
    if (keepKeys.size >= maxEntries) break;
    if (entry.key === url) continue;
    keepKeys.add(entry.key);
  }
  const prunedExisting = {};
  for (const key of keepKeys) {
    if (existing[key]) {
      prunedExisting[key] = existing[key];
    }
  }
  try {
    await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: prunedExisting });
  } catch (error) {
    const isQuotaError = /quota/i.test(error?.message || '');
    if (isQuotaError) {
      const emergencyEntry = pruneDebugEntry(data, {
        maxPreviewChars: Math.min(600, DEBUG_PREVIEW_MAX_CHARS),
        maxPayloads: 10,
        maxCallsPerEntry: 10,
        maxEvents: 50,
        maxComparisons: 30,
        maxCallHistory: 50
      });
      try {
        await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: { [url]: emergencyEntry } });
        return;
      } catch (retryError) {
        console.warn('Failed to persist debug info after emergency prune.', retryError);
      }
    }
    const now = Date.now();
    if (now - debugStorageWarningSentAt > 30000) {
      debugStorageWarningSentAt = now;
      appendDebugEvent(CALL_TAGS.STORAGE_DROPPED, error?.message || 'debug-storage-write-failed');
    }
  }
}

async function clearTranslationDebugInfo(url) {
  const existing = await getTranslationDebugObject();
  delete existing[url];
  try {
    await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: existing });
  } catch (error) {
    appendDebugEvent(CALL_TAGS.STORAGE_DROPPED, error?.message || 'debug-storage-clear-failed');
  }
}

async function resetTranslationDebugInfo(url) {
  if (!url) return;
  const existing = await getTranslationDebugObject();
  const entry = existing[url];
  if (!entry) return;
  const contextFull =
    typeof entry.contextFull === 'string'
      ? entry.contextFull
      : typeof entry.context === 'string'
        ? entry.context
        : '';
  const contextShort = typeof entry.contextShort === 'string' ? entry.contextShort : '';
  const contextFullStatus = entry.contextFullStatus || entry.contextStatus || (contextFull ? 'done' : 'pending');
  const contextShortStatus = entry.contextShortStatus || (contextShort ? 'done' : 'pending');
  existing[url] = {
    context: contextFull,
    contextStatus: contextFullStatus,
    contextFull,
    contextFullStatus,
    contextShort,
    contextShortStatus,
    contextFullRefId: entry.contextFullRefId || '',
    contextShortRefId: entry.contextShortRefId || '',
    contextFullTruncated: entry.contextFullTruncated || false,
    contextShortTruncated: entry.contextShortTruncated || false,
    items: [],
    aiRequestCount: 0,
    aiResponseCount: 0,
    sessionStartTime: entry.sessionStartTime ?? null,
    sessionEndTime: entry.sessionEndTime ?? null,
    events: Array.isArray(entry.events) ? entry.events : [],
    callHistory: Array.isArray(entry.callHistory) ? entry.callHistory : [],
    updatedAt: Date.now()
  };
  try {
    await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: existing });
  } catch (error) {
    appendDebugEvent(CALL_TAGS.STORAGE_DROPPED, error?.message || 'debug-storage-reset-failed');
  }
}

async function initializeDebugState(blocks, settings = {}, initial = {}, options = {}) {
  const proofreadEnabled = Boolean(settings.proofreadEnabled);
  debugSessionId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const blockKeys = Array.isArray(options?.blockKeys) ? options.blockKeys : [];
  const initialContextFull = typeof initial.initialContextFull === 'string' ? initial.initialContextFull : '';
  const initialContextShort = typeof initial.initialContextShort === 'string' ? initial.initialContextShort : '';
  const initialContextFullStatus =
    initial.initialContextFullStatus ||
    (settings.contextGenerationEnabled ? 'pending' : 'disabled');
  const initialContextShortStatus =
    initial.initialContextShortStatus ||
    (settings.contextGenerationEnabled ? 'pending' : 'disabled');
  debugEntries = blocks.map((block, index) => ({
    index: index + 1,
    blockKey: blockKeys[index] || '',
    original: formatBlockText(block.map(({ original }) => original)),
    originalSegments: block.map(({ original }) => original),
    translated: '',
    translatedSegments: [],
    doneSegments: 0,
    totalSegments: block.length,
    translationRaw: '',
    translationRawRefId: '',
    translationRawTruncated: false,
    translationDebug: [],
    proofread: [],
    proofreadRaw: '',
    proofreadRawRefId: '',
    proofreadRawTruncated: false,
    proofreadDebug: [],
    proofreadComparisons: [],
    proofreadExecuted: false,
    proofreadApplied: proofreadEnabled,
    translationStatus: 'pending',
    proofreadStatus: proofreadEnabled ? 'pending' : 'disabled',
    fullContextSnapshot: '',
    shortContextSnapshot: '',
    shortContextSource: '',
    translationCalls: [],
    proofreadCalls: [],
    translationBaseFullCallId: null,
    translationBaseFullAnswer: '',
    translationFullSuccess: false,
    proofreadBaseFullCallId: null,
    proofreadBaseFullAnswer: '',
    proofreadFullSuccess: false,
    translationCallCounter: 0,
    proofreadCallCounter: 0,
    translateAttemptCount: 0,
    proofreadAttemptCount: 0
  }));
  const contextFullPreview = { text: initialContextFull, truncated: false };
  const contextShortPreview = { text: initialContextShort, truncated: false };
  const contextFullRefId = initialContextFull ? `${debugSessionId}:context:full` : '';
  const contextShortRefId = initialContextShort ? `${debugSessionId}:context:short` : '';
  if (contextFullRefId) {
    await storeDebugRawSafe({
      id: contextFullRefId,
      ts: Date.now(),
      value: { type: 'context', text: truncateText(initialContextFull, DEBUG_RAW_MAX_CHARS).text }
    });
  }
  if (contextShortRefId) {
    await storeDebugRawSafe({
      id: contextShortRefId,
      ts: Date.now(),
      value: { type: 'context', text: truncateText(initialContextShort, DEBUG_RAW_MAX_CHARS).text }
    });
  }
  debugState = {
    context: contextFullPreview.text || '',
    contextStatus: initialContextFullStatus,
    contextFull: contextFullPreview.text || '',
    contextFullStatus: initialContextFullStatus,
    contextShort: contextShortPreview.text || '',
    contextShortStatus: initialContextShortStatus,
    contextFullRefId,
    contextShortRefId,
    contextFullTruncated: contextFullPreview.truncated,
    contextShortTruncated: contextShortPreview.truncated,
    items: debugEntries,
    aiRequestCount: 0,
    aiResponseCount: 0,
    sessionStartTime: Math.floor(Date.now() / 1000),
    sessionEndTime: null,
    events: [],
    callHistory: [],
    health: initHealthState(),
    updatedAt: Date.now()
  };
  await saveTranslationDebugInfo(location.href, debugState);
}

function schedulePersistDebugState(reason = '') {
  if (!debugState) return;
  debugPersistDirty = true;
  const now = Date.now();
  if (now - debugLastPersistAt > DEBUG_PERSIST_MAX_INTERVAL_MS) {
    if (debugPersistTimer) {
      clearTimeout(debugPersistTimer);
      debugPersistTimer = null;
    }
    void flushPersistDebugState(`max-interval:${reason}`);
    return;
  }
  if (debugPersistTimer) return;
  debugPersistTimer = setTimeout(() => {
    debugPersistTimer = null;
    void flushPersistDebugState(`debounce:${reason}`);
  }, DEBUG_PERSIST_DEBOUNCE_MS);
}

async function flushPersistDebugState(reason = '') {
  if (!debugState) return;
  if (debugPersistTimer) {
    clearTimeout(debugPersistTimer);
    debugPersistTimer = null;
  }
  if (debugPersistInFlight) {
    debugPersistDirty = true;
    return;
  }
  debugPersistInFlight = true;
  debugPersistDirty = false;
  debugState.updatedAt = Date.now();
  debugState.items = debugEntries;
  try {
    await saveTranslationDebugInfo(location.href, debugState);
  } catch (error) {
    console.warn('Failed to persist debug info.', error);
  } finally {
    await notifyDebugUpdate().catch(() => {});
    debugPersistInFlight = false;
    debugLastPersistAt = Date.now();
  }
  if (debugPersistDirty) {
    debugPersistDirty = false;
    await flushPersistDebugState(`dirty:${reason}`);
  }
}

function updateDebugContextFull(context, status) {
  if (!debugState) return;
  const value = typeof context === 'string' ? context : debugState.contextFull || '';
  const preview = { text: value, truncated: false };
  debugState.contextFull = preview.text;
  debugState.context = preview.text;
  debugState.contextFullTruncated = preview.truncated;
  if (value) {
    const refId = debugState.contextFullRefId || `${debugSessionId || 'session'}:context:full`;
    debugState.contextFullRefId = refId;
    void storeDebugRawSafe({
      id: refId,
      ts: Date.now(),
      value: { type: 'context', text: truncateText(value, DEBUG_RAW_MAX_CHARS).text }
    });
  }
  if (status) {
    debugState.contextFullStatus = status;
    debugState.contextStatus = status;
  }
  schedulePersistDebugState('updateDebugContextFull');
}

function updateDebugContextShort(context, status) {
  if (!debugState) return;
  const value = typeof context === 'string' ? context : debugState.contextShort || '';
  const preview = { text: value, truncated: false };
  debugState.contextShort = preview.text;
  debugState.contextShortTruncated = preview.truncated;
  if (value) {
    const refId = debugState.contextShortRefId || `${debugSessionId || 'session'}:context:short`;
    debugState.contextShortRefId = refId;
    void storeDebugRawSafe({
      id: refId,
      ts: Date.now(),
      value: { type: 'context', text: truncateText(value, DEBUG_RAW_MAX_CHARS).text }
    });
  }
  if (status) {
    debugState.contextShortStatus = status;
  }
  schedulePersistDebugState('updateDebugContextShort');
}

function updateDebugContextFullStatus(status) {
  if (!debugState) return;
  debugState.contextFullStatus = status;
  debugState.contextStatus = status;
  schedulePersistDebugState('updateDebugContextFullStatus');
}

function updateDebugContextShortStatus(status) {
  if (!debugState) return;
  debugState.contextShortStatus = status;
  schedulePersistDebugState('updateDebugContextShortStatus');
}

function updateDebugContext(context, status) {
  updateDebugContextFull(context, status);
}

function updateDebugContextStatus(status) {
  updateDebugContextFullStatus(status);
}

function updateDebugSessionEndTime() {
  if (!debugState) return;
  debugState.sessionEndTime = Math.floor(Date.now() / 1000);
  schedulePersistDebugState('sessionEndTime');
}

function updateDebugEntry(index, updates = {}) {
  const entry = debugEntries.find((item) => item.index === index);
  if (!entry) return;
  if (Array.isArray(updates.translationDebug) && updates.translationDebug.length > DEBUG_PAYLOADS_PER_ENTRY_LIMIT) {
    updates.translationDebug = updates.translationDebug.slice(-DEBUG_PAYLOADS_PER_ENTRY_LIMIT);
  }
  if (Array.isArray(updates.proofreadDebug) && updates.proofreadDebug.length > DEBUG_PAYLOADS_PER_ENTRY_LIMIT) {
    updates.proofreadDebug = updates.proofreadDebug.slice(-DEBUG_PAYLOADS_PER_ENTRY_LIMIT);
  }
  Object.assign(entry, updates);
  schedulePersistDebugState('updateDebugEntry');
}

function appendDebugEvent(tag, message) {
  if (!debugState) return;
  if (!Array.isArray(debugState.events)) {
    debugState.events = [];
  }
  debugState.events.push({
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    tag,
    message: message || '',
    timestamp: Date.now()
  });
  if (debugState.events.length > DEBUG_EVENTS_LIMIT) {
    debugState.events = debugState.events.slice(debugState.events.length - DEBUG_EVENTS_LIMIT);
  }
  if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
    globalThis.ntPageJsonLog(
      {
        kind: 'debug.event',
        ts: Date.now(),
        pageUrl: location.href,
        tag,
        message
      },
      'log'
    );
  }
  schedulePersistDebugState('appendDebugEvent');
}

function registerCallHistory(entry, record) {
  if (!debugState || !entry || !record) return;
  if (!Array.isArray(debugState.callHistory)) {
    debugState.callHistory = [];
  }
  debugState.callHistory.push({
    id: record.id,
    entryIndex: entry.index,
    stage: record.stage
  });
  while (debugState.callHistory.length > DEBUG_CALLS_TOTAL_LIMIT) {
    const oldest = debugState.callHistory.shift();
    if (!oldest) break;
    const targetEntry = debugEntries.find((item) => item.index === oldest.entryIndex);
    if (!targetEntry) continue;
    const callsKey = oldest.stage === 'proofreading' ? 'proofreadCalls' : 'translationCalls';
    targetEntry[callsKey] = (targetEntry[callsKey] || []).filter((call) => call.id !== oldest.id);
  }
  if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
    globalThis.ntPageJsonLog(
      {
        kind: 'ai.call.history',
        ts: Date.now(),
        pageUrl: location.href,
        recordId: record.id ?? null,
        stage: record.stage ?? null,
        entryIndex: entry.index ?? null,
        ok: true,
        error: null,
        durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined
      },
      'log'
    );
  }
}

function appendCallRecord(index, stage, payload) {
  const entry = debugEntries.find((item) => item.index === index);
  if (!entry) return;
  const callsKey = stage === 'proofreading' ? 'proofreadCalls' : 'translationCalls';
  const counterKey = stage === 'proofreading' ? 'proofreadCallCounter' : 'translationCallCounter';
  const currentCount = Number.isFinite(entry[counterKey]) ? entry[counterKey] : 0;
  const callId = currentCount + 1;
  entry[counterKey] = callId;
  const contextTypeUsed =
    payload?.contextTypeUsed ||
    (typeof payload?.contextMode === 'string' && ['FULL', 'SHORT'].includes(payload.contextMode.toUpperCase())
      ? payload.contextMode
      : 'FULL');
  const record = {
    id: callId,
    stage: stage === 'proofreading' ? 'proofreading' : 'translation',
    attemptIndex: callId,
    timestamp: Date.now(),
    tag: payload?.tag || '',
    contextMode: contextTypeUsed,
    baseAnswerIncluded: Boolean(payload?.baseAnswerIncluded),
    baseAnswerPreview: payload?.baseAnswerPreview || '',
    rawRefId: payload?.rawRefId || ''
  };
  const existing = Array.isArray(entry[callsKey]) ? entry[callsKey] : [];
  entry[callsKey] = [...existing, record];
  registerCallHistory(entry, record);
  schedulePersistDebugState('appendCallRecord');
}

function appendDebugPayload(index, key, payload) {
  const entry = debugEntries.find((item) => item.index === index);
  if (!entry) return;
  const existing = Array.isArray(entry[key]) ? entry[key] : [];
  const next = [...existing, payload];
  if (next.length > DEBUG_PAYLOADS_PER_ENTRY_LIMIT) {
    entry[key] = next.slice(next.length - DEBUG_PAYLOADS_PER_ENTRY_LIMIT);
  } else {
    entry[key] = next;
  }
  if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
    const stage = key === 'proofreadDebug' ? 'proofread' : 'translation';
    globalThis.ntPageJsonLog(
      {
        kind: 'debug.payload',
        ts: Date.now(),
        pageUrl: location.href,
        stage,
        entryIndex: index,
        payload
      },
      'log'
    );
  }
  schedulePersistDebugState('appendDebugPayload');
}

function incrementDebugAiRequestCount() {
  if (!debugState) return;
  const currentCount = Number.isFinite(debugState.aiRequestCount) ? debugState.aiRequestCount : 0;
  debugState.aiRequestCount = currentCount + 1;
  recordHealthRequest();
  if (globalThis.ntPageJsonLogEnabled && globalThis.ntPageJsonLogEnabled()) {
    globalThis.ntPageJsonLog(
      {
        kind: 'ai.request.count',
        ts: Date.now(),
        pageUrl: location.href,
        recordId: null,
        stage: null,
        entryIndex: null,
        ok: true,
        error: null
      },
      'log'
    );
  }
  schedulePersistDebugState('aiRequestCount');
}

function recordAiResponseMetrics(debugPayloads) {
  if (!debugState) return;
  const currentCount = Number.isFinite(debugState.aiResponseCount) ? debugState.aiResponseCount : 0;
  debugState.aiResponseCount = currentCount + 1;
  recordHealthResponse(true);
  recordHealthTokens(debugPayloads);
  schedulePersistDebugState('aiResponseMetrics');
}

async function getTranslationsObject() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve(data?.[STORAGE_KEY] || {});
    });
  });
}

async function getTranslationDebugObject() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DEBUG_STORAGE_KEY], (data) => {
      resolve(data?.[DEBUG_STORAGE_KEY] || {});
    });
  });
}

function restoreOriginal(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  let restoredCount = 0;
  entries.forEach(({ path, original }) => {
    const node = findNodeByPath(path);
    if (!node) {
      console.warn(`Missing node while restoring original.${formatLogDetails({ path })}`);
      return;
    }
    if (typeof original !== 'string') {
      console.warn(`Missing original text while restoring.${formatLogDetails({ path })}`);
      return;
    }
    node.nodeValue = original;
    restoredCount += 1;
  });
  if (restoredCount !== entries.length) {
    console.warn(
      `Not all originals restored.${formatLogDetails({
        restoredCount,
        totalEntries: entries.length
      })}`
    );
  }
}

async function cancelTranslation() {
  await stopTranslation('cancelled');
  updateDebugSessionEndTime();
  await flushPersistDebugState('cancelTranslation');
  const entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
  if (entriesToRestore.length) {
    restoreOriginal(entriesToRestore);
  }
  await clearStoredTranslations(location.href);
  await resetTranslationDebugInfo(location.href);
  activeTranslationEntries = [];
  originalSnapshot = [];
  debugState = null;
  translationError = null;
  cancelRequested = false;
  translationProgress = { completedBlocks: 0, totalBlocks: 0, inProgressBlocks: 0 };
  translationVisible = false;
  notifyVisibilityChange();
  reportProgress('Перевод отменён', 0, 0, 0, { reason: 'cancelled' });
  const tabId = await getActiveTabId();
  void sendBackgroundMessageSafe({ type: 'TRANSLATION_CANCELLED', tabId });
}

async function stopTranslation(reason = 'stop') {
  cancelRequested = true;
  stopRpcHeartbeat();
  if (activeJobControl?.cancel) {
    await activeJobControl.cancel('cancelled');
  }
  reportProgress('Перевод остановлен', translationProgress.completedBlocks, translationProgress.totalBlocks, 0, {
    reason
  });
  if (currentTabIdForProgress) {
    void sendBackgroundMessageSafe({
      type: 'NT_PROGRESS_PULSE',
      tabId: currentTabIdForProgress,
      channel: 'prewarm',
      reason,
      queued: 0,
      inFlight: 0,
      total: 0
    });
  }
}

function resetContextState() {
  contextState.full.status = 'empty';
  contextState.full.signature = '';
  contextState.full.text = '';
  contextState.full.promise = null;
  contextState.short.status = 'empty';
  contextState.short.signature = '';
  contextState.short.text = '';
  contextState.short.promise = null;
  latestContextSummary = '';
  latestShortContextSummary = '';
  shortContextPromise = null;
}

async function resetContextCache() {
  try {
    await chrome.storage.local.remove([CONTEXT_CACHE_KEY]);
  } catch (error) {
    console.warn('Failed to reset context cache.', error);
  }
}

async function resetTranslationState({ resetContext = true, resetMemory = true } = {}) {
  await stopTranslation('reset');
  if (resetContext) {
    resetContextState();
    await resetContextCache();
  }
  if (resetMemory) {
    await clearStoredTranslations(location.href);
  }
  await resetTranslationDebugInfo(location.href);
  activeTranslationEntries = [];
  originalSnapshot = [];
  debugState = null;
  translationError = null;
  cancelRequested = false;
  translationProgress = { completedBlocks: 0, totalBlocks: 0, inProgressBlocks: 0 };
  translationVisible = false;
  notifyVisibilityChange();
  reportProgress('Перевод сброшен', 0, 0, 0, { reason: 'reset' });
}

function getActiveTabId() {
  return (async () => {
    const response = await sendRpcRequest({ type: 'GET_TAB_ID' }, 'GET_TAB_ID failed', 2000);
    if (response?.tabId != null) {
      return response.tabId;
    }
    if (response?.rpcUnavailable) {
      console.warn('Falling back to runtime.sendMessage for GET_TAB_ID.', response.error);
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (legacyResponse) => {
        resolve(legacyResponse?.tabId ?? null);
      });
    });
  })();
}

async function setTranslationVisibility(visible) {
  translationVisible = visible;
  if (translationVisible) {
    await restoreTranslations();
  } else {
    let entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
    if (!entriesToRestore.length) {
      await hydrateStoredTranslations();
      entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
    }
    if (entriesToRestore.length) {
      restoreOriginal(entriesToRestore);
    }
  }
  notifyVisibilityChange();
}

async function hydrateStoredTranslations() {
  if (activeTranslationEntries.length) return;
  const storedEntries = await getStoredTranslations(location.href);
  if (!storedEntries.length) return;
  activeTranslationEntries = storedEntries.map(({ path, translated, original, originalHash }) => ({
    path,
    translated,
    original,
    originalHash
  }));
  if (!originalSnapshot.length) {
    originalSnapshot = storedEntries.map(({ path, original, originalHash }) => ({
      path,
      original,
      originalHash
    }));
  }
}

async function restoreTranslations() {
  const storedEntries = activeTranslationEntries.length ? activeTranslationEntries : await getStoredTranslations(location.href);
  if (!storedEntries.length) return;

  const restoredSnapshot = [];
  const updatedEntries = [];
  let appliedCount = 0;

  storedEntries.forEach(({ path, translated, original, originalHash }) => {
    const node = findNodeByPath(path);
    const originalValue = typeof original === 'string' ? original : node?.nodeValue;
    const resolvedOriginalHash = getOriginalHash(originalValue, originalHash);
    if (!node) {
      console.warn(`Missing node while restoring translation.${formatLogDetails({ path })}`);
    } else {
      node.nodeValue = translated;
      appliedCount += 1;
      restoredSnapshot.push({
        path,
        original: originalValue,
        originalHash: resolvedOriginalHash
      });
    }
    updatedEntries.push({
      path,
      original: originalValue,
      originalHash: resolvedOriginalHash,
      translated
    });
  });

  if (appliedCount !== storedEntries.length) {
    console.warn(
      `Not all translations restored.${formatLogDetails({
        appliedCount,
        totalEntries: storedEntries.length
      })}`
    );
  }

  if (updatedEntries.length) {
    originalSnapshot = updatedEntries.map(({ path, original, originalHash }) => ({
      path,
      original,
      originalHash
    }));
    activeTranslationEntries = updatedEntries;
  }
}

function notifyVisibilityChange() {
  void sendBackgroundMessageSafe({ type: 'UPDATE_TRANSLATION_VISIBILITY', visible: translationVisible });
}

globalThis.ntPagePreflightHelpers = {
  collectTextNodes,
  groupTextNodesByBlock,
  normalizeBlocksByLength,
  isUiBlock,
  calculateTextLengthStats,
  normalizeBlockLength,
  getNodePath,
  computeTextHash,
  getOriginalHash
};
})();
