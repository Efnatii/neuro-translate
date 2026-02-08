const apiKeyInput = document.getElementById('apiKey');
const translationModelListContainer = document.getElementById('translationModelList');
const contextModelListContainer = document.getElementById('contextModelList');
const proofreadModelListContainer = document.getElementById('proofreadModelList');
const translationModelCount = document.getElementById('translationModelCount');
const contextModelCount = document.getElementById('contextModelCount');
const proofreadModelCount = document.getElementById('proofreadModelCount');
const contextGenerationCheckbox = document.getElementById('contextGeneration');
const proofreadEnabledCheckbox = document.getElementById('proofreadEnabled');
const blockLengthLimitInput = document.getElementById('blockLengthLimit');
const blockLengthValueLabel = document.getElementById('blockLengthValue');
const statusLabel = document.getElementById('status');
const statusProgressBar = document.getElementById('statusProgress');
const statusProgressFill = document.getElementById('statusProgressFill');
const cancelButton = document.getElementById('cancel');
const translateButton = document.getElementById('translate');
const toggleTranslationButton = document.getElementById('toggleTranslation');
const openDebugButton = document.getElementById('openDebug');
const POPUP_PORT_NAME = 'popup';

let keySaveTimeout = null;
let activeTabId = null;
let translationVisible = false;
let canShowTranslation = false;
let currentTranslationStatus = null;
let temporaryStatusMessage = null;
let temporaryStatusTimeout = null;
let pendingFailureToken = 0;
let pendingFailureTimeoutId = null;
let popupPort = null;
let popupReconnectTimer = null;
let popupReconnectDelay = 500;

const models = buildModelOptions();
const defaultModelSpec = getDefaultModelSpec(models);
const modelRegistry = typeof getModelRegistry === 'function' ? getModelRegistry() : { entries: [], byKey: {} };

function buildModelOptions() {
  const formatPrice = (value) => {
    if (value == null || Number.isNaN(value)) return '—';
    const fixed = Number(value).toFixed(4);
    return fixed.replace(/\.?0+$/, '');
  };
  const registry = typeof getModelRegistry === 'function' ? getModelRegistry() : { entries: [] };
  const entries = Array.isArray(registry.entries) ? registry.entries : [];
  return entries
    .map((entry) => {
      const modelSpec = typeof formatModelSpec === 'function' ? formatModelSpec(entry.id, entry.tier) : `${entry.id}:${entry.tier}`;
      const inputLabel = formatPrice(entry.inputPrice);
      const cachedLabel = entry.cachedInputPrice != null ? formatPrice(entry.cachedInputPrice) : '—';
      const outputLabel = formatPrice(entry.outputPrice);
      const sumLabel = formatPrice(entry.sum_1M);
      return {
        id: entry.id,
        tier: entry.tier,
        spec: modelSpec,
        sum_1M: entry.sum_1M,
        sumLabel,
        inputLabel,
        cachedLabel,
        outputLabel
      };
    })
    .sort((left, right) => {
      if (left.tier !== right.tier) {
        return left.tier === 'flex' ? -1 : 1;
      }
      return (right.sum_1M || 0) - (left.sum_1M || 0);
    });
}

function getDefaultModelSpec(modelOptions) {
  const standardEntry = modelOptions.find((entry) => entry.tier === 'standard');
  return standardEntry?.spec || modelOptions[0]?.spec || '';
}

init();

