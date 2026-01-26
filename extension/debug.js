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
  entriesByKey: new Map()
};
let latestDebugSnapshot = null;
let latestDebugUrl = '';
let debugPatchScheduled = false;

init();

async function init() {
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
  // Раньше весь блок отладки перерисовывался через innerHTML, что сбрасывало раскрытие <details> и прокрутку.
  // Теперь сохраняем состояние и патчим только нужные узлы.
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
    entry.innerHTML = renderEntryHtml(item, entryKey);
    liveKeys.add(entryKey);
  });
  for (const [entryKey, entryEl] of debugDomState.entriesByKey.entries()) {
    if (!liveKeys.has(entryKey)) {
      entryEl.remove();
      debugDomState.entriesByKey.delete(entryKey);
    }
  }
  restoreUiState();
  autoLoadRawTargets(document);
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
  return entry;
}

function renderEntryHtml(item, entryKey) {
  const translationStatus = normalizeStatus(item.translationStatus, item.translated);
  const proofreadStatus = normalizeStatus(item.proofreadStatus, item.proofread, item.proofreadApplied);
  const proofreadSection = renderProofreadSection(item, entryKey);
  const translateKey = `entry:${entryKey}:translate`;
  const translateAiKey = `${translateKey}:ai`;
  return `
    <div class="entry-header">
      <h2>Блок ${item.index || ''}</h2>
      <div class="status-row">
        <div class="status-group">
          <span class="status-label">Перевод</span>
          ${renderStatusBadge(translationStatus)}
        </div>
        <div class="status-group">
          <span class="status-label">Вычитка</span>
          ${renderStatusBadge(proofreadStatus)}
        </div>
      </div>
    </div>
    <div class="block">
      <div class="label">Оригинал</div>
      <pre>${escapeHtml(item.original || '')}</pre>
    </div>
    <div class="block">
      <div class="label">Перевод</div>
      ${
        item.translated
          ? `<pre>${escapeHtml(item.translated)}</pre>`
          : `<div class="empty">Перевод ещё не получен.</div>`
      }
    </div>
    <div class="block">
      <details class="ai-response" data-debug-key="${escapeHtml(translateAiKey)}">
        <summary>Ответ ИИ (перевод)</summary>
        <div class="details-content">
          ${renderDebugPayloads(item?.translationDebug, item?.translationRaw, 'TRANSLATE', {
            rawRefId: item?.translationRawRefId,
            truncated: item?.translationRawTruncated,
            baseKey: translateKey
          })}
        </div>
      </details>
    </div>
    ${proofreadSection}
  `;
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


function renderProofreadSection(item, entryKey) {
  if (item?.proofreadApplied === false) {
    const proofreadAiKey = `entry:${entryKey}:proofread:ai`;
    return `
      <div class="block">
        <div class="label">Вычитка</div>
        <div class="empty">Вычитка выключена.</div>
      </div>
      <div class="block">
        <details class="ai-response" data-debug-key="${escapeHtml(proofreadAiKey)}">
          <summary>Ответ ИИ (вычитка)</summary>
          <div class="details-content">
            <div class="empty">Вычитка выключена.</div>
          </div>
        </details>
      </div>
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
      <div class="block proofread-block${isExpanded ? ' is-expanded' : ''}" data-proofread-id="${escapeHtml(entryKey)}" data-proofread-view="${escapeHtml(showView)}">
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
      </div>
      <div class="block">
        <details class="ai-response" data-debug-key="${escapeHtml(`entry:${entryKey}:proofread:ai`)}">
          <summary>Ответ ИИ (вычитка)</summary>
          <div class="details-content">
            ${renderDebugPayloads(item?.proofreadDebug, item?.proofreadRaw, 'PROOFREAD', {
              rawRefId: item?.proofreadRawRefId,
              truncated: item?.proofreadRawTruncated,
              baseKey: `entry:${entryKey}:proofread`
            })}
          </div>
        </details>
      </div>
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
  const autoLoad = rawRefId && truncated;
  const autoLoadAttrs = autoLoad
    ? ` data-raw-auto="true" data-raw-id="${escapeHtml(rawRefId)}" data-raw-field="${escapeHtml(rawField)}"`
    : '';
  return `
    <div data-raw-target="${escapeHtml(targetId)}"${autoLoadAttrs}>
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
  const baseKey = fallbackMeta.baseKey || phase.toLowerCase();
  return normalized.map((payload, index) => renderDebugPayload(payload, index, baseKey)).join('');
}

function renderDebugPayload(payload, index, baseKey) {
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
  const contextMeta = contextLabel
    ? `<div class="debug-context">Context used: ${contextBadge}${baseBadge}</div>`
    : '';
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
  const requestMetaSection = requestMetaItems.length
    ? `<div class="debug-meta debug-meta--request">${requestMetaItems.join(' · ')}</div>`
    : '';
  const payloadKey = `${baseKey}:payload:${index}`;
  const contextSection = contextLabel
    ? renderDebugSection('Context text sent', payload?.contextTextSent, {
        rawRefId: payload?.rawRefId,
        rawField: 'contextTextSent',
        truncated: payload?.contextTruncated,
        debugKey: `${payloadKey}:context`
      })
    : '';
  const requestSection = renderDebugSection('Request (raw)', payload?.request, {
    rawRefId: payload?.rawRefId,
    rawField: 'request',
    truncated: payload?.requestTruncated,
    debugKey: `${payloadKey}:request`
  });
  const responseSection = renderDebugSection('Response (raw)', payload?.response, {
    rawRefId: payload?.rawRefId,
    rawField: 'response',
    truncated: payload?.responseTruncated,
    debugKey: `${payloadKey}:response`
  });
  const parseSection = renderDebugParseSection(payload?.parseIssues, `${payloadKey}:parse`);
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
      ${requestMetaSection}
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
  const debugKey = options.debugKey ? ` data-debug-key="${escapeHtml(options.debugKey)}"` : '';
  const targetId = rawRefId ? `raw-${Math.random().toString(16).slice(2)}` : '';
  const autoLoad = rawRefId && isTruncated;
  const autoLoadAttrs = autoLoad
    ? ` data-raw-auto="true" data-raw-id="${escapeHtml(rawRefId)}" data-raw-field="${escapeHtml(rawField)}"`
    : '';
  return `
    <details class="debug-details"${debugKey}>
      <summary>${escapeHtml(label)}</summary>
      <div class="details-content">
        <div data-raw-target="${escapeHtml(targetId)}"${autoLoadAttrs}>
          ${renderRawResponse(value, 'Нет данных.')}
        </div>
      </div>
    </details>
  `;
}

function renderDebugParseSection(parseIssues, debugKey = '') {
  const issues = Array.isArray(parseIssues) ? parseIssues.filter(Boolean) : [];
  const content = issues.length
    ? `<pre class="raw-response">${escapeHtml(issues.join('\n'))}</pre>`
    : `<div class="empty">Ошибок не обнаружено.</div>`;
  const debugKeyAttr = debugKey ? ` data-debug-key="${escapeHtml(debugKey)}"` : '';
  return `
    <details class="debug-details"${debugKeyAttr}>
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

function autoLoadRawTargets(root = document) {
  const targets = root.querySelectorAll('[data-raw-auto="true"]:not([data-raw-loaded="true"])');
  targets.forEach((target) => {
    target.setAttribute('data-raw-loaded', 'true');
    loadRawTarget(target);
  });
}

async function loadRawTarget(target) {
  const rawId = target.getAttribute('data-raw-id');
  const rawField = target.getAttribute('data-raw-field') || 'text';
  if (!rawId) return;
  try {
    const record = await getRawRecord(rawId);
    const payload = record?.value || {};
    const rawValue = payload?.[rawField] ?? payload?.text ?? '';
    target.innerHTML = renderRawResponse(rawValue, 'Нет данных.');
  } catch (error) {
    target.innerHTML = '<div class="empty">Не удалось загрузить данные.</div>';
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
    details.open = debugUiState.openKeys.has(key);
  });
  const scrollEl = document.scrollingElement;
  if (scrollEl) {
    scrollEl.scrollTop = debugUiState.scrollTop;
  }
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
