const metaEl = document.getElementById('meta');
const contextEl = document.getElementById('context');
const summaryEl = document.getElementById('summary');
const entriesEl = document.getElementById('entries');
const eventsEl = document.getElementById('events');

const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const DEBUG_PORT_NAME = 'debug';
const DEBUG_DB_NAME = 'nt_debug';
const DEBUG_DB_VERSION = 1;
const DEBUG_RAW_STORE = 'raw';
const STATUS_CONFIG = {
  pending: { label: 'Ожидает', className: 'status-pending' },
  in_progress: { label: 'В работе', className: 'status-in-progress' },
  done: { label: 'Готово', className: 'status-done' },
  failed: { label: 'Ошибка', className: 'status-failed' },
  disabled: { label: 'Отключено', className: 'status-disabled' }
};

let sourceUrl = '';
let refreshTimer = null;
let debugPort = null;
let debugReconnectTimer = null;
let debugReconnectDelay = 500;
const proofreadUiState = new Map();
const debugUiState = {
  openKeys: new Set(),
  scrollTop: 0
};
const debugDomState = {
  contextReady: false,
  entriesByKey: new Map(),
  entryPartsByKey: new Map(),
  payloadPartsByKey: new Map()
};
let latestDebugSnapshot = null;
let latestDebugUrl = '';
let debugPatchScheduled = false;
const debugInstrumentation = {
  enabled: isDebugInstrumentationEnabled(),
  lastRefByKey: new Map(),
  lastUserActionTs: 0
};

init();

async function init() {
  sourceUrl = getSourceUrlFromQuery();
  if (!sourceUrl) {
    renderEmpty('Не удалось определить страницу для отладки.');
    return;
  }

  setupDebugInstrumentation();

  if (contextEl) {
    addDebugListener(contextEl, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('[data-action="clear-context"]');
      if (button) {
        event.preventDefault();
        clearContext();
        return;
      }
      const loadButton = target.closest('[data-action="load-raw"]');
      if (loadButton) {
        event.preventDefault();
        handleLoadRawClick(loadButton);
      }
    });
  }

  if (entriesEl) {
    addDebugListener(entriesEl, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const viewButton = target.closest('[data-action="set-proofread-view"]');
      if (viewButton) {
        event.preventDefault();
        event.stopPropagation();
        const view = viewButton.getAttribute('data-view');
        const container = viewButton.closest('.proofread-block');
        if (!view || !container) return;
        const entryKey = container.getAttribute('data-proofread-id') || '';
        const state = proofreadUiState.get(entryKey) || {};
        proofreadUiState.set(entryKey, { ...state, view });
        container.setAttribute('data-proofread-view', view);
        container.querySelectorAll('[data-action="set-proofread-view"]').forEach((node) => {
          node.classList.toggle('is-active', node.getAttribute('data-view') === view);
        });
        return;
      }

      const expandButton = target.closest('[data-action="toggle-proofread-expand"]');
      if (expandButton) {
        event.preventDefault();
        const container = expandButton.closest('.proofread-block');
        if (!container) return;
        const entryKey = container.getAttribute('data-proofread-id') || '';
        const isExpanded = container.classList.toggle('is-expanded');
        const state = proofreadUiState.get(entryKey) || {};
        proofreadUiState.set(entryKey, { ...state, expanded: isExpanded });
        container.querySelectorAll('.proofread-expand').forEach((button) => {
          button.setAttribute('aria-expanded', String(isExpanded));
          button.textContent = isExpanded ? 'Свернуть' : 'Развернуть';
        });
        return;
      }

      const loadButton = target.closest('[data-action="load-raw"]');
      if (loadButton) {
        event.preventDefault();
        handleLoadRawClick(loadButton);
        return;
      }
    });
  }

  await refreshDebug();
  connectDebugPort();
  startAutoRefresh();
}

function isDebugInstrumentationEnabled() {
  const params = new URLSearchParams(window.location.search);
  return params.get('debug') === '1' || params.get('instrument') === '1';
}

function setupDebugInstrumentation() {
  if (!debugInstrumentation.enabled) return;
  const root = document.body;
  if (!root) return;
  addDebugListener(root, 'pointerdown', () => {
    debugInstrumentation.lastUserActionTs = performance.now();
  });
  addDebugListener(root, 'keydown', () => {
    debugInstrumentation.lastUserActionTs = performance.now();
  });
  root.addEventListener(
    'toggle',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLDetailsElement)) return;
      const key = target.getAttribute('data-debug-key') || '';
      if (!key) return;
      const elapsed = performance.now() - debugInstrumentation.lastUserActionTs;
      if (elapsed > 400) {
        console.warn(`[debug] PROGRAMMATIC TOGGLE key=${key} open=${target.open} ts=${Date.now()}`);
      }
    },
    true
  );
}

function addDebugListener(element, eventName, handler) {
  if (debugInstrumentation.enabled) {
    const existing = element.getAttribute('data-nt-listener') || '';
    const events = existing.split(',').map((value) => value.trim()).filter(Boolean);
    if (events.includes(eventName)) {
      console.warn(`[debug] DUPLICATE LISTENER event=${eventName} el=${element.tagName}`);
    } else {
      events.push(eventName);
      element.setAttribute('data-nt-listener', events.join(','));
    }
  }
  element.addEventListener(eventName, handler);
}

function getSourceUrlFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const source = params.get('source');
  return source ? decodeURIComponent(source) : '';
}

async function getDebugData(url) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([DEBUG_STORAGE_KEY], (data) => {
      const store = data?.[DEBUG_STORAGE_KEY] || {};
      resolve(store[url]);
    });
  });
}

async function getDebugStore() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return null;
  }
  return new Promise((resolve) => {
    chrome.storage.local.get([DEBUG_STORAGE_KEY], (data) => {
      resolve(data?.[DEBUG_STORAGE_KEY] || {});
    });
  });
}

async function clearContext() {
  if (!sourceUrl) return;
  const store = await getDebugStore();
  if (!store) return;
  const current = store[sourceUrl];
  if (!current) return;
  const nextFullStatus = current.contextFullStatus === 'disabled' || current.contextStatus === 'disabled' ? 'disabled' : 'pending';
  const nextShortStatus = current.contextShortStatus === 'disabled' ? 'disabled' : 'pending';
  store[sourceUrl] = {
    ...current,
    context: '',
    contextStatus: nextFullStatus,
    contextFull: '',
    contextFullStatus: nextFullStatus,
    contextShort: '',
    contextShortStatus: nextShortStatus,
    contextFullRefId: '',
    contextShortRefId: '',
    contextFullTruncated: false,
    contextShortTruncated: false,
    updatedAt: Date.now()
  };
  await new Promise((resolve) => {
    chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: store }, () => resolve());
  });
  await refreshDebug();
}

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  const canListen = typeof chrome !== 'undefined' && chrome.storage?.onChanged && !debugPort;
  if (canListen) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (!changes[DEBUG_STORAGE_KEY]) {
        return;
      }
      refreshDebug();
    });
  }

  if (!canListen) {
    refreshTimer = setInterval(() => {
      refreshDebug();
    }, 1000);
  }
}