async function init() {
  const tab = await getActiveTab();
  activeTabId = tab?.id || null;

  const state = await getState();
  try {
    chrome.runtime.sendMessage({
      type: 'SYNC_STATE_CACHE',
      state: {
        apiKey: state.apiKey,
        translationModel: state.translationModel,
        contextModel: state.contextModel,
        proofreadModel: state.proofreadModel,
        translationModelList: state.translationModelList,
        contextModelList: state.contextModelList,
        proofreadModelList: state.proofreadModelList,
        contextGenerationEnabled: state.contextGenerationEnabled,
        proofreadEnabled: state.proofreadEnabled,
        blockLengthLimit: state.blockLengthLimit,
        tpmLimitsByModel: state.tpmLimitsByModel,
        outputRatioByRole: state.outputRatioByRole,
        tpmSafetyBufferTokens: state.tpmSafetyBufferTokens
      }
    });
  } catch (error) {
    // Best-effort sync for Edge; ignore failures.
  }
  apiKeyInput.value = state.apiKey || '';
  renderModelChecklist(translationModelListContainer, state.translationModelList, () =>
    handleModelChecklistChange({
      container: translationModelListContainer,
      modelListKey: 'translationModelList',
      modelKey: 'translationModel',
      countLabel: translationModelCount,
      statusMessage: 'Модель для перевода сохранена.'
    })
  );
  renderModelChecklist(contextModelListContainer, state.contextModelList, () =>
    handleModelChecklistChange({
      container: contextModelListContainer,
      modelListKey: 'contextModelList',
      modelKey: 'contextModel',
      countLabel: contextModelCount,
      statusMessage: 'Модель для контекста сохранена.'
    })
  );
  renderModelChecklist(proofreadModelListContainer, state.proofreadModelList, () =>
    handleModelChecklistChange({
      container: proofreadModelListContainer,
      modelListKey: 'proofreadModelList',
      modelKey: 'proofreadModel',
      countLabel: proofreadModelCount,
      statusMessage: 'Модель для вычитки сохранена.'
    })
  );
  updateModelSummaryCount(translationModelListContainer, translationModelCount);
  updateModelSummaryCount(contextModelListContainer, contextModelCount);
  updateModelSummaryCount(proofreadModelListContainer, proofreadModelCount);
  renderContextGeneration(state.contextGenerationEnabled);
  renderProofreadEnabled(state.proofreadEnabled);
  renderBlockLengthLimit(state.blockLengthLimit);
  currentTranslationStatus = state.translationStatusByTab?.[activeTabId] || null;
  updateCanShowTranslation(currentTranslationStatus);
  renderStatus();
  renderTranslationVisibility(state.translationVisibilityByTab?.[activeTabId]);
  await syncTranslationVisibility();

  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  connectPopupPort();

  apiKeyInput.addEventListener('input', handleApiKeyChange);
  contextGenerationCheckbox.addEventListener('change', handleContextGenerationChange);
  proofreadEnabledCheckbox.addEventListener('change', handleProofreadEnabledChange);
  blockLengthLimitInput.addEventListener('input', handleBlockLengthLimitChange);
  blockLengthLimitInput.addEventListener('change', handleBlockLengthLimitCommit);
  cancelButton.addEventListener('click', sendCancel);
  translateButton.addEventListener('click', sendTranslateRequest);
  toggleTranslationButton.addEventListener('click', handleToggleTranslationVisibility);
  openDebugButton.addEventListener('click', handleOpenDebug);
}

function connectPopupPort() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
  if (popupPort) return;
  try {
    popupPort = chrome.runtime.connect({ name: POPUP_PORT_NAME });
  } catch (error) {
    schedulePopupReconnect();
    return;
  }
  popupReconnectDelay = 500;
  popupPort.onMessage.addListener((message) => {
    handleRuntimeMessage(message, {});
  });
  popupPort.onDisconnect.addListener(() => {
    popupPort = null;
    schedulePopupReconnect();
  });
}

function schedulePopupReconnect() {
  if (popupReconnectTimer) return;
  popupReconnectTimer = setTimeout(() => {
    popupReconnectTimer = null;
    connectPopupPort();
    popupReconnectDelay = Math.min(10000, Math.max(500, popupReconnectDelay * 2));
  }, popupReconnectDelay);
}

function handleApiKeyChange() {
  clearTimeout(keySaveTimeout);
  const apiKey = apiKeyInput.value.trim();
  keySaveTimeout = setTimeout(async () => {
    await chrome.storage.local.set({ apiKey });
    setTemporaryStatus('API ключ сохранён.');
  }, 300);
}

async function handleModelChecklistChange({ container, modelListKey, modelKey, countLabel, statusMessage }) {
  const modelList = getSelectedModelList(container);
  const selectedModel = parseModelSpec(modelList[0] || defaultModelSpec).id;
  await chrome.storage.local.set({ [modelListKey]: modelList, [modelKey]: selectedModel });
  updateModelSummaryCount(container, countLabel);
  if (modelKey === 'translationModel') {
    renderStatus();
  }
  setTemporaryStatus(statusMessage);
}

