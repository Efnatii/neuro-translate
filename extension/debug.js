const metaEl = document.getElementById('meta');
const contextEl = document.getElementById('context');
const summaryEl = document.getElementById('summary');
const aiTestsEl = document.getElementById('aiTests');
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
const aiTestState = {
  items: []
};

const AI_TESTS = [
  { title: 'TPM', description: 'Проверить лимит tokens per minute и текущий запас.' },
  { title: 'Пропускная способность', description: 'Оценить tokens/sec при типичном запросе.' },
  { title: 'Стоимость', description: 'Проверить цену за 1k токенов и итоговую стоимость пакета.' },
  { title: 'Лимит запросов', description: 'Проверить RPM и пиковую нагрузку.' },
  { title: 'Задержка', description: 'Сравнить p50/p95 latency для моделей.' },
  { title: 'Контекстное окно', description: 'Проверить запас по максимальному контексту.' },
  { title: 'Стабильность', description: 'Проверить долю ошибок/ретраев.' },
  { title: 'Кэширование', description: 'Оценить экономию при повторных запросах.' }
];

init();

async function init() {
  sourceUrl = getSourceUrlFromQuery();
  if (!sourceUrl) {
    renderEmpty('Не удалось определить страницу для отладки.');
    return;
  }

  initAiTests();
  aiTestsEl?.addEventListener('click', handleAiTestRefresh);
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
  const translationStatuses = items.map((item) =>
    normalizeStatus(item.translationStatus, item.translated)
  );
  const completed = translationStatuses.filter((status) => status === 'done').length;
  const inProgress = translationStatuses.filter((status) => status === 'in_progress').length;
  const failed = translationStatuses.filter((status) => status === 'failed').length;
  const contextStatus = normalizeStatus(data.contextStatus, data.context);
  const progress = total ? Math.round((completed / total) * 100) : 0;
  const overallStatus = getOverallStatus({
    completed,
    inProgress,
    failed,
    total,
    contextStatus
  });
  const summaryLine = fallbackMessage
    ? fallbackMessage
    : `Контекст: ${STATUS_CONFIG[contextStatus]?.label || '—'} • Готово блоков: ${completed}/${total} • В работе: ${inProgress} • Ошибки: ${failed}`;
  summaryEl.innerHTML = `
    <div class="summary-header">
      <div class="status-row">
        <div class="status-group">
          <span class="status-label">Статус</span>
          ${renderStatusBadge(overallStatus)}
        </div>
      </div>
    </div>
    <div class="summary-meta">${summaryLine}</div>
    <div class="progress-bar">
      <div class="progress-fill" style="width: ${progress}%"></div>
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
          .map((replacement) => `${replacement.from} → ${replacement.to ?? ''}`)
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

function initAiTests() {
  aiTestState.items = pickRandomTests();
  renderAiTests();
}

function pickRandomTests(count = 4) {
  const shuffled = [...AI_TESTS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, AI_TESTS.length));
}

function handleAiTestRefresh(event) {
  const button = event.target.closest('button[data-action="refresh-tests"]');
  if (!button) return;
  aiTestState.items = pickRandomTests();
  renderAiTests();
}

function renderAiTests() {
  if (!aiTestsEl) return;
  const tests = aiTestState.items || [];
  const rows = tests
    .map(
      (test) => `
        <div class="ai-test-row">
          <div class="ai-test-title">${escapeHtml(test.title)}</div>
          <p class="ai-test-desc">${escapeHtml(test.description)}</p>
        </div>
      `
    )
    .join('');
  aiTestsEl.innerHTML = `
    <div class="ai-tests-header">
      <button class="ai-test-refresh" type="button" data-action="refresh-tests">Обновить</button>
    </div>
    <div class="ai-test-list">${rows}</div>
  `;
}
