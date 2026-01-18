const metaEl = document.getElementById('meta');
const contextEl = document.getElementById('context');
const summaryEl = document.getElementById('summary');
const entriesEl = document.getElementById('entries');

const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const AUTO_REFRESH_INTERVAL = 1000;
const STATUS_CONFIG = {
  pending: { label: 'Ожидает', className: 'status-pending' },
  in_progress: { label: 'В работе', className: 'status-in-progress' },
  done: { label: 'Готово', className: 'status-done' },
  failed: { label: 'Ошибка', className: 'status-failed' },
  disabled: { label: 'Отключено', className: 'status-disabled' }
};

let sourceUrl = '';
let refreshTimer = null;

init();

async function init() {
  sourceUrl = getSourceUrlFromQuery();
  if (!sourceUrl) {
    renderEmpty('Не удалось определить страницу для отладки.');
    return;
  }

  await refreshDebug();
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

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(() => {
    refreshDebug();
  }, AUTO_REFRESH_INTERVAL);

  if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) {
    return;
  }
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!changes[DEBUG_STORAGE_KEY]) return;
    refreshDebug();
  });
}

async function refreshDebug() {
  const debugData = await getDebugData(sourceUrl);
  if (!debugData) {
    renderEmpty('Ожидание отладочных данных...');
    return;
  }

  renderDebug(sourceUrl, debugData);
}

function renderEmpty(message) {
  metaEl.textContent = message;
  contextEl.innerHTML = '';
  entriesEl.innerHTML = '';
  renderSummary({
    items: [],
    contextStatus: 'pending',
    context: ''
  }, message);
}

function renderDebug(url, data) {
  const updatedAt = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU') : '—';
  metaEl.textContent = `URL: ${url} • Обновлено: ${updatedAt}`;
  renderSummary(data);

  const contextStatus = normalizeStatus(data.contextStatus, data.context);
  const contextText = data.context?.trim();
  contextEl.innerHTML = contextText
    ? `<div class="entry-header">
         <h2>Контекст</h2>
         <div class="status-row">
           <div class="status-group">
             <span class="status-label">Статус</span>
             ${renderStatusBadge(contextStatus)}
           </div>
         </div>
       </div>
       <pre>${escapeHtml(contextText)}</pre>`
    : `<div class="entry-header">
         <h2>Контекст</h2>
         <div class="status-row">
           <div class="status-group">
             <span class="status-label">Статус</span>
             ${renderStatusBadge(contextStatus)}
           </div>
         </div>
       </div>
       <div class="empty">Контекст не сформирован.</div>`;

  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    entriesEl.innerHTML = '<div class="empty">Нет данных о блоках перевода.</div>';
    return;
  }

  entriesEl.innerHTML = '';
  items.forEach((item) => {
    const entry = document.createElement('div');
    entry.className = 'entry';
    const translationStatus = normalizeStatus(item.translationStatus, item.translated);
    const proofreadStatus = normalizeStatus(item.proofreadStatus, item.proofread, item.proofreadApplied);
    const proofreadSection = renderProofreadSection(item);
    entry.innerHTML = `
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
      ${proofreadSection}
    `;
    entriesEl.appendChild(entry);
  });
}

function renderSummary(data, fallbackMessage = '') {
  if (!summaryEl) return;
  const items = Array.isArray(data.items) ? data.items : [];
  const total = items.length;
  const overallStatuses = items.map((item) => getOverallEntryStatus(item));
  const completed = overallStatuses.filter((status) => status === 'done').length;
  const inProgress = overallStatuses.filter((status) => status === 'in_progress').length;
  const failed = overallStatuses.filter((status) => status === 'failed').length;
  const contextStatus = normalizeStatus(data.contextStatus, data.context);
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const aiRequestCount = Number.isFinite(data.aiRequestCount) ? data.aiRequestCount : 0;
  const overallStatus = getOverallStatus({
    completed,
    inProgress,
    failed,
    total,
    contextStatus
  });
  const summaryLine = fallbackMessage
    ? fallbackMessage
    : `Контекст: ${STATUS_CONFIG[contextStatus]?.label || '—'} • Готово блоков: ${completed}/${total} • В работе: ${inProgress} • Ошибки: ${failed} • Запросов к ИИ: ${aiRequestCount}`;
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

function getOverallStatus({ completed, inProgress, failed, total, contextStatus }) {
  if (failed > 0 || contextStatus === 'failed') return 'failed';
  if (total && completed === total && (contextStatus === 'done' || contextStatus === 'disabled')) {
    return 'done';
  }
  if (inProgress > 0 || completed > 0 || contextStatus === 'in_progress') {
    return 'in_progress';
  }
  if (contextStatus === 'disabled') return 'disabled';
  return 'pending';
}

function renderProofreadSection(item) {
  const replacements = Array.isArray(item?.proofread) ? item.proofread : [];
  let content = '';
  if (item?.proofreadApplied) {
    content = replacements.length
      ? replacements
          .map((replacement, index) => formatProofreadReplacement(replacement, index))
          .filter(Boolean)
          .join('\n')
      : 'Нет правок.';
  }
  return `
      <div class="block">
        <div class="label">Вычитка</div>
        ${
          item?.proofreadApplied
            ? `<pre>${escapeHtml(content)}</pre>`
            : `<div class="empty">Вычитка выключена.</div>`
        }
      </div>
    `;
}

function formatProofreadReplacement(replacement, index) {
  if (!replacement || typeof replacement !== 'object') return '';
  const hasFromTo = 'from' in replacement || 'to' in replacement;
  if (hasFromTo) {
    const fromText = typeof replacement.from === 'string' ? replacement.from : '';
    const toText = typeof replacement.to === 'string' ? replacement.to : '';
    if (!fromText && !toText) return '';
    return `${fromText} → ${toText}`;
  }

  if ('revisedText' in replacement) {
    const revisedText = typeof replacement.revisedText === 'string' ? replacement.revisedText : '';
    if (!revisedText) return '';
    const segmentIndex = Number(replacement.segmentIndex);
    const segmentLabel = Number.isInteger(segmentIndex)
      ? `Сегмент ${segmentIndex + 1}`
      : `Правка ${index + 1}`;
    return `${segmentLabel}: ${revisedText}`;
  }

  return '';
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
  if (value) return 'done';
  return 'pending';
}

function renderStatusBadge(status) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;
  return `<span class="status-badge ${config.className}">${config.label}</span>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