async function handleContextGenerationChange() {
  const contextGenerationEnabled = contextGenerationCheckbox.checked;
  await chrome.storage.local.set({ contextGenerationEnabled });
  setTemporaryStatus(
    contextGenerationEnabled ? 'Генерация контекста включена.' : 'Генерация контекста отключена.'
  );
}

async function handleProofreadEnabledChange() {
  const proofreadEnabled = proofreadEnabledCheckbox.checked;
  await chrome.storage.local.set({ proofreadEnabled });
  setTemporaryStatus(proofreadEnabled ? 'Вычитка перевода включена.' : 'Вычитка перевода отключена.');
}


async function handleBlockLengthLimitChange() {
  const blockLengthLimit = clampBlockLengthLimit(Number(blockLengthLimitInput.value));
  await chrome.storage.local.set({ blockLengthLimit });
  renderBlockLengthLimit(blockLengthLimit);
  await sendBlockLengthLimitUpdate(blockLengthLimit);
}

async function handleBlockLengthLimitCommit() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.reload(tab.id);
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
        'apiKey',
        'model',
        'translationModel',
        'contextModel',
        'proofreadModel',
        'translationModelList',
        'contextModelList',
        'proofreadModelList',
        'contextGenerationEnabled',
        'proofreadEnabled',
        'blockLengthLimit',
        'chunkLengthLimit',
        'translationStatusByTab',
        'translationVisibilityByTab',
        'tpmLimitsByModel',
        'outputRatioByRole',
        'tpmSafetyBufferTokens'
      ],
      (data) => {
        const defaultModel = parseModelSpec(defaultModelSpec).id;
        const normalizeModelList = (list, fallbackModel) => {
          const rawList = Array.isArray(list)
            ? list
            : typeof list === 'string'
              ? [list]
              : [];
          const normalized = [];
          rawList.forEach((modelSpec) => {
            if (!modelSpec || typeof modelSpec !== 'string' || modelSpec.startsWith('deepseek')) {
              return;
            }
            const parsed = parseModelSpec(modelSpec);
            if (!parsed.id) return;
            const normalizedSpec = formatModelSpec(parsed.id, parsed.tier);
            if (!modelRegistry.byKey?.[normalizedSpec]) {
              const fallbackSpec = formatModelSpec(parsed.id, 'standard');
              if (!modelRegistry.byKey?.[fallbackSpec]) return;
              if (!normalized.includes(fallbackSpec)) {
                normalized.push(fallbackSpec);
              }
              return;
            }
            if (!normalized.includes(normalizedSpec)) {
              normalized.push(normalizedSpec);
            }
          });
          if (!normalized.length && fallbackModel) {
            normalized.push(formatModelSpec(fallbackModel, 'standard'));
          }
          return normalized;
        };
        const areModelListsEqual = (left, right) => {
          if (!Array.isArray(left) || !Array.isArray(right)) return false;
          if (left.length !== right.length) return false;
          return left.every((value, index) => value === right[index]);
        };
        const storedTranslationModel = data.translationModel || data.model || defaultModel;
        const storedContextModel = data.contextModel || data.model || defaultModel;
        const storedProofreadModel = data.proofreadModel || data.model || defaultModel;
        const translationModelList = normalizeModelList(
          data.translationModelList || storedTranslationModel,
          defaultModel
        );
        const contextModelList = normalizeModelList(data.contextModelList || storedContextModel, defaultModel);
        const proofreadModelList = normalizeModelList(data.proofreadModelList || storedProofreadModel, defaultModel);
        const translationModel = parseModelSpec(translationModelList[0] || defaultModelSpec).id;
        const contextModel = parseModelSpec(contextModelList[0] || defaultModelSpec).id;
        const proofreadModel = parseModelSpec(proofreadModelList[0] || defaultModelSpec).id;
        if (
          translationModel !== storedTranslationModel ||
          contextModel !== storedContextModel ||
          proofreadModel !== storedProofreadModel ||
          !areModelListsEqual(data.translationModelList, translationModelList) ||
          !areModelListsEqual(data.contextModelList, contextModelList) ||
          !areModelListsEqual(data.proofreadModelList, proofreadModelList)
        ) {
          chrome.storage.local.set({
            translationModel,
            contextModel,
            proofreadModel,
            translationModelList,
            contextModelList,
            proofreadModelList
          });
        }
        resolve({
          apiKey: data.apiKey || '',
          translationModel,
          contextModel,
          proofreadModel,
          translationModelList,
          contextModelList,
          proofreadModelList,
          contextGenerationEnabled: data.contextGenerationEnabled,
          proofreadEnabled: data.proofreadEnabled,
          blockLengthLimit: data.blockLengthLimit ?? data.chunkLengthLimit,
          translationStatusByTab: data.translationStatusByTab || {},
          translationVisibilityByTab: data.translationVisibilityByTab || {},
          tpmLimitsByModel: data.tpmLimitsByModel || {},
          outputRatioByRole: data.outputRatioByRole || {},
          tpmSafetyBufferTokens: data.tpmSafetyBufferTokens
        });
      }
    );
  });
}

