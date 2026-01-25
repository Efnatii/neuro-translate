importScripts('ai-common.js');
importScripts('messaging.js');
importScripts('translation-service.js');
importScripts('context-service.js');
importScripts('proofread-service.js');

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
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  singleBlockConcurrency: false,
  blockLengthLimit: 1200,
  tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
  outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
  tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS,
  modelThroughputById: {}
};

let STATE_CACHE = null;
let STATE_CACHE_READY = false;
const NT_RPC_PORT_NAME = 'NT_RPC_PORT';
const STATE_CACHE_KEYS = new Set([
  'apiKey',
  'translationModel',
  'contextModel',
  'proofreadModel',
  'contextGenerationEnabled',
  'proofreadEnabled',
  'singleBlockConcurrency',
  'blockLengthLimit',
  'tpmLimitsByModel',
  'outputRatioByRole',
  'tpmSafetyBufferTokens',
  'modelThroughputById'
]);

const MODEL_THROUGHPUT_TEST_TIMEOUT_MS = 15000;
const MODEL_THROUGHPUT_TEST_THROTTLE_MS = 2 * 60 * 1000;
const TRANSLATION_ACTIVITY_GRACE_MS = 45000;
const THROUGHPUT_CHECK_INTERVAL_MS = 30000;
const CONTENT_READY_BY_TAB = new Map();
const NT_SETTINGS_RESPONSE_TYPE = 'NT_SETTINGS_RESPONSE';
const ACTIVE_TRANSLATION_TABS = new Map();
const LAST_THROUGHPUT_REQUEST_BY_MODEL = new Map();
let lastThroughputScheduleAt = 0;
let throughputTestInFlight = false;

function invokeHandlerAsPromise(handler, message, timeoutMs = 240000) {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (payload && typeof payload === 'object') {
        resolve(payload);
        return;
      }
      resolve({
        success: false,
        error: 'Background RPC response is empty',
        isRuntimeError: true
      });
    };
    const timeoutId = setTimeout(() => {
      safeResolve({ success: false, error: 'Background RPC timeout', isRuntimeError: true });
    }, timeoutMs);
    try {
      const maybePromise = handler(message, (response) => {
        safeResolve(response);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch((error) => {
          safeResolve({
            success: false,
            error: error?.message || String(error),
            isRuntimeError: true
          });
        });
      }
    } catch (error) {
      safeResolve({
        success: false,
        error: error?.message || String(error),
        isRuntimeError: true
      });
    }
  });
}

function invokeSettingsAsPromise(handler, message, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(payload && typeof payload === 'object' ? payload : null);
    };
    const timeoutId = setTimeout(() => {
      safeResolve(null);
    }, timeoutMs);
    try {
      const maybePromise = handler(message, (response) => {
        safeResolve(response);
      });
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch((error) => {
          console.warn('Settings handler failed in RPC.', error);
          safeResolve(null);
        });
      }
    } catch (error) {
      console.warn('Settings handler threw in RPC.', error);
      safeResolve(null);
    }
  });
}

