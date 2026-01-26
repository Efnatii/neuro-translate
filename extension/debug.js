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
const DEBUG_UI_STATE_KEY = 'neuroTranslate.debugUIState';
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
let latestDebugData = null;
let debugPatchScheduled = false;
let uiStatePersistTimer = null;
let contextUi = null;
let entriesEmptyEl = null;
const debugEntryUis = new Map();

init();

async function init() {
  loadDebugUiState();
  sourceUrl = getSourceUrlFromQuery();
  if (!sourceUrl) {
    renderEmpty('Не удалось определить страницу для отладки.');
    return;
  }

  if (contextEl) {
    contextEl.addEventListener('click', (event) => {
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
    entriesEl.addEventListener('click', (event) => {
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
        schedulePersistUiState();
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
        schedulePersistUiState();
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
  if (eventsEl) {
    eventsEl.innerHTML = '';
  }
  renderSummary({
    items: [],
    contextStatus: 'pending',
    context: ''
  }, message);
  ensureContextSkeleton();
  updateContext({
    context: '',
    contextFull: '',
    contextShort: '',
    contextFullStatus: 'pending',
    contextShortStatus: 'pending',
    contextStatus: 'pending',
    contextFullTruncated: false,
    contextShortTruncated: false,
    contextFullRefId: '',
    contextShortRefId: ''
  });
  updateEntries([]);
}

function scheduleDebugPatch(url, data) {
  latestDebugData = { url, data };
  if (debugPatchScheduled) return;
  debugPatchScheduled = true;
  requestAnimationFrame(() => {
    debugPatchScheduled = false;
    if (!latestDebugData) return;
    patchDebugUI(latestDebugData.url, latestDebugData.data);
  });
}

function patchDebugUI(url, data) {
  const snapshot = captureUiSnapshot();
  const updatedAt = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU') : '—';
  metaEl.textContent = `URL: ${url} • Обновлено: ${updatedAt}`;
  renderSummary(data, '');
  renderEvents(data);
  updateContext(data);
  updateEntries(Array.isArray(data.items) ? data.items : []);
  restoreUiSnapshot(snapshot);
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
  if (contextUi) return;
  contextEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'entry-header';

  const title = document.createElement('h2');
  title.textContent = 'Контекст';

  const statusRow = document.createElement('div');
  statusRow.className = 'status-row';

  const shortGroup = document.createElement('div');
  shortGroup.className = 'status-group';
  const shortLabel = document.createElement('span');
  shortLabel.className = 'status-label';
  shortLabel.textContent = 'SHORT';
  const shortBadge = document.createElement('span');
  shortBadge.className = 'status-badge';
  shortGroup.append(shortLabel, shortBadge);

  const fullGroup = document.createElement('div');
  fullGroup.className = 'status-group';
  const fullLabel = document.createElement('span');
  fullLabel.className = 'status-label';
  fullLabel.textContent = 'FULL';
  const fullBadge = document.createElement('span');
  fullBadge.className = 'status-badge';
  fullGroup.append(fullLabel, fullBadge);

  const actions = document.createElement('div');
  actions.className = 'context-actions';
  const clearButton = document.createElement('button');
  clearButton.className = 'action-button';
  clearButton.type = 'button';
  clearButton.setAttribute('data-action', 'clear-context');
  clearButton.textContent = 'Сбросить';
  actions.appendChild(clearButton);

  statusRow.append(shortGroup, fullGroup, actions);
  header.append(title, statusRow);

  const body = document.createElement('div');
  body.className = 'context-body';

  const shortSection = document.createElement('div');
  shortSection.className = 'context-section';
  const shortSectionLabel = document.createElement('div');
  shortSectionLabel.className = 'label';
  shortSectionLabel.textContent = 'SHORT контекст';
  const shortBody = document.createElement('div');
  shortSection.append(shortSectionLabel, shortBody);

  const fullDetails = document.createElement('details');
  fullDetails.className = 'context-card context-card--full';
  const fullSummary = document.createElement('summary');
  fullSummary.textContent = 'FULL контекст';
  const fullContent = document.createElement('div');
  fullContent.className = 'details-content';
  fullDetails.append(fullSummary, fullContent);

  body.append(shortSection, fullDetails);

  contextEl.append(header, body);

  contextUi = {
    shortBadge,
    fullBadge,
    shortBody,
    fullContent
  };
}

function updateContext(data) {
  ensureContextSkeleton();
  const contextFullText = (data.contextFull || data.context || '').trim();
  const contextShortText = (data.contextShort || '').trim();
  const contextFullRefId = data.contextFullRefId || '';
  const contextShortRefId = data.contextShortRefId || '';
  const contextFullTruncated = Boolean(data.contextFullTruncated);
  const contextShortTruncated = Boolean(data.contextShortTruncated);
  const contextFullStatus = normalizeStatus(data.contextFullStatus || data.contextStatus, contextFullText);
  const contextShortStatus = normalizeStatus(data.contextShortStatus, contextShortText);

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

  updateStatusBadge(contextUi.shortBadge, contextShortStatus);
  updateStatusBadge(contextUi.fullBadge, contextFullStatus);
  contextUi.shortBody.innerHTML = shortContextBody;
  contextUi.fullContent.innerHTML = fullContextBody;
}

function ensureEntriesSkeleton() {
  if (entriesEmptyEl) return;
  entriesEmptyEl = document.createElement('div');
  entriesEmptyEl.className = 'empty';
  entriesEmptyEl.textContent = 'Нет данных о блоках перевода.';
  entriesEl.appendChild(entriesEmptyEl);
}

function updateEntries(items) {
  ensureEntriesSkeleton();
  const normalizedItems = Array.isArray(items) ? items : [];
  const activeKeys = new Set();

  entriesEl.appendChild(entriesEmptyEl);
  entriesEmptyEl.hidden = normalizedItems.length > 0;

  normalizedItems.forEach((item, index) => {
    const entryKey = getProofreadEntryKey(item, index);
    activeKeys.add(entryKey);
    let entryUi = debugEntryUis.get(entryKey);
    if (!entryUi) {
      entryUi = createEntryUi(entryKey);
      debugEntryUis.set(entryKey, entryUi);
    }
    updateEntryUi(entryUi, item, index, entryKey);
    entriesEl.appendChild(entryUi.root);
  });

  Array.from(debugEntryUis.entries()).forEach(([entryKey, entryUi]) => {
    if (activeKeys.has(entryKey)) return;
    entryUi.root.remove();
    debugEntryUis.delete(entryKey);
  });
}

function createEntryUi(entryKey) {
  const entry = document.createElement('div');
  entry.className = 'entry';

  const header = document.createElement('div');
  header.className = 'entry-header';
  const title = document.createElement('h2');

  const statusRow = document.createElement('div');
  statusRow.className = 'status-row';

  const translationGroup = document.createElement('div');
  translationGroup.className = 'status-group';
  const translationLabel = document.createElement('span');
  translationLabel.className = 'status-label';
  translationLabel.textContent = 'Перевод';
  const translationBadge = document.createElement('span');
  translationBadge.className = 'status-badge';
  translationGroup.append(translationLabel, translationBadge);

  const proofreadGroup = document.createElement('div');
  proofreadGroup.className = 'status-group';
  const proofreadLabel = document.createElement('span');
  proofreadLabel.className = 'status-label';
  proofreadLabel.textContent = 'Вычитка';
  const proofreadBadge = document.createElement('span');
  proofreadBadge.className = 'status-badge';
  proofreadGroup.append(proofreadLabel, proofreadBadge);

  statusRow.append(translationGroup, proofreadGroup);
  header.append(title, statusRow);

  const originalBlock = document.createElement('div');
  originalBlock.className = 'block';
  const originalLabel = document.createElement('div');
  originalLabel.className = 'label';
  originalLabel.textContent = 'Оригинал';
  const originalPre = document.createElement('pre');
  originalBlock.append(originalLabel, originalPre);

  const translatedBlock = document.createElement('div');
  translatedBlock.className = 'block';
  const translatedLabel = document.createElement('div');
  translatedLabel.className = 'label';
  translatedLabel.textContent = 'Перевод';
  const translatedPre = document.createElement('pre');
  const translatedEmpty = document.createElement('div');
  translatedEmpty.className = 'empty';
  translatedEmpty.textContent = 'Перевод ещё не получен.';
  translatedBlock.append(translatedLabel, translatedPre, translatedEmpty);

  const translationDetailsBlock = document.createElement('div');
  translationDetailsBlock.className = 'block';
  const translationDetails = document.createElement('details');
  translationDetails.className = 'ai-response';
  const translationSummary = document.createElement('summary');
  translationSummary.textContent = 'Ответ ИИ (перевод)';
  const translationDetailsContent = document.createElement('div');
  translationDetailsContent.className = 'details-content';
  translationDetails.append(translationSummary, translationDetailsContent);
  translationDetailsBlock.appendChild(translationDetails);

  const proofreadSection = createProofreadSection(entryKey);

  entry.append(
    header,
    originalBlock,
    translatedBlock,
    translationDetailsBlock,
    proofreadSection.block,
    proofreadSection.debugBlock
  );

  return {
    root: entry,
    title,
    translationBadge,
    proofreadBadge,
    originalPre,
    translatedPre,
    translatedEmpty,
    translationDetailsContent,
    proofread: proofreadSection
  };
}

function createProofreadSection(entryKey) {
  const block = document.createElement('div');
  block.className = 'block proofread-block';
  block.setAttribute('data-proofread-id', entryKey);

  const header = document.createElement('div');
  header.className = 'proofread-header';

  const title = document.createElement('div');
  title.className = 'proofread-title';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Вычитка';
  const status = document.createElement('span');
  status.className = 'proofread-status';
  const latency = document.createElement('span');
  latency.className = 'proofread-metric';
  const changes = document.createElement('span');
  changes.className = 'proofread-metric';
  title.append(label, status, latency, changes);

  const controls = document.createElement('div');
  controls.className = 'proofread-controls';
  const toggle = document.createElement('div');
  toggle.className = 'proofread-toggle';
  const diffButton = document.createElement('button');
  diffButton.className = 'toggle-button';
  diffButton.type = 'button';
  diffButton.setAttribute('data-action', 'set-proofread-view');
  diffButton.setAttribute('data-view', 'diff');
  diffButton.textContent = 'Diff';
  const sideButton = document.createElement('button');
  sideButton.className = 'toggle-button';
  sideButton.type = 'button';
  sideButton.setAttribute('data-action', 'set-proofread-view');
  sideButton.setAttribute('data-view', 'side');
  sideButton.textContent = 'Side-by-side';
  const finalButton = document.createElement('button');
  finalButton.className = 'toggle-button';
  finalButton.type = 'button';
  finalButton.setAttribute('data-action', 'set-proofread-view');
  finalButton.setAttribute('data-view', 'final');
  finalButton.textContent = 'Final';
  toggle.append(diffButton, sideButton, finalButton);

  const expandButton = document.createElement('button');
  expandButton.className = 'proofread-expand';
  expandButton.type = 'button';
  expandButton.setAttribute('data-action', 'toggle-proofread-expand');
  expandButton.setAttribute('aria-expanded', 'false');
  expandButton.textContent = 'Развернуть';

  controls.append(toggle, expandButton);
  header.append(title, controls);

  const body = document.createElement('div');
  body.className = 'proofread-body';

  const viewsContainer = document.createElement('div');
  const diffView = document.createElement('div');
  diffView.className = 'proofread-view proofread-view--diff';
  const sideView = document.createElement('div');
  sideView.className = 'proofread-view proofread-view--side';
  const finalView = document.createElement('div');
  finalView.className = 'proofread-view proofread-view--final';
  const previewOverlay = document.createElement('div');
  previewOverlay.className = 'proofread-preview-overlay';
  const previewButton = document.createElement('button');
  previewButton.className = 'proofread-preview-button';
  previewButton.type = 'button';
  previewButton.setAttribute('data-action', 'toggle-proofread-expand');
  previewButton.textContent = 'Показать полностью';
  previewOverlay.appendChild(previewButton);
  viewsContainer.append(diffView, sideView, finalView, previewOverlay);

  const emptyMessage = document.createElement('div');
  emptyMessage.className = 'empty';
  emptyMessage.textContent = 'Нет правок.';

  body.append(viewsContainer, emptyMessage);

  block.append(header, body);

  const debugBlock = document.createElement('div');
  debugBlock.className = 'block';
  const debugDetails = document.createElement('details');
  debugDetails.className = 'ai-response';
  const debugSummary = document.createElement('summary');
  debugSummary.textContent = 'Ответ ИИ (вычитка)';
  const debugContent = document.createElement('div');
  debugContent.className = 'details-content';
  debugDetails.append(debugSummary, debugContent);
  debugBlock.appendChild(debugDetails);

  return {
    block,
    status,
    latency,
    changes,
    controls,
    diffButton,
    sideButton,
    finalButton,
    expandButton,
    viewsContainer,
    emptyMessage,
    diffView,
    sideView,
    finalView,
    debugContent
  };
}

function updateEntryUi(entryUi, item, index, entryKey) {
  entryUi.title.textContent = `Блок ${item.index || ''}`;
  const translationStatus = normalizeStatus(item.translationStatus, item.translated);
  const proofreadStatus = normalizeStatus(item.proofreadStatus, item.proofread, item.proofreadApplied);
  updateStatusBadge(entryUi.translationBadge, translationStatus);
  updateStatusBadge(entryUi.proofreadBadge, proofreadStatus);

  entryUi.originalPre.textContent = item.original || '';

  if (item.translated) {
    entryUi.translatedPre.textContent = item.translated;
    entryUi.translatedPre.hidden = false;
    entryUi.translatedEmpty.hidden = true;
  } else {
    entryUi.translatedPre.textContent = '';
    entryUi.translatedPre.hidden = true;
    entryUi.translatedEmpty.hidden = false;
  }

  entryUi.translationDetailsContent.innerHTML = renderDebugPayloads(
    item?.translationDebug,
    item?.translationRaw,
    'TRANSLATE',
    {
      rawRefId: item?.translationRawRefId,
      truncated: item?.translationRawTruncated
    }
  );

  updateProofreadUi(entryUi.proofread, item, entryKey);
}

function updateProofreadUi(ui, item, entryKey) {
  const defaultView = 'diff';
  const comparisonsAll = Array.isArray(item?.proofreadComparisons) ? item.proofreadComparisons : [];
  const comparisons = comparisonsAll.filter((comparison) => comparison?.changed);
  const hasComparisons = comparisons.length > 0;
  const proofreadApplied = item?.proofreadApplied !== false;
  const state = getProofreadState(entryKey, defaultView);
  const showView = state.view || defaultView;
  const isExpanded = Boolean(state.expanded);

  const statusLabel = getProofreadStatusLabel(item, hasComparisons);
  const statusClass = getProofreadStatusClass(item, hasComparisons);
  const latency = getProofreadLatency(item);
  const changes = getProofreadChangesSummary(comparisons);

  ui.status.textContent = statusLabel;
  ui.status.className = `proofread-status ${statusClass}`;
  ui.latency.textContent = latency;
  ui.changes.textContent = changes;

  ui.controls.hidden = !hasComparisons || !proofreadApplied;

  if (!proofreadApplied) {
    proofreadUiState.set(entryKey, { ...state, expanded: false });
    ui.block.classList.remove('is-expanded');
    ui.block.setAttribute('data-proofread-view', defaultView);
    ui.emptyMessage.textContent = 'Вычитка выключена.';
    ui.viewsContainer.hidden = true;
    ui.emptyMessage.hidden = false;
    ui.debugContent.innerHTML = '<div class="empty">Вычитка выключена.</div>';
    return;
  }

  ui.block.classList.toggle('is-expanded', isExpanded);
  ui.block.setAttribute('data-proofread-view', showView);
  ui.expandButton.setAttribute('aria-expanded', String(isExpanded));
  ui.expandButton.textContent = isExpanded ? 'Свернуть' : 'Развернуть';

  ui.diffButton.classList.toggle('is-active', showView === 'diff');
  ui.sideButton.classList.toggle('is-active', showView === 'side');
  ui.finalButton.classList.toggle('is-active', showView === 'final');

  if (hasComparisons) {
    ui.viewsContainer.hidden = false;
    ui.emptyMessage.hidden = true;
    ui.diffView.innerHTML = renderProofreadDiffView(comparisons);
    ui.sideView.innerHTML = renderProofreadSideBySideView(comparisons);
    ui.finalView.innerHTML = renderProofreadFinalView(comparisons);
  } else {
    ui.viewsContainer.hidden = true;
    ui.emptyMessage.hidden = false;
    ui.emptyMessage.textContent = 'Нет правок.';
    ui.diffView.innerHTML = '';
    ui.sideView.innerHTML = '';
    ui.finalView.innerHTML = '';
  }

  ui.debugContent.innerHTML = renderDebugPayloads(item?.proofreadDebug, item?.proofreadRaw, 'PROOFREAD', {
    rawRefId: item?.proofreadRawRefId,
    truncated: item?.proofreadRawTruncated
  });
}

function updateStatusBadge(node, status) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  node.className = `status-badge ${config.className}`;
  node.textContent = config.label;
}

function captureUiSnapshot() {
  const scrollEl = document.scrollingElement || document.documentElement;
  const activeEl = document.activeElement;
  const snapshot = {
    scrollEl,
    scrollTop: scrollEl ? scrollEl.scrollTop : 0,
    activeEl: null,
    selectionStart: null,
    selectionEnd: null
  };

  if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
    snapshot.activeEl = activeEl;
    snapshot.selectionStart = activeEl.selectionStart;
    snapshot.selectionEnd = activeEl.selectionEnd;
  }

  return snapshot;
}

function restoreUiSnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.scrollEl) {
    snapshot.scrollEl.scrollTop = snapshot.scrollTop;
  }
  if (snapshot.activeEl && document.contains(snapshot.activeEl)) {
    snapshot.activeEl.focus();
    if (snapshot.selectionStart != null && snapshot.selectionEnd != null) {
      snapshot.activeEl.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  }
}

function loadDebugUiState() {
  try {
    const raw = sessionStorage.getItem(DEBUG_UI_STATE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const stored = parsed.proofread;
    if (!stored || typeof stored !== 'object') return;
    Object.entries(stored).forEach(([key, value]) => {
      if (!key) return;
      proofreadUiState.set(key, value || {});
    });
  } catch (error) {
    // ignore
  }
}

function schedulePersistUiState() {
  if (uiStatePersistTimer) return;
  uiStatePersistTimer = setTimeout(() => {
    uiStatePersistTimer = null;
    persistUiState();
  }, 400);
}

function persistUiState() {
  try {
    const proofread = {};
    proofreadUiState.forEach((value, key) => {
      proofread[key] = value;
    });
    sessionStorage.setItem(DEBUG_UI_STATE_KEY, JSON.stringify({ proofread }));
  } catch (error) {
    // ignore
  }
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

function renderDebugPayloads(payloads, fallbackRaw, phase, fallbackMeta = {}) {
  const normalized = normalizeDebugPayloads(payloads, fallbackRaw, phase, fallbackMeta);
  if (!normalized.length) {
    return '<div class="empty">Ответ ИИ ещё не получен.</div>';
  }
  return normalized
    .map((payload, index) => renderDebugPayload(payload, index))
    .join('');
}

function renderDebugPayload(payload, index) {
  const phase = payload?.phase || 'UNKNOWN';
  const model = payload?.model || '—';
  const tag = payload?.tag || '';
  const usage = formatUsage(payload?.usage);
  const latency = formatLatency(payload?.latencyMs);
  const inputChars = formatCharCount(payload?.inputChars);
  const outputChars = formatCharCount(payload?.outputChars);
  const contextModeRaw = payload?.contextMode || payload?.contextTypeUsed || '';
  const contextMode = typeof contextModeRaw === 'string' ? contextModeRaw.toUpperCase() : '';
  const contextLabel = contextMode === 'FULL' ? 'FULL' : contextMode === 'SHORT' ? 'SHORT' : '';
  const contextTypeClass = contextMode === 'SHORT' ? 'short' : contextMode === 'FULL' ? 'full' : '';
  const contextBadge = contextLabel
    ? `<span class="context-pill context-pill--${escapeHtml(contextTypeClass)}">${escapeHtml(contextLabel)}</span>`
    : '';
  const baseBadge = payload?.baseAnswerIncluded
    ? `<span class="context-pill context-pill--base">base included</span>`
    : '';
  const contextMeta = contextLabel
    ? `<div class="debug-context">Context used: ${contextBadge}${baseBadge}</div>`
    : '';
  const contextSection = contextLabel
    ? renderDebugSection('Context text sent', payload?.contextTextSent, {
        rawRefId: payload?.rawRefId,
        rawField: 'contextTextSent',
        truncated: payload?.contextTruncated
      })
    : '';
  const requestSection = renderDebugSection('Request (raw)', payload?.request, {
    rawRefId: payload?.rawRefId,
    rawField: 'request',
    truncated: payload?.requestTruncated
  });
  const responseSection = renderDebugSection('Response (raw)', payload?.response, {
    rawRefId: payload?.rawRefId,
    rawField: 'response',
    truncated: payload?.responseTruncated
  });
  const parseSection = renderDebugParseSection(payload?.parseIssues);
  const tagBadge = tag ? `<span class="debug-tag">${escapeHtml(tag)}</span>` : '';
  return `
    <div class="debug-payload">
      <div class="debug-header">
        <div class="debug-title">
          <span class="debug-phase">${escapeHtml(phase)}</span>
          <span class="debug-model">${escapeHtml(model)}</span>
          ${tagBadge}
        </div>
        <div class="debug-metrics">
          <span>Latency: ${escapeHtml(latency)}</span>
          <span>Tokens: ${escapeHtml(usage)}</span>
        </div>
      </div>
      <div class="debug-meta">
        <span>Input: ${escapeHtml(inputChars)}</span>
        <span>Output: ${escapeHtml(outputChars)}</span>
      </div>
      ${contextMeta}
      ${contextSection}
      ${requestSection}
      ${responseSection}
      ${parseSection}
    </div>
  `;
}


function renderDebugSection(label, value, options = {}) {
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
    <details class="debug-details">
      <summary>${escapeHtml(label)}</summary>
      <div class="details-content">
        ${loadButton}
        <div data-raw-target="${escapeHtml(targetId)}">
          ${renderRawResponse(value, 'Нет данных.')}
        </div>
      </div>
    </details>
  `;
}

function renderDebugParseSection(parseIssues) {
  const issues = Array.isArray(parseIssues) ? parseIssues.filter(Boolean) : [];
  const content = issues.length
    ? `<pre class="raw-response">${escapeHtml(issues.join('\n'))}</pre>`
    : `<div class="empty">Ошибок не обнаружено.</div>`;
  return `
    <details class="debug-details">
      <summary>Parse/Validation</summary>
      <div class="details-content">
        ${content}
      </div>
    </details>
  `;
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