function connectDebugPort() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) {
    return;
  }
  if (debugPort) return;
  try {
    debugPort = chrome.runtime.connect({ name: DEBUG_PORT_NAME });
  } catch (error) {
    scheduleDebugReconnect();
    return;
  }
  debugReconnectDelay = 500;
  debugPort.onMessage.addListener(handleDebugPortMessage);
  debugPort.onDisconnect.addListener(() => {
    debugPort = null;
    scheduleDebugReconnect();
  });
  if (sourceUrl) {
    try {
      debugPort.postMessage({ type: 'DEBUG_GET_SNAPSHOT', sourceUrl });
    } catch (error) {
      // ignore
    }
  }
}

function scheduleDebugReconnect() {
  if (debugReconnectTimer) return;
  debugReconnectTimer = setTimeout(() => {
    debugReconnectTimer = null;
    connectDebugPort();
    debugReconnectDelay = Math.min(10000, Math.max(500, debugReconnectDelay * 2));
  }, debugReconnectDelay);
}

function handleDebugPortMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'DEBUG_UPDATED') {
    if (!sourceUrl || message.sourceUrl !== sourceUrl) return;
    if (debugPort) {
      try {
        debugPort.postMessage({ type: 'DEBUG_GET_SNAPSHOT', sourceUrl });
      } catch (error) {
        refreshDebug();
      }
      return;
    }
    refreshDebug();
    return;
  }
  if (message.type === 'DEBUG_SNAPSHOT') {
    if (!sourceUrl || message.sourceUrl !== sourceUrl) return;
    if (!message.snapshot) {
      renderEmpty('Ожидание отладочных данных...');
      return;
    }
    scheduleDebugPatch(sourceUrl, message.snapshot);
  }
}

function openDebugDb() {
  return new Promise((resolve, reject) => {
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
}

async function getRawRecord(rawId) {
  if (!rawId) return null;
  const db = await openDebugDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEBUG_RAW_STORE, 'readonly');
    const store = tx.objectStore(DEBUG_RAW_STORE);
    const request = store.get(rawId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
  });
}

async function handleLoadRawClick(button) {
  const rawId = button.getAttribute('data-raw-id');
  const rawField = button.getAttribute('data-raw-field') || 'text';
  const targetId = button.getAttribute('data-target-id');
  if (!rawId || !targetId) return;
  const container = document.querySelector(`[data-raw-target="${CSS.escape(targetId)}"]`);
  if (!container) return;
  try {
    const record = await getRawRecord(rawId);
    const payload = record?.value || {};
    const rawValue = payload?.[rawField] ?? payload?.text ?? '';
    container.innerHTML = renderRawResponse(rawValue, 'Нет данных.');
    button.remove();
  } catch (error) {
    container.innerHTML = `<div class="empty">Не удалось загрузить данные.</div>`;
  }
}

async function refreshDebug() {
  const debugData = await getDebugData(sourceUrl);
  if (!debugData) {
    renderEmpty('Ожидание отладочных данных...');
    return;
  }
  scheduleDebugPatch(sourceUrl, debugData);
}

function extractTokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0, hasBreakdown: false };
  }
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens);
  const outputTokens = Number(
    usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens
  );
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens);
  const hasBreakdown = Number.isFinite(inputTokens) || Number.isFinite(outputTokens);
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    hasBreakdown
  };
}

function collectTokensFromPayloads(payloads) {
  const tokens = { inputTokens: 0, outputTokens: 0, totalTokens: 0, hasBreakdown: false };
  (Array.isArray(payloads) ? payloads : []).forEach((payload) => {
    const { inputTokens, outputTokens, totalTokens, hasBreakdown } = extractTokensFromUsage(payload?.usage);
    tokens.inputTokens += inputTokens;
    tokens.outputTokens += outputTokens;
    tokens.totalTokens += totalTokens;
    if (hasBreakdown) tokens.hasBreakdown = true;
  });
  return tokens;
}

function renderEmpty(message) {
  metaEl.textContent = message;
  ensureContextSkeleton();
  patchContext({
    contextStatus: 'pending',
    context: '',
    contextFullStatus: 'pending',
    contextShortStatus: 'pending',
    contextFull: '',
    contextShort: ''
  });
  entriesEl.innerHTML = '';
  debugDomState.entriesByKey.clear();
  debugDomState.entryPartsByKey.clear();
  debugDomState.payloadPartsByKey.clear();
  if (eventsEl) {
    eventsEl.innerHTML = '';
  }
  renderSummary({
    items: [],
    contextStatus: 'pending',
    context: ''
  }, message);
}

function scheduleDebugPatch(url, data) {
  latestDebugSnapshot = data;
  latestDebugUrl = url;
  if (debugPatchScheduled) return;
  debugPatchScheduled = true;
  requestAnimationFrame(() => {
    debugPatchScheduled = false;
    if (!latestDebugSnapshot) return;
    const snapshot = latestDebugSnapshot;
    const snapshotUrl = latestDebugUrl;
    latestDebugSnapshot = null;
    patchDebug(snapshotUrl, snapshot);
  });
}

function patchDebug(url, data) {
  // Причина моргания: пересоздание <details> через innerHTML сбрасывало open и затем восстанавливалось.
  // Используем механизм из стабильной части: один раз создаём DOM-скелет и патчим только leaf-контент.
  captureUiState();
  const updatedAt = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU') : '—';
  metaEl.textContent = `URL: ${url} • Обновлено: ${updatedAt}`;
  renderSummary(data, '');
  renderEvents(data);
  patchContext(data);

  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    entriesEl.innerHTML = '<div class="empty">Нет данных о блоках перевода.</div>';
    debugDomState.entriesByKey.clear();
    restoreUiState();
    return;
  }

  if (!debugDomState.entriesByKey.size && entriesEl.querySelector('.entry') === null) {
    entriesEl.innerHTML = '';
  }
  const liveKeys = new Set();
  items.forEach((item, index) => {
    const entryKey = getProofreadEntryKey(item, index);
    const entry = ensureEntryContainer(entryKey);
    patchEntry(entry, item, entryKey);
    liveKeys.add(entryKey);
  });
  for (const [entryKey, entryEl] of debugDomState.entriesByKey.entries()) {
    if (!liveKeys.has(entryKey)) {
      entryEl.remove();
      debugDomState.entriesByKey.delete(entryKey);
      debugDomState.entryPartsByKey.delete(entryKey);
    }
  }
  debugDomState.payloadPartsByKey.forEach((value, key) => {
    if (!value.el.isConnected) {
      debugDomState.payloadPartsByKey.delete(key);
    }
  });
  restoreUiState();
  runDebugRecreationCheck();
}