function storageLocalGet(keysOrDefaults, timeoutMs = 6000) {
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

function storageLocalSet(items, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let hasCompleted = false;
    const timeoutId = setTimeout(() => {
      if (hasCompleted) return;
      hasCompleted = true;
      reject(new Error('storageLocalSet timeout'));
    }, timeoutMs);
    try {
      chrome.storage.local.set(items, () => {
        if (hasCompleted) return;
        hasCompleted = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function applyStatePatch(patch = {}) {
  const next = STATE_CACHE && typeof STATE_CACHE === 'object' ? { ...STATE_CACHE } : { ...DEFAULT_STATE };

  for (const [key, value] of Object.entries(patch || {})) {
    if (!STATE_CACHE_KEYS.has(key)) continue;
    if (['apiKey', 'translationModel', 'contextModel', 'proofreadModel'].includes(key)) {
      next[key] = typeof value === 'string' ? value : value == null ? '' : String(value);
      continue;
    }
    if (['contextGenerationEnabled', 'proofreadEnabled', 'singleBlockConcurrency'].includes(key)) {
      next[key] = Boolean(value);
      continue;
    }
    if (['blockLengthLimit', 'tpmSafetyBufferTokens'].includes(key)) {
      const numValue = Number(value);
      next[key] = Number.isFinite(numValue) ? numValue : DEFAULT_STATE[key];
      continue;
    }
    if (['tpmLimitsByModel', 'outputRatioByRole', 'modelThroughputById'].includes(key)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        next[key] = value;
      }
      continue;
    }
  }

  STATE_CACHE = next;
  STATE_CACHE_READY = true;
}

function getApiConfigForModel(model, state) {
  return {
    apiKey: state.apiKey,
    apiBaseUrl: OPENAI_API_URL,
    provider: 'openai'
  };
}

function getTpmLimitForModel(model, tpmLimitsByModel) {
  if (!tpmLimitsByModel || typeof tpmLimitsByModel !== 'object') {
    return DEFAULT_TPM_LIMITS_BY_MODEL.default;
  }
  const fallback = tpmLimitsByModel.default ?? DEFAULT_TPM_LIMITS_BY_MODEL.default;
  return tpmLimitsByModel[model] ?? fallback;
}

function buildMissingKeyReason(roleLabel, config, model) {
  return `Перевод недоступен: укажите OpenAI API ключ для модели ${model} (${roleLabel}).`;
}

async function getState() {
  if (STATE_CACHE_READY && STATE_CACHE && typeof STATE_CACHE === 'object') {
    return { ...DEFAULT_STATE, ...STATE_CACHE };
  }

  try {
    let stored;
    try {
      stored = await storageLocalGet({ ...DEFAULT_STATE, model: null, chunkLengthLimit: null });
    } catch (error) {
      if (error?.message === 'storageLocalGet timeout') {
        console.warn('storageLocalGet timed out, retrying with extended timeout.', error);
        stored = await storageLocalGet({ ...DEFAULT_STATE, model: null, chunkLengthLimit: null }, 8000);
      } else {
        throw error;
      }
    }
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
      proofreadModel: merged.proofreadModel
    };
    if (merged.translationModel?.startsWith('deepseek')) {
      merged.translationModel = DEFAULT_STATE.translationModel;
    }
    if (merged.contextModel?.startsWith('deepseek')) {
      merged.contextModel = DEFAULT_STATE.contextModel;
    }
    if (merged.proofreadModel?.startsWith('deepseek')) {
      merged.proofreadModel = DEFAULT_STATE.proofreadModel;
    }
    if (
      merged.translationModel !== previousModels.translationModel ||
      merged.contextModel !== previousModels.contextModel ||
      merged.proofreadModel !== previousModels.proofreadModel
    ) {
      await storageLocalSet({
        translationModel: merged.translationModel,
        contextModel: merged.contextModel,
        proofreadModel: merged.proofreadModel
      });
    }
    applyStatePatch(merged);
    return { ...DEFAULT_STATE, ...STATE_CACHE };
  } catch (error) {
    console.warn('Failed to load state from storage, using defaults.', error);
    if (STATE_CACHE_READY && STATE_CACHE && typeof STATE_CACHE === 'object') {
      return { ...DEFAULT_STATE, ...STATE_CACHE };
    }
    return { ...DEFAULT_STATE };
  }
}

async function saveState(partial) {
  const current = await getState();
  const next = { ...current, ...partial };
  await storageLocalSet(next);
  applyStatePatch(next);
  return next;
}

async function ensureDefaultKeysOnFreshInstall() {
  const stored = await storageLocalGet({});
  const safeStored = stored && typeof stored === 'object' ? stored : {};
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULT_STATE)) {
    if (safeStored[key] === undefined) {
      patch[key] = value;
    }
  }
  if (Object.keys(patch).length > 0) {
    await storageLocalSet(patch);
  }
  applyStatePatch({ ...DEFAULT_STATE, ...safeStored, ...patch });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const reason = details?.reason;
  if (reason === 'install') {
    await ensureDefaultKeysOnFreshInstall();
  } else {
    await getState();
  }
  await warmUpContentScripts(reason || 'installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await warmUpContentScripts('startup');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  const patch = {};
  for (const [key, change] of Object.entries(changes || {})) {
    if (!STATE_CACHE_KEYS.has(key)) continue;
    patch[key] = change?.newValue;
  }
  applyStatePatch(patch);
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== NT_RPC_PORT_NAME) return;
  const tabId = port.sender?.tab?.id ?? null;
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    const rpcId = msg.rpcId;
    if (typeof rpcId !== 'string') return;
    const type = msg.type;
    const postResponse = (response) => {
      try {
        port.postMessage({ rpcId, response });
      } catch (error) {
        console.warn('Failed to post RPC response.', { error, rpcId, type, tabId });
      }
    };

    let responsePromise;
    switch (type) {
      case 'RPC_HEARTBEAT':
        responsePromise = Promise.resolve({ ok: true, ts: Date.now() });
        break;
      case 'TRANSLATE_TEXT':
        responsePromise = invokeHandlerAsPromise(handleTranslateText, msg, 240000);
        break;
      case 'GENERATE_CONTEXT':
        responsePromise = invokeHandlerAsPromise(handleGenerateContext, msg, 120000);
        break;
      case 'PROOFREAD_TEXT':
        responsePromise = invokeHandlerAsPromise(handleProofreadText, msg, 180000);
        break;
      case 'GET_SETTINGS':
        responsePromise = invokeSettingsAsPromise(handleGetSettings, msg, 1500).then((settings) => ({
          ok: true,
          settings
        }));
        break;
      case 'GET_TAB_ID':
        responsePromise = Promise.resolve({ ok: true, tabId });
        break;
      default:
        responsePromise = Promise.resolve({
          success: false,
          error: `Unknown RPC type: ${type}`,
          isRuntimeError: true
        });
        break;
    }

    Promise.resolve(responsePromise)
      .then((response) => {
        postResponse(response);
      })
      .catch((error) => {
        postResponse({
          success: false,
          error: error?.message || String(error),
          isRuntimeError: true
        });
      });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_SETTINGS') {
    const requestId =
      typeof message?.requestId === 'string' && message.requestId
        ? message.requestId
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    sendResponse({ ok: true, requestId });
    const tabId = sender?.tab?.id;
    if (!tabId) {
      return true;
    }
    Promise.resolve()
      .then(async () => {
        const settings = await computeSettingsViaHandle({ ...message, requestId });
        const safeSettings =
          settings && typeof settings === 'object'
            ? settings
            : {
                allowed: false,
                disallowedReason:
                  'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.',
                apiKey: DEFAULT_STATE.apiKey,
                translationModel: DEFAULT_STATE.translationModel,
                contextModel: DEFAULT_STATE.contextModel,
                proofreadModel: DEFAULT_STATE.proofreadModel,
                contextGenerationEnabled: DEFAULT_STATE.contextGenerationEnabled,
                proofreadEnabled: DEFAULT_STATE.proofreadEnabled,
                blockLengthLimit: DEFAULT_STATE.blockLengthLimit,
                tpmLimitsByRole: {
                  translation: getTpmLimitForModel(DEFAULT_STATE.translationModel, DEFAULT_STATE.tpmLimitsByModel),
                  context: getTpmLimitForModel(DEFAULT_STATE.contextModel, DEFAULT_STATE.tpmLimitsByModel),
                  proofread: getTpmLimitForModel(DEFAULT_STATE.proofreadModel, DEFAULT_STATE.tpmLimitsByModel)
                },
                outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
                tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
              };
        chrome.tabs.sendMessage(
          tabId,
          { type: NT_SETTINGS_RESPONSE_TYPE, requestId, settings: safeSettings },
          () => {
            if (chrome.runtime.lastError) {
              console.debug('Failed to deliver settings response to tab.', chrome.runtime.lastError.message);
            }
          }
        );
      })
      .catch((error) => {
        console.warn('Failed to compute settings for tab message.', error);
      });
    return true;
  }

  if (message?.type === 'TRANSLATE_TEXT') {
    handleTranslateText(message, sendResponse);
    return true;
  }

  if (message?.type === 'GENERATE_CONTEXT') {
    handleGenerateContext(message, sendResponse);
    return true;
  }

  if (message?.type === 'PROOFREAD_TEXT') {
    handleProofreadText(message, sendResponse);
    return true;
  }

  if (message?.type === 'RUN_MODEL_THROUGHPUT_TEST') {
    handleModelThroughputTest(message, sendResponse);
    return true;
  }

  if (message?.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender?.tab?.id ?? null });
    return true;
  }

  if (message?.type === 'SYNC_STATE_CACHE') {
    try {
      applyStatePatch(message?.state || {});
    } catch (error) {
      console.warn('Failed to sync state cache.', error);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'CANCEL_PAGE_TRANSLATION' && sender?.tab?.id) {
    sendMessageToTabSafe(sender.tab, { type: 'CANCEL_TRANSLATION' }).then((result) => {
      if (!result.ok) {
        console.warn('Failed to cancel translation via tab message.', result.reason);
      }
    });
  }

  if (message?.type === 'NT_CONTENT_READY' && sender?.tab?.id) {
    CONTENT_READY_BY_TAB.set(sender.tab.id, Date.now());
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'ENSURE_CONTENT_SCRIPT') {
    const tabId = Number(message.tabId);
    if (!Number.isFinite(tabId)) {
      sendResponse({ ok: false, reason: 'tab-not-found' });
      return true;
    }
    chrome.tabs.get(tabId, async (tab) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      if (!tab?.url || !isInjectableTabUrl(tab.url)) {
        sendResponse({ ok: false, reason: 'unsupported-url' });
        return;
      }
      const injected = await ensureContentScriptInjected(tabId);
      if (injected.ok) {
        CONTENT_READY_BY_TAB.set(tabId, Date.now());
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, reason: injected.reason || 'inject-failed' });
      }
    });
    return true;
  }

  if (message?.type === 'TRANSLATION_PROGRESS') {
    handleTranslationProgress(message, sender);
  }

  if (message?.type === 'TRANSLATION_CANCELLED') {
    handleTranslationCancelled(message, sender);
  }

  if (message?.type === 'UPDATE_TRANSLATION_VISIBILITY') {
    handleTranslationVisibility(message, sender);
  }

  if (message?.type === 'GET_TRANSLATION_STATUS') {
    handleGetTranslationStatus(sendResponse, sender?.tab?.id);
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  CONTENT_READY_BY_TAB.delete(tabId);
  ACTIVE_TRANSLATION_TABS.delete(tabId);
});

