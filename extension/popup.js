const apiKeyInput = document.getElementById('apiKey');
const translationModelSelect = document.getElementById('translationModel');
const contextModelSelect = document.getElementById('contextModel');
const proofreadModelSelect = document.getElementById('proofreadModel');
const contextGenerationCheckbox = document.getElementById('contextGeneration');
const proofreadEnabledCheckbox = document.getElementById('proofreadEnabled');
const blockLengthLimitInput = document.getElementById('blockLengthLimit');
const blockLengthValueLabel = document.getElementById('blockLengthValue');
const statusLabel = document.getElementById('status');
const statusProgressBar = document.getElementById('statusProgress');
const statusProgressFill = document.getElementById('statusProgressFill');
const translationThroughputLabel = document.getElementById('translationThroughput');
const contextThroughputLabel = document.getElementById('contextThroughput');
const proofreadThroughputLabel = document.getElementById('proofreadThroughput');

const cancelButton = document.getElementById('cancel');
const translateButton = document.getElementById('translate');
const toggleTranslationButton = document.getElementById('toggleTranslation');
const openDebugButton = document.getElementById('openDebug');

let keySaveTimeout = null;
let activeTabId = null;
let translationVisible = false;
let canShowTranslation = false;
let currentTranslationStatus = null;
let currentThroughputByRole = {
  translation: null,
  context: null,
  proofread: null
};
let currentTranslationModelId = null;
let currentContextModelId = null;
let currentProofreadModelId = null;
let temporaryStatusMessage = null;
let temporaryStatusTimeout = null;
let pendingFailureToken = 0;
let pendingFailureTimeoutId = null;

const models = [
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', price: 0.45 },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', price: 0.5 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', price: 0.75 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', price: 2 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', price: 2.25 },
  { id: 'gpt-4.1', name: 'GPT-4.1', price: 10 },
  { id: 'gpt-5.1', name: 'GPT-5.1', price: 11.25 },
  { id: 'gpt-5', name: 'GPT-5', price: 11.25 },
  { id: 'gpt-5.1-chat-latest', name: 'GPT-5.1 Chat Latest', price: 11.25 },
  { id: 'gpt-5-chat-latest', name: 'GPT-5 Chat Latest', price: 11.25 },
  { id: 'gpt-4o', name: 'GPT-4o', price: 12.5 },
  { id: 'gpt-5.2', name: 'GPT-5.2', price: 15.75 },
  { id: 'gpt-5.2-chat-latest', name: 'GPT-5.2 Chat Latest', price: 15.75 },
  { id: 'gpt-4o-2024-05-13', name: 'GPT-4o (2024-05-13)', price: 20 }
].sort((a, b) => a.price - b.price);

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
        contextGenerationEnabled: state.contextGenerationEnabled,
        proofreadEnabled: state.proofreadEnabled,
        blockLengthLimit: state.blockLengthLimit,
        tpmLimitsByModel: state.tpmLimitsByModel,
        outputRatioByRole: state.outputRatioByRole,
        tpmSafetyBufferTokens: state.tpmSafetyBufferTokens,
        modelThroughputById: state.modelThroughputById
      }
    });
  } catch (error) {
    // Best-effort sync for Edge; ignore failures.
  }
  apiKeyInput.value = state.apiKey || '';
  renderModelOptions(translationModelSelect, state.translationModel);
  renderModelOptions(contextModelSelect, state.contextModel);
  renderModelOptions(proofreadModelSelect, state.proofreadModel);
  currentTranslationModelId = translationModelSelect.value;
  currentContextModelId = contextModelSelect.value;
  currentProofreadModelId = proofreadModelSelect.value;
  currentThroughputByRole = {
    translation: state.modelThroughputById?.[currentTranslationModelId] || null,
    context: state.modelThroughputById?.[currentContextModelId] || null,
    proofread: state.modelThroughputById?.[currentProofreadModelId] || null
  };
  renderContextGeneration(state.contextGenerationEnabled);
  renderProofreadEnabled(state.proofreadEnabled);
  renderBlockLengthLimit(state.blockLengthLimit);
  currentTranslationStatus = state.translationStatusByTab?.[activeTabId] || null;
  updateCanShowTranslation(currentTranslationStatus);
  renderStatus();
  renderThroughputStatuses();
  renderTranslationVisibility(state.translationVisibilityByTab?.[activeTabId]);
  await syncTranslationVisibility();

  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  apiKeyInput.addEventListener('input', handleApiKeyChange);
  translationModelSelect.addEventListener('change', handleTranslationModelChange);
  contextModelSelect.addEventListener('change', handleContextModelChange);
  proofreadModelSelect.addEventListener('change', handleProofreadModelChange);
  contextGenerationCheckbox.addEventListener('change', handleContextGenerationChange);
  proofreadEnabledCheckbox.addEventListener('change', handleProofreadEnabledChange);
  blockLengthLimitInput.addEventListener('input', handleBlockLengthLimitChange);
  blockLengthLimitInput.addEventListener('change', handleBlockLengthLimitCommit);
  cancelButton.addEventListener('click', sendCancel);
  translateButton.addEventListener('click', sendTranslateRequest);
  toggleTranslationButton.addEventListener('click', handleToggleTranslationVisibility);
  openDebugButton.addEventListener('click', handleOpenDebug);
}