function renderSummary(data, fallbackMessage = '') {
  if (!summaryEl) return;
  const items = Array.isArray(data.items) ? data.items : [];
  const total = items.length;
  const overallStatuses = items.map((item) => getOverallEntryStatus(item));
  const completed = overallStatuses.filter((status) => status === 'done').length;
  const inProgress = overallStatuses.filter((status) => status === 'in_progress').length;
  const failed = overallStatuses.filter((status) => status === 'failed').length;
  const contextFullText = (data.contextFull || data.context || '').trim();
  const contextShortText = (data.contextShort || '').trim();
  const contextFullStatus = normalizeStatus(data.contextFullStatus || data.contextStatus, contextFullText);
  const contextShortStatus = normalizeStatus(data.contextShortStatus, contextShortText);
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const aiRequestCount = Number.isFinite(data.aiRequestCount) ? data.aiRequestCount : 0;
  const aiResponseCount = Number.isFinite(data.aiResponseCount) ? data.aiResponseCount : 0;
  const overallStatus = getOverallStatus({
    completed,
    inProgress,
    failed,
    total,
    contextFullStatus,
    contextShortStatus
  });
  const summaryLine = fallbackMessage
    ? `${fallbackMessage}`
    : `Контекст SHORT: ${STATUS_CONFIG[contextShortStatus]?.label || '—'} • Контекст FULL: ${STATUS_CONFIG[contextFullStatus]?.label || '—'} • Готово блоков: ${completed}/${total} • В работе: ${inProgress} • Ошибки: ${failed} • Запросов к ИИ: ${aiRequestCount} • Ответов ИИ: ${aiResponseCount}`;
  summaryEl.innerHTML = `
    <div class="summary-header">
      <div class="summary-meta">${summaryLine}</div>
      <div class="summary-progress">
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progress}%"></div>
        </div>
      </div>
      <div class="summary-status">
        <div class="status-group">
          <span class="status-label">Статус</span>
          ${renderStatusBadge(overallStatus)}
        </div>
      </div>
    </div>
  `;
}

function setTextIfChanged(element, value) {
  if (!element) return;
  const next = value == null ? '' : String(value);
  if (element.textContent !== next) {
    element.textContent = next;
  }
}

function setHtmlIfChanged(element, html) {
  if (!element) return;
  const next = html == null ? '' : String(html);
  if (element.innerHTML !== next) {
    element.innerHTML = next;
  }
}

function ensureDetailsElement(parent, debugKey, summaryText, className = '') {
  if (!parent) return { detailsEl: null, contentEl: null };
  let details = parent.querySelector(`details[data-debug-key="${CSS.escape(debugKey)}"]`);
  if (!details) {
    details = document.createElement('details');
    details.className = className;
    details.setAttribute('data-debug-key', debugKey);
    const summary = document.createElement('summary');
    summary.textContent = summaryText;
    const content = document.createElement('div');
    content.className = 'details-content';
    details.appendChild(summary);
    details.appendChild(content);
    parent.appendChild(details);
  }
  const contentEl = details.querySelector('.details-content');
  return { detailsEl: details, contentEl };
}

function renderEvents(data) {
  if (!eventsEl) return;
  const events = Array.isArray(data?.events) ? data.events : [];
  if (!events.length) {
    eventsEl.innerHTML = '';
    return;
  }
  eventsEl.innerHTML = `
    <div class="events">
      <div class="events-title">Warnings</div>
      ${events
        .slice(-10)
        .map((event) => {
          const ts = event?.timestamp ? new Date(event.timestamp).toLocaleTimeString('ru-RU') : '—';
          const tag = event?.tag || 'EVENT';
          const message = event?.message || '';
          return `
            <div class="event-row">
              <span class="event-time">${escapeHtml(ts)}</span>
              <span class="event-tag">${escapeHtml(tag)}</span>
              <span class="event-message">${escapeHtml(message)}</span>
            </div>
          `;
        })
        .join('')}
    </div>
  `;
}

function ensureContextSkeleton() {
  if (!contextEl || debugDomState.contextReady) return;
  contextEl.innerHTML = `
    <div class="entry-header">
      <h2>Контекст</h2>
      <div class="status-row">
        <div class="status-group">
          <span class="status-label">SHORT</span>
          <span data-role="context-short-status"></span>
        </div>
        <div class="status-group">
          <span class="status-label">FULL</span>
          <span data-role="context-full-status"></span>
        </div>
        <div class="context-actions">
          <button class="action-button" type="button" data-action="clear-context">Сбросить</button>
        </div>
      </div>
    </div>
    <div class="context-body">
      <div class="context-section">
        <div class="label">SHORT контекст</div>
        <div data-role="context-short-body"></div>
      </div>
      <details class="context-card context-card--full" data-debug-key="context:full">
        <summary>FULL контекст</summary>
        <div class="details-content" data-role="context-full-body"></div>
      </details>
    </div>
  `;
  debugDomState.contextReady = true;
}

function patchContext(data) {
  ensureContextSkeleton();
  if (!contextEl) return;
  const contextFullText = (data.contextFull || data.context || '').trim();
  const contextShortText = (data.contextShort || '').trim();
  const contextFullRefId = data.contextFullRefId || '';
  const contextShortRefId = data.contextShortRefId || '';
  const contextFullTruncated = Boolean(data.contextFullTruncated);
  const contextShortTruncated = Boolean(data.contextShortTruncated);
  const contextFullStatus = normalizeStatus(data.contextFullStatus || data.contextStatus, contextFullText);
  const contextShortStatus = normalizeStatus(data.contextShortStatus, contextShortText);
  const shortStatusEl = contextEl.querySelector('[data-role="context-short-status"]');
  const fullStatusEl = contextEl.querySelector('[data-role="context-full-status"]');
  if (shortStatusEl) {
    shortStatusEl.innerHTML = renderStatusBadge(contextShortStatus);
  }
  if (fullStatusEl) {
    fullStatusEl.innerHTML = renderStatusBadge(contextFullStatus);
  }
  const shortBodyEl = contextEl.querySelector('[data-role="context-short-body"]');
  const fullBodyEl = contextEl.querySelector('[data-role="context-full-body"]');
  const fullContextBody = contextFullText
    ? renderInlineRaw(contextFullText, {
        rawRefId: contextFullRefId,
        rawField: 'text',
        truncated: contextFullTruncated
      })
    : `<div class="empty">FULL контекст ещё не готов.</div>`;
  const shortContextBody = contextShortText
    ? renderInlineRaw(contextShortText, {
        rawRefId: contextShortRefId,
        rawField: 'text',
        truncated: contextShortTruncated
      })
    : `<div class="empty">SHORT контекст ещё не готов.</div>`;
  if (shortBodyEl) shortBodyEl.innerHTML = shortContextBody;
  if (fullBodyEl) fullBodyEl.innerHTML = fullContextBody;
}