setInterval(() => {
  maybeTriggerThroughputTests('timer');
}, THROUGHPUT_CHECK_INTERVAL_MS);

async function warmUpContentScripts(reason) {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab?.id || !isInjectableTabUrl(tab.url)) {
        continue;
      }
      if (tab.status && tab.status !== 'complete') {
        continue;
      }
      if (CONTENT_READY_BY_TAB.has(tab.id)) {
        continue;
      }
      const injected = await ensureContentScriptInjected(tab.id);
      if (injected.ok) {
        CONTENT_READY_BY_TAB.set(tab.id, Date.now());
      } else {
        console.debug('Content script warm-up skipped.', { reason, tabId: tab.id, error: injected.reason });
      }
    }
  } catch (error) {
    console.warn('Failed to warm up content scripts.', error);
  }
}

function computeSettingsViaHandle(messageForHandle) {
  return new Promise((resolve) => {
    let done = false;
    const safeResolve = (payload) => {
      if (done) return;
      done = true;
      resolve(payload && typeof payload === 'object' ? payload : null);
    };
    const timer = setTimeout(() => safeResolve(null), 1500);
    Promise.resolve()
      .then(() =>
        handleGetSettings(messageForHandle, (resp) => {
          clearTimeout(timer);
          safeResolve(resp);
        })
      )
      .catch(() => {
        clearTimeout(timer);
        safeResolve(null);
      });
  });
}

