const apiKeyInput = document.getElementById('apiKey');
const deepseekApiKeyInput = document.getElementById('deepseekApiKey');
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
let deepseekKeySaveTimeout = null;
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
let debugEnabled = false;

const logDebug = createDebugLogger('popup', () => debugEnabled);
const storageLocalGet = (keys) => chromeApi.storageGet('local', keys);
const storageLocalSet = (items) => chromeApi.storageSet('local', items);
const tabsQuery = (query) => chromeApi.tabsQuery(query);
const tabsReload = (tabId) => chromeApi.tabsReload(tabId);
const tabsCreate = (createProperties) => chromeApi.tabsCreate(createProperties);
const executeScript = (details) => chromeApi.executeScript(details);
const runtimeSendMessageSafe = (payload) => chromeApi.sendMessageSafe(payload);

const models = [
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', price: 0.45 },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', price: 0.5 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', price: 0.75 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', price: 2 },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', price: 0.7 },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', price: 0.7 },
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
  debugEnabled = Boolean(state.debug);
  apiKeyInput.value = state.apiKey || '';
  deepseekApiKeyInput.value = state.deepseekApiKey || '';
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
  deepseekApiKeyInput.addEventListener('input', handleDeepseekApiKeyChange);
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
    await storageLocalSet({ apiKey });
    setTemporaryStatus('API ключ сохранён.');
  }, 300);
}

function handleDeepseekApiKeyChange() {
  clearTimeout(deepseekKeySaveTimeout);
  const deepseekApiKey = deepseekApiKeyInput.value.trim();
  deepseekKeySaveTimeout = setTimeout(async () => {
    await storageLocalSet({ deepseekApiKey });
    setTemporaryStatus('DeepSeek ключ сохранён.');
  }, 300);
}

async function handleTranslationModelChange() {
  const translationModel = translationModelSelect.value;
  await storageLocalSet({ translationModel });
  currentTranslationModelId = translationModel;
  const { modelThroughputById = {} } = await storageLocalGet({ modelThroughputById: {} });
  currentThroughputByRole.translation = modelThroughputById[translationModel] || null;
  renderStatus();
  renderThroughputStatuses();
  setTemporaryStatus('Модель для перевода сохранена.');
  runModelThroughputTest(translationModel, 'translation');
}

async function handleContextModelChange() {
  const contextModel = contextModelSelect.value;
  await storageLocalSet({ contextModel });
  currentContextModelId = contextModel;
  const { modelThroughputById = {} } = await storageLocalGet({ modelThroughputById: {} });
  currentThroughputByRole.context = modelThroughputById[contextModel] || null;
  renderThroughputStatuses();
  setTemporaryStatus('Модель для контекста сохранена.');
  runModelThroughputTest(contextModel, 'context');
}

async function handleProofreadModelChange() {
  const proofreadModel = proofreadModelSelect.value;
  await storageLocalSet({ proofreadModel });
  currentProofreadModelId = proofreadModel;
  const { modelThroughputById = {} } = await storageLocalGet({ modelThroughputById: {} });
  currentThroughputByRole.proofread = modelThroughputById[proofreadModel] || null;
  renderThroughputStatuses();
  setTemporaryStatus('Модель для вычитки сохранена.');
  runModelThroughputTest(proofreadModel, 'proofread');
}

async function handleContextGenerationChange() {
  const contextGenerationEnabled = contextGenerationCheckbox.checked;
  await storageLocalSet({ contextGenerationEnabled });
  setTemporaryStatus(
    contextGenerationEnabled ? 'Генерация контекста включена.' : 'Генерация контекста отключена.'
  );
}

async function handleProofreadEnabledChange() {
  const proofreadEnabled = proofreadEnabledCheckbox.checked;
  await storageLocalSet({ proofreadEnabled });
  setTemporaryStatus(proofreadEnabled ? 'Вычитка перевода включена.' : 'Вычитка перевода отключена.');
}

async function handleBlockLengthLimitChange() {
  const blockLengthLimit = clampBlockLengthLimit(Number(blockLengthLimitInput.value));
  await storageLocalSet({ blockLengthLimit });
  renderBlockLengthLimit(blockLengthLimit);
  setTemporaryStatus(`Максимальная длина блока: ${blockLengthLimit} символов.`);
  await sendBlockLengthLimitUpdate(blockLengthLimit);
}

async function handleBlockLengthLimitCommit() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await tabsReload(tab.id);
}