function ensureEntryContainer(entryKey) {
  const existing = debugDomState.entriesByKey.get(entryKey);
  if (existing) return existing;
  const entry = document.createElement('div');
  entry.className = 'entry';
  entry.dataset.entryKey = entryKey;
  entriesEl.appendChild(entry);
  debugDomState.entriesByKey.set(entryKey, entry);
  debugDomState.entryPartsByKey.set(entryKey, createEntrySkeleton(entry, entryKey));
  return entry;
}

function createEntrySkeleton(entry, entryKey) {
  entry.innerHTML = `
    <div class="entry-header">
      <h2 data-role="entry-title"></h2>
      <div class="status-row">
        <div class="status-group">
          <span class="status-label">Перевод</span>
          <span data-role="translation-status"></span>
        </div>
        <div class="status-group">
          <span class="status-label">Вычитка</span>
          <span data-role="proofread-status"></span>
        </div>
      </div>
    </div>
    <div class="block">
      <div class="label">Оригинал</div>
      <pre data-role="original-text"></pre>
    </div>
    <div class="block">
      <div class="label">Перевод</div>
      <div data-role="translated-body"></div>
    </div>
    <div class="block" data-role="translate-ai-block"></div>
    <div data-role="proofread-section"></div>
  `;
  const translateKey = `entry:${entryKey}:translate`;
  const translateAiKey = `${translateKey}:ai`;
  const translateAiBlock = entry.querySelector('[data-role="translate-ai-block"]');
  const translateDetails = ensureDetailsElement(translateAiBlock, translateAiKey, 'Ответ ИИ (перевод)', 'ai-response');
  const proofreadSection = entry.querySelector('[data-role="proofread-section"]');
  const proofreadBlock = document.createElement('div');
  proofreadBlock.className = 'block proofread-block';
  proofreadBlock.dataset.role = 'proofread-block';
  const proofreadAiBlock = document.createElement('div');
  proofreadAiBlock.className = 'block';
  proofreadAiBlock.dataset.role = 'proofread-ai-block';
  proofreadSection.appendChild(proofreadBlock);
  proofreadSection.appendChild(proofreadAiBlock);
  const proofreadAiKey = `entry:${entryKey}:proofread:ai`;
  const proofreadDetails = ensureDetailsElement(proofreadAiBlock, proofreadAiKey, 'Ответ ИИ (вычитка)', 'ai-response');
  return {
    entry,
    titleEl: entry.querySelector('[data-role="entry-title"]'),
    translationStatusEl: entry.querySelector('[data-role="translation-status"]'),
    proofreadStatusEl: entry.querySelector('[data-role="proofread-status"]'),
    originalEl: entry.querySelector('[data-role="original-text"]'),
    translatedBodyEl: entry.querySelector('[data-role="translated-body"]'),
    translateDetailsContentEl: translateDetails.contentEl,
    proofreadBlockEl: proofreadBlock,
    proofreadDetailsContentEl: proofreadDetails.contentEl
  };
}

function patchEntry(entry, item, entryKey) {
  const parts = debugDomState.entryPartsByKey.get(entryKey);
  if (!parts) return;
  const translationStatus = normalizeStatus(item.translationStatus, item.translated);
  const proofreadStatus = normalizeStatus(item.proofreadStatus, item.proofread, item.proofreadApplied);
  setTextIfChanged(parts.titleEl, `Блок ${item.index || ''}`);
  setHtmlIfChanged(parts.translationStatusEl, renderStatusBadge(translationStatus));
  setHtmlIfChanged(parts.proofreadStatusEl, renderStatusBadge(proofreadStatus));
  setTextIfChanged(parts.originalEl, item.original || '');
  const translatedHtml = item.translated
    ? `<pre>${escapeHtml(item.translated)}</pre>`
    : `<div class="empty">Перевод ещё не получен.</div>`;
  setHtmlIfChanged(parts.translatedBodyEl, translatedHtml);
  patchDebugPayloads(parts.translateDetailsContentEl, item?.translationDebug, item?.translationRaw, 'TRANSLATE', {
    rawRefId: item?.translationRawRefId,
    truncated: item?.translationRawTruncated,
    baseKey: `entry:${entryKey}:translate`
  });
  patchProofreadBlock(parts.proofreadBlockEl, item, entryKey);
  if (item?.proofreadApplied === false) {
    setHtmlIfChanged(parts.proofreadDetailsContentEl, '<div class="empty">Вычитка выключена.</div>');
  } else {
    patchDebugPayloads(parts.proofreadDetailsContentEl, item?.proofreadDebug, item?.proofreadRaw, 'PROOFREAD', {
      rawRefId: item?.proofreadRawRefId,
      truncated: item?.proofreadRawTruncated,
      baseKey: `entry:${entryKey}:proofread`
    });
  }
}

function patchProofreadBlock(container, item, entryKey) {
  const defaultView = 'diff';
  const state = getProofreadState(entryKey, defaultView);
  const isExpanded = Boolean(state.expanded);
  const showView = state.view || defaultView;
  const html = renderProofreadBlockHtml(item, entryKey);
  setHtmlIfChanged(container, html);
  container.setAttribute('data-proofread-id', entryKey);
  container.setAttribute('data-proofread-view', showView);
  container.classList.toggle('is-expanded', isExpanded);
}

function getOverallStatus({ completed, inProgress, failed, total, contextFullStatus, contextShortStatus }) {
  const hasFailedContext = contextFullStatus === 'failed' || contextShortStatus === 'failed';
  if (failed > 0 || hasFailedContext) return 'failed';
  const fullDone = contextFullStatus === 'done' || contextFullStatus === 'disabled';
  const shortDone = contextShortStatus === 'done' || contextShortStatus === 'disabled';
  if (total && completed === total && fullDone && shortDone) {
    return 'done';
  }
  if (inProgress > 0 || completed > 0 || contextFullStatus === 'in_progress' || contextShortStatus === 'in_progress') {
    return 'in_progress';
  }
  if (contextFullStatus === 'disabled' && contextShortStatus === 'disabled') return 'disabled';
  return 'pending';
}


