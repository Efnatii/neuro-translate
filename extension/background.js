importScripts('core/message-schema.js');
importScripts('core/migrations.js');
importScripts('core/notification-center.js');
importScripts('core/port-hub.js');
importScripts('core/state-store.js');
importScripts('core/rpc.js');
importScripts('core/openai-client.js');
importScripts('core/llm-service-base.js');
importScripts('core/user-notifier.js');
importScripts('core/prompt-tags.js');
importScripts('core/prompt-builder.js');
importScripts('ai-common.js');
importScripts('messaging.js');
importScripts('translation-service.js');
importScripts('context-service.js');
importScripts('proofread-service.js');
importScripts('services/translation-service.js');
importScripts('services/context-service.js');
importScripts('services/proofread-service.js');

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
const STATE_SCHEMA_VERSION = 2;
const DEFAULT_STATE = {
  apiKey: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  translationModelList: ['gpt-4.1-mini:standard'],
  contextModelList: ['gpt-4.1-mini:standard'],
  proofreadModelList: ['gpt-4.1-mini:standard'],
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  notificationsEnabled: false,
  blockLengthLimit: 1200,
  tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
  outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
  tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS,
  stateVersion: STATE_SCHEMA_VERSION,
  translationStatusByTab: {},
  translationJobById: {}
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
// Obsolete storage keys from removed settings (OpenAI org/project, single-block concurrency).
const OBSOLETE_STORAGE_KEYS = [
  'openAi' + 'Organization',
  'openAi' + 'Project',
  'single' + 'Block' + 'Concurrency'
];
const STATE_CACHE_KEYS = new Set([
  'apiKey',
  'translationModel',
  'contextModel',
  'proofreadModel',
  'translationModelList',
  'contextModelList',
  'proofreadModelList',
  'contextGenerationEnabled',
  'proofreadEnabled',
  'notificationsEnabled',
  'blockLengthLimit',
  'tpmLimitsByModel',
  'outputRatioByRole',
  'tpmSafetyBufferTokens',
  'stateVersion'
]);

const CONTENT_READY_BY_TAB = new Map();
const NT_SETTINGS_RESPONSE_TYPE = 'NT_SETTINGS_RESPONSE';
const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const DEBUG_PORTS = new Set();
const POPUP_PORTS = new Set();
let debugDbPromise = null;
let STATE_STORE_READY = false;
const NT_TRANSLATION_SERVICE = new TranslationService({ client: globalThis.ntOpenAiClient });
const NT_CONTEXT_SERVICE = new ContextService({ client: globalThis.ntOpenAiClient });
const NT_PROOFREAD_SERVICE = new ProofreadService({ client: globalThis.ntOpenAiClient });
const NT_RPC_SERVER = new NtRpcServer({ portHub: globalThis.ntPortHub, notifications: globalThis.ntNotifications });
const ACTIVE_JOBS = new Map();

function createJobController(jobId, meta = {}) {
  if (!jobId) return null;
  const existing = ACTIVE_JOBS.get(jobId);
  if (existing?.abortController) {
    try {
      existing.abortController.abort('replaced');
    } catch (error) {
      // ignore
    }
  }
  const abortController = new AbortController();
  const entry = {
    tabId: meta.tabId ?? null,
    startedAt: Date.now(),
    abortController,
    stage: meta.stage || ''
  };
  ACTIVE_JOBS.set(jobId, entry);
  return entry;
}

function releaseJobController(jobId, abortController) {
  const existing = ACTIVE_JOBS.get(jobId);
  if (existing?.abortController === abortController) {
    ACTIVE_JOBS.delete(jobId);
  }
}

function isCancelledError(error) {
  return Boolean(error?.isCancelled || error?.name === 'AbortError');
}

async function runJobHandler(stage, payload, meta, handler, timeoutMs) {
  const jobId = payload?.jobId;
  if (!jobId) {
    return { success: false, error: 'Missing jobId.', isRuntimeError: true };
  }
  const jobEntry = createJobController(jobId, { tabId: meta?.tabId, stage });
  if (!jobEntry) {
    return { success: false, error: 'Failed to register job.', isRuntimeError: true };
  }
  try {
    const message = {
      ...(payload && typeof payload === 'object' ? payload : {}),
      abortSignal: jobEntry.abortController.signal
    };
    return await invokeHandlerAsPromise(handler, mergeRpcMeta(message, meta), timeoutMs);
  } finally {
    releaseJobController(jobId, jobEntry.abortController);
  }
}

function registerRpcHandlers() {
  NT_RPC_SERVER.registerHandler(
    'heartbeat',
    async () => ({ ok: true, ts: Date.now() }),
    { timeoutMs: 2000 }
  );
  NT_RPC_SERVER.registerHandler(
    'translate_text',
    async (payload, meta) => runJobHandler('translation', payload, meta, handleTranslateText, 240000),
    { timeoutMs: 250000 }
  );
  NT_RPC_SERVER.registerHandler(
    'generate_context',
    async (payload, meta) => runJobHandler('context', payload, meta, handleGenerateContext, 120000),
    { timeoutMs: 130000 }
  );
  NT_RPC_SERVER.registerHandler(
    'generate_short_context',
    async (payload, meta) => runJobHandler('context', payload, meta, handleGenerateShortContext, 120000),
    { timeoutMs: 130000 }
  );
  NT_RPC_SERVER.registerHandler(
    'proofread_text',
    async (payload, meta) => runJobHandler('proofread', payload, meta, handleProofreadText, 180000),
    { timeoutMs: 190000 }
  );
  NT_RPC_SERVER.registerHandler(
    'cancel_job',
    async (payload) => {
      const jobId = payload?.jobId;
      if (!jobId) {
        return { success: false, error: 'Missing jobId.', isRuntimeError: true };
      }
      const entry = ACTIVE_JOBS.get(jobId);
      if (!entry) {
        return { success: false, error: 'Job not found.', isRuntimeError: true };
      }
      try {
        entry.abortController.abort('cancelled');
      } catch (error) {
        // ignore
      }
      ACTIVE_JOBS.delete(jobId);
      if (globalThis.ntPortHub && globalThis.ntCreateMessage) {
        const envelope = globalThis.ntCreateMessage(
          'JOB_CANCELLED',
          { jobId, tabId: entry.tabId ?? null },
          { tabId: entry.tabId ?? null }
        );
        globalThis.ntPortHub.broadcastUi(envelope);
        sendRuntimeMessageSafe(envelope);
      }
      return { success: true, cancelled: true };
    },
    { timeoutMs: 5000 }
  );
  NT_RPC_SERVER.registerHandler(
    'get_tab_id',
    async (_payload, meta) => ({ ok: true, tabId: meta?.tabId ?? null }),
    { timeoutMs: 2000 }
  );
}

registerRpcHandlers();

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
  port.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'UI_HEARTBEAT') {
      try {
        const ack = globalThis.ntCreateMessage
          ? globalThis.ntCreateMessage('UI_HEARTBEAT_ACK', { ts: Date.now() })
          : { type: 'UI_HEARTBEAT_ACK', ts: Date.now() };
        port.postMessage(ack);
      } catch (error) {
        // Ignore heartbeat post failures to avoid log spam.
      }
      return;
    }
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
  if (globalThis.ntPortHub) {
    if (ports === DEBUG_PORTS) {
      return globalThis.ntPortHub.broadcast('debug', message);
    }
    if (ports === POPUP_PORTS) {
      return globalThis.ntPortHub.broadcast('popup', message);
    }
  }
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

