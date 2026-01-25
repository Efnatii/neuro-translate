const metaEl = document.getElementById('meta');
const contextEl = document.getElementById('context');
const summaryEl = document.getElementById('summary');
const entriesEl = document.getElementById('entries');

const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const STATUS_CONFIG = {
  pending: { label: 'Ожидает', className: 'status-pending' },
  in_progress: { label: 'В работе', className: 'status-in-progress' },
  done: { label: 'Готово', className: 'status-done' },
  failed: { label: 'Ошибка', className: 'status-failed' },
  disabled: { label: 'Отключено', className: 'status-disabled' }
};

let sourceUrl = '';
let refreshTimer = null;
const proofreadUiState = new Map();

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
    });
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
  const nextStatus = current.contextStatus === 'disabled' ? 'disabled' : 'pending';
  store[sourceUrl] = {
    ...current,
    context: '',
    contextStatus: nextStatus,
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
  const canListen = typeof chrome !== 'undefined' && chrome.storage?.onChanged;
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
  renderSummary(data, '');

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
           <div class="context-actions">
             <button class="action-button" type="button" data-action="clear-context">Сбросить</button>
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
           <div class="context-actions">
             <button class="action-button" type="button" data-action="clear-context">Сбросить</button>
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
  items.forEach((item, index) => {
    const entry = document.createElement('div');
    entry.className = 'entry';
    const translationStatus = normalizeStatus(item.translationStatus, item.translated);
    const proofreadStatus = normalizeStatus(item.proofreadStatus, item.proofread, item.proofreadApplied);
    const entryKey = getProofreadEntryKey(item, index);
    const proofreadSection = renderProofreadSection(item, entryKey);
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
      <div class="block">
        <details class="ai-response">
          <summary>Ответ ИИ (перевод)</summary>
          <div class="details-content">
            ${renderDebugPayloads(item?.translationDebug, item?.translationRaw, 'TRANSLATE')}
          </div>
        </details>
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
  const aiResponseCount = Number.isFinite(data.aiResponseCount) ? data.aiResponseCount : 0;
  const totalCostUsd = Number.isFinite(data.totalCostUsd) ? data.totalCostUsd : null;
  const totalCostLabel = totalCostUsd != null ? `$${totalCostUsd.toFixed(4)}` : '—';
  const overallStatus = getOverallStatus({
    completed,
    inProgress,
    failed,
    total,
    contextStatus
  });
  const summaryLine = fallbackMessage
    ? `${fallbackMessage}`
    : `Контекст: ${STATUS_CONFIG[contextStatus]?.label || '—'} • Готово блоков: ${completed}/${total} • В работе: ${inProgress} • Ошибки: ${failed} • Запросов к ИИ: ${aiRequestCount} • Ответов ИИ: ${aiResponseCount} • Потрачено: ${totalCostLabel}`;
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

function renderProofreadSection(item, entryKey) {
  if (item?.proofreadApplied === false) {
    return `
      <div class="block">
        <div class="label">Вычитка</div>
        <div class="empty">Вычитка выключена.</div>
      </div>
      <div class="block">
        <details class="ai-response">
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
        <details class="ai-response">
          <summary>Ответ ИИ (вычитка)</summary>
          <div class="details-content">
            ${renderDebugPayloads(item?.proofreadDebug, item?.proofreadRaw, 'PROOFREAD')}
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

function normalizeDebugPayloads(payloads, fallbackRaw, phase) {
  if (Array.isArray(payloads) && payloads.length) {
    return payloads;
  }
  if (fallbackRaw) {
    return [
      {
        phase,
        model: '—',
        latencyMs: null,
        usage: null,
        costUsd: null,
        inputChars: null,
        outputChars: typeof fallbackRaw === 'string' ? fallbackRaw.length : null,
        request: null,
        response: fallbackRaw,
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

function formatCost(costUsd) {
  if (!Number.isFinite(costUsd)) return '—';
  return `$${costUsd.toFixed(4)}`;
}

function formatCharCount(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value} chars`;
}

function renderDebugPayloads(payloads, fallbackRaw, phase) {
  const normalized = normalizeDebugPayloads(payloads, fallbackRaw, phase);
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
  const usage = formatUsage(payload?.usage);
  const latency = formatLatency(payload?.latencyMs);
  const cost = formatCost(payload?.costUsd);
  const inputChars = formatCharCount(payload?.inputChars);
  const outputChars = formatCharCount(payload?.outputChars);
  const requestSection = renderDebugSection('Request (raw)', payload?.request);
  const responseSection = renderDebugSection('Response (raw)', payload?.response);
  const parseSection = renderDebugParseSection(payload?.parseIssues);
  return `
    <div class="debug-payload">
      <div class="debug-header">
        <div class="debug-title">
          <span class="debug-phase">${escapeHtml(phase)}</span>
          <span class="debug-model">${escapeHtml(model)}</span>
        </div>
        <div class="debug-metrics">
          <span>Latency: ${escapeHtml(latency)}</span>
          <span>Tokens: ${escapeHtml(usage)}</span>
          <span>Cost: ${escapeHtml(cost)}</span>
        </div>
      </div>
      <div class="debug-meta">
        <span>Input: ${escapeHtml(inputChars)}</span>
        <span>Output: ${escapeHtml(outputChars)}</span>
      </div>
      ${requestSection}
      ${responseSection}
      ${parseSection}
    </div>
  `;
}

function renderDebugSection(label, value) {
  return `
    <details class="debug-details">
      <summary>${escapeHtml(label)}</summary>
      <div class="details-content">
        ${renderRawResponse(value, 'Нет данных.')}
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