function renderProofreadBlockHtml(item, entryKey) {
  if (item?.proofreadApplied === false) {
    return `
      <div class="label">Вычитка</div>
      <div class="empty">Вычитка выключена.</div>
    `;
  }

  const comparisonsAll = Array.isArray(item?.proofreadComparisons) ? item.proofreadComparisons : [];
  const comparisons = comparisonsAll.filter((comparison) => comparison?.changed);
  const hasComparisons = comparisons.length > 0;
  const diffView = hasComparisons ? renderProofreadDiffView(comparisons) : '<div class="empty">Нет правок.</div>';
  const sideBySideView = hasComparisons
    ? renderProofreadSideBySideView(comparisons)
    : '<div class="empty">Нет правок.</div>';
  const finalView = hasComparisons ? renderProofreadFinalView(comparisons) : '<div class="empty">Нет правок.</div>';
  const defaultView = 'diff';
  const state = getProofreadState(entryKey, defaultView);
  const statusLabel = getProofreadStatusLabel(item, hasComparisons);
  const statusClass = getProofreadStatusClass(item, hasComparisons);
  const latency = getProofreadLatency(item);
  const changes = getProofreadChangesSummary(comparisons);
  const isExpanded = Boolean(state.expanded);
  const showView = state.view || defaultView;
  const controls = hasComparisons
    ? `
          <div class="proofread-controls">
            <div class="proofread-toggle">
              <button class="toggle-button${showView === 'diff' ? ' is-active' : ''}" type="button" data-action="set-proofread-view" data-view="diff">
                Diff
              </button>
              <button class="toggle-button${showView === 'side' ? ' is-active' : ''}" type="button" data-action="set-proofread-view" data-view="side">
                Side-by-side
              </button>
              <button class="toggle-button${showView === 'final' ? ' is-active' : ''}" type="button" data-action="set-proofread-view" data-view="final">
                Final
              </button>
            </div>
            <button class="proofread-expand" type="button" data-action="toggle-proofread-expand" aria-expanded="${isExpanded}">
              ${isExpanded ? 'Свернуть' : 'Развернуть'}
            </button>
          </div>
        `
    : '';
  const proofreadBody = hasComparisons
    ? `
        <div class="proofread-body">
          <div class="proofread-view proofread-view--diff">${diffView}</div>
          <div class="proofread-view proofread-view--side">${sideBySideView}</div>
          <div class="proofread-view proofread-view--final">${finalView}</div>
          <div class="proofread-preview-overlay">
            <button class="proofread-preview-button" type="button" data-action="toggle-proofread-expand">
              Показать полностью
            </button>
          </div>
        </div>
      `
    : `
        <div class="proofread-body">
          <div class="empty">Нет правок.</div>
        </div>
      `;

  return `
      <div class="proofread-header">
        <div class="proofread-title">
          <span class="label">Вычитка</span>
          <span class="proofread-status ${escapeHtml(statusClass)}">${escapeHtml(statusLabel)}</span>
          <span class="proofread-metric">${escapeHtml(latency)}</span>
          <span class="proofread-metric">${escapeHtml(changes)}</span>
        </div>
        ${controls}
      </div>
      ${proofreadBody}
    `;
}


function getOverallEntryStatus(item) {
  if (!item) return 'pending';
  const translationStatus = normalizeStatus(item.translationStatus, item.translated);
  const proofreadApplied = item.proofreadApplied !== false;
  const proofreadStatus = normalizeStatus(item.proofreadStatus, item.proofread, proofreadApplied);

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

function normalizeStatus(status, value, proofreadApplied = true) {
  if (status && STATUS_CONFIG[status]) return status;
  if (proofreadApplied === false) return 'disabled';
  if (Array.isArray(value)) return value.length ? 'done' : 'pending';
  if (typeof value === 'string') return value.trim() ? 'done' : 'pending';
  if (value) return 'done';
  return 'pending';
}

function renderStatusBadge(status) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return `<span class="status-badge ${config.className}">${config.label}</span>`;
}

function renderRawResponse(value, emptyMessage) {
  const { text, isJson, isEmpty } = formatRawResponse(value);
  if (isEmpty) {
    return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
  }
  const classes = ['raw-response'];
  if (isJson) classes.push('raw-json');
  return `<pre class="${classes.join(' ')}">${escapeHtml(text)}</pre>`;
}

function renderInlineRaw(value, options = {}) {
  const rawRefId = options.rawRefId || '';
  const rawField = options.rawField || 'text';
  const truncated = Boolean(options.truncated);
  const targetId = rawRefId ? `raw-${Math.random().toString(16).slice(2)}` : '';
  const loadButton =
    rawRefId && truncated
      ? `<button class="action-button action-button--inline" type="button" data-action="load-raw" data-raw-id="${escapeHtml(
          rawRefId
        )}" data-raw-field="${escapeHtml(rawField)}" data-target-id="${escapeHtml(targetId)}">Загрузить полностью</button>`
      : '';
  return `
    ${loadButton}
    <div data-raw-target="${escapeHtml(targetId)}">
      ${renderRawResponse(value, options.emptyMessage || 'Нет данных.')}
    </div>
  `;
}

function normalizeDebugPayloads(payloads, fallbackRaw, phase, fallbackMeta = {}) {
  if (Array.isArray(payloads) && payloads.length) {
    return payloads;
  }
  if (fallbackRaw || fallbackMeta?.rawRefId) {
    return [
      {
        phase,
        model: '—',
        latencyMs: null,
        usage: null,
        inputChars: null,
        outputChars: typeof fallbackRaw === 'string' ? fallbackRaw.length : null,
        request: null,
        response: fallbackRaw,
        rawRefId: fallbackMeta?.rawRefId || '',
        responseTruncated: fallbackMeta?.truncated || false,
        parseIssues: []
      }
    ];
  }
  return [];
}

