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
  openAiOrganization: '',
  openAiProject: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  singleBlockConcurrency: false,
  blockLengthLimit: 1200,
  tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
  outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
  tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
};

let STATE_CACHE = null;
let STATE_CACHE_READY = false;
const NT_RPC_PORT_NAME = 'NT_RPC_PORT';
const UI_PORT_NAMES = {
  debug: 'debug',
  popup: 'popup'
};
const DEBUG_DB_NAME = 'nt_debug';
const DEBUG_DB_VERSION = 1;
const DEBUG_RAW_STORE = 'raw';
const DEBUG_RAW_MAX_RECORDS = 1500;
const DEBUG_RAW_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STATE_CACHE_KEYS = new Set([
  'apiKey',
  'openAiOrganization',
  'openAiProject',
  'translationModel',
  'contextModel',
  'proofreadModel',
  'contextGenerationEnabled',
  'proofreadEnabled',
  'singleBlockConcurrency',
  'blockLengthLimit',
  'tpmLimitsByModel',
  'outputRatioByRole',
  'tpmSafetyBufferTokens'
]);

const CONTENT_READY_BY_TAB = new Map();
const NT_SETTINGS_RESPONSE_TYPE = 'NT_SETTINGS_RESPONSE';
const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const DEBUG_PORTS = new Set();
const POPUP_PORTS = new Set();
let debugDbPromise = null;

function openDebugDb() {
  if (debugDbPromise) return debugDbPromise;
  debugDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DEBUG_DB_NAME, DEBUG_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DEBUG_RAW_STORE)) {
        const store = db.createObjectStore(DEBUG_RAW_STORE, { keyPath: 'id' });
        store.createIndex('ts', 'ts', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
  return debugDbPromise;
}

function wrapIdbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

async function withRawStore(mode, fn) {
  const db = await openDebugDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEBUG_RAW_STORE, mode);
    const store = tx.objectStore(DEBUG_RAW_STORE);
    Promise.resolve(fn(store))
      .then((result) => {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      })
      .catch((error) => {
        tx.abort();
        reject(error);
      });
  });
}

async function pruneDebugRawStore() {
  const now = Date.now();
  return withRawStore('readwrite', async (store) => {
    const index = store.index('ts');
    const total = await wrapIdbRequest(index.count());
    let excess = Math.max(0, total - DEBUG_RAW_MAX_RECORDS);
    return new Promise((resolve, reject) => {
      const cursorRequest = index.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve();
          return;
        }
        const isExpired = cursor.value?.ts && cursor.value.ts < now - DEBUG_RAW_MAX_AGE_MS;
        if (isExpired || excess > 0) {
          if (excess > 0) {
            excess -= 1;
          }
          cursor.delete();
          cursor.continue();
          return;
        }
        resolve();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error || new Error('IndexedDB cursor failed'));
    });
  });
}

async function storeDebugRaw(record) {
  if (!record?.id) {
    return { ok: false, error: 'missing-id' };
  }
  const payload = {
    ...record,
    ts: Number.isFinite(record.ts) ? record.ts : Date.now()
  };
  await withRawStore('readwrite', (store) => wrapIdbRequest(store.put(payload)));
  await pruneDebugRawStore();
  return { ok: true };
}

async function getDebugRaw(id) {
  if (!id) return null;
  return withRawStore('readonly', (store) => wrapIdbRequest(store.get(id)));
}

function registerUiPort(port, kind) {
  const set = kind === UI_PORT_NAMES.debug ? DEBUG_PORTS : POPUP_PORTS;
  set.add(port);
  port.onDisconnect.addListener(() => {
    set.delete(port);
  });
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (kind !== UI_PORT_NAMES.debug) return;
    if (message.type === 'DEBUG_GET_SNAPSHOT') {
      const sourceUrl = typeof message.sourceUrl === 'string' ? message.sourceUrl : '';
      getDebugSnapshot(sourceUrl)
        .then((snapshot) => {
          port.postMessage({ type: 'DEBUG_SNAPSHOT', sourceUrl, snapshot });
        })
        .catch((error) => {
          port.postMessage({
            type: 'DEBUG_SNAPSHOT',
            sourceUrl,
            snapshot: null,
            error: error?.message || String(error)
          });
        });
    }
    if (message.type === 'DEBUG_GET_RAW') {
      const rawId = typeof message.rawId === 'string' ? message.rawId : '';
      getDebugRaw(rawId)
        .then((record) => {
          port.postMessage({ type: 'DEBUG_RAW', rawId, record: record || null });
        })
        .catch((error) => {
          port.postMessage({
            type: 'DEBUG_RAW',
            rawId,
            record: null,
            error: error?.message || String(error)
          });
        });
    }
  });
}