function handleApiKeyChange() {
  clearTimeout(keySaveTimeout);
  const apiKey = apiKeyInput.value.trim();
  keySaveTimeout = setTimeout(async () => {
    await chrome.storage.local.set({ apiKey });
    setTemporaryStatus('API ключ сохранён.');
  }, 300);
}

async function handleTranslationModelChange() {
  const translationModel = translationModelSelect.value;
  await chrome.storage.local.set({ translationModel });
  currentTranslationModelId = translationModel;
  const { modelThroughputById = {} } = await chrome.storage.local.get({ modelThroughputById: {} });
  currentThroughputByRole.translation = modelThroughputById[translationModel] || null;
  renderStatus();
  renderThroughputStatuses();
  setTemporaryStatus('Модель для перевода сохранена.');
  runModelThroughputTest(translationModel, 'translation');
}

async function handleContextModelChange() {
  const contextModel = contextModelSelect.value;
  await chrome.storage.local.set({ contextModel });
  currentContextModelId = contextModel;
  const { modelThroughputById = {} } = await chrome.storage.local.get({ modelThroughputById: {} });
  currentThroughputByRole.context = modelThroughputById[contextModel] || null;
  renderThroughputStatuses();
  setTemporaryStatus('Модель для контекста сохранена.');
  runModelThroughputTest(contextModel, 'context');
}

async function handleProofreadModelChange() {
  const proofreadModel = proofreadModelSelect.value;
  await chrome.storage.local.set({ proofreadModel });
  currentProofreadModelId = proofreadModel;
  const { modelThroughputById = {} } = await chrome.storage.local.get({ modelThroughputById: {} });
  currentThroughputByRole.proofread = modelThroughputById[proofreadModel] || null;
  renderThroughputStatuses();
  setTemporaryStatus('Модель для вычитки сохранена.');
  runModelThroughputTest(proofreadModel, 'proofread');
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
        'contextGenerationEnabled',
        'proofreadEnabled',
        'blockLengthLimit',
        'chunkLengthLimit',
        'translationStatusByTab',
        'translationVisibilityByTab',
        'modelThroughputById',
        'tpmLimitsByModel',
        'outputRatioByRole',
        'tpmSafetyBufferTokens'
      ],
      (data) => {
      const defaultModel = models[0]?.id;
      const normalizeModel = (model) => {
        if (!model || model.startsWith('deepseek')) {
          return defaultModel;
        }
        return models.some((entry) => entry.id === model) ? model : defaultModel;
      };
      const storedTranslationModel = data.translationModel || data.model;
      const storedContextModel = data.contextModel || data.model;
      const storedProofreadModel = data.proofreadModel || data.model;
      const translationModel = normalizeModel(storedTranslationModel);
      const contextModel = normalizeModel(storedContextModel);
      const proofreadModel = normalizeModel(storedProofreadModel);
      if (
        translationModel !== storedTranslationModel ||
        contextModel !== storedContextModel ||
        proofreadModel !== storedProofreadModel
      ) {
        chrome.storage.local.set({ translationModel, contextModel, proofreadModel });
      }
      resolve({
        apiKey: data.apiKey || '',
        translationModel,
        contextModel,
        proofreadModel,
        contextGenerationEnabled: data.contextGenerationEnabled,
        proofreadEnabled: data.proofreadEnabled,
        blockLengthLimit: data.blockLengthLimit ?? data.chunkLengthLimit,
        translationStatusByTab: data.translationStatusByTab || {},
        translationVisibilityByTab: data.translationVisibilityByTab || {},
        modelThroughputById: data.modelThroughputById || {},
        tpmLimitsByModel: data.tpmLimitsByModel || {},
        outputRatioByRole: data.outputRatioByRole || {},
        tpmSafetyBufferTokens: data.tpmSafetyBufferTokens
      });
    });
  });
}