function patchDebugPayloads(container, payloads, fallbackRaw, phase, fallbackMeta = {}) {
  if (!container) return;
  const normalized = normalizeDebugPayloads(payloads, fallbackRaw, phase, fallbackMeta);
  const emptyEl = ensurePayloadEmpty(container);
  const listEl = ensurePayloadList(container);
  if (!normalized.length) {
    emptyEl.hidden = false;
    listEl.innerHTML = '';
    debugDomState.payloadPartsByKey.forEach((value, key) => {
      if (!value.el.isConnected) {
        debugDomState.payloadPartsByKey.delete(key);
      }
    });
    return;
  }
  emptyEl.hidden = true;
  const liveKeys = new Set();
  normalized.forEach((payload, index) => {
    const baseKey = fallbackMeta.baseKey || phase.toLowerCase();
    const payloadKey = `${baseKey}:payload:${index}`;
    const payloadEl = ensurePayloadElement(listEl, payloadKey);
    patchDebugPayload(payloadEl, payload, payloadKey);
    liveKeys.add(payloadKey);
  });
  Array.from(listEl.querySelectorAll('.debug-payload')).forEach((payloadEl) => {
    const key = payloadEl.getAttribute('data-payload-key') || '';
    if (key && !liveKeys.has(key)) {
      payloadEl.remove();
      debugDomState.payloadPartsByKey.delete(key);
    }
  });
}

function ensurePayloadEmpty(container) {
  let emptyEl = container.querySelector('[data-role="payload-empty"]');
  if (!emptyEl) {
    emptyEl = document.createElement('div');
    emptyEl.className = 'empty';
    emptyEl.dataset.role = 'payload-empty';
    emptyEl.textContent = 'Ответ ИИ ещё не получен.';
    container.appendChild(emptyEl);
  }
  return emptyEl;
}

function ensurePayloadList(container) {
  let listEl = container.querySelector('[data-role="payload-list"]');
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.dataset.role = 'payload-list';
    container.appendChild(listEl);
  }
  return listEl;
}

function ensurePayloadElement(container, payloadKey) {
  let payloadEl = container.querySelector(`[data-payload-key="${CSS.escape(payloadKey)}"]`);
  if (!payloadEl) {
    payloadEl = document.createElement('div');
    payloadEl.className = 'debug-payload';
    payloadEl.dataset.payloadKey = payloadKey;
    payloadEl.innerHTML = `
      <div class="debug-header">
        <div class="debug-title">
          <span class="debug-phase" data-role="payload-phase"></span>
          <span class="debug-model" data-role="payload-model"></span>
          <span class="debug-tag" data-role="payload-tag"></span>
        </div>
        <div class="debug-metrics">
          <span data-role="payload-latency"></span>
          <span data-role="payload-usage"></span>
        </div>
      </div>
      <div class="debug-meta" data-role="payload-io"></div>
      <div class="debug-meta debug-meta--request" data-role="payload-request-meta"></div>
      <div class="debug-context" data-role="payload-context-meta"></div>
      <div data-role="payload-sections"></div>
    `;
    const sectionsEl = payloadEl.querySelector('[data-role="payload-sections"]');
    const contextDetails = ensureDebugDetails(sectionsEl, `${payloadKey}:context`, 'Context text sent');
    const requestDetails = ensureDebugDetails(sectionsEl, `${payloadKey}:request`, 'Request (raw)');
    const responseDetails = ensureDebugDetails(sectionsEl, `${payloadKey}:response`, 'Response (raw)');
    const parseDetails = ensureDebugDetails(sectionsEl, `${payloadKey}:parse`, 'Parse/Validation');
    debugDomState.payloadPartsByKey.set(payloadKey, {
      el: payloadEl,
      phaseEl: payloadEl.querySelector('[data-role="payload-phase"]'),
      modelEl: payloadEl.querySelector('[data-role="payload-model"]'),
      tagEl: payloadEl.querySelector('[data-role="payload-tag"]'),
      latencyEl: payloadEl.querySelector('[data-role="payload-latency"]'),
      usageEl: payloadEl.querySelector('[data-role="payload-usage"]'),
      ioMetaEl: payloadEl.querySelector('[data-role="payload-io"]'),
      requestMetaEl: payloadEl.querySelector('[data-role="payload-request-meta"]'),
      contextMetaEl: payloadEl.querySelector('[data-role="payload-context-meta"]'),
      contextDetails,
      requestDetails,
      responseDetails,
      parseDetails
    });
    container.appendChild(payloadEl);
  }
  return payloadEl;
}

function ensureDebugDetails(container, debugKey, label) {
  const { detailsEl, contentEl } = ensureDetailsElement(container, debugKey, label, 'debug-details');
  return { detailsEl, contentEl };
}

