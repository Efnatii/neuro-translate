const metaEl = document.getElementById('meta');
const contextEl = document.getElementById('context');
const summaryEl = document.getElementById('summary');
const entriesEl = document.getElementById('entries');

const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const COST_SETTINGS_KEYS = [
  'openAiProject',
  'showRealCosts',
  'allocateRealCosts'
];
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

async function getCostSettings() {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { openAiProject: '', showRealCosts: false, allocateRealCosts: false };
  }
  return new Promise((resolve) => {
    chrome.storage.local.get(COST_SETTINGS_KEYS, (data) => {
      resolve({
        openAiProject: data?.openAiProject || '',
        showRealCosts: Boolean(data?.showRealCosts),
        allocateRealCosts: Boolean(data?.allocateRealCosts)
      });
    });
  });
}

function sendRuntimeMessage(type, payload) {
  return new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      resolve({ ok: false, errorType: 'runtime', message: 'Runtime API недоступен.' });
      return;
    }
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          errorType: 'runtime',
          message: chrome.runtime.lastError.message || 'Runtime error'
        });
        return;
      }
      resolve(response || { ok: false, errorType: 'runtime', message: 'Пустой ответ.' });
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

  const costSettings = await getCostSettings();
  const orgMetrics = await loadOrgMetrics(debugData, costSettings);
  renderDebug(sourceUrl, debugData, costSettings, orgMetrics);
}

function getUtcDayStartSeconds(timestampSec) {
  const date = new Date(timestampSec * 1000);
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

function getUtcDayStartFromMs(timestampMs) {
  const seconds = Math.floor(timestampMs / 1000);
  return getUtcDayStartSeconds(seconds);
}

function getUtcDayLabel(timestampSec) {
  const date = new Date(timestampSec * 1000);
  return date.toISOString().slice(0, 10);
}

function collectModelsFromDebug(debugData) {
  const items = Array.isArray(debugData?.items) ? debugData.items : [];
  const models = new Set();
  items.forEach((item) => {
    const payloads = [
      ...(Array.isArray(item?.translationDebug) ? item.translationDebug : []),
      ...(Array.isArray(item?.proofreadDebug) ? item.proofreadDebug : [])
    ];
    payloads.forEach((payload) => {
      const model = payload?.model;
      if (typeof model === 'string' && model.trim()) {
        models.add(model.trim());
      }
    });
  });
  return Array.from(models);
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

function getEntryCompletedAt(entry) {
  const proofreadCompletedAt = Number(entry?.proofreadCompletedAt);
  const translationCompletedAt = Number(entry?.translationCompletedAt);
  if (Number.isFinite(proofreadCompletedAt)) return proofreadCompletedAt;
  if (Number.isFinite(translationCompletedAt)) return translationCompletedAt;
  return null;
}

function buildCostsByDay(buckets) {
  const map = new Map();
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const start = Number(bucket?.start_time);
    const amount = Number(bucket?.amount_usd);
    if (!Number.isFinite(start) || !Number.isFinite(amount)) return;
    const dayStart = getUtcDayStartSeconds(start);
    map.set(dayStart, (map.get(dayStart) || 0) + amount);
  });
  return map;
}

function buildUsageTotalsByDay(buckets) {
  const map = new Map();
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const start = Number(bucket?.start_time);
    if (!Number.isFinite(start)) return;
    const dayStart = getUtcDayStartSeconds(start);
    const current = map.get(dayStart) || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const input = Number(bucket?.input_tokens) || 0;
    const output = Number(bucket?.output_tokens) || 0;
    current.inputTokens += input;
    current.outputTokens += output;
    current.totalTokens += Number(bucket?.total_tokens) || input + output;
    map.set(dayStart, current);
  });
  return map;
}

function sumUsageTokensInRange(buckets, startSec, endSec) {
  const totals = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  (Array.isArray(buckets) ? buckets : []).forEach((bucket) => {
    const start = Number(bucket?.start_time);
    if (!Number.isFinite(start)) return;
    if (start < startSec || start >= endSec) return;
    const input = Number(bucket?.input_tokens) || 0;
    const output = Number(bucket?.output_tokens) || 0;
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.totalTokens += Number(bucket?.total_tokens) || input + output;
  });
  return totals;
}