function mergeRpcMeta(payload, meta) {
  if (!payload || typeof payload !== 'object') return payload;
  const requestMeta = payload.requestMeta && typeof payload.requestMeta === 'object' ? payload.requestMeta : {};
  const mergedMeta = {
    ...requestMeta
  };
  if (meta?.tabId != null && mergedMeta.tabId == null) {
    mergedMeta.tabId = meta.tabId;
  }
  if (meta?.url && !mergedMeta.url) {
    mergedMeta.url = meta.url;
  }
  if (meta?.stage && !mergedMeta.stage) {
    mergedMeta.stage = meta.stage;
  }
  return {
    ...payload,
    requestMeta: mergedMeta
  };
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

function storageLocalGetAll(timeoutMs = 6000) {
  return storageLocalGet(null, timeoutMs);
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

function broadcastStateSnapshot(state) {
  if (!state) return;
  const snapshot = { state, ts: Date.now() };
  const envelope = globalThis.ntCreateMessage
    ? globalThis.ntCreateMessage('STATE_SNAPSHOT', snapshot)
    : { type: 'STATE_SNAPSHOT', payload: snapshot };
  if (globalThis.ntPortHub) {
    globalThis.ntPortHub.broadcastUi(envelope);
  }
  sendRuntimeMessageSafe(envelope);
}

async function runStateMigrations() {
  if (typeof migrateState !== 'function') {
    return { migratedState: null, changed: false, fromVersion: STATE_SCHEMA_VERSION, toVersion: STATE_SCHEMA_VERSION };
  }
  let storedState = {};
  try {
    storedState = await storageLocalGetAll(8000);
  } catch (error) {
    console.warn('Failed to load stored state for migrations.', error);
    storedState = {};
  }
  const result = migrateState(storedState);
  const migratedState = result?.migratedState && typeof result.migratedState === 'object' ? result.migratedState : {};
  const changed = Boolean(result?.changed);
  const fromVersion = Number.isFinite(result?.fromVersion) ? result.fromVersion : STATE_SCHEMA_VERSION;
  const toVersion = Number.isFinite(result?.toVersion) ? result.toVersion : STATE_SCHEMA_VERSION;
  if (changed) {
    try {
      await storageLocalSet(migratedState, 8000);
      if (fromVersion < 2 && OBSOLETE_STORAGE_KEYS.length) {
        chrome.storage.local.remove(OBSOLETE_STORAGE_KEYS, () => {
          if (chrome.runtime.lastError) {
            console.warn('Failed to remove obsolete storage keys.', chrome.runtime.lastError);
          }
        });
      }
    } catch (error) {
      console.warn('Failed to persist migrated state.', error);
    }
  }
  return { migratedState, changed, fromVersion, toVersion };
}

async function ensureStateStoreLoaded() {
  if (!globalThis.ntStateStore) return null;
  if (STATE_STORE_READY) return globalThis.ntStateStore.get();
  const migrationResult = await runStateMigrations();
  const loaded = await globalThis.ntStateStore.load({ ...DEFAULT_STATE, model: null, chunkLengthLimit: null });
  STATE_STORE_READY = true;
  globalThis.ntStateStore.subscribe(({ patch }) => {
    if (patch?.values) {
      applyStatePatch(patch.values);
    }
  });
  applyStatePatch(loaded);
  if (migrationResult?.changed) {
    broadcastStateSnapshot(globalThis.ntStateStore.get());
  }
  return loaded;
}

function broadcastStatePatch(patch, meta) {
  if (!patch) return;
  if (globalThis.ntPortHub && globalThis.ntCreateMessage) {
    const envelope = globalThis.ntCreateMessage('STATE_PATCH', patch, meta);
    globalThis.ntPortHub.broadcastUi(envelope);
    sendRuntimeMessageSafe(envelope);
  }
}

async function updateState(partial, meta) {
  if (globalThis.ntStateStore) {
    await ensureStateStoreLoaded();
    const patch = await globalThis.ntStateStore.set(partial, meta);
    broadcastStatePatch(patch, meta);
    return patch;
  }
  await storageLocalSet(partial);
  applyStatePatch(partial);
  const patch = {
    changedKeys: Object.keys(partial || {}),
    values: partial || {},
    ts: Date.now()
  };
  broadcastStatePatch(patch, meta);
  return patch;
}

function areNotificationsEnabled() {
  if (globalThis.ntStateStore) {
    const state = globalThis.ntStateStore.get();
    return Boolean(state?.notificationsEnabled);
  }
  return Boolean(STATE_CACHE?.notificationsEnabled || DEFAULT_STATE.notificationsEnabled);
}

const STATE_STORE_READY_PROMISE = ensureStateStoreLoaded().catch((error) => {
  console.warn('Failed to load state store on startup.', error);
  return null;
});
globalThis.ntStateStoreReadyPromise = STATE_STORE_READY_PROMISE;

function applyStatePatch(patch = {}) {
  const next = STATE_CACHE && typeof STATE_CACHE === 'object' ? { ...STATE_CACHE } : { ...DEFAULT_STATE };

  for (const [key, value] of Object.entries(patch || {})) {
    if (!STATE_CACHE_KEYS.has(key)) continue;
    if (['apiKey', 'translationModel', 'contextModel', 'proofreadModel'].includes(key)) {
      next[key] = typeof value === 'string' ? value : value == null ? '' : String(value);
      continue;
    }
    if (['translationModelList', 'contextModelList', 'proofreadModelList'].includes(key)) {
      const fallbackModel =
        key === 'contextModelList'
          ? next.contextModel
          : key === 'proofreadModelList'
            ? next.proofreadModel
            : next.translationModel;
      const normalizedList = normalizeModelList(value, fallbackModel);
      next[key] = normalizedList;
      if (key === 'translationModelList') {
        next.translationModel = parseModelSpec(normalizedList[0]).id || next.translationModel;
      } else if (key === 'contextModelList') {
        next.contextModel = parseModelSpec(normalizedList[0]).id || next.contextModel;
      } else if (key === 'proofreadModelList') {
        next.proofreadModel = parseModelSpec(normalizedList[0]).id || next.proofreadModel;
      }
      continue;
    }
    if (['contextGenerationEnabled', 'proofreadEnabled', 'notificationsEnabled'].includes(key)) {
      next[key] = Boolean(value);
      continue;
    }
    if (['blockLengthLimit', 'tpmSafetyBufferTokens'].includes(key)) {
      const numValue = Number(value);
      next[key] = Number.isFinite(numValue) ? numValue : DEFAULT_STATE[key];
      continue;
    }
    if (key === 'stateVersion') {
      const numValue = Number(value);
      next[key] = Number.isFinite(numValue) ? numValue : DEFAULT_STATE.stateVersion;
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

function normalizeModelList(list, fallbackModelId) {
  const registry = getModelRegistry();
  const byKey = registry?.byKey || {};
  const rawList = Array.isArray(list)
    ? list
    : typeof list === 'string'
      ? [list]
      : [];
  const normalized = [];
  rawList.forEach((entry) => {
    if (typeof entry !== 'string' || !entry) return;
    const parsed = parseModelSpec(entry);
    if (!parsed.id) return;
    const spec = formatModelSpec(parsed.id, parsed.tier);
    if (!byKey[spec]) return;
    if (!normalized.includes(spec)) {
      normalized.push(spec);
    }
  });
  if (!normalized.length) {
    const fallbackSpec = fallbackModelId ? formatModelSpec(fallbackModelId, 'standard') : '';
    if (fallbackSpec && byKey[fallbackSpec]) {
      normalized.push(fallbackSpec);
    }
  }
  return normalized;
}

function areModelListsEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function getPrimaryModelId(modelList, fallbackModelId) {
  const normalized = normalizeModelList(modelList, fallbackModelId);
  return parseModelSpec(normalized[0]).id || fallbackModelId;
}

function getModelListForStage(state, stage) {
  if (stage === 'context') return state.contextModelList || [];
  if (stage === 'proofread') return state.proofreadModelList || [];
  return state.translationModelList || [];
}

function getModelCooldownMap() {
  if (!globalThis.__NT_MODEL_COOLDOWNS__) {
    globalThis.__NT_MODEL_COOLDOWNS__ = new Map();
  }
  return globalThis.__NT_MODEL_COOLDOWNS__;
}

function getModelCooldown(spec) {
  const cooldowns = getModelCooldownMap();
  const entry = cooldowns.get(spec);
  if (!entry?.availableAfter) return null;
  if (entry.availableAfter <= Date.now()) {
    cooldowns.delete(spec);
    return null;
  }
  return entry;
}

function setModelCooldown(spec, error) {
  if (!spec) return;
  const cooldowns = getModelCooldownMap();
  const retryAfterMs = Number.isFinite(Number(error?.retryAfterMs))
    ? Number(error.retryAfterMs)
    : 5000;
  const capped = Math.min(Math.max(retryAfterMs, 0), 60000);
  cooldowns.set(spec, { availableAfter: Date.now() + capped });
}

function normalizeTriggerSource(triggerSource) {
  if (!triggerSource || typeof triggerSource !== 'string') return '';
  return triggerSource.trim().toLowerCase();
}

function getCandidateModels(stage, requestMeta, state) {
  const fallbackModel = stage === 'context'
    ? state.contextModel
    : stage === 'proofread'
      ? state.proofreadModel
      : state.translationModel;
  let originalRequestedModelList = normalizeModelList(getModelListForStage(state, stage), fallbackModel);
  const triggerSource = requestMeta?.triggerSource || '';
  const purpose = requestMeta?.purpose || '';
  const normalizedTriggerSource = normalizeTriggerSource(triggerSource);
  let effectivePurpose = typeof purpose === 'string' ? purpose : '';
  if (normalizedTriggerSource.includes('validate')) {
    effectivePurpose = 'validate';
  } else if (normalizedTriggerSource.includes('retry')) {
    effectivePurpose = 'retry';
  } else if (!effectivePurpose) {
    effectivePurpose = 'main';
  }
  const isManualTrigger =
    (Boolean(requestMeta?.isManual) ||
      normalizedTriggerSource.includes('manual') ||
      effectivePurpose === 'manual') &&
    !normalizedTriggerSource.includes('retry') &&
    !normalizedTriggerSource.includes('validate');
  let candidateStrategy = 'default_preserve_order';
  if (stage === 'translate') {
    if (effectivePurpose === 'validate') {
      candidateStrategy = 'validate_cheapest';
    } else if (effectivePurpose === 'retry') {
      candidateStrategy = 'retry_cheapest';
    } else if (isManualTrigger) {
      candidateStrategy = 'manual_smartest';
    }
  } else if (stage === 'proofread') {
    if (effectivePurpose === 'validate') {
      candidateStrategy = 'validate_cheapest';
    } else if (effectivePurpose === 'retry') {
      candidateStrategy = 'retry_cheapest';
    } else if (isManualTrigger) {
      candidateStrategy = 'manual_smartest';
    }
  } else if (stage === 'context') {
    if (effectivePurpose === 'validate') {
      candidateStrategy = 'validate_cheapest';
    } else if (effectivePurpose === 'retry') {
      candidateStrategy = 'retry_cheapest';
    } else if (isManualTrigger) {
      candidateStrategy = 'manual_smartest';
    }
  }
  if (!Array.isArray(originalRequestedModelList) || !originalRequestedModelList.length) {
    const fallbackSpec = fallbackModel ? formatModelSpec(fallbackModel, 'standard') : '';
    if (fallbackSpec) {
      originalRequestedModelList = [fallbackSpec];
    } else {
      originalRequestedModelList = [];
    }
  }
  const parsedEntries = originalRequestedModelList.map((spec, index) => {
    const parsed = parseModelSpec(spec);
    const tierPref = parsed.tier === 'flex' ? 1 : 0;
    const capabilityRank = getModelCapabilityRank(parsed.id);
    const costSum = getModelEntry(parsed.id, parsed.tier)?.sum_1M ?? Infinity;
    return {
      spec,
      index,
      parsed,
      tierPref,
      capabilityRank,
      costSum
    };
  });
  const compareManual = (left, right) => {
    if (left.capabilityRank !== right.capabilityRank) {
      return right.capabilityRank - left.capabilityRank;
    }
    if (left.tierPref !== right.tierPref) {
      return right.tierPref - left.tierPref;
    }
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return 0;
  };
  const compareCheapest = (left, right) => {
    if (left.costSum !== right.costSum) {
      return left.costSum - right.costSum;
    }
    if (left.capabilityRank !== right.capabilityRank) {
      return right.capabilityRank - left.capabilityRank;
    }
    if (left.tierPref !== right.tierPref) {
      return right.tierPref - left.tierPref;
    }
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return 0;
  };
  const orderedEntries = [...parsedEntries];
  if (candidateStrategy === 'manual_smartest') {
    orderedEntries.sort(compareManual);
  } else if (candidateStrategy === 'retry_cheapest' || candidateStrategy === 'validate_cheapest') {
    orderedEntries.sort(compareCheapest);
  }
  const orderedList = orderedEntries.map((entry) => entry.spec);
  const cooldownFiltered = orderedList.filter((spec) => !getModelCooldown(spec));
  const finalOrderedList = cooldownFiltered.length ? cooldownFiltered : orderedList;
  return {
    orderedList: finalOrderedList,
    originalRequestedModelList,
    isManual: Boolean(isManualTrigger),
    candidateStrategy
  };
}

function classifyFallbackReason(error) {
  if (!error) return 'unknown_error';
  if (error?.fallbackReason) return error.fallbackReason;
  const status = error?.status;
  const message = String(error?.message || '').toLowerCase();
  if (error?.isRateLimit || status === 429) return 'rate_limit';
  if (message.includes('tpm') || message.includes('tokens per minute')) return 'tpm_limit';
  if (status === 404 || message.includes('not found')) return 'model_not_found';
  if (message.includes('service_tier')) return 'service_tier_unavailable';
  if (status === 503 || status === 502 || status === 504 || message.includes('unavailable')) return 'unavailable';
  if (message.includes('unsupported') || message.includes('unknown parameter')) return 'unsupported_param';
  return 'request_failed';
}

function shouldFallbackToStandard(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('service_tier')) return true;
  if (error?.fallbackReason && String(error.fallbackReason).includes('service_tier')) return true;
  if (error?.fallbackReason && String(error.fallbackReason).includes('unsupported_param')) return true;
  return false;
}

function recordCooldownIfNeeded(modelSpec, reason, error) {
  if (!modelSpec) return;
  if (reason === 'tpm_limit' || reason === 'rate_limit') {
    setModelCooldown(modelSpec, error);
  }
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
      stored = globalThis.ntStateStore
        ? await ensureStateStoreLoaded()
        : await storageLocalGet({ ...DEFAULT_STATE, model: null, chunkLengthLimit: null });
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
      proofreadModel: merged.proofreadModel,
      translationModelList: merged.translationModelList,
      contextModelList: merged.contextModelList,
      proofreadModelList: merged.proofreadModelList
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
      await updateState({
        translationModel: merged.translationModel,
        contextModel: merged.contextModel,
        proofreadModel: merged.proofreadModel,
        translationModelList: merged.translationModelList,
        contextModelList: merged.contextModelList,
        proofreadModelList: merged.proofreadModelList
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
  await updateState(next);
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
    await updateState(patch);
  }
  applyStatePatch({ ...DEFAULT_STATE, ...safeStored, ...patch });
}

async function removeObsoleteStorageKeys() {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.remove(OBSOLETE_STORAGE_KEYS, () => {
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

chrome.runtime.onInstalled.addListener(async (details) => {
  const reason = details?.reason;
  if (reason === 'install') {
    await ensureDefaultKeysOnFreshInstall();
  } else {
    try {
      await removeObsoleteStorageKeys();
    } catch (error) {
      console.warn('Failed to remove obsolete storage keys on update.', error);
    }
    await getState();
  }
  await warmUpContentScripts(reason || 'installed');
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await removeObsoleteStorageKeys();
  } catch (error) {
    console.warn('Failed to remove obsolete storage keys on startup.', error);
  }
  await ensureStateStoreLoaded();
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
  if (globalThis.ntPortHub) {
    globalThis.ntPortHub.registerPort(port);
  }
  if (port.name === UI_PORT_NAMES.debug || port.name === UI_PORT_NAMES.popup) {
    registerUiPort(port, port.name);
    return;
  }
  if (port.name !== NT_RPC_PORT_NAME) return;
  NT_RPC_SERVER.registerPort(port);
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

  if (message?.type === 'JOB_STARTED' || message?.type === 'JOB_DONE' ||
      message?.type === 'JOB_ERROR' || message?.type === 'JOB_CANCELLED') {
    const tabId = sender?.tab?.id ?? message?.tabId ?? null;
    const payload = {
      type: message.type,
      jobId: message.jobId || '',
      tabId,
      error: message.error || ''
    };
    if (globalThis.ntPortHub && globalThis.ntCreateMessage) {
      const envelope = globalThis.ntCreateMessage(message.type, payload, { tabId });
      globalThis.ntPortHub.broadcastUi(envelope);
      sendRuntimeMessageSafe(envelope);
    } else {
      broadcastToPorts(POPUP_PORTS, payload);
      sendRuntimeMessageSafe(payload);
    }
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
                translationModelList: DEFAULT_STATE.translationModelList,
                contextModelList: DEFAULT_STATE.contextModelList,
                proofreadModelList: DEFAULT_STATE.proofreadModelList,
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

  if (message?.type === 'TRANSLATION_STATUS') {
    handleTranslationStatus(message, sender);
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
        translationModelList: DEFAULT_STATE.translationModelList,
        contextModelList: DEFAULT_STATE.contextModelList,
        proofreadModelList: DEFAULT_STATE.proofreadModelList,
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
    } else {
      const translationModel = getPrimaryModelId(state.translationModelList, state.translationModel);
      const contextModel = getPrimaryModelId(state.contextModelList, state.contextModel);
      const proofreadModel = getPrimaryModelId(state.proofreadModelList, state.proofreadModel);
      const translationConfig = getApiConfigForModel(translationModel, state);
      const contextConfig = getApiConfigForModel(contextModel, state);
      const proofreadConfig = getApiConfigForModel(proofreadModel, state);
      const tpmLimitsByRole = {
        translation: getTpmLimitForModel(translationModel, state.tpmLimitsByModel),
        context: getTpmLimitForModel(contextModel, state.tpmLimitsByModel),
        proofread: getTpmLimitForModel(proofreadModel, state.tpmLimitsByModel)
      };
      const hasTranslationKey = Boolean(translationConfig.apiKey);
      const hasContextKey = Boolean(contextConfig.apiKey);
      const hasProofreadKey = Boolean(proofreadConfig.apiKey);
      let disallowedReason = null;
      if (!hasTranslationKey) {
        disallowedReason = buildMissingKeyReason('перевод', translationConfig, translationModel);
      } else if (state.contextGenerationEnabled && !hasContextKey) {
        disallowedReason = buildMissingKeyReason('контекст', contextConfig, contextModel);
      } else if (state.proofreadEnabled && !hasProofreadKey) {
        disallowedReason = buildMissingKeyReason('вычитка', proofreadConfig, proofreadModel);
      }
      response = {
        allowed:
          hasTranslationKey &&
          (!state.contextGenerationEnabled || hasContextKey) &&
          (!state.proofreadEnabled || hasProofreadKey),
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
      translationModelList: DEFAULT_STATE.translationModelList,
      contextModelList: DEFAULT_STATE.contextModelList,
      proofreadModelList: DEFAULT_STATE.proofreadModelList,
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
        translationModelList: DEFAULT_STATE.translationModelList,
        contextModelList: DEFAULT_STATE.contextModelList,
        proofreadModelList: DEFAULT_STATE.proofreadModelList,
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
    }
    sendResponse(response);
  }
}

async function executeModelFallback(stage, state, message, handler) {
  const baseRequestMeta = message?.requestMeta && typeof message.requestMeta === 'object' ? message.requestMeta : {};
  const { orderedList, originalRequestedModelList, candidateStrategy } = getCandidateModels(stage, baseRequestMeta, state);
  let attemptIndex = 0;
  let lastError = null;
  let fallbackReasonForNext = null;

  for (const modelSpec of orderedList) {
    const parsed = parseModelSpec(modelSpec);
    const modelId = parsed.id;
    const requestedTier = parsed.tier;
    if (!modelId) continue;
    const flexEntry = getModelEntry(modelId, 'flex');
    const standardEntry = getModelEntry(modelId, 'standard');
    const attemptWithTier = async (tier, fallbackReason) => {
      attemptIndex += 1;
      const selectedModelSpec = formatModelSpec(modelId, tier);
      const requestMeta = {
        ...baseRequestMeta,
        selectedModel: modelId,
        selectedTier: tier,
        selectedModelSpec,
        attemptIndex,
        fallbackReason: fallbackReason || baseRequestMeta.fallbackReason || '',
        originalRequestedModelList,
        candidateStrategy,
        candidateOrderedList: orderedList
      };
      const requestOptions = {
        tier,
        serviceTier: tier === 'flex' ? 'flex' : null
      };
      return handler({ modelId, requestOptions, requestMeta });
    };

    const attemptFallbackReason = fallbackReasonForNext;
    fallbackReasonForNext = null;

    if (requestedTier === 'flex') {
      if (!flexEntry) {
        if (standardEntry) {
          try {
            return await attemptWithTier('standard', attemptFallbackReason || 'service_tier_unavailable');
          } catch (standardError) {
            lastError = standardError;
            const standardReason = classifyFallbackReason(standardError);
            recordCooldownIfNeeded(formatModelSpec(modelId, 'standard'), standardReason, standardError);
            fallbackReasonForNext = standardReason;
            continue;
          }
        }
        lastError = new Error('Requested flex tier unavailable.');
        fallbackReasonForNext = classifyFallbackReason(lastError);
        continue;
      }
      try {
        return await attemptWithTier('flex', attemptFallbackReason);
      } catch (error) {
        if (isCancelledError(error)) {
          throw error;
        }
        lastError = error;
        const reason = classifyFallbackReason(error);
        recordCooldownIfNeeded(formatModelSpec(modelId, 'flex'), reason, error);
        if (shouldFallbackToStandard(error) && standardEntry) {
          try {
            return await attemptWithTier('standard', reason);
          } catch (standardError) {
            lastError = standardError;
            const standardReason = classifyFallbackReason(standardError);
            recordCooldownIfNeeded(formatModelSpec(modelId, 'standard'), standardReason, standardError);
            fallbackReasonForNext = standardReason;
            continue;
          }
        }
        fallbackReasonForNext = reason;
        continue;
      }
    }

    if (requestedTier === 'standard') {
      if (!standardEntry) {
        lastError = new Error('Requested standard tier unavailable.');
        fallbackReasonForNext = classifyFallbackReason(lastError);
        continue;
      }
      try {
        return await attemptWithTier('standard', attemptFallbackReason);
      } catch (error) {
        if (isCancelledError(error)) {
          throw error;
        }
        lastError = error;
        const reason = classifyFallbackReason(error);
        recordCooldownIfNeeded(formatModelSpec(modelId, 'standard'), reason, error);
        fallbackReasonForNext = reason;
      }
    }
  }

  throw lastError || new Error('All candidate models failed.');
}

async function handleTranslateText(message, sendResponse) {
  try {
    if (!message?.jobId) {
      sendResponse({ success: false, error: 'Missing jobId.', isRuntimeError: true });
      return;
    }
    const state = await getState();
    const primaryModel = getPrimaryModelId(state.translationModelList, state.translationModel);
    const { apiKey, apiBaseUrl } = getApiConfigForModel(primaryModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const requestSignal = message?.abortSignal;
    const result = await executeModelFallback('translate', state, message, async ({ modelId, requestOptions, requestMeta }) => {
      return NT_TRANSLATION_SERVICE.translateSegments({
        segments: message.texts,
        targetLanguage: message.targetLanguage,
        contextPayload: message.context,
        modelSpec: modelId,
        apiKey,
        apiBaseUrl,
        keepPunctuationTokens: message.keepPunctuationTokens,
        requestMeta,
        requestOptions,
        requestSignal
      });
    });
    sendResponse({ success: true, translations: result.translations, rawTranslation: result.rawTranslation, debug: result.debug });
  } catch (error) {
    console.error('Translation failed', error);
    sendResponse({
      success: false,
      error: error?.message || 'Unknown error',
      contextOverflow: Boolean(error?.isContextOverflow),
      isCancelled: isCancelledError(error)
    });
  }
}

async function handleGenerateContext(message, sendResponse) {
  try {
    if (!message?.jobId) {
      sendResponse({ success: false, error: 'Missing jobId.', isRuntimeError: true });
      return;
    }
    const state = await getState();
    const primaryModel = getPrimaryModelId(state.contextModelList, state.contextModel);
    const { apiKey, apiBaseUrl } = getApiConfigForModel(primaryModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const contextRequestMeta = {
      ...(message?.requestMeta || {}),
      stage: 'context',
      purpose: message?.requestMeta?.purpose || 'main'
    };
    if (
      (contextRequestMeta.purpose === 'retry' || contextRequestMeta.purpose === 'validate') &&
      !contextRequestMeta.triggerSource
    ) {
      contextRequestMeta.triggerSource = contextRequestMeta.purpose;
    }
    const contextMessage = {
      ...message,
      requestMeta: contextRequestMeta
    };
    const requestSignal = message?.abortSignal;
    const result = await executeModelFallback('context', state, contextMessage, async ({ modelId, requestOptions, requestMeta }) => {
      return NT_CONTEXT_SERVICE.buildContext({
        text: message.text,
        targetLanguage: message.targetLanguage,
        modelSpec: modelId,
        apiKey,
        apiBaseUrl,
        requestMeta,
        requestOptions,
        requestSignal
      });
    });
    sendResponse({ success: true, context: result.context, debug: result.debug });
  } catch (error) {
    console.error('Context generation failed', error);
    sendResponse({
      success: false,
      error: error?.message || 'Unknown error',
      isCancelled: isCancelledError(error)
    });
  }
}

async function handleGenerateShortContext(message, sendResponse) {
  try {
    if (!message?.jobId) {
      sendResponse({ success: false, error: 'Missing jobId.', isRuntimeError: true });
      return;
    }
    const state = await getState();
    const primaryModel = getPrimaryModelId(state.contextModelList, state.contextModel);
    const { apiKey, apiBaseUrl } = getApiConfigForModel(primaryModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const contextRequestMeta = {
      ...(message?.requestMeta || {}),
      stage: 'context',
      purpose: message?.requestMeta?.purpose || 'short'
    };
    if (
      (contextRequestMeta.purpose === 'retry' || contextRequestMeta.purpose === 'validate') &&
      !contextRequestMeta.triggerSource
    ) {
      contextRequestMeta.triggerSource = contextRequestMeta.purpose;
    }
    const contextMessage = {
      ...message,
      requestMeta: contextRequestMeta
    };
    const requestSignal = message?.abortSignal;
    const result = await executeModelFallback('context', state, contextMessage, async ({ modelId, requestOptions, requestMeta }) => {
      return NT_CONTEXT_SERVICE.buildShortContext({
        text: message.text,
        targetLanguage: message.targetLanguage,
        modelSpec: modelId,
        apiKey,
        apiBaseUrl,
        requestMeta,
        requestOptions,
        requestSignal
      });
    });
    sendResponse({ success: true, context: result.context, debug: result.debug });
  } catch (error) {
    console.error('Short context generation failed', error);
    sendResponse({
      success: false,
      error: error?.message || 'Unknown error',
      isCancelled: isCancelledError(error)
    });
  }
}

async function handleProofreadText(message, sendResponse) {
  try {
    if (!message?.jobId) {
      sendResponse({ success: false, error: 'Missing jobId.', isRuntimeError: true });
      return;
    }
    const state = await getState();
    const primaryModel = getPrimaryModelId(state.proofreadModelList, state.proofreadModel);
    const { apiKey, apiBaseUrl } = getApiConfigForModel(primaryModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const requestSignal = message?.abortSignal;
    const result = await executeModelFallback('proofread', state, message, async ({ modelId, requestOptions, requestMeta }) => {
      return NT_PROOFREAD_SERVICE.proofreadSegments({
        segments: message.segments,
        sourceBlock: message.sourceBlock,
        translatedBlock: message.translatedBlock,
        contextPayload: message.context,
        mode: message.proofreadMode,
        language: message.language,
        modelSpec: modelId,
        apiKey,
        apiBaseUrl,
        requestMeta,
        requestOptions,
        requestSignal
      });
    });
    sendResponse({
      success: true,
      translations: result.translations,
      rawProofread: result.rawProofread,
      debug: result.debug
    });
  } catch (error) {
    console.error('Proofreading failed', error);
    sendResponse({
      success: false,
      error: error?.message || 'Unknown error',
      contextOverflow: Boolean(error?.isContextOverflow),
      isCancelled: isCancelledError(error)
    });
  }
}

function coerceProgressValue(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeTranslationStatus(rawStatus, fallback = {}) {
  const status = rawStatus && typeof rawStatus === 'object' ? rawStatus : {};
  const progressSource =
    status.progress && typeof status.progress === 'object'
      ? status.progress
      : status;
  const progress = {
    completed: coerceProgressValue(
      progressSource.completed ?? progressSource.completedBlocks ?? progressSource.completedChunks,
      0
    ),
    total: coerceProgressValue(progressSource.total ?? progressSource.totalBlocks ?? progressSource.totalChunks, 0),
    inFlight: coerceProgressValue(
      progressSource.inFlight ?? progressSource.inProgressBlocks ?? progressSource.inProgressChunks,
      0
    )
  };
  const tabId =
    typeof status.tabId === 'number'
      ? status.tabId
      : typeof fallback.tabId === 'number'
        ? fallback.tabId
        : null;
  return {
    jobId: String(status.jobId ?? fallback.jobId ?? ''),
    tabId,
    url: String(status.url ?? fallback.url ?? ''),
    stage: String(status.stage ?? fallback.stage ?? 'translation'),
    progress,
    lastUpdateTs: coerceProgressValue(status.lastUpdateTs ?? Date.now(), Date.now()),
    ...(status.error ? { error: status.error } : {})
  };
}

function getTranslationStageLabel(stage) {
  const stageLabels = {
    idle: 'Перевод не выполняется',
    context: 'Готовим контекст',
    translation: 'Переводим',
    proofread: 'Проверяем перевод',
    apply: 'Применяем перевод',
    done: 'Перевод завершён',
    cancelled: 'Перевод отменён',
    error: 'Ошибка перевода'
  };
  return stageLabels[stage] || '';
}

async function persistTranslationStatus(status, { tabId, source } = {}) {
  const resolvedTabId = typeof tabId === 'number' ? tabId : status?.tabId;
  if (!resolvedTabId) return;
  const currentState = globalThis.ntStateStore
    ? await ensureStateStoreLoaded()
    : await storageLocalGet({ translationStatusByTab: {} });
  const { translationStatusByTab = {} } = currentState || {};
  translationStatusByTab[resolvedTabId] = status;
  await updateState({ translationStatusByTab }, { tabId: resolvedTabId, source });
  if (globalThis.ntPortHub && globalThis.ntCreateMessage) {
    const envelope = globalThis.ntCreateMessage(
      'TRANSLATION_STATUS',
      { tabId: resolvedTabId, status },
      { tabId: resolvedTabId }
    );
    globalThis.ntPortHub.broadcastUi(envelope);
    sendRuntimeMessageSafe(envelope);
  }
  if (areNotificationsEnabled() && globalThis.ntUserNotifier) {
    const totalBlocks = status?.progress?.total || 0;
    const completedBlocks = status?.progress?.completed || 0;
    const inFlightBlocks = status?.progress?.inFlight || 0;
    const current = Math.min(totalBlocks, completedBlocks + inFlightBlocks);
    const percent = totalBlocks ? Math.round((current / totalBlocks) * 100) : 0;
    const message = getTranslationStageLabel(status?.stage);
    globalThis.ntUserNotifier.notifyProgress(resolvedTabId, percent, message);
    if (totalBlocks && completedBlocks >= totalBlocks && inFlightBlocks === 0) {
      globalThis.ntUserNotifier.notifyDone(resolvedTabId);
    }
  }
}

async function handleTranslationStatus(message, sender) {
  const payload = message?.payload || message?.status || message;
  const statusPayload = payload?.status && typeof payload.status === 'object' ? payload.status : payload;
  const tabId =
    typeof payload?.tabId === 'number'
      ? payload.tabId
      : typeof statusPayload?.tabId === 'number'
        ? statusPayload.tabId
        : sender?.tab?.id;
  if (!tabId) return;
  const normalized = normalizeTranslationStatus(statusPayload, {
    tabId,
    url: sender?.tab?.url || statusPayload?.url || '',
    stage: statusPayload?.stage || payload?.stage || 'translation'
  });
  await persistTranslationStatus(normalized, { tabId, source: 'translation-status' });
}

async function handleTranslationProgress(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;
  const normalized = normalizeTranslationStatus(
    {
      jobId: message?.jobId || '',
      tabId,
      url: sender?.tab?.url || '',
      stage: message?.stage || 'translation',
      progress: {
        completed: message?.completedBlocks || 0,
        total: message?.totalBlocks || 0,
        inFlight: message?.inProgressBlocks || 0
      },
      lastUpdateTs: Date.now()
    },
    { tabId, stage: message?.stage || 'translation', url: sender?.tab?.url || '' }
  );
  await persistTranslationStatus(normalized, { tabId, source: 'translation-progress' });
}

async function handleGetTranslationStatus(sendResponse, tabId) {
  const currentState = globalThis.ntStateStore
    ? await ensureStateStoreLoaded()
    : await storageLocalGet({ translationStatusByTab: {} });
  const { translationStatusByTab = {} } = currentState || {};
  sendResponse(translationStatusByTab[tabId] || null);
}

async function handleTranslationVisibility(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;
  const currentState = globalThis.ntStateStore
    ? await ensureStateStoreLoaded()
    : await storageLocalGet({ translationVisibilityByTab: {} });
  const { translationVisibilityByTab = {} } = currentState || {};
  translationVisibilityByTab[tabId] = Boolean(message.visible);
  await updateState({ translationVisibilityByTab }, { tabId, source: 'translation-visibility' });
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
  const jobId = message?.jobId || '';
  const currentState = globalThis.ntStateStore
    ? await ensureStateStoreLoaded()
    : await storageLocalGet({ translationStatusByTab: {}, translationVisibilityByTab: {} });
  const { translationStatusByTab = {}, translationVisibilityByTab = {} } = currentState || {};
  const previousStatus = translationStatusByTab[tabId] || null;
  delete translationStatusByTab[tabId];
  translationVisibilityByTab[tabId] = false;
  await updateState({ translationStatusByTab, translationVisibilityByTab }, { tabId, source: 'translation-cancelled' });
  const cancelledStatus = normalizeTranslationStatus(
    {
      ...(previousStatus || {}),
      jobId: previousStatus?.jobId || jobId,
      tabId,
      stage: 'cancelled',
      lastUpdateTs: Date.now()
    },
    { tabId, jobId, stage: 'cancelled', url: previousStatus?.url || '' }
  );
  if (globalThis.ntPortHub && globalThis.ntCreateMessage) {
    const envelope = globalThis.ntCreateMessage(
      'TRANSLATION_STATUS',
      { tabId, status: cancelledStatus },
      { tabId }
    );
    globalThis.ntPortHub.broadcastUi(envelope);
    sendRuntimeMessageSafe(envelope);
  }
  const payload = { type: 'TRANSLATION_CANCELLED', tabId, jobId };
  broadcastToPorts(POPUP_PORTS, payload);
  sendRuntimeMessageSafe(payload);
  if (areNotificationsEnabled() && globalThis.ntUserNotifier) {
    globalThis.ntUserNotifier.notifyError(tabId, 'Перевод отменён');
  }
}