async function getState() {
  const data = await storageLocalGet([
    'apiKey',
    'model',
    'deepseekApiKey',
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
    'debug'
  ]);
  return {
    apiKey: data.apiKey || '',
    deepseekApiKey: data.deepseekApiKey || '',
    translationModel: data.translationModel || data.model,
    contextModel: data.contextModel || data.model,
    proofreadModel: data.proofreadModel || data.model,
    contextGenerationEnabled: data.contextGenerationEnabled,
    proofreadEnabled: data.proofreadEnabled,
    blockLengthLimit: data.blockLengthLimit ?? data.chunkLengthLimit,
    translationStatusByTab: data.translationStatusByTab || {},
    translationVisibilityByTab: data.translationVisibilityByTab || {},
    modelThroughputById: data.modelThroughputById || {},
    debug: Boolean(data.debug)
  };
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

async function runModelThroughputTest(model, role) {
  if (!model) return;
  const roleLabel = getRoleLabel(role);
  const statusMessage = roleLabel
    ? `Запускаем тест пропускной способности (${roleLabel})...`
    : 'Запускаем тест пропускной способности...';
  setTemporaryStatus(statusMessage);
  const { result, lastError } = await runtimeSendMessageSafe({ type: 'RUN_MODEL_THROUGHPUT_TEST', model });
  logDebug('RUN_MODEL_THROUGHPUT_TEST response.', {
    model,
    role,
    response: result,
    runtimeError: lastError?.message || null
  });
  if (lastError) {
    const error = lastError.message || 'Не удалось выполнить тест';
    if (role) {
      currentThroughputByRole[role] = { success: false, error, timestamp: Date.now() };
    }
    renderThroughputStatuses();
    setTemporaryStatus('Тест пропускной способности не удался.', 3000);
    return;
  }
  if (result?.success) {
    if (role) {
      currentThroughputByRole[role] = result.result || null;
    }
    renderThroughputStatuses();
    setTemporaryStatus('Тест пропускной способности завершён.', 2000);
    return;
  }
  const error = result?.error || 'Не удалось выполнить тест';
  if (role) {
    currentThroughputByRole[role] = { success: false, error, timestamp: Date.now() };
  }
  renderThroughputStatuses();
  setTemporaryStatus('Тест пропускной способности не удался.', 3000);
}

async function getActiveTab() {
  const [tab] = await tabsQuery({ active: true, currentWindow: true });
  return tab;
}

async function sendMessageWithAutoInject(tab, message) {
  const delivered = await sendMessageToTab(tab.id, message);
  if (delivered) return true;

  const injected = await ensureContentScript(tab);
  if (!injected) return false;

  return sendMessageToTab(tab.id, message);
}

async function sendMessageWithAutoInjectAndResponse(tab, message) {
  const initial = await sendMessageToTabWithResponse(tab.id, message);
  if (initial.delivered) return initial.response;

  const injected = await ensureContentScript(tab);
  if (!injected) return null;

  const retry = await sendMessageToTabWithResponse(tab.id, message);
  return retry.response;
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        logDebug('tabs.sendMessage failed.', {
          tabId,
          messageType: message?.type,
          runtimeError: chrome.runtime.lastError?.message || null
        });
        resolve(false);
        return;
      }
      logDebug('tabs.sendMessage delivered.', { tabId, messageType: message?.type });
      resolve(true);
    });
  });
}

function sendMessageToTabWithResponse(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        logDebug('tabs.sendMessage response failed.', {
          tabId,
          messageType: message?.type,
          runtimeError: chrome.runtime.lastError?.message || null
        });
        resolve({ delivered: false, response: null });
        return;
      }
      logDebug('tabs.sendMessage response received.', { tabId, messageType: message?.type, response });
      resolve({ delivered: true, response });
    });
  });
}

async function ensureContentScript(tab) {
  if (!tab?.id || !isInjectableUrl(tab?.url)) {
    return false;
  }
  try {
    await executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js']
    });
    logDebug('Content script injected.', { tabId: tab.id });
    return true;
  } catch (error) {
    console.warn('Failed to inject content script', error);
    logDebug('Content script injection failed.', { tabId: tab.id, error: error?.message || String(error) });
    return false;
  }
}

function isInjectableUrl(url) {
  if (!url) return false;
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
}

async function sendCancel() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const delivered = await sendMessageWithAutoInject(tab, { type: 'CANCEL_TRANSLATION' });
  if (!delivered) {
    return;
  }
  setTemporaryStatus('Отменяем перевод...');
}