function patchDebugPayload(payloadEl, payload, payloadKey) {
  const parts = debugDomState.payloadPartsByKey.get(payloadKey);
  if (!parts) return;
  const phase = payload?.phase || 'UNKNOWN';
  const model = payload?.model || '—';
  const tag = payload?.tag || '';
  const usage = formatUsage(payload?.usage);
  const latency = formatLatency(payload?.latencyMs);
  const inputChars = formatCharCount(payload?.inputChars);
  const outputChars = formatCharCount(payload?.outputChars);
  const contextTypeRaw =
    payload?.contextTypeUsed ||
    (typeof payload?.contextMode === 'string' && ['FULL', 'SHORT'].includes(payload.contextMode.toUpperCase())
      ? payload.contextMode
      : '');
  const contextMode = typeof contextTypeRaw === 'string' ? contextTypeRaw.toUpperCase() : '';
  const contextLabel = contextMode === 'FULL' ? 'FULL' : contextMode === 'SHORT' ? 'SHORT' : '';
  const contextTypeClass = contextMode === 'SHORT' ? 'short' : contextMode === 'FULL' ? 'full' : '';
  const contextBadge = contextLabel
    ? `<span class="context-pill context-pill--${escapeHtml(contextTypeClass)}">${escapeHtml(contextLabel)}</span>`
    : '';
  const baseBadge = payload?.baseAnswerIncluded
    ? `<span class="context-pill context-pill--base">base included</span>`
    : '';
  const contextMeta = contextLabel ? `Context used: ${contextBadge}${baseBadge}` : '';
  const requestId = payload?.requestId || '';
  const parentRequestId = payload?.parentRequestId || '';
  const blockKey = payload?.blockKey || '';
  const stage = payload?.stage || '';
  const purpose = payload?.purpose || '';
  const attempt = Number.isFinite(payload?.attempt) ? payload.attempt : null;
  const triggerSource = payload?.triggerSource || '';
  const contextPolicyRaw = payload?.contextMode || payload?.contextPolicy || '';
  const contextPolicy =
    typeof contextPolicyRaw === 'string' && ['full', 'minimal', 'none'].includes(contextPolicyRaw.toLowerCase())
      ? contextPolicyRaw.toLowerCase()
      : '';
  const contextHash = payload?.contextHash ?? null;
  const contextLength = payload?.contextLength ?? null;
  const requestMetaItems = [
    requestId ? `requestId: ${escapeHtml(requestId)}` : '',
    parentRequestId ? `parentRequestId: ${escapeHtml(parentRequestId)}` : '',
    blockKey ? `blockKey: ${escapeHtml(blockKey)}` : '',
    stage ? `stage: ${escapeHtml(stage)}` : '',
    purpose ? `purpose: ${escapeHtml(purpose)}` : '',
    Number.isFinite(attempt) ? `attempt: ${escapeHtml(String(attempt))}` : '',
    triggerSource ? `triggerSource: ${escapeHtml(triggerSource)}` : '',
    contextPolicy ? `contextMode: ${escapeHtml(contextPolicy)}` : '',
    Number.isFinite(contextLength) ? `contextLen: ${escapeHtml(String(contextLength))}` : '',
    contextHash ? `contextHash: ${escapeHtml(String(contextHash))}` : ''
  ].filter(Boolean);
  setTextIfChanged(parts.phaseEl, phase);
  setTextIfChanged(parts.modelEl, model);
  setTextIfChanged(parts.tagEl, tag);
  parts.tagEl.style.display = tag ? '' : 'none';
  setTextIfChanged(parts.latencyEl, `Latency: ${latency}`);
  setTextIfChanged(parts.usageEl, `Tokens: ${usage}`);
  setHtmlIfChanged(parts.ioMetaEl, `<span>Input: ${escapeHtml(inputChars)}</span><span>Output: ${escapeHtml(outputChars)}</span>`);
  setHtmlIfChanged(parts.requestMetaEl, requestMetaItems.length ? requestMetaItems.join(' · ') : '');
  parts.requestMetaEl.style.display = requestMetaItems.length ? '' : 'none';
  setHtmlIfChanged(parts.contextMetaEl, contextMeta);
  parts.contextMetaEl.style.display = contextMeta ? '' : 'none';
  const hasContextSection = Boolean(contextLabel);
  parts.contextDetails.detailsEl.style.display = hasContextSection ? '' : 'none';
  if (hasContextSection) {
    setHtmlIfChanged(
      parts.contextDetails.contentEl,
      buildDebugSectionContent(payload?.contextTextSent, {
        rawRefId: payload?.rawRefId,
        rawField: 'contextTextSent',
        truncated: payload?.contextTruncated
      })
    );
  }
  setHtmlIfChanged(
    parts.requestDetails.contentEl,
    buildDebugSectionContent(payload?.request, {
      rawRefId: payload?.rawRefId,
      rawField: 'request',
      truncated: payload?.requestTruncated
    })
  );
  setHtmlIfChanged(
    parts.responseDetails.contentEl,
    buildDebugSectionContent(payload?.response, {
      rawRefId: payload?.rawRefId,
      rawField: 'response',
      truncated: payload?.responseTruncated
    })
  );
  setHtmlIfChanged(parts.parseDetails.contentEl, buildDebugParseContent(payload?.parseIssues));
}

function buildDebugSectionContent(value, options = {}) {
  const rawRefId = options.rawRefId || '';
  const rawField = options.rawField || 'text';
  const isTruncated = Boolean(options.truncated);
  const targetId = rawRefId ? `raw-${Math.random().toString(16).slice(2)}` : '';
  const loadButton =
    rawRefId && isTruncated
      ? `<button class="action-button action-button--inline" type="button" data-action="load-raw" data-raw-id="${escapeHtml(
          rawRefId
        )}" data-raw-field="${escapeHtml(rawField)}" data-target-id="${escapeHtml(targetId)}">Загрузить полностью</button>`
      : '';
  return `
    ${loadButton}
    <div data-raw-target="${escapeHtml(targetId)}">
      ${renderRawResponse(value, 'Нет данных.')}
    </div>
  `;
}

function buildDebugParseContent(parseIssues) {
  const issues = Array.isArray(parseIssues) ? parseIssues.filter(Boolean) : [];
  return issues.length
    ? `<pre class="raw-response">${escapeHtml(issues.join('\n'))}</pre>`
    : `<div class="empty">Ошибок не обнаружено.</div>`;
}

function formatUsage(usage) {
  if (!usage) return '—';
  const total = usage.total_tokens ?? usage.totalTokens;
  const prompt = usage.prompt_tokens ?? usage.promptTokens;
  const completion = usage.completion_tokens ?? usage.completionTokens;
  if (Number.isFinite(prompt) && Number.isFinite(completion)) {
    return `${prompt} prompt / ${completion} completion`;
  }
  if (Number.isFinite(total)) {
    return `${total} total`;
  }
  return '—';
}

function formatLatency(latencyMs) {
  if (!Number.isFinite(latencyMs)) return '—';
  return `${Math.round(latencyMs)} ms`;
}

