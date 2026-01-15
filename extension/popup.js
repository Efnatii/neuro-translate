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

const cancelButton = document.getElementById('cancel');
const translateButton = document.getElementById('translate');
const toggleTranslationButton = document.getElementById('toggleTranslation');
const openDebugButton = document.getElementById('openDebug');

let keySaveTimeout = null;
let deepseekKeySaveTimeout = null;
let activeTabId = null;
let translationVisible = false;
let currentTranslationStatus = null;
let currentThroughputInfo = null;
let currentTranslationModelId = null;
let currentContextModelId = null;
let currentProofreadModelId = null;
let temporaryStatusMessage = null;
let temporaryStatusTimeout = null;

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
  apiKeyInput.value = state.apiKey || '';
  deepseekApiKeyInput.value = state.deepseekApiKey || '';
  renderModelOptions(translationModelSelect, state.translationModel);
  renderModelOptions(contextModelSelect, state.contextModel);
  renderModelOptions(proofreadModelSelect, state.proofreadModel);
  currentTranslationModelId = translationModelSelect.value;
  currentContextModelId = contextModelSelect.value;
  currentProofreadModelId = proofreadModelSelect.value;
  currentThroughputInfo = state.modelThroughputById?.[currentTranslationModelId] || null;
  renderContextGeneration(state.contextGenerationEnabled);
  renderProofreadEnabled(state.proofreadEnabled);
  renderBlockLengthLimit(state.blockLengthLimit);
  currentTranslationStatus = state.translationStatusByTab?.[activeTabId] || null;
  renderStatus();
  renderTranslationVisibility(state.translationVisibilityByTab?.[activeTabId]);

  chrome.storage.onChanged.addListener(handleStorageChange);

  apiKeyInput.addEventListener('input', handleApiKeyChange);
  deepseekApiKeyInput.addEventListener('input', handleDeepseekApiKeyChange);
  translationModelSelect.addEventListener('change', handleTranslationModelChange);
  contextModelSelect.addEventListener('change', handleContextModelChange);
  proofreadModelSelect.addEventListener('change', handleProofreadModelChange);
  contextGenerationCheckbox.addEventListener('change', handleContextGenerationChange);
  proofreadEnabledCheckbox.addEventListener('change', handleProofreadEnabledChange);
  blockLengthLimitInput.addEventListener('input', handleBlockLengthLimitChange);
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

function handleDeepseekApiKeyChange() {
  clearTimeout(deepseekKeySaveTimeout);
  const deepseekApiKey = deepseekApiKeyInput.value.trim();
  deepseekKeySaveTimeout = setTimeout(async () => {
    await chrome.storage.local.set({ deepseekApiKey });
    setTemporaryStatus('DeepSeek ключ сохранён.');
  }, 300);
}

async function handleTranslationModelChange() {
  const translationModel = translationModelSelect.value;
  await chrome.storage.local.set({ translationModel });
  currentTranslationModelId = translationModel;
  const { modelThroughputById = {} } = await chrome.storage.local.get({ modelThroughputById: {} });
  currentThroughputInfo = modelThroughputById[translationModel] || null;
  renderStatus();
  setTemporaryStatus('Модель для перевода сохранена.');
  runModelThroughputTest(translationModel);
}

async function handleContextModelChange() {
  const contextModel = contextModelSelect.value;
  await chrome.storage.local.set({ contextModel });
  currentContextModelId = contextModel;
  setTemporaryStatus('Модель для контекста сохранена.');
}

async function handleProofreadModelChange() {
  const proofreadModel = proofreadModelSelect.value;
  await chrome.storage.local.set({ proofreadModel });
  currentProofreadModelId = proofreadModel;
  setTemporaryStatus('Модель для вычитки сохранена.');
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
  setTemporaryStatus(`Максимальная длина блока: ${blockLengthLimit} символов.`);
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      [
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
        'modelThroughputById'
      ],
      (data) => {
      resolve({
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
        modelThroughputById: data.modelThroughputById || {}
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

function runModelThroughputTest(model) {
  if (!model) return;
  setTemporaryStatus('Запускаем тест пропускной способности...');
  chrome.runtime.sendMessage({ type: 'RUN_MODEL_THROUGHPUT_TEST', model }, (response) => {
    if (response?.success) {
      currentThroughputInfo = response.result || null;
      renderStatus();
      setTemporaryStatus('Тест пропускной способности завершён.', 2000);
      return;
    }
    const error = response?.error || 'Не удалось выполнить тест';
    currentThroughputInfo = { success: false, error, timestamp: Date.now() };
    renderStatus();
    setTemporaryStatus('Тест пропускной способности не удался.', 3000);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendMessageWithAutoInject(tab, message) {
  const delivered = await sendMessageToTab(tab.id, message);
  if (delivered) return true;

  const injected = await ensureContentScript(tab);
  if (!injected) return false;

  return sendMessageToTab(tab.id, message);
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

async function ensureContentScript(tab) {
  if (!tab?.id || !isInjectableUrl(tab?.url)) {
    return false;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content-script.js']
    });
    return true;
  } catch (error) {
    console.warn('Failed to inject content script', error);
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
    setTemporaryStatus('Перевод недоступен для этой страницы. Откройте обычную веб-страницу и попробуйте снова.');
    return;
  }
  updateTranslationVisibility(false);
  updateTranslationVisibilityStorage(false);
  setTemporaryStatus('Перевод для этой страницы отменён.');
}

async function sendTranslateRequest() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const delivered = await sendMessageWithAutoInject(tab, { type: 'START_TRANSLATION' });
  if (!delivered) {
    setTemporaryStatus('Перевод недоступен для этой страницы. Откройте обычную веб-страницу и попробуйте снова.');
    return;
  }
  updateTranslationVisibility(true);
  updateTranslationVisibilityStorage(true);
  setTemporaryStatus('Запускаем перевод страницы...');
}

async function handleToggleTranslationVisibility() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const nextVisible = !translationVisible;
  const delivered = await sendMessageWithAutoInject(tab, {
    type: 'SET_TRANSLATION_VISIBILITY',
    visible: nextVisible
  });
  if (!delivered) {
    setTemporaryStatus('Перевод недоступен для этой страницы. Откройте обычную веб-страницу и попробуйте снова.');
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
    renderStatus();
  }
  if (changes.translationVisibilityByTab) {
    const nextVisibility = changes.translationVisibilityByTab.newValue || {};
    renderTranslationVisibility(activeTabId ? nextVisibility[activeTabId] : false);
  }
  if (changes.modelThroughputById) {
    const nextThroughput = changes.modelThroughputById.newValue || {};
    currentThroughputInfo = currentTranslationModelId ? nextThroughput[currentTranslationModelId] : null;
    renderStatus();
  }
}

function renderStatus() {
  const baseMessage = getBaseStatusMessage();
  const throughputMessage = formatThroughputStatus(currentThroughputInfo);
  statusLabel.textContent = throughputMessage ? `${baseMessage}\n${throughputMessage}` : baseMessage;
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