function broadcastToPorts(ports, message) {
  if (!ports.size) return false;
  let delivered = false;
  for (const port of ports) {
    try {
      port.postMessage(message);
      delivered = true;
    } catch (error) {
      ports.delete(port);
    }
  }
  return delivered;
}

function sendRuntimeMessageSafe(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      if (chrome.runtime.lastError) {
        // Ignore missing listeners.
      }
    });
  } catch (error) {
    // Ignore missing listeners.
  }
}

async function getDebugSnapshot(sourceUrl) {
  if (!sourceUrl) return null;
  const store = await storageLocalGet({ [DEBUG_STORAGE_KEY]: {} });
  const map = store?.[DEBUG_STORAGE_KEY] || {};
  return map[sourceUrl] || null;
}

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
    if (
      ['apiKey', 'openAiOrganization', 'openAiProject', 'translationModel', 'contextModel', 'proofreadModel'].includes(
        key
      )
    ) {
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
    if (['tpmLimitsByModel', 'outputRatioByRole'].includes(key)) {
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
  if (!port) return;
  if (port.name === UI_PORT_NAMES.debug || port.name === UI_PORT_NAMES.popup) {
    registerUiPort(port, port.name);
    return;
  }
  if (port.name !== NT_RPC_PORT_NAME) return;
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
      case 'GENERATE_SHORT_CONTEXT':
        responsePromise = invokeHandlerAsPromise(handleGenerateShortContext, msg, 120000);
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
  if (message?.type === 'DEBUG_STORE_RAW') {
    Promise.resolve()
      .then(() => storeDebugRaw(message?.record || {}))
      .then((result) => {
        sendResponse(result || { ok: false, error: 'store-failed' });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message?.type === 'DEBUG_GET_RAW') {
    Promise.resolve()
      .then(() => getDebugRaw(message?.rawId))
      .then((record) => {
        sendResponse({ ok: true, record: record || null });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message?.type === 'DEBUG_GET_SNAPSHOT') {
    Promise.resolve()
      .then(() => getDebugSnapshot(message?.sourceUrl || ''))
      .then((snapshot) => {
        sendResponse({ ok: true, snapshot: snapshot || null });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message?.type === 'DEBUG_NOTIFY') {
    const sourceUrl = typeof message?.sourceUrl === 'string' ? message.sourceUrl : '';
    const delivered = broadcastToPorts(DEBUG_PORTS, { type: 'DEBUG_UPDATED', sourceUrl });
    sendResponse({ ok: true, delivered });
    return true;
  }

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

  if (message?.type === 'GENERATE_SHORT_CONTEXT') {
    handleGenerateShortContext(message, sendResponse);
    return true;
  }

  if (message?.type === 'PROOFREAD_TEXT') {
    handleProofreadText(message, sendResponse);
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
});

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
    sendResponse({
      success: false,
      error: error?.message || 'Unknown error',
      contextOverflow: Boolean(error?.isContextOverflow)
    });
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

async function handleGenerateShortContext(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.contextModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const { context, debug } = await generateShortTranslationContext(
      message.text,
      apiKey,
      message.targetLanguage,
      state.contextModel,
      apiBaseUrl
    );
    sendResponse({ success: true, context, debug });
  } catch (error) {
    console.error('Short context generation failed', error);
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
      message.proofreadMode,
      message.language,
      apiKey,
      state.proofreadModel,
      apiBaseUrl
    );
    sendResponse({ success: true, translations, rawProofread, debug });
  } catch (error) {
    console.error('Proofreading failed', error);
    sendResponse({
      success: false,
      error: error?.message || 'Unknown error',
      contextOverflow: Boolean(error?.isContextOverflow)
    });
  }
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
  const payload = {
    type: 'TRANSLATION_VISIBILITY_CHANGED',
    tabId,
    visible: Boolean(message.visible)
  };
  broadcastToPorts(POPUP_PORTS, payload);
  sendRuntimeMessageSafe(payload);
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
  const payload = { type: 'TRANSLATION_CANCELLED', tabId };
  broadcastToPorts(POPUP_PORTS, payload);
  sendRuntimeMessageSafe(payload);
}