function renderModelChecklist(container, selectedList, onChange) {
  const defaultModel = defaultModelSpec;
  const normalizedList = Array.isArray(selectedList)
    ? selectedList
    : typeof selectedList === 'string'
      ? [selectedList]
      : [];
  const selected = normalizedList.length ? normalizedList : [defaultModel];

  if (!container) return;
  container.innerHTML = '';

  const filterWrapper = document.createElement('div');
  filterWrapper.className = 'model-filter';
  const filterInput = document.createElement('input');
  filterInput.type = 'text';
  filterInput.placeholder = 'Поиск модели…';
  filterInput.dataset.modelFilter = 'true';
  filterWrapper.appendChild(filterInput);
  container.appendChild(filterWrapper);

  const tierGroups = {
    flex: models.filter((model) => model.tier === 'flex'),
    standard: models.filter((model) => model.tier === 'standard')
  };

  Object.entries(tierGroups).forEach(([tier, entries]) => {
    if (!entries.length) return;
    const group = document.createElement('details');
    group.className = 'model-tier';
    group.dataset.modelTier = tier;
    group.open = true;
    const summary = document.createElement('summary');
    const summaryLabel = document.createElement('span');
    summaryLabel.dataset.modelTierLabel = tier;
    summary.appendChild(summaryLabel);
    group.appendChild(summary);
    const actions = document.createElement('div');
    actions.className = 'model-tier-actions';
    const selectAllButton = document.createElement('button');
    selectAllButton.type = 'button';
    selectAllButton.textContent = 'Выбрать все';
    const clearAllButton = document.createElement('button');
    clearAllButton.type = 'button';
    clearAllButton.textContent = 'Снять все';
    actions.appendChild(selectAllButton);
    actions.appendChild(clearAllButton);
    group.appendChild(actions);
    const list = document.createElement('div');
    list.className = 'model-options';
    entries.forEach((model) => {
      const itemLabel = document.createElement('label');
      itemLabel.className = 'model-option';
      itemLabel.dataset.modelId = model.id.toLowerCase();
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.modelSpec = model.spec;
      checkbox.checked = selected.includes(model.spec);
      checkbox.addEventListener('change', () => {
        if (typeof onChange === 'function') {
          onChange();
        }
      });
      const modelId = document.createElement('span');
      modelId.className = 'model-id';
      modelId.textContent = model.id;
      const price = document.createElement('span');
      price.className = 'model-price';
      price.textContent = `Σ1M: ${model.sumLabel}`;
      const info = document.createElement('span');
      info.className = 'model-info';
      info.textContent = 'i';
      info.title = `Input: ${model.inputLabel} / Cached: ${model.cachedLabel} / Output: ${model.outputLabel}`;
      itemLabel.appendChild(checkbox);
      itemLabel.appendChild(modelId);
      itemLabel.appendChild(price);
      itemLabel.appendChild(info);
      list.appendChild(itemLabel);
    });
    group.appendChild(list);
    container.appendChild(group);

    selectAllButton.addEventListener('click', () => {
      const checkboxes = [...group.querySelectorAll('input[type="checkbox"][data-model-spec]')];
      let changed = false;
      checkboxes.forEach((box) => {
        if (!box.checked) {
          box.checked = true;
          changed = true;
        }
      });
      if (changed && typeof onChange === 'function') {
        onChange();
      } else {
        updateModelSummaryCount(container, null);
      }
    });

    clearAllButton.addEventListener('click', () => {
      const checkboxes = [...group.querySelectorAll('input[type="checkbox"][data-model-spec]')];
      let changed = false;
      checkboxes.forEach((box) => {
        if (box.checked) {
          box.checked = false;
          changed = true;
        }
      });
      if (changed && typeof onChange === 'function') {
        onChange();
      } else {
        updateModelSummaryCount(container, null);
      }
    });
  });

  const applyFilter = () => {
    const query = filterInput.value.trim().toLowerCase();
    const items = [...container.querySelectorAll('.model-option[data-model-id]')];
    items.forEach((item) => {
      const modelId = item.dataset.modelId || '';
      const match = !query || modelId.includes(query);
      item.classList.toggle('is-hidden', !match);
    });
  };
  filterInput.addEventListener('input', applyFilter);

  updateModelSummaryCount(container, null);
}

