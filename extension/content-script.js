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

let cancelRequested = false;
let translationError = null;
let translationProgress = { completedBlocks: 0, totalBlocks: 0 };
let translationInProgress = false;
let activeTranslationEntries = [];
let originalSnapshot = [];
let translationVisible = false;
let latestContextSummary = '';
let latestShortContextSummary = '';
let shortContextPromise = null;
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
let tpmLimiter = null;
let tpmSettings = {
  outputRatioByRole: {
    translation: 0.6,
    context: 0.4,
    proofread: 0.5
  },
  safetyBufferTokens: 100
};

const STORAGE_KEY = 'pageTranslations';
const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const CONTEXT_CACHE_KEY = 'contextCacheByPage';
const RATE_LIMIT_RETRY_ATTEMPTS = 2;
const SHORT_CONTEXT_MAX_CHARS = 800;
const TRANSLATION_MAX_TOKENS_PER_REQUEST = 2600;
const PROOFREAD_SUSPICIOUS_RATIO = 0.35;
const DEBUG_PREVIEW_MAX_CHARS = 2000;
const DEBUG_RAW_MAX_CHARS = 50000;
const DEBUG_CALLS_TOTAL_LIMIT = 1200;
const DEBUG_EVENTS_LIMIT = 200;
const DEBUG_PAYLOADS_PER_ENTRY_LIMIT = 120;
const MAX_BLOCK_RETRIES = 15;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const NT_SETTINGS_RESPONSE_TYPE = 'NT_SETTINGS_RESPONSE';
const NT_RPC_PORT_NAME = 'NT_RPC_PORT';
const BLOCK_KEY_ATTR = 'data-nt-block-key';
const TRANSLATED_ATTR = 'data-nt-translated';
const PROOFREAD_ATTR = 'data-nt-proofread';
const DEFAULT_TPM_LIMITS_BY_MODEL = {
  default: 200000,
  'gpt-4.1-mini': 200000,
  'gpt-4.1': 300000,
  'gpt-4o-mini': 200000,
  'gpt-4o': 300000,
  'o4-mini': 200000
};
const DEFAULT_OUTPUT_RATIO_BY_ROLE = {
  translation: 0.6,
  context: 0.4,
  proofread: 0.5
};
const DEFAULT_TPM_SAFETY_BUFFER_TOKENS = 100;
const DEFAULT_STATE = {
  apiKey: '',
  openAiOrganization: '',
  openAiProject: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  translationModelList: ['gpt-4.1-mini'],
  contextModelList: ['gpt-4.1-mini'],
  proofreadModelList: ['gpt-4.1-mini'],
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  singleBlockConcurrency: false,
  blockLengthLimit: 1200,
  tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
  outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
  tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
};
const CALL_TAGS = {
  TRANSLATE_BASE_FULL: 'TRANSLATE_BASE_FULL',
  TRANSLATE_RETRY_FULL: 'TRANSLATE_RETRY_FULL',
  TRANSLATE_FOLLOWUP_SHORT: 'TRANSLATE_FOLLOWUP_SHORT',
  TRANSLATE_OVERFLOW_FALLBACK: 'TRANSLATE_OVERFLOW_FALLBACK',
  PROOFREAD_BASE_FULL: 'PROOFREAD_BASE_FULL',
  PROOFREAD_RETRY_FULL: 'PROOFREAD_RETRY_FULL',
  PROOFREAD_REWRITE_SHORT: 'PROOFREAD_REWRITE_SHORT',
  PROOFREAD_NOISE_SHORT: 'PROOFREAD_NOISE_SHORT',
  PROOFREAD_OVERFLOW_FALLBACK: 'PROOFREAD_OVERFLOW_FALLBACK',
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
const pendingSettingsRequests = new Map();
let ntRpcPort = null;
const RPC_HEARTBEAT_INTERVAL_MS = 20000;
const RPC_PORT_ROTATE_MS = 240000;
let rpcHeartbeatTimer = null;
let rpcPortCreatedAt = 0;
const ntRpcPending = new Map();
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
      sendResponse({ ok: true, type: 'NT_PONG', timestamp: Date.now() });
    }
    return true;
  }

  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelTranslation();
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
    return { ok: false, error: 'missing-id' };
  }
  const response = await sendBackgroundMessageSafe({ type: 'DEBUG_STORE_RAW', record });
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
  const stored = await storageLocalGet({ ...DEFAULT_STATE, model: null, chunkLengthLimit: null });
  const safeStored = stored && typeof stored === 'object' ? stored : {};
  const merged = { ...DEFAULT_STATE, ...safeStored };
  if (!merged.blockLengthLimit && safeStored.chunkLengthLimit) {
    merged.blockLengthLimit = safeStored.chunkLengthLimit;
  }
  if (!merged.translationModel && safeStored.model) {
    merged.translationModel = safeStored.model;
  }
  if (!merged.contextModel && safeStored.model) {
    merged.contextModel = safeStored.model;
  }
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
    rawList.forEach((model) => {
      if (!model || typeof model !== 'string' || model.startsWith('deepseek')) {
        return;
      }
      if (SUPPORTED_MODEL_IDS.has(model) && !normalized.includes(model)) {
        normalized.push(model);
      }
    });
    if (!normalized.length) {
      normalized.push(fallback);
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
    merged.translationModelList || merged.translationModel || safeStored.model,
    fallbackTranslationModel
  );
  merged.contextModelList = normalizeModelList(
    merged.contextModelList || merged.contextModel || safeStored.model,
    fallbackContextModel
  );
  merged.proofreadModelList = normalizeModelList(
    merged.proofreadModelList || merged.proofreadModel || safeStored.model,
    fallbackProofreadModel
  );
  merged.translationModel = merged.translationModelList[0] || fallbackTranslationModel;
  merged.contextModel = merged.contextModelList[0] || fallbackContextModel;
  merged.proofreadModel = merged.proofreadModelList[0] || fallbackProofreadModel;
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
      singleBlockConcurrency: DEFAULT_STATE.singleBlockConcurrency,
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
  const translationModel = Array.isArray(state.translationModelList) && state.translationModelList.length
    ? state.translationModelList[0]
    : state.translationModel;
  const contextModel = Array.isArray(state.contextModelList) && state.contextModelList.length
    ? state.contextModelList[0]
    : state.contextModel;
  const proofreadModel = Array.isArray(state.proofreadModelList) && state.proofreadModelList.length
    ? state.proofreadModelList[0]
    : state.proofreadModel;
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
    singleBlockConcurrency: Boolean(state.singleBlockConcurrency),
    blockLengthLimit: state.blockLengthLimit,
    tpmLimitsByRole,
    outputRatioByRole: state.outputRatioByRole || DEFAULT_OUTPUT_RATIO_BY_ROLE,
    tpmSafetyBufferTokens:
      Number.isFinite(state.tpmSafetyBufferTokens) && state.tpmSafetyBufferTokens >= 0
        ? state.tpmSafetyBufferTokens
        : DEFAULT_TPM_SAFETY_BUFFER_TOKENS
  };
}