async function sendTranslateRequest() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const delivered = await sendMessageWithAutoInject(tab, { type: 'START_TRANSLATION' });
  if (!delivered) {
    return;
  }
  updateTranslationVisibility(true);
  updateTranslationVisibilityStorage(true);
  setTemporaryStatus('Запускаем перевод страницы...');
}

async function handleToggleTranslationVisibility() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const visibilityInfo = await getTranslationVisibilityFromPage(tab);
  const currentVisible =
    visibilityInfo && typeof visibilityInfo.visible === 'boolean' ? visibilityInfo.visible : translationVisible;
  const nextVisible = !currentVisible;
  if (nextVisible && !canShowTranslation && visibilityInfo?.hasTranslations === false) {
    setTemporaryStatus('Сначала переведите хотя бы один блок.');
    return;
  }
  const delivered = await sendMessageWithAutoInject(tab, {
    type: 'SET_TRANSLATION_VISIBILITY',
    visible: nextVisible
  });
  if (!delivered) {
    return;
  }
  updateTranslationVisibility(nextVisible);
  updateTranslationVisibilityStorage(nextVisible);
  setTemporaryStatus(nextVisible ? 'Показываем перевод.' : 'Показываем оригинал.');
}

function handleStorageChange(changes) {
  if (changes.translationStatusByTab) {
    const nextStatuses = changes.translationStatusByTab.newValue || {};
    currentTranslationStatus = activeTabId ? nextStatuses[activeTabId] : null;
    updateCanShowTranslation(currentTranslationStatus);
    renderStatus();
  }
  if (changes.translationVisibilityByTab) {
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
    if (typeof message.tabId === 'number') {
      await handleTranslationCancelled(message.tabId);
    }
    return;
  }
  if (message.type === 'UPDATE_TRANSLATION_VISIBILITY') {
    if (activeTabId && sender?.tab?.id && sender.tab.id !== activeTabId) {
      return;
    }
    renderTranslationVisibility(Boolean(message.visible));
    return;
  }
  if (message.type !== 'TRANSLATION_VISIBILITY_CHANGED') {
    return;
  }
  if (activeTabId && typeof message.tabId === 'number' && message.tabId !== activeTabId) {
    return;
  }
  renderTranslationVisibility(Boolean(message.visible));
}

async function handleTranslationCancelled(tabId) {
  await clearTranslationStatus(tabId);
  updateTranslationVisibility(false);
  await updateTranslationVisibilityStorage(false);
  setTemporaryStatus('Перевод для этой страницы отменён.');
  await tabsReload(tabId);
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
  const response = await sendMessageWithAutoInjectAndResponse(tab, { type: 'GET_TRANSLATION_VISIBILITY' });
  if (!response) return null;
  return response;
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
  const { translationVisibilityByTab = {} } = await storageLocalGet({ translationVisibilityByTab: {} });
  translationVisibilityByTab[activeTabId] = visible;
  await storageLocalSet({ translationVisibilityByTab });
}

async function clearTranslationStatus(tabId) {
  const { translationStatusByTab = {} } = await storageLocalGet({ translationStatusByTab: {} });
  delete translationStatusByTab[tabId];
  await storageLocalSet({ translationStatusByTab });
  if (activeTabId === tabId) {
    currentTranslationStatus = null;
    updateCanShowTranslation(currentTranslationStatus);
    renderStatus();
  }
}

async function clearTranslationStorage(url) {
  if (!url) return;
  const { pageTranslations = {} } = await storageLocalGet({ pageTranslations: {} });
  if (pageTranslations[url]) {
    delete pageTranslations[url];
    await storageLocalSet({ pageTranslations });
  }
}

async function handleOpenDebug() {
  const tab = await getActiveTab();
  if (!tab?.url) {
    const fallbackUrl = chrome.runtime.getURL('debug.html');
    await tabsCreate({ url: fallbackUrl });
    return;
  }
  const debugUrl = chrome.runtime.getURL(`debug.html?source=${encodeURIComponent(tab.url)}`);
  await tabsCreate({ url: debugUrl });
}

async function sendBlockLengthLimitUpdate(blockLengthLimit) {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const response = await sendMessageWithAutoInjectAndResponse(tab, {
    type: 'RECALCULATE_BLOCKS',
    blockLengthLimit
  });
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
      const { translationStatusByTab = {} } = await storageLocalGet({ translationStatusByTab: {} });
      translationStatusByTab[activeTabId] = nextStatus;
      await storageLocalSet({ translationStatusByTab });
    }
  }
}