function getSelectedModelList(container) {
  if (!container) return [defaultModelSpec];
  const checkboxes = [...container.querySelectorAll('input[type="checkbox"][data-model-spec]')];
  const selected = checkboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.dataset.modelSpec)
    .filter(Boolean);
  if (!selected.length && defaultModelSpec) {
    const fallback = checkboxes.find((checkbox) => checkbox.dataset.modelSpec === defaultModelSpec);
    if (fallback) fallback.checked = true;
    selected.push(defaultModelSpec);
  }
  return selected;
}

function updateModelSummaryCount(container, countLabel) {
  if (!container) return;
  const checkboxes = [...container.querySelectorAll('input[type="checkbox"][data-model-spec]')];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  const label = `(выбрано ${selectedCount})`;
  if (countLabel) {
    countLabel.textContent = label;
  }
  const groups = [...container.querySelectorAll('[data-model-tier]')];
  groups.forEach((group) => {
    const tier = group.dataset.modelTier || '';
    const tierCheckboxes = [...group.querySelectorAll('input[type="checkbox"][data-model-spec]')];
    const tierCount = tierCheckboxes.filter((checkbox) => checkbox.checked).length;
    const totalCount = tierCheckboxes.length;
    const summaryLabel = group.querySelector('[data-model-tier-label]');
    if (summaryLabel) {
      summaryLabel.textContent = `${tier.toUpperCase()} (выбрано ${tierCount} / всего ${totalCount})`;
    }
  });
}

function renderContextGeneration(enabled) {
  contextGenerationCheckbox.checked = Boolean(enabled);
}

function renderProofreadEnabled(enabled) {
  proofreadEnabledCheckbox.checked = Boolean(enabled);
}


function renderBlockLengthLimit(limit) {
  const fallback = Number(blockLengthLimitInput.min) || 600;
  const parsed = Number(limit);
  const normalized = clampBlockLengthLimit(Number.isFinite(parsed) ? parsed : fallback);
  blockLengthLimitInput.value = String(normalized);
  blockLengthValueLabel.textContent = String(normalized);
}

function clampBlockLengthLimit(value) {
  const min = Number(blockLengthLimitInput.min) || 0;
  const max = Number(blockLengthLimitInput.max) || Number.POSITIVE_INFINITY;
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getMessageFailureStatus(result) {
  if (!result || result.ok) return '';
  switch (result.reason) {
    case 'unsupported-url':
      return 'Перевод недоступен на этой странице.';
    case 'tab-not-ready':
      return 'Страница ещё загружается. Попробуйте снова через пару секунд.';
    case 'content-script-unavailable':
      return 'Не удалось подключиться к странице. Перезагрузите вкладку.';
    case 'inject-failed':
      return 'Не удалось подключиться к странице. Проверьте права расширения.';
    default:
      return 'Не удалось связаться со страницей.';
  }
}

function scheduleFailureStatus(message, delayMs = 750) {
  pendingFailureToken += 1;
  const token = pendingFailureToken;
  clearTimeout(pendingFailureTimeoutId);
  pendingFailureTimeoutId = setTimeout(() => {
    if (token !== pendingFailureToken) return;
    setTemporaryStatus(message, 2500);
  }, delayMs);
}

function cancelScheduledFailure() {
  pendingFailureToken += 1;
  clearTimeout(pendingFailureTimeoutId);
  pendingFailureTimeoutId = null;
}

async function sendMessageToActiveTabSafe(message, options = {}) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return { ok: false, reason: 'tab-not-found' };
  }
  return sendMessageToTabSafe(tab, message, options);
}