async function startTranslation(triggerSource = 'manual') {
  if (translationInProgress) {
    reportProgress('Перевод уже выполняется', translationProgress.completedBlocks, translationProgress.totalBlocks);
    return;
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
    return;
  }

  if (!translationVisible) {
    await setTranslationVisibility(true);
  }

  configureTpmLimiter(settings);
  translationInProgress = true;
  try {
    startRpcHeartbeat();
    await translatePage(settings, { triggerSource });
  } finally {
    translationInProgress = false;
    stopRpcHeartbeat();
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
      contextLength: payload.contextLength ?? meta.contextLength ?? null
    };
  });
}

function traceRequestInitiator(meta) {
  if (!debugState) return;
  console.debug('Neuro Translate request initiated', meta);
  console.trace('Neuro Translate request trace');
}

async function translatePage(settings, options = {}) {
  const translationTriggerSource = options?.triggerSource || 'manual';
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
  primeContextState(contextState.short, contextSignature, existingContextShortText);
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
    initialContextShort: latestShortContextSummary || existingContextShortText,
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

  cancelRequested = false;
  translationError = null;
  reportProgress('Перевод запущен', 0, blocks.length, 0);

  const pageText = settings.contextGenerationEnabled ? buildPageText(nodesWithPath) : '';

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
        build: () => requestShortContext(pageText, settings.targetLanguage || 'ru')
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
        build: () => requestTranslationContext(pageText, settings.targetLanguage || 'ru')
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

  if (settings.contextGenerationEnabled && (!latestShortContextSummary || !latestContextSummary)) {
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
    const shortResult = getOrBuildContext({
      state: contextState.short,
      signature: contextSignature,
      build: () => requestShortContext(pageText, settings.targetLanguage || 'ru')
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
    if (contextMode === 'SHORT' && shortContextPromise) {
      await shortContextPromise;
    }
    const contextText = contextMode === 'SHORT' ? latestShortContextSummary : latestContextSummary;
    const baseAnswerIncluded = contextMode === 'SHORT' && Boolean(baseAnswer) && (!options.forceShort || fullSuccess);
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

  const singleBlockConcurrency = Boolean(settings.singleBlockConcurrency);
  const translationConcurrency = singleBlockConcurrency ? 1 : Math.max(1, Math.min(6, blocks.length));
  let maxConcurrentTranslationJobs = translationConcurrency;
  let totalBlockRetries = 0;
  let activeTranslationWorkers = 0;
  let activeProofreadWorkers = 0;
  let translationQueueDone = false;
  const translationQueue = [];
  const proofreadQueue = [];
  const queuedBlockElements = new WeakSet();
  const proofreadQueueKeys = new Set();
  let proofreadConcurrency = singleBlockConcurrency ? 1 : Math.max(1, Math.min(4, blocks.length));
  // Duplicate translate/proofread requests could be triggered for the same block; dedupe by jobKey.
  const jobInFlight = new Map();
  const jobCompleted = new Map();

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

  const enqueueTranslationBlock = (block, index) => {
    const key = getBlockKey(block);
    const blockElement = block?.[0]?.blockElement;
    if (blockElement && queuedBlockElements.has(blockElement)) {
      return false;
    }
    if (isBlockProcessed(blockElement, 'translate')) {
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

  const translationWorker = async () => {
    while (true) {
      if (cancelRequested) return;
      const queuedItem = translationQueue.shift();
      if (!queuedItem) {
        return;
      }
      if (queuedItem.availableAt && queuedItem.availableAt > Date.now()) {
        translationQueue.push(queuedItem);
        await delay(Math.min(queuedItem.availableAt - Date.now(), 200));
        continue;
      }
      while (activeTranslationWorkers >= maxConcurrentTranslationJobs) {
        if (cancelRequested) return;
        await delay(50);
      }
      activeTranslationWorkers += 1;
      const currentIndex = queuedItem.index;
      const block = queuedItem.block;
      try {
        await updateDebugEntry(currentIndex + 1, {
          translationStatus: 'in_progress',
          proofreadStatus: settings.proofreadEnabled ? 'pending' : 'disabled',
          translationStartedAt: Date.now()
        });
        reportProgress('Перевод выполняется');
        const preparedTexts = block.map(({ original }) =>
          prepareTextForTranslation(original)
        );
        const { uniqueTexts, indexMap } = deduplicateTexts(preparedTexts);
        const blockTranslations = [];

        const keepPunctuationTokens = Boolean(settings.proofreadEnabled);
        const debugEntry = debugEntries.find((item) => item.index === currentIndex + 1);
        const primaryContext = await selectContextForBlock(debugEntry, 'translation');
        const baseRequestMeta = {
          blockKey: queuedItem.key,
          stage: 'translate',
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
        const translateJobKey = `${queuedItem.key}:translate`;
        let result = null;

        if (queuedItem.fallbackMode === 'single') {
          const fallbackContext = await selectContextForBlock(debugEntry, 'translation', { forceShort: true });
          const perTextTranslations = [];
          for (let textIndex = 0; textIndex < uniqueTexts.length; textIndex += 1) {
            const text = uniqueTexts[textIndex];
            const perTextRequestMeta = buildRequestMeta(baseRequestMeta, {
              requestId: createRequestId(),
              parentRequestId: mainRequestMeta.requestId,
              purpose: 'single',
              attempt: fallbackContext.attemptIndex,
              triggerSource: 'retry',
              contextText: fallbackContext.contextText,
              contextMode: fallbackContext.contextMode
            });
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
              currentIndex + 1,
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
        } else {
          result = await runJobOnce(
            translateJobKey,
            async () => {
              await ensureShortContextReadyForTrigger(mainRequestMeta);
              return translate(
                uniqueTexts,
                settings.targetLanguage || 'ru',
                {
                  contextText: primaryContext.contextText,
                  contextMode: primaryContext.contextMode,
                  baseAnswer: primaryContext.baseAnswer,
                  baseAnswerIncluded: primaryContext.baseAnswerIncluded,
                  baseAnswerPreview: primaryContext.baseAnswerPreview,
                  tag: primaryContext.tag
                },
                keepPunctuationTokens,
                currentIndex + 1,
                mainRequestMeta
              );
            },
            (resolved) => resolved?.success
          );
          if (!result?.success && result?.contextOverflow && primaryContext.contextMode === 'FULL') {
            appendDebugPayload(
              currentIndex + 1,
              'translationDebug',
              buildContextOverflowDebugPayload({
                phase: 'TRANSLATE',
                model: settings.translationModel,
                errorMessage: result?.error || 'fullContext overflow/error',
                contextMode: primaryContext.contextMode,
                contextTextSent: primaryContext.contextText,
                baseAnswerIncluded: primaryContext.baseAnswerIncluded,
                tag: primaryContext.tag,
                requestMeta: mainRequestMeta
              })
            );
            const fallbackContext = await selectContextForBlock(debugEntry, 'translation', { forceShort: true });
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
                  currentIndex + 1,
                  retryRequestMeta
                );
              },
              (resolved) => resolved?.success
            );
          }
        }
        if (!result?.success) {
          throw new Error(result?.error || 'Не удалось выполнить перевод.');
        }
        if (result.translations.length !== uniqueTexts.length) {
          throw new Error(
            `Translation length mismatch: expected ${uniqueTexts.length}, got ${result.translations.length}`
          );
        }
        const translatedTexts = block.map(({ original }, index) => {
          const translationIndex = indexMap[index];
          if (translationIndex == null || translationIndex < 0 || translationIndex >= result.translations.length) {
            throw new Error(`Translation index mismatch at segment ${index}`);
          }
          const translated = result.translations[translationIndex] || original;
          return applyOriginalFormatting(original, translated);
        });
        if (translatedTexts.length !== block.length) {
          throw new Error(`Block translation length mismatch: expected ${block.length}, got ${translatedTexts.length}`);
        }

        let finalTranslations = translatedTexts;
        if (keepPunctuationTokens) {
          finalTranslations = finalTranslations.map((text) => restorePunctuationTokens(text));
        }

        block.forEach(({ node, path, original, originalHash }, index) => {
          if (!shouldApplyTranslation(node, original, originalHash)) {
            blockTranslations.push(node.nodeValue);
            return;
          }
          const withOriginalFormatting = finalTranslations[index] || node.nodeValue;
          if (translationVisible) {
            node.nodeValue = withOriginalFormatting;
          }
          blockTranslations.push(withOriginalFormatting);
          updateActiveEntry(path, original, withOriginalFormatting, originalHash);
        });
        markBlockProcessed(queuedItem.blockElement, 'translate');
        const baseTranslationAnswer =
          primaryContext.contextMode === 'FULL' && debugEntry && !debugEntry.translationBaseFullAnswer
            ? formatBlockText(finalTranslations)
            : '';
        const baseTranslationCallId =
          primaryContext.contextMode === 'FULL' && debugEntry && !debugEntry.translationBaseFullCallId
            ? findFirstFullCallId(debugEntry?.translationCalls)
            : null;
        const translationRawField = await prepareRawTextField(result.rawTranslation || '', 'translation_raw');
        await updateDebugEntry(currentIndex + 1, {
          translated: formatBlockText(blockTranslations),
          translatedSegments: translatedTexts,
          translationStatus: 'done',
          translationCompletedAt: Date.now(),
          translationRaw: translationRawField.preview,
          translationRawRefId: translationRawField.refId,
          translationRawTruncated: translationRawField.truncated || translationRawField.rawTruncated,
          translationDebug: result.debug || [],
          ...(baseTranslationAnswer
            ? { translationBaseFullAnswer: baseTranslationAnswer, translationFullSuccess: true }
            : {}),
          ...(baseTranslationCallId ? { translationBaseFullCallId: baseTranslationCallId } : {})
        });
        translationProgress.completedBlocks += 1;

        if (settings.proofreadEnabled) {
          const proofreadSegments = translatedTexts.map((text, index) => ({ id: String(index), text }));
          const proofreadMode = detectProofreadMode(proofreadSegments, settings.targetLanguage || 'ru');
          if (!proofreadSegments.length) {
            await updateDebugEntry(currentIndex + 1, {
              proofreadStatus: 'done',
              proofread: [],
              proofreadComparisons: [],
              proofreadExecuted: false,
              proofreadCompletedAt: Date.now()
            });
          } else {
            enqueueProofreadTask({
              block,
              index: currentIndex,
              key: queuedItem.key,
              blockElement: queuedItem.blockElement,
              translatedTexts,
              originalTexts: block.map(({ original }) => original),
              proofreadSegments,
              proofreadMode
            });
          }
        }
      } catch (error) {
        console.error('Block translation failed', error);
        if (isFatalBlockError(error)) {
          translationError = error;
          cancelRequested = true;
          await updateDebugEntry(currentIndex + 1, {
            translationStatus: 'failed',
            proofreadStatus: settings.proofreadEnabled ? 'failed' : 'disabled',
            translationCompletedAt: Date.now()
          });
        } else {
          queuedItem.retryCount += 1;
          totalBlockRetries += 1;
          if (queuedItem.retryCount > MAX_BLOCK_RETRIES) {
            queuedItem.fallbackMode = 'single';
            queuedItem.retryCount = 0;
          }
          if (isRateLimitOrOverload(error)) {
            maxConcurrentTranslationJobs = Math.max(1, maxConcurrentTranslationJobs - 1);
          }
          const retryBase = Math.max(1, queuedItem.retryCount);
          const delayMs = Math.min(
            MAX_RETRY_DELAY_MS,
            BASE_RETRY_DELAY_MS * Math.pow(2, retryBase - 1)
          );
          queuedItem.availableAt = Date.now() + delayMs;
          await updateDebugEntry(currentIndex + 1, {
            translationStatus: 'retrying',
            translationRetryCount: queuedItem.retryCount,
            translationLastError: String(error?.message || error)
          });
          reportProgress(
            'Повтор перевода блока',
            translationProgress.completedBlocks,
            totalBlocks,
            activeTranslationWorkers
          );
          translationQueue.push(queuedItem);
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

        updatePageWithProofreading(task, finalTranslations);
        markBlockProcessed(task.blockElement, 'proofread');

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
        reportProgress('Вычитка выполняется');
      } catch (error) {
        console.warn('Proofreading failed, keeping original translations.', error);
        const proofreadComparisons = buildProofreadComparisons({
          originalTexts: task.originalTexts,
          beforeTexts: task.translatedTexts,
          afterTexts: task.translatedTexts
        }).filter((comparison) => comparison.changed);
        await updateDebugEntry(task.index + 1, {
          proofreadStatus: 'failed',
          proofread: [],
          proofreadComparisons,
          proofreadExecuted: true,
          proofreadCompletedAt: Date.now()
        });
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
    runProofreadSelfCheck();
    let skipped = 0;
    let applied = 0;
    task.block.forEach(({ node, path, original, originalHash }, index) => {
      const entry = getActiveTranslationEntry(path, original, originalHash);
      if (!shouldApplyProofreadTranslation(node, entry, original)) {
        skipped += 1;
        return;
      }
      const withOriginalFormatting = finalTranslations[index] || node.nodeValue;
      if (translationVisible) {
        node.nodeValue = withOriginalFormatting;
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
  }

  blocks.forEach((block, index) => {
    enqueueTranslationBlock(block, index);
  });
  translationProgress.totalBlocks = translationQueue.length;
  const totalBlocks = translationProgress.totalBlocks;

  if (totalBlocks !== blocks.length) {
    reportProgress('Перевод запущен', translationProgress.completedBlocks, totalBlocks, 0);
  }

  const workers = Array.from({ length: translationConcurrency }, () => translationWorker());
  const proofreadWorkers = settings.proofreadEnabled
    ? Array.from({ length: proofreadConcurrency }, () => proofreadWorker())
    : [];
  const translationCompletion = Promise.all(workers).then(() => {
    translationQueueDone = true;
  });
  await Promise.all([...proofreadWorkers, translationCompletion]);

  if (translationError) {
    updateDebugSessionEndTime();
    await flushPersistDebugState('translatePage:error');
    reportProgress('Ошибка перевода', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
    return;
  }

  if (cancelRequested) {
    updateDebugSessionEndTime();
    await flushPersistDebugState('translatePage:cancelled');
    reportProgress('Перевод отменён', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
    return;
  }

  updateDebugSessionEndTime();
  await flushPersistDebugState('translatePage:completed');
  reportProgress('Перевод завершён', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
  await flushPersistDebugState('translatePage:before-save');
  await saveTranslationsToMemory(activeTranslationEntries);
}

async function translate(
  texts,
  targetLanguage,
  contextMeta,
  keepPunctuationTokens = false,
  debugEntryIndex = null,
  requestMeta = null
) {
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
  const context = resolvedContextMeta.contextText || '';
  const baseAnswer = resolvedContextMeta.baseAnswerIncluded ? resolvedContextMeta.baseAnswer || '' : '';
  const contextEstimateText = [context, baseAnswer].filter(Boolean).join('\n');
  const batches = splitTextsByTokenEstimate(
    Array.isArray(texts) ? texts : [texts],
    contextEstimateText,
    TRANSLATION_MAX_TOKENS_PER_REQUEST
  );
  const translations = [];
  const rawParts = [];
  const debugParts = [];
  const baseRequestMeta = requestMeta && typeof requestMeta === 'object' ? requestMeta : null;

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const batchContext = context;
    const batchRequestMeta = baseRequestMeta
      ? buildRequestMeta(baseRequestMeta, {
          contextText: batchContext,
          contextMode: resolvedContextMeta.contextMode
        })
      : null;
    const estimatedTokens = estimateTokensForRole('translation', {
      texts: batch,
      context: [batchContext, baseAnswer].filter(Boolean).join('\n')
    });
    await ensureTpmBudget('translation', estimatedTokens);
    const batchResult = await withRateLimitRetry(
      async () => {
        await incrementDebugAiRequestCount();
        const response = await sendRuntimeMessage(
          {
            type: 'TRANSLATE_TEXT',
            texts: batch,
            targetLanguage,
            context: {
              text: batchContext,
              mode: resolvedContextMeta.contextMode,
              fullText: resolvedContextMeta.contextFullText || resolvedContextMeta.contextText || '',
              shortText: resolvedContextMeta.contextShortText || '',
              baseAnswer,
              baseAnswerIncluded: resolvedContextMeta.baseAnswerIncluded
            },
            keepPunctuationTokens,
            requestMeta: batchRequestMeta || undefined
          },
          'Не удалось выполнить перевод.'
        );
        if (!response?.success) {
          if (response?.contextOverflow) {
            return { success: false, contextOverflow: true, error: response.error || 'Контекст не помещается.' };
          }
          if (response?.isRuntimeError) {
            return { success: false, error: response.error || 'Не удалось выполнить перевод.' };
          }
          throw new Error(response?.error || 'Не удалось выполнить перевод.');
        }
        return {
          success: true,
          translations: Array.isArray(response.translations) ? response.translations : [],
          rawTranslation: response.rawTranslation || '',
          debug: response.debug || []
        };
      },
      'Translation'
    );
    if (!batchResult?.success) {
      return {
        success: false,
        error: batchResult?.error || 'Не удалось выполнить перевод.',
        contextOverflow: Boolean(batchResult?.contextOverflow)
      };
    }
    translations.push(...batchResult.translations);
    if (batchResult.rawTranslation) {
      rawParts.push(batchResult.rawTranslation);
    }
    if (Array.isArray(batchResult.debug)) {
      const annotated = annotateContextUsage(batchResult.debug, {
        contextMode: resolvedContextMeta.contextMode,
        baseAnswerIncluded: resolvedContextMeta.baseAnswerIncluded,
        baseAnswerPreview: resolvedContextMeta.baseAnswerPreview,
        contextTextSent: batchContext,
        tag: resolvedContextMeta.tag
      });
      const withRequestMeta = annotateRequestMetadata(annotated, batchRequestMeta);
      const summarized = await summarizeDebugPayloads(withRequestMeta, {
        entryIndex: debugEntryIndex,
        stage: 'translation'
      });
      debugParts.push(...summarized);
    }
    recordAiResponseMetrics(batchResult?.debug || []);
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
  const baseAnswer = contextMeta.baseAnswerIncluded ? contextMeta.baseAnswer || '' : '';
  const requestMeta =
    payload?.requestMeta && typeof payload.requestMeta === 'object' ? payload.requestMeta : null;
  const resolvedRequestMeta = requestMeta
    ? buildRequestMeta(requestMeta, {
        contextText: context,
        contextMode: contextMeta.contextMode
      })
    : null;
  const estimatedTokens = estimateTokensForRole('proofread', {
    texts: segmentTexts,
    context: [context, baseAnswer].filter(Boolean).join('\n'),
    sourceTexts: [sourceBlock, translatedBlock]
  });
  await ensureTpmBudget('proofread', estimatedTokens);
  return withRateLimitRetry(
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
            text: context,
            mode: contextMeta.contextMode,
            fullText: contextMeta.contextFullText || contextMeta.contextText || '',
            shortText: contextMeta.contextShortText || '',
            baseAnswer,
            baseAnswerIncluded: contextMeta.baseAnswerIncluded
          },
          language: payload?.language || '',
          requestMeta: resolvedRequestMeta || undefined
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
        throw new Error(response?.error || 'Не удалось выполнить вычитку.');
      }
      recordAiResponseMetrics(response?.debug || []);
      const annotated = annotateContextUsage(response.debug || [], {
        contextMode: contextMeta.contextMode,
        baseAnswerIncluded: contextMeta.baseAnswerIncluded,
        baseAnswerPreview: contextMeta.baseAnswerPreview,
        contextTextSent: context,
        tag: contextMeta.tag
      });
      const withRequestMeta = annotateRequestMetadata(annotated, resolvedRequestMeta);
      const summarized = await summarizeDebugPayloads(withRequestMeta, {
        entryIndex: payload?.debugEntryIndex,
        stage: 'proofreading'
      });
      return {
        success: true,
        translations: Array.isArray(response.translations) ? response.translations : [],
        rawProofread: response.rawProofread || '',
        debug: summarized
      };
    },
    'Proofreading'
  );
}

function ensureRpcPort() {
  if (ntRpcPort) return ntRpcPort;
  try {
    ntRpcPort = chrome.runtime.connect({ name: NT_RPC_PORT_NAME });
    rpcPortCreatedAt = Date.now();
  } catch (error) {
    console.warn('Failed to connect RPC port', error);
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
    entry.resolve(msg.response);
  });

  ntRpcPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    console.warn('RPC port disconnected', err?.message || '');
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
    sendRpcRequest({ type: 'RPC_HEARTBEAT' }, 'RPC heartbeat failed', 2000).then(() => {});
  }, RPC_HEARTBEAT_INTERVAL_MS);
}

function stopRpcHeartbeat() {
  if (!rpcHeartbeatTimer) return;
  clearInterval(rpcHeartbeatTimer);
  rpcHeartbeatTimer = null;
}

function shouldRotateRpcPort() {
  return rpcPortCreatedAt && Date.now() - rpcPortCreatedAt > RPC_PORT_ROTATE_MS;
}

function rotateRpcPort(reason = '') {
  if (ntRpcPort) {
    try {
      ntRpcPort.disconnect();
    } catch (error) {
      // ignore
    }
  }
  ntRpcPort = null;
  rpcPortCreatedAt = 0;
  console.info('RPC port rotated', { reason });
}

function getRpcPortAgeMs() {
  return rpcPortCreatedAt ? Date.now() - rpcPortCreatedAt : 0;
}

function sendRpcRequest(payload, fallbackError, timeoutMs) {
  let rotated = false;
  if (shouldRotateRpcPort()) {
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
  return new Promise((resolve) => {
    let timeoutId = setTimeout(() => {
      ntRpcPending.delete(rpcId);
      resolve({
        success: false,
        error: fallbackError || 'RPC timeout',
        isRuntimeError: true
      });
    }, timeoutMs);
    ntRpcPending.set(rpcId, { resolve, timeoutId });
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
      timeoutId = setTimeout(() => {
        ntRpcPending.delete(retryRpcId);
        resolve({
          success: false,
          error: fallbackError || 'RPC timeout',
          isRuntimeError: true
        });
      }, timeoutMs);
      ntRpcPending.set(retryRpcId, { resolve, timeoutId });
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

function getRpcTimeoutMs(type) {
  if (type === 'TRANSLATE_TEXT') return 240000;
  if (type === 'GENERATE_CONTEXT') return 120000;
  if (type === 'PROOFREAD_TEXT') return 180000;
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

async function requestTranslationContext(text, targetLanguage) {
  const estimatedTokens = estimateTokensForRole('context', {
    texts: [text]
  });
  await ensureTpmBudget('context', estimatedTokens);
  await incrementDebugAiRequestCount();
  const response = await sendRuntimeMessage(
    {
      type: 'GENERATE_CONTEXT',
      text,
      targetLanguage
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

async function requestShortContext(text, targetLanguage) {
  const estimatedTokens = estimateTokensForRole('context', {
    texts: [text]
  });
  await ensureTpmBudget('context', estimatedTokens);
  await incrementDebugAiRequestCount();
  const response = await sendRuntimeMessage(
    {
      type: 'GENERATE_SHORT_CONTEXT',
      text,
      targetLanguage
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
  return response.context || '';
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

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentNode;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.nodeName.toLowerCase();
      if (['script', 'style', 'noscript', 'code', 'pre'].includes(tag)) {
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
  const batches = [];
  let current = [];
  let currentTokens = 0;

  texts.forEach((text) => {
    const nextTokens = estimateTokensForRole('translation', {
      texts: [text],
      context: current.length ? '' : context
    });
    if (current.length && currentTokens + nextTokens > maxTokens) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += nextTokens;
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

function buildShortContextFallback(context = '') {
  if (!context) return '';
  const normalized = typeof context === 'string' ? context : String(context ?? '');
  return normalized.trimEnd();
}

function reportProgress(message, completedBlocks, totalBlocks, inProgressBlocks = 0) {
  const snapshot = getProgressSnapshot();
  const resolvedCompleted = Number.isFinite(snapshot?.completedBlocks)
    ? snapshot.completedBlocks
    : completedBlocks || 0;
  const resolvedTotal = Number.isFinite(snapshot?.totalBlocks) ? snapshot.totalBlocks : totalBlocks || 0;
  const resolvedInProgress = Number.isFinite(snapshot?.inProgressBlocks)
    ? snapshot.inProgressBlocks
    : inProgressBlocks || 0;
  translationProgress = {
    completedBlocks: resolvedCompleted,
    totalBlocks: resolvedTotal,
    inProgressBlocks: resolvedInProgress
  };
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
  schedulePersistDebugState('appendDebugPayload');
}

function incrementDebugAiRequestCount() {
  if (!debugState) return;
  const currentCount = Number.isFinite(debugState.aiRequestCount) ? debugState.aiRequestCount : 0;
  debugState.aiRequestCount = currentCount + 1;
  schedulePersistDebugState('aiRequestCount');
}

function recordAiResponseMetrics(debugPayloads) {
  if (!debugState) return;
  const currentCount = Number.isFinite(debugState.aiResponseCount) ? debugState.aiResponseCount : 0;
  debugState.aiResponseCount = currentCount + 1;
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
  cancelRequested = true;
  stopRpcHeartbeat();
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
  translationProgress = { completedBlocks: 0, totalBlocks: 0, inProgressBlocks: 0 };
  translationVisible = false;
  notifyVisibilityChange();
  reportProgress('Перевод отменён', 0, 0, 0);
  const tabId = await getActiveTabId();
  void sendBackgroundMessageSafe({ type: 'TRANSLATION_CANCELLED', tabId });
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
})();