function renderModelOptions(select, selected) {
  const defaultModel = models[0]?.id;
  const currentModel = selected || defaultModel;

  select.innerHTML = '';

  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.name} ($${model.price}/1M токенов)`;
    option.selected = model.id === currentModel;
    select.appendChild(option);
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

function runModelThroughputTest(model, role) {
  if (!model) return;
  const roleLabel = getRoleLabel(role);
  const statusMessage = roleLabel
    ? `Запускаем тест пропускной способности (${roleLabel})...`
    : 'Запускаем тест пропускной способности...';
  setTemporaryStatus(statusMessage);
  chrome.runtime.sendMessage({ type: 'RUN_MODEL_THROUGHPUT_TEST', model }, (response) => {
    if (response?.success) {
      if (role) {
        currentThroughputByRole[role] = response.result || null;
      }
      renderThroughputStatuses();
      setTemporaryStatus('Тест пропускной способности завершён.', 2000);
      return;
    }
    const error = response?.error || 'Не удалось выполнить тест';
    if (role) {
      currentThroughputByRole[role] = { success: false, error, timestamp: Date.now() };
    }
    renderThroughputStatuses();
    setTemporaryStatus('Тест пропускной способности не удался.', 3000);
  });
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
  if (changes.modelThroughputById) {
    const nextThroughput = changes.modelThroughputById.newValue || {};
    currentThroughputByRole = {
      translation: currentTranslationModelId ? nextThroughput[currentTranslationModelId] : null,
      context: currentContextModelId ? nextThroughput[currentContextModelId] : null,
      proofread: currentProofreadModelId ? nextThroughput[currentProofreadModelId] : null
    };
    renderThroughputStatuses();
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

function formatThroughputStatus(info) {
  if (!info) return '';
  if (info.success === false) {
    const errorText = info.error ? ` (${info.error})` : '';
    return `Тест пропускной способности: ошибка${errorText}`;
  }
  if (!info.tokensPerSecond || !info.durationMs) return '';
  const tokensPerSecond = Number(info.tokensPerSecond).toFixed(1);
  const durationSeconds = (info.durationMs / 1000).toFixed(1);
  return `Пропускная способность: ${tokensPerSecond} ток/с • ${durationSeconds}с`;
}

function renderThroughputStatuses() {
  updateThroughputLabel(translationThroughputLabel, currentThroughputByRole.translation);
  updateThroughputLabel(contextThroughputLabel, currentThroughputByRole.context);
  updateThroughputLabel(proofreadThroughputLabel, currentThroughputByRole.proofread);
}

function updateThroughputLabel(label, info) {
  if (!label) return;
  if (!info) {
    label.textContent = 'Тест не запускался';
    return;
  }
  label.textContent = formatThroughputStatus(info) || 'Тест не запускался';
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

function getRoleLabel(role) {
  if (role === 'translation') return 'перевод';
  if (role === 'context') return 'контекст';
  if (role === 'proofread') return 'вычитка';
  return '';
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