async function ensureActiveTabConnection() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    return { ok: false, reason: 'tab-not-found' };
  }
  if (!isSupportedTabUrl(tab.url)) {
    return { ok: false, reason: 'unsupported-url' };
  }
  setTemporaryStatus('Подключение...', 0);
  const connected = await ensureConnected(tab.id, {
    pingTimeoutMs: 700,
    retryCount: 2,
    retryDelayMs: 250,
    useBackgroundInjection: true
  });
  if (!connected.ok) {
    return { ok: false, reason: connected.reason || 'content-script-unavailable' };
  }
  cancelScheduledFailure();
  return { ok: true, tab };
}

async function sendCancel() {
  const connection = await ensureActiveTabConnection();
  if (!connection.ok) {
    scheduleFailureStatus(getMessageFailureStatus(connection));
    return;
  }
  const result = await sendMessageToTabSafe(connection.tab, { type: 'CANCEL_TRANSLATION' }, {
    skipEnsureConnection: true
  });
  if (!result.ok) {
    scheduleFailureStatus(getMessageFailureStatus(result));
    return;
  }
  cancelScheduledFailure();
  setTemporaryStatus('Отменяем перевод...');
}

async function sendTranslateRequest() {
  const connection = await ensureActiveTabConnection();
  if (!connection.ok) {
    scheduleFailureStatus(getMessageFailureStatus(connection));
    return;
  }
  const result = await sendMessageToTabSafe(connection.tab, { type: 'START_TRANSLATION' }, {
    skipEnsureConnection: true
  });
  if (!result.ok) {
    scheduleFailureStatus(getMessageFailureStatus(result));
    return;
  }
  cancelScheduledFailure();
  updateTranslationVisibility(true);
  updateTranslationVisibilityStorage(true);
  setTemporaryStatus('Запускаем перевод страницы...');
}

async function handleToggleTranslationVisibility() {
  const connection = await ensureActiveTabConnection();
  if (!connection.ok) {
    scheduleFailureStatus(getMessageFailureStatus(connection));
    return;
  }
  const tab = connection.tab;
  const visibilityInfo = await getTranslationVisibilityFromPage(tab);
  const currentVisible =
    visibilityInfo && typeof visibilityInfo.visible === 'boolean' ? visibilityInfo.visible : translationVisible;
  const nextVisible = !currentVisible;
  if (nextVisible && !canShowTranslation && visibilityInfo?.hasTranslations === false) {
    setTemporaryStatus('Сначала переведите хотя бы один блок.');
    return;
  }
  const result = await sendMessageToTabSafe(tab, {
    type: 'SET_TRANSLATION_VISIBILITY',
    visible: nextVisible
  }, { skipEnsureConnection: true });
  if (!result.ok) {
    scheduleFailureStatus(getMessageFailureStatus(result));
    return;
  }
  cancelScheduledFailure();
  updateTranslationVisibility(nextVisible);
  updateTranslationVisibilityStorage(nextVisible);
  setTemporaryStatus(nextVisible ? 'Показываем перевод.' : 'Показываем оригинал.');
}

function handleStorageChange(changes) {
  if (changes.translationStatusByTab) {
    cancelScheduledFailure();
    const nextStatuses = changes.translationStatusByTab.newValue || {};
    currentTranslationStatus = activeTabId ? nextStatuses[activeTabId] : null;
    updateCanShowTranslation(currentTranslationStatus);
    renderStatus();
  }
  if (changes.translationVisibilityByTab) {
    cancelScheduledFailure();
    const nextVisibility = changes.translationVisibilityByTab.newValue || {};
    renderTranslationVisibility(activeTabId ? nextVisibility[activeTabId] : false);
  }
}