async function handleGetSettings(message, sendResponse) {
  let response = null;
  try {
    const state = await getState();
    if (!state || typeof state !== 'object') {
      response = {
        allowed: false,
        disallowedReason:
          'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.',
        apiKey: DEFAULT_STATE.apiKey,
        translationModel: DEFAULT_STATE.translationModel,
        contextModel: DEFAULT_STATE.contextModel,
        proofreadModel: DEFAULT_STATE.proofreadModel,
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
    } else {
      const translationConfig = getApiConfigForModel(state.translationModel, state);
      const contextConfig = getApiConfigForModel(state.contextModel, state);
      const proofreadConfig = getApiConfigForModel(state.proofreadModel, state);
      const tpmLimitsByRole = {
        translation: getTpmLimitForModel(state.translationModel, state.tpmLimitsByModel),
        context: getTpmLimitForModel(state.contextModel, state.tpmLimitsByModel),
        proofread: getTpmLimitForModel(state.proofreadModel, state.tpmLimitsByModel)
      };
      const hasTranslationKey = Boolean(translationConfig.apiKey);
      const hasContextKey = Boolean(contextConfig.apiKey);
      const hasProofreadKey = Boolean(proofreadConfig.apiKey);
      let disallowedReason = null;
      if (!hasTranslationKey) {
        disallowedReason = buildMissingKeyReason('перевод', translationConfig, state.translationModel);
      } else if (state.contextGenerationEnabled && !hasContextKey) {
        disallowedReason = buildMissingKeyReason('контекст', contextConfig, state.contextModel);
      } else if (state.proofreadEnabled && !hasProofreadKey) {
        disallowedReason = buildMissingKeyReason('вычитка', proofreadConfig, state.proofreadModel);
      }
      response = {
        allowed:
          hasTranslationKey &&
          (!state.contextGenerationEnabled || hasContextKey) &&
          (!state.proofreadEnabled || hasProofreadKey),
        disallowedReason,
        apiKey: state.apiKey,
        translationModel: state.translationModel,
        contextModel: state.contextModel,
        proofreadModel: state.proofreadModel,
        contextGenerationEnabled: state.contextGenerationEnabled,
        proofreadEnabled: state.proofreadEnabled,
        singleBlockConcurrency: state.singleBlockConcurrency,
        blockLengthLimit: state.blockLengthLimit,
        tpmLimitsByRole,
        outputRatioByRole: state.outputRatioByRole || DEFAULT_OUTPUT_RATIO_BY_ROLE,
        tpmSafetyBufferTokens:
          Number.isFinite(state.tpmSafetyBufferTokens) && state.tpmSafetyBufferTokens >= 0
            ? state.tpmSafetyBufferTokens
            : DEFAULT_TPM_SAFETY_BUFFER_TOKENS
      };
    }
  } catch (error) {
    console.error('Failed to fetch settings.', error);
    response = {
      allowed: false,
      disallowedReason:
        'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.',
      apiKey: DEFAULT_STATE.apiKey,
      translationModel: DEFAULT_STATE.translationModel,
      contextModel: DEFAULT_STATE.contextModel,
      proofreadModel: DEFAULT_STATE.proofreadModel,
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
  } finally {
    if (!response) {
      response = {
        allowed: false,
        disallowedReason:
          'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.',
        apiKey: DEFAULT_STATE.apiKey,
        translationModel: DEFAULT_STATE.translationModel,
        contextModel: DEFAULT_STATE.contextModel,
        proofreadModel: DEFAULT_STATE.proofreadModel,
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
    sendResponse(response);
  }
}

async function handleTranslateText(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.translationModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const { translations, rawTranslation, debug } = await translateTexts(
      message.texts,
      apiKey,
      message.targetLanguage,
      state.translationModel,
      message.context,
      apiBaseUrl,
      message.keepPunctuationTokens
    );
    sendResponse({ success: true, translations, rawTranslation, debug });
  } catch (error) {
    console.error('Translation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleGenerateContext(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.contextModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const { context, debug } = await generateTranslationContext(
      message.text,
      apiKey,
      message.targetLanguage,
      state.contextModel,
      apiBaseUrl
    );
    sendResponse({ success: true, context, debug });
  } catch (error) {
    console.error('Context generation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleProofreadText(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.proofreadModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const { translations, rawProofread, debug } = await proofreadTranslation(
      message.segments,
      message.sourceBlock,
      message.translatedBlock,
      message.context,
      message.language,
      apiKey,
      state.proofreadModel,
      apiBaseUrl
    );
    sendResponse({ success: true, translations, rawProofread, debug });
  } catch (error) {
    console.error('Proofreading failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleModelThroughputTest(message, sendResponse) {
  try {
    const state = await getState();
    const model = message?.model || state.translationModel;
    const { apiKey, apiBaseUrl } = getApiConfigForModel(model, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const result = await runModelThroughputTest(apiKey, model, apiBaseUrl);
    await saveModelThroughputResult(model, result);
    sendResponse({ success: true, result });
  } catch (error) {
    const model = message?.model || DEFAULT_STATE.translationModel;
    const failure = {
      success: false,
      error: error?.message || 'Throughput test failed',
      timestamp: Date.now(),
      model
    };
    await saveModelThroughputResult(model, failure);
    sendResponse({ success: false, error: failure.error });
  }
}

async function runModelThroughputTest(apiKey, model, apiBaseUrl = OPENAI_API_URL) {
  if (!apiKey) {
    throw new Error('API key is missing.');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_THROUGHPUT_TEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const requestPayload = {
      model,
      messages: [
        {
          role: 'system',
          content: 'You output plain text only.'
        },
        {
          role: 'user',
          content: 'Generate 200 tokens of random English words. Output only the words.'
        }
      ],
      max_tokens: 200,
      temperature: 0.3
    };
    const response = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Throughput request failed: ${response.status} ${errorText}`);
    }
    const data = await response.json();
    const endedAt = Date.now();
    const durationMs = Math.max(1, endedAt - startedAt);
    const usage = normalizeUsage(data?.usage);
    let completionTokens = Number(usage?.completion_tokens);
    if (!Number.isFinite(completionTokens) || completionTokens <= 0) {
      const content = data?.choices?.[0]?.message?.content || '';
      completionTokens = Math.max(1, Math.round(content.length / 4));
    }
    const tokensPerSecond = completionTokens / (durationMs / 1000);
    return {
      success: true,
      model,
      durationMs,
      tokensPerSecond: Number.isFinite(tokensPerSecond) ? tokensPerSecond : null,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
      totalTokens: Number.isFinite(usage?.total_tokens) ? usage.total_tokens : null,
      timestamp: Date.now()
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function saveModelThroughputResult(model, result) {
  if (!model) return;
  const { modelThroughputById = {} } = await storageLocalGet({ modelThroughputById: {} });
  modelThroughputById[model] = {
    ...result,
    model,
    timestamp: Number.isFinite(result?.timestamp) ? result.timestamp : Date.now()
  };
  await storageLocalSet({ modelThroughputById });
}

function isTranslationActive(status) {
  if (!status) return false;
  const completedBlocks = status.completedBlocks ?? status.completedChunks ?? 0;
  const totalBlocks = status.totalBlocks ?? status.totalChunks ?? 0;
  const inProgressBlocks = status.inProgressBlocks ?? status.inProgressChunks ?? 0;
  if (!totalBlocks) return false;
  return completedBlocks < totalBlocks || inProgressBlocks > 0;
}

function trackTranslationActivity(tabId, status) {
  if (!tabId) return;
  if (isTranslationActive(status)) {
    ACTIVE_TRANSLATION_TABS.set(tabId, { lastProgressAt: Date.now() });
  } else {
    ACTIVE_TRANSLATION_TABS.delete(tabId);
  }
}

function hasActiveTranslations(now) {
  let hasActive = false;
  ACTIVE_TRANSLATION_TABS.forEach((value, tabId) => {
    if (!value || now - value.lastProgressAt > TRANSLATION_ACTIVITY_GRACE_MS) {
      ACTIVE_TRANSLATION_TABS.delete(tabId);
      return;
    }
    hasActive = true;
  });
  return hasActive;
}

function shouldRunThroughputTest(model, previousInfo, now) {
  if (!model) return false;
  const lastRequestedAt = LAST_THROUGHPUT_REQUEST_BY_MODEL.get(model) || 0;
  const lastStoredAt = Number.isFinite(previousInfo?.timestamp) ? previousInfo.timestamp : 0;
  const lastKnownAt = Math.max(lastRequestedAt, lastStoredAt);
  return now - lastKnownAt >= MODEL_THROUGHPUT_TEST_THROTTLE_MS;
}

async function runPeriodicThroughputTests(reason) {
  if (throughputTestInFlight) return;
  throughputTestInFlight = true;
  try {
    const state = await getState();
    const { modelThroughputById = {} } = await storageLocalGet({ modelThroughputById: {} });
    const modelsToTest = new Set();
    if (state.translationModel) modelsToTest.add(state.translationModel);
    if (state.contextGenerationEnabled && state.contextModel) modelsToTest.add(state.contextModel);
    if (state.proofreadEnabled && state.proofreadModel) modelsToTest.add(state.proofreadModel);

    const now = Date.now();
    for (const model of modelsToTest) {
      if (!shouldRunThroughputTest(model, modelThroughputById[model], now)) {
        continue;
      }
      const { apiKey, apiBaseUrl } = getApiConfigForModel(model, state);
      if (!apiKey) {
        continue;
      }
      LAST_THROUGHPUT_REQUEST_BY_MODEL.set(model, now);
      try {
        const result = await runModelThroughputTest(apiKey, model, apiBaseUrl);
        await saveModelThroughputResult(model, result);
      } catch (error) {
        const failure = {
          success: false,
          error: error?.message || 'Throughput test failed',
          timestamp: Date.now(),
          model,
          reason
        };
        await saveModelThroughputResult(model, failure);
      }
    }
  } finally {
    throughputTestInFlight = false;
  }
}

function maybeTriggerThroughputTests(reason) {
  const now = Date.now();
  if (!hasActiveTranslations(now)) return;
  if (now - lastThroughputScheduleAt < THROUGHPUT_CHECK_INTERVAL_MS) return;
  lastThroughputScheduleAt = now;
  void runPeriodicThroughputTests(reason);
}

async function handleTranslationProgress(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  const status = {
    completedBlocks: message.completedBlocks || 0,
    totalBlocks: message.totalBlocks || 0,
    inProgressBlocks: message.inProgressBlocks || 0,
    message: message.message || '',
    timestamp: Date.now()
  };
  const { translationStatusByTab = {} } = await storageLocalGet({ translationStatusByTab: {} });
  translationStatusByTab[tabId] = status;
  await storageLocalSet({ translationStatusByTab });
  trackTranslationActivity(tabId, status);
  maybeTriggerThroughputTests('progress');
}

async function handleGetTranslationStatus(sendResponse, tabId) {
  const { translationStatusByTab = {} } = await storageLocalGet({ translationStatusByTab: {} });
  sendResponse(translationStatusByTab[tabId] || null);
}

async function handleTranslationVisibility(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;
  const { translationVisibilityByTab = {} } = await storageLocalGet({ translationVisibilityByTab: {} });
  translationVisibilityByTab[tabId] = Boolean(message.visible);
  await storageLocalSet({ translationVisibilityByTab });
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_VISIBILITY_CHANGED',
    tabId,
    visible: Boolean(message.visible)
  });
}

async function handleTranslationCancelled(message, sender) {
  const tabId = message?.tabId ?? sender?.tab?.id;
  if (!tabId) return;
  const { translationStatusByTab = {}, translationVisibilityByTab = {} } = await storageLocalGet({
    translationStatusByTab: {},
    translationVisibilityByTab: {}
  });
  delete translationStatusByTab[tabId];
  translationVisibilityByTab[tabId] = false;
  await storageLocalSet({ translationStatusByTab, translationVisibilityByTab });
  ACTIVE_TRANSLATION_TABS.delete(tabId);
  chrome.runtime.sendMessage({ type: 'TRANSLATION_CANCELLED', tabId });
}