async function loadOrgMetrics(debugData, costSettings) {
  if (!costSettings.showRealCosts) {
    return { status: 'disabled', message: 'Показ реальных расходов выключен в настройках.' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const todayStart = getUtcDayStartSeconds(nowSec);
  const last7Start = todayStart - 6 * 86400;
  const items = Array.isArray(debugData?.items) ? debugData.items : [];
  const dayStarts = new Set([todayStart, last7Start]);
  items.forEach((item) => {
    const completedAt = getEntryCompletedAt(item);
    if (Number.isFinite(completedAt)) {
      dayStarts.add(getUtcDayStartFromMs(completedAt));
    }
  });

  const sessionStart = Number(debugData?.sessionStartTime);
  const sessionEnd = Number(debugData?.sessionEndTime) || nowSec;
  if (Number.isFinite(sessionStart)) {
    const sessionStartDay = getUtcDayStartSeconds(sessionStart);
    const sessionEndDay = getUtcDayStartSeconds(sessionEnd);
    dayStarts.add(sessionStartDay);
    dayStarts.add(sessionEndDay);
  }

  const dayArray = Array.from(dayStarts).filter((value) => Number.isFinite(value));
  const rangeStart = dayArray.length ? Math.min(...dayArray) : last7Start;
  const rangeEnd = dayArray.length ? Math.max(...dayArray) + 86400 : todayStart + 86400;
  const projectIds = costSettings.openAiProject ? [costSettings.openAiProject] : undefined;
  const models = collectModelsFromDebug(debugData);

  const costsResponse = await sendRuntimeMessage('GET_ORG_COSTS', {
    start_time: rangeStart,
    end_time: rangeEnd,
    bucket_width: '1d',
    group_by: ['project_id'],
    project_ids: projectIds
  });

  if (!costsResponse?.ok) {
    return {
      status: 'error',
      message: costsResponse?.message || 'Не удалось получить расходы OpenAI.',
      errorType: costsResponse?.errorType || 'request_failed'
    };
  }

  let usageResponse = null;
  if (costSettings.allocateRealCosts) {
    usageResponse = await sendRuntimeMessage('GET_ORG_USAGE', {
      start_time: rangeStart,
      end_time: rangeEnd,
      bucket_width: '1h',
      group_by: ['project_id', 'model'],
      project_ids: projectIds,
      models: models.length ? models : undefined
    });
  }

  return {
    status: 'ok',
    costs: costsResponse,
    usage: usageResponse,
    rangeStart,
    rangeEnd,
    sessionStart: Number.isFinite(sessionStart) ? sessionStart : null,
    sessionEnd: Number.isFinite(sessionStart) ? sessionEnd : null
  };
}

function renderEmpty(message) {
  metaEl.textContent = message;
  contextEl.innerHTML = '';
  entriesEl.innerHTML = '';
  renderSummary({
    items: [],
    contextStatus: 'pending',
    context: ''
  }, { showRealCosts: false, allocateRealCosts: false }, null, message);
}

function renderDebug(url, data, costSettings, orgMetrics) {
  const updatedAt = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ru-RU') : '—';
  metaEl.textContent = `URL: ${url} • Обновлено: ${updatedAt}`;
  renderSummary(data, costSettings, orgMetrics, '');

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
  const allocationState = buildAllocationState(costSettings, orgMetrics);
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
    const costInfo = buildBlockCostInfo(item, allocationState);
    const tokensLabel = formatTokenSummary(costInfo.tokenInfo);
    const allocatedLabel =
      Number.isFinite(costInfo.allocatedUsd) ? formatUsd(costInfo.allocatedUsd) : `— (${costInfo.reason})`;
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
        <div class="status-row status-row--metrics">
          <div class="status-group">
            <span class="status-label">Tokens in/out</span>
            <span>${escapeHtml(tokensLabel)}</span>
          </div>
          <div class="status-group">
            <span class="status-label">Allocated</span>
            <span>${escapeHtml(allocatedLabel)}</span>
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

function renderSummary(data, costSettings, orgMetrics, fallbackMessage = '') {
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
  const overallStatus = getOverallStatus({
    completed,
    inProgress,
    failed,
    total,
    contextStatus
  });
  const summaryLine = fallbackMessage
    ? `${fallbackMessage}`
    : `Контекст: ${STATUS_CONFIG[contextStatus]?.label || '—'} • Готово блоков: ${completed}/${total} • В работе: ${inProgress} • Ошибки: ${failed} • Запросов к ИИ: ${aiRequestCount} • Ответов ИИ: ${aiResponseCount}`;
  const costSummary = buildCostSummary(data, costSettings, orgMetrics);
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
    ${renderCostSummarySection(costSummary)}
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

function formatUsd(amount) {
  if (!Number.isFinite(amount)) return '—';
  return `$${amount.toFixed(4)}`;
}

function buildCostSummary(data, costSettings, orgMetrics) {
  if (!costSettings?.showRealCosts) {
    return {
      status: 'disabled',
      message: 'Показ реальных расходов выключен в настройках.'
    };
  }
  if (!orgMetrics) {
    return { status: 'pending', message: 'Загрузка расходов OpenAI...' };
  }
  if (orgMetrics.status !== 'ok') {
    return {
      status: 'error',
      message: orgMetrics.message || 'Не удалось получить расходы OpenAI.'
    };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const todayStart = getUtcDayStartSeconds(nowSec);
  const last7Start = todayStart - 6 * 86400;
  const costsByDay = buildCostsByDay(orgMetrics.costs?.buckets);
  let todayUsd = costsByDay.get(todayStart) ?? null;
  let last7Usd = null;
  let todayMessage = '';
  let last7Message = '';
  if (costsByDay.size === 0) {
    todayUsd = null;
    last7Usd = null;
    todayMessage = 'Нет данных Costs API.';
    last7Message = 'Нет данных Costs API.';
  } else if (!costsByDay.has(todayStart)) {
    todayMessage = `Нет расходов за ${getUtcDayLabel(todayStart)}.`;
  }
  if (costsByDay.size > 0) {
    last7Usd = 0;
    for (let day = last7Start; day <= todayStart; day += 86400) {
      last7Usd += costsByDay.get(day) || 0;
    }
  }

  let sessionUsd = null;
  let sessionMessage = '';
  if (orgMetrics.sessionStart && orgMetrics.usage?.ok && Array.isArray(orgMetrics.usage?.buckets)) {
    const usageBuckets = orgMetrics.usage.buckets;
    const usageByDay = buildUsageTotalsByDay(usageBuckets);
    const sessionStart = orgMetrics.sessionStart;
    const sessionEnd = orgMetrics.sessionEnd || nowSec;
    const sessionStartDay = getUtcDayStartSeconds(sessionStart);
    const sessionEndDay = getUtcDayStartSeconds(sessionEnd);
    sessionUsd = 0;
    for (let day = sessionStartDay; day <= sessionEndDay; day += 86400) {
      const dayStart = day;
      const dayEnd = day + 86400;
      const windowStart = Math.max(sessionStart, dayStart);
      const windowEnd = Math.min(sessionEnd, dayEnd);
      const sessionTokens = sumUsageTokensInRange(usageBuckets, windowStart, windowEnd);
      const dayTotals = usageByDay.get(dayStart);
      const daySpend = costsByDay.get(dayStart);
      if (!Number.isFinite(daySpend)) {
        sessionMessage = `Нет расходов за ${getUtcDayLabel(dayStart)}.`;
        continue;
      }
      const dayTotalTokens = dayTotals?.totalTokens || 0;
      if (!dayTotalTokens || !sessionTokens.totalTokens) {
        sessionMessage = 'Недостаточно usage-данных для расчёта сессии.';
        sessionUsd = null;
        break;
      }
      sessionUsd += daySpend * (sessionTokens.totalTokens / dayTotalTokens);
    }
  } else if (orgMetrics.sessionStart) {
    sessionMessage = costSettings.allocateRealCosts
      ? 'Нет usage-данных для распределения стоимости по сессии.'
      : 'Распределение по сессии выключено.';
  }

  return {
    status: 'ok',
    todayUsd,
    last7Usd,
    sessionUsd,
    sessionMessage,
    todayMessage,
    last7Message,
    updatedAt: orgMetrics.costs?.updatedAt || null,
    warning: orgMetrics.costs?.warning || null,
    usageWarning: orgMetrics.usage?.warning || null
  };
}

function renderCostSummarySection(costSummary) {
  const statusLabel = costSummary?.status === 'ok' ? '' : costSummary?.message || '';
  const updatedLabel = costSummary?.updatedAt
    ? new Date(costSummary.updatedAt).toLocaleString('ru-RU')
    : '—';
  const warningLines = [costSummary?.warning, costSummary?.usageWarning]
    .filter(Boolean)
    .map((warning) => `<div class="cost-warning">${escapeHtml(warning)}</div>`)
    .join('');
  if (costSummary?.status !== 'ok') {
    return `
      <div class="cost-summary">
        <div class="label">Расходы OpenAI (реальные)</div>
        <div class="cost-row">
          <span class="cost-label">Статус</span>
          <span class="cost-value">${escapeHtml(statusLabel || '—')}</span>
        </div>
      </div>
    `;
  }

  const todayLine =
    costSummary.todayUsd != null
      ? formatUsd(costSummary.todayUsd)
      : costSummary.todayMessage
        ? `— (${escapeHtml(costSummary.todayMessage)})`
        : '—';
  const last7Line =
    costSummary.last7Usd != null
      ? formatUsd(costSummary.last7Usd)
      : costSummary.last7Message
        ? `— (${escapeHtml(costSummary.last7Message)})`
        : '—';
  const sessionLine =
    costSummary.sessionUsd != null
      ? formatUsd(costSummary.sessionUsd)
      : costSummary.sessionMessage
        ? `— (${escapeHtml(costSummary.sessionMessage)})`
        : '—';

  return `
    <div class="cost-summary">
      <div class="label">Расходы OpenAI (реальные)</div>
      <div class="cost-row">
        <span class="cost-label">Сегодня (USD)</span>
        <span class="cost-value">${todayLine}</span>
      </div>
      <div class="cost-row">
        <span class="cost-label">Последние 7 дней</span>
        <span class="cost-value">${last7Line}</span>
      </div>
      <div class="cost-row">
        <span class="cost-label">Текущая сессия (allocated)</span>
        <span class="cost-value">${sessionLine}</span>
      </div>
      <div class="cost-meta">Обновлено: ${escapeHtml(updatedLabel)}</div>
      ${warningLines}
    </div>
  `;
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

function buildAllocationState(costSettings, orgMetrics) {
  if (!costSettings?.showRealCosts) {
    return { enabled: false, reason: 'Показ реальных расходов выключен.' };
  }
  if (!orgMetrics) {
    return { enabled: false, reason: 'Загрузка расходов OpenAI...' };
  }
  if (orgMetrics.status !== 'ok') {
    return { enabled: false, reason: orgMetrics.message || 'Расходы недоступны.' };
  }
  if (!costSettings.allocateRealCosts) {
    return { enabled: false, reason: 'Распределение расходов выключено.' };
  }
  if (!orgMetrics.usage?.ok) {
    return { enabled: false, reason: orgMetrics.usage?.message || 'Usage API недоступен.' };
  }
  const costsByDay = buildCostsByDay(orgMetrics.costs?.buckets);
  const usageByDay = buildUsageTotalsByDay(orgMetrics.usage?.buckets);
  return {
    enabled: true,
    costsByDay,
    usageByDay,
    usageBuckets: orgMetrics.usage?.buckets || []
  };
}

function buildBlockTokenInfo(item) {
  const translationTokens = collectTokensFromPayloads(item?.translationDebug);
  const proofreadTokens = collectTokensFromPayloads(item?.proofreadDebug);
  const inputTokens = translationTokens.inputTokens + proofreadTokens.inputTokens;
  const outputTokens = translationTokens.outputTokens + proofreadTokens.outputTokens;
  const hasBreakdown = translationTokens.hasBreakdown || proofreadTokens.hasBreakdown;
  const totalTokens = hasBreakdown
    ? inputTokens + outputTokens
    : translationTokens.totalTokens + proofreadTokens.totalTokens;
  return { inputTokens, outputTokens, totalTokens, hasBreakdown };
}

function formatTokenSummary(tokenInfo) {
  if (!tokenInfo) return '—';
  const input = Number.isFinite(tokenInfo.inputTokens) ? tokenInfo.inputTokens : 0;
  const output = Number.isFinite(tokenInfo.outputTokens) ? tokenInfo.outputTokens : 0;
  const total = Number.isFinite(tokenInfo.totalTokens) ? tokenInfo.totalTokens : 0;
  if (tokenInfo.hasBreakdown) {
    return `${input} in / ${output} out`;
  }
  if (total > 0) {
    return `— / — (total ${total})`;
  }
  return '—';
}

function buildBlockCostInfo(item, allocationState) {
  const tokenInfo = buildBlockTokenInfo(item);
  if (!allocationState?.enabled) {
    return { tokenInfo, allocatedUsd: null, reason: allocationState?.reason || 'Недоступно.' };
  }
  const completedAt = getEntryCompletedAt(item);
  if (!Number.isFinite(completedAt)) {
    return { tokenInfo, allocatedUsd: null, reason: 'Нет времени выполнения блока.' };
  }
  const dayStart = getUtcDayStartFromMs(completedAt);
  const daySpend = allocationState.costsByDay.get(dayStart);
  if (!Number.isFinite(daySpend)) {
    return { tokenInfo, allocatedUsd: null, reason: `Нет costs за ${getUtcDayLabel(dayStart)}.` };
  }
  const dayTotals = allocationState.usageByDay.get(dayStart);
  const dayTotalTokens = dayTotals?.totalTokens || 0;
  const blockTokens = tokenInfo.hasBreakdown
    ? tokenInfo.inputTokens + tokenInfo.outputTokens
    : tokenInfo.totalTokens;
  if (!dayTotalTokens || !blockTokens) {
    return { tokenInfo, allocatedUsd: null, reason: 'Недостаточно токенов для распределения.' };
  }
  return {
    tokenInfo,
    allocatedUsd: daySpend * (blockTokens / dayTotalTokens),
    reason: ''
  };
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
          <span>Billing Δ: ${escapeHtml(cost)}</span>
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