async function handleRuntimeMessage(message, sender) {
  if (!message?.type) {
    return;
  }
  if (message.type === 'TRANSLATION_CANCELLED') {
    if (typeof message.tabId === 'number' && activeTabId && message.tabId !== activeTabId) {
      return;
    }
    cancelScheduledFailure();
    if (typeof message.tabId === 'number') {
      await handleTranslationCancelled(message.tabId);
    }
    return;
  }
  if (message.type === 'UPDATE_TRANSLATION_VISIBILITY') {
    if (activeTabId && sender?.tab?.id && sender.tab.id !== activeTabId) {
      return;
    }
    cancelScheduledFailure();
    renderTranslationVisibility(Boolean(message.visible));
    return;
  }
  if (message.type !== 'TRANSLATION_VISIBILITY_CHANGED') {
    return;
  }
  if (activeTabId && typeof message.tabId === 'number' && message.tabId !== activeTabId) {
    return;
  }
  cancelScheduledFailure();
  renderTranslationVisibility(Boolean(message.visible));
}

async function handleTranslationCancelled(tabId) {
  await clearTranslationStatus(tabId);
  updateTranslationVisibility(false);
  await updateTranslationVisibilityStorage(false);
  setTemporaryStatus('Перевод для этой страницы отменён.');
  await chrome.tabs.reload(tabId);
}

function renderStatus() {
  if (!statusLabel) {
    return;
  }
  const baseMessage = getBaseStatusMessage();
  statusLabel.textContent = baseMessage;
  renderProgressBar();
}

function getBaseStatusMessage() {
  if (temporaryStatusMessage) {
    return temporaryStatusMessage;
  }
  return formatTranslationStatus(currentTranslationStatus);
}

function formatTranslationStatus(status) {
  const defaultText = 'Статус: перевод не выполняется.';
  if (!status) {
    return defaultText;
  }

  const completedBlocks = status.completedBlocks ?? status.completedChunks ?? 0;
  const totalBlocks = status.totalBlocks ?? status.totalChunks ?? 0;
  const inProgressBlocks = status.inProgressBlocks ?? status.inProgressChunks ?? 0;
  const { message } = status;
  if (!message) {
    return defaultText;
  }
  if (!totalBlocks) {
    return message;
  }
  return `${message} ${completedBlocks}(+${inProgressBlocks}) из ${totalBlocks}`;
}

function updateCanShowTranslation(status) {
  const completedBlocks = status?.completedBlocks ?? status?.completedChunks ?? 0;
  canShowTranslation = completedBlocks > 0;
}

function renderProgressBar() {
  if (!statusProgressFill || !statusProgressBar) return;
  const { percent, label } = getProgressInfo(currentTranslationStatus);
  statusProgressFill.style.width = `${percent}%`;
  statusProgressBar.setAttribute('aria-valuenow', String(percent));
  if (label) {
    statusProgressBar.setAttribute('aria-label', label);
    statusProgressBar.title = label;
  }
}

function getProgressInfo(status) {
  if (!status) {
    return { percent: 0, label: 'Прогресс: 0%' };
  }
  const completedBlocks = status.completedBlocks ?? status.completedChunks ?? 0;
  const inProgressBlocks = status.inProgressBlocks ?? status.inProgressChunks ?? 0;
  const totalBlocks = status.totalBlocks ?? status.totalChunks ?? 0;
  if (!totalBlocks) {
    return { percent: 0, label: 'Прогресс: 0%' };
  }
  const current = Math.min(totalBlocks, completedBlocks + inProgressBlocks);
  const percent = Math.max(0, Math.min(100, Math.round((current / totalBlocks) * 100)));
  return { percent, label: `Прогресс: ${percent}%` };
}

function setTemporaryStatus(message, durationMs = 2500) {
  temporaryStatusMessage = message;
  renderStatus();
  clearTimeout(temporaryStatusTimeout);
  if (durationMs <= 0) return;
  temporaryStatusTimeout = setTimeout(() => {
    temporaryStatusMessage = null;
    renderStatus();
  }, durationMs);
}