function formatCharCount(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value} chars`;
}

function formatRawResponse(value) {
  if (value == null) {
    return { text: '', isJson: false, isEmpty: true };
  }

  if (typeof value !== 'string') {
    try {
      return { text: JSON.stringify(value, null, 2), isJson: true, isEmpty: false };
    } catch (error) {
      return { text: String(value), isJson: false, isEmpty: !String(value).trim() };
    }
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { text: '', isJson: false, isEmpty: true };
  }

  const normalized = stripCodeFences(trimmed);
  try {
    const parsed = JSON.parse(normalized);
    if (typeof parsed === 'string') {
      const innerTrimmed = parsed.trim();
      if (!innerTrimmed) {
        return { text: '', isJson: false, isEmpty: true };
      }
      try {
        const innerParsed = JSON.parse(innerTrimmed);
        return { text: JSON.stringify(innerParsed, null, 2), isJson: true, isEmpty: false };
      } catch (innerError) {
        return { text: parsed, isJson: false, isEmpty: false };
      }
    }
    return { text: JSON.stringify(parsed, null, 2), isJson: true, isEmpty: false };
  } catch (error) {
    return { text: trimmed, isJson: false, isEmpty: false };
  }
}

function stripCodeFences(value) {
  return value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function tokenizeForDiff(text = '') {
  const tokens = text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}\s]+|\s+/gu);
  return tokens || [];
}

function diffTokens(beforeTokens, afterTokens) {
  const rows = beforeTokens.length + 1;
  const cols = afterTokens.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = rows - 2; i >= 0; i -= 1) {
    for (let j = cols - 2; j >= 0; j -= 1) {
      if (beforeTokens[i] === afterTokens[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const result = [];
  let i = 0;
  let j = 0;
  while (i < beforeTokens.length && j < afterTokens.length) {
    if (beforeTokens[i] === afterTokens[j]) {
      result.push({ type: 'equal', value: beforeTokens[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'delete', value: beforeTokens[i] });
      i += 1;
    } else {
      result.push({ type: 'insert', value: afterTokens[j] });
      j += 1;
    }
  }
  while (i < beforeTokens.length) {
    result.push({ type: 'delete', value: beforeTokens[i] });
    i += 1;
  }
  while (j < afterTokens.length) {
    result.push({ type: 'insert', value: afterTokens[j] });
    j += 1;
  }

  return result;
}

function renderDiffHtml(before = '', after = '') {
  const beforeTokens = tokenizeForDiff(before);
  const afterTokens = tokenizeForDiff(after);
  const diff = diffTokens(beforeTokens, afterTokens);
  return diff
    .map((entry) => {
      const escaped = escapeHtml(entry.value);
      if (entry.type === 'insert') {
        return `<span class="diff-insert">${escaped}</span>`;
      }
      if (entry.type === 'delete') {
        return `<span class="diff-delete">${escaped}</span>`;
      }
      return escaped;
    })
    .join('');
}

function getProofreadEntryKey(item, index) {
  if (item?.id) return String(item.id);
  if (item?.index != null) return String(item.index);
  return `entry-${index}`;
}

function captureUiState() {
  // Сохраняем раскрытые <details> по стабильным data-debug-key, чтобы вложенные секции не сбрасывались.
  const openKeys = new Set();
  document.querySelectorAll('details[open][data-debug-key]').forEach((details) => {
    const key = details.getAttribute('data-debug-key');
    if (key) openKeys.add(key);
  });
  debugUiState.openKeys = openKeys;
  const scrollEl = document.scrollingElement;
  debugUiState.scrollTop = scrollEl ? scrollEl.scrollTop : 0;
}

function restoreUiState() {
  document.querySelectorAll('details[data-debug-key]').forEach((details) => {
    const key = details.getAttribute('data-debug-key');
    if (!key) return;
    if (details.hasAttribute('data-open-initialized')) return;
    details.open = debugUiState.openKeys.has(key);
    details.setAttribute('data-open-initialized', '1');
  });
  const scrollEl = document.scrollingElement;
  if (scrollEl) {
    scrollEl.scrollTop = debugUiState.scrollTop;
  }
}

function runDebugRecreationCheck() {
  if (!debugInstrumentation.enabled) return;
  const nextRefs = new Map();
  let recreatedCount = 0;
  document.querySelectorAll('details[data-debug-key]').forEach((details) => {
    const key = details.getAttribute('data-debug-key');
    if (!key) return;
    const prev = debugInstrumentation.lastRefByKey.get(key);
    if (prev && prev !== details) {
      console.warn(`[debug] RECREATED key=${key}`);
      recreatedCount += 1;
    }
    nextRefs.set(key, details);
  });
  if (recreatedCount > 0) {
    console.warn(`[debug] RECREATED total=${recreatedCount}`);
  }
  debugInstrumentation.lastRefByKey = nextRefs;
}

function getProofreadState(entryKey, defaultView) {
  const existing = proofreadUiState.get(entryKey);
  if (existing) {
    return { view: existing.view || defaultView, expanded: Boolean(existing.expanded) };
  }
  const next = { view: defaultView, expanded: false };
  proofreadUiState.set(entryKey, next);
  return next;
}

function getProofreadStatusLabel(item, hasComparisons) {
  if (item?.proofreadApplied === false) return 'Отключено';
  const status = STATUS_CONFIG[item?.proofreadStatus]
    ? item.proofreadStatus
    : normalizeStatus(item?.proofreadStatus, item?.proofread, true);
  if (status === 'failed') return 'Ошибка';
  if (status === 'in_progress') return 'В работе';
  if (status === 'pending') return 'Ожидает';
  if (status === 'disabled') return 'Отключено';
  if (status === 'done') {
    if (hasComparisons) return 'Применено';
    return item?.proofreadExecuted ? 'Без изменений' : 'Не требовалось';
  }
  return 'Ожидает';
}

function getProofreadStatusClass(item, hasComparisons) {
  if (item?.proofreadApplied === false) return 'proofread-status--skipped';
  const status = STATUS_CONFIG[item?.proofreadStatus]
    ? item.proofreadStatus
    : normalizeStatus(item?.proofreadStatus, item?.proofread, true);
  if (status === 'failed') return 'proofread-status--error';
  if (status === 'done') {
    if (hasComparisons) return 'proofread-status--applied';
    return item?.proofreadExecuted ? 'proofread-status--applied' : 'proofread-status--skipped';
  }
  if (status === 'disabled') return 'proofread-status--skipped';
  return '';
}

function getProofreadLatency(item) {
  const debug = Array.isArray(item?.proofreadDebug) ? item.proofreadDebug : [];
  const latency = debug.find((entry) => Number.isFinite(entry?.latencyMs))?.latencyMs;
  if (Number.isFinite(latency)) {
    return `${Math.round(latency)} ms`;
  }
  return '— ms';
}

function getProofreadChangesSummary(comparisons) {
  const totalBefore = comparisons.reduce((sum, comparison) => sum + (comparison.before || '').length, 0);
  const totalAfter = comparisons.reduce((sum, comparison) => sum + (comparison.after || '').length, 0);
  const delta = totalAfter - totalBefore;
  const deltaLabel = delta === 0 ? 'Δ 0' : `Δ ${delta > 0 ? '+' : ''}${delta}`;
  const changes = comparisons.length;
  return changes ? `${deltaLabel} • ${changes} сегм.` : `${deltaLabel}`;
}

function renderProofreadDiffView(comparisons) {
  return comparisons
    .map((comparison) => `
      <div class="proofread-item">
        <div class="proofread-item-header">Сегмент ${comparison.segmentIndex + 1}</div>
        <div class="proofread-diff">${renderDiffHtml(comparison.before || '', comparison.after || '')}</div>
      </div>
    `)
    .join('');
}

function renderProofreadSideBySideView(comparisons) {
  return comparisons
    .map((comparison) => `
      <div class="proofread-item">
        <div class="proofread-item-header">Сегмент ${comparison.segmentIndex + 1}</div>
        <div class="proofread-columns">
          <div>
            <div class="proofread-subtitle">До (перевод)</div>
            <pre>${escapeHtml(comparison.before || '')}</pre>
          </div>
          <div>
            <div class="proofread-subtitle">После (вычитка)</div>
            <pre>${escapeHtml(comparison.after || '')}</pre>
          </div>
        </div>
      </div>
    `)
    .join('');
}

function renderProofreadFinalView(comparisons) {
  return comparisons
    .map((comparison) => `
      <div class="proofread-item">
        <div class="proofread-item-header">Сегмент ${comparison.segmentIndex + 1}</div>
        <pre>${escapeHtml(comparison.after || '')}</pre>
      </div>
    `)
    .join('');
}