function renderTranslationVisibility(visible) {
  updateTranslationVisibility(Boolean(visible));
}

async function syncTranslationVisibility() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const visibilityInfo = await getTranslationVisibilityFromPage(tab);
  if (visibilityInfo && typeof visibilityInfo.visible === 'boolean') {
    updateTranslationVisibility(visibilityInfo.visible);
    updateTranslationVisibilityStorage(visibilityInfo.visible);
  }
}

async function getTranslationVisibilityFromPage(tab) {
  const result = await sendMessageToTabSafe(tab, { type: 'GET_TRANSLATION_VISIBILITY' }, { expectResponse: true });
  if (!result.ok) {
    return null;
  }
  return result.response;
}

function updateTranslationVisibility(visible) {
  translationVisible = visible;
  const label = translationVisible ? 'Показать оригинал' : 'Показать перевод';
  const labelNode = toggleTranslationButton.querySelector('.sr-only');
  if (labelNode) {
    labelNode.textContent = label;
  }
  toggleTranslationButton.setAttribute('aria-pressed', translationVisible ? 'true' : 'false');
  toggleTranslationButton.setAttribute('aria-label', label);
  toggleTranslationButton.title = label;
}

async function updateTranslationVisibilityStorage(visible) {
  if (!activeTabId) return;
  const { translationVisibilityByTab = {} } = await chrome.storage.local.get({ translationVisibilityByTab: {} });
  translationVisibilityByTab[activeTabId] = visible;
  await chrome.storage.local.set({ translationVisibilityByTab });
}

async function clearTranslationStatus(tabId) {
  const { translationStatusByTab = {} } = await chrome.storage.local.get({ translationStatusByTab: {} });
  delete translationStatusByTab[tabId];
  await chrome.storage.local.set({ translationStatusByTab });
  if (activeTabId === tabId) {
    currentTranslationStatus = null;
    updateCanShowTranslation(currentTranslationStatus);
    renderStatus();
  }
}

async function clearTranslationStorage(url) {
  if (!url) return;
  const { pageTranslations = {} } = await chrome.storage.local.get({ pageTranslations: {} });
  if (pageTranslations[url]) {
    delete pageTranslations[url];
    await chrome.storage.local.set({ pageTranslations });
  }
}

async function handleOpenDebug() {
  const tab = await getActiveTab();
  if (!tab?.url) {
    const fallbackUrl = chrome.runtime.getURL('debug.html');
    await chrome.tabs.create({ url: fallbackUrl });
    return;
  }
  const debugUrl = chrome.runtime.getURL(`debug.html?source=${encodeURIComponent(tab.url)}`);
  await chrome.tabs.create({ url: debugUrl });
}

async function sendBlockLengthLimitUpdate(blockLengthLimit) {
  const connection = await ensureActiveTabConnection();
  if (!connection.ok) {
    scheduleFailureStatus(getMessageFailureStatus(connection));
    return;
  }
  const result = await sendMessageToTabSafe(connection.tab, {
    type: 'RECALCULATE_BLOCKS',
    blockLengthLimit
  }, { expectResponse: true, skipEnsureConnection: true });
  if (!result.ok) {
    scheduleFailureStatus(getMessageFailureStatus(result));
    return;
  }
  cancelScheduledFailure();
  setTemporaryStatus(`Максимальная длина блока: ${blockLengthLimit} символов.`);
  const response = result.response;
  if (response?.updated && typeof response.totalBlocks === 'number') {
    const nextStatus = {
      completedBlocks: 0,
      totalBlocks: response.totalBlocks,
      inProgressBlocks: 0,
      message: response.message || 'Готово к переводу',
      timestamp: Date.now()
    };
    currentTranslationStatus = nextStatus;
    updateCanShowTranslation(currentTranslationStatus);
    renderStatus();
    if (activeTabId) {
      const { translationStatusByTab = {} } = await chrome.storage.local.get({ translationStatusByTab: {} });
      translationStatusByTab[activeTabId] = nextStatus;
      await chrome.storage.local.set({ translationStatusByTab });
    }
  }
}
