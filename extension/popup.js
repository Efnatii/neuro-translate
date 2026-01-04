const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('model');
const translationStyleSelect = document.getElementById('translationStyle');
const statusLabel = document.getElementById('status');

const cancelButton = document.getElementById('cancel');
const translateButton = document.getElementById('translate');

let keySaveTimeout = null;
let activeTabId = null;

const translationStyles = [
  { id: 'natural', name: 'Естественный' },
  { id: 'conversational', name: 'Разговорный' },
  { id: 'formal', name: 'Деловой' },
  { id: 'creative', name: 'Выразительный' }
];

const models = [
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', price: 0.45 },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', price: 0.5 },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', price: 0.75 },
  { id: 'gpt-4o-mini-audio-preview', name: 'GPT-4o Mini Audio Preview', price: 0.75 },
  { id: 'gpt-4o-mini-search-preview', name: 'GPT-4o Mini Search Preview', price: 0.75 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', price: 2 },
  { id: 'gpt-image-1-mini', name: 'GPT-Image-1 Mini', price: 2 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', price: 2.25 },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', price: 2.25 },
  { id: 'gpt-realtime-mini', name: 'GPT Realtime Mini', price: 3 },
  { id: 'gpt-4o-mini-realtime-preview', name: 'GPT-4o Mini Realtime Preview', price: 3 },
  { id: 'gpt-audio-mini', name: 'GPT Audio Mini', price: 3 },
  { id: 'gpt-image-1', name: 'GPT-Image-1', price: 5 },
  { id: 'o4-mini', name: 'o4 Mini', price: 5.5 },
  { id: 'o3-mini', name: 'o3 Mini', price: 5.5 },
  { id: 'o1-mini', name: 'o1 Mini', price: 5.5 },
  { id: 'codex-mini-latest', name: 'Codex Mini Latest', price: 7.5 },
  { id: 'gpt-4.1', name: 'GPT-4.1', price: 10 },
  { id: 'o3', name: 'o3', price: 10 },
  { id: 'o4-mini-deep-research', name: 'o4 Mini Deep Research', price: 10 },
  { id: 'gpt-5.1', name: 'GPT-5.1', price: 11.25 },
  { id: 'gpt-5', name: 'GPT-5', price: 11.25 },
  { id: 'gpt-5.1-chat-latest', name: 'GPT-5.1 Chat Latest', price: 11.25 },
  { id: 'gpt-5-chat-latest', name: 'GPT-5 Chat Latest', price: 11.25 },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', price: 11.25 },
  { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', price: 11.25 },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', price: 11.25 },
  { id: 'gpt-5-search-api', name: 'GPT-5 Search API', price: 11.25 },
  { id: 'gpt-4o', name: 'GPT-4o', price: 12.5 },
  { id: 'gpt-audio', name: 'GPT Audio', price: 12.5 },
  { id: 'gpt-4o-audio-preview', name: 'GPT-4o Audio Preview', price: 12.5 },
  { id: 'gpt-4o-search-preview', name: 'GPT-4o Search Preview', price: 12.5 },
  { id: 'computer-use-preview', name: 'Computer Use Preview', price: 15 },
  { id: 'gpt-5.2', name: 'GPT-5.2', price: 15.75 },
  { id: 'gpt-5.2-chat-latest', name: 'GPT-5.2 Chat Latest', price: 15.75 },
  { id: 'gpt-4o-2024-05-13', name: 'GPT-4o (2024-05-13)', price: 20 },
  { id: 'gpt-realtime', name: 'GPT Realtime', price: 20 },
  { id: 'gpt-4o-realtime-preview', name: 'GPT-4o Realtime Preview', price: 25 },
  { id: 'o3-deep-research', name: 'o3 Deep Research', price: 50 },
  { id: 'o1', name: 'o1', price: 75 },
  { id: 'o3-pro', name: 'o3 Pro', price: 100 },
  { id: 'gpt-5-pro', name: 'GPT-5 Pro', price: 135 },
  { id: 'gpt-5.2-pro', name: 'GPT-5.2 Pro', price: 189 },
  { id: 'o1-pro', name: 'o1 Pro', price: 750 }
].sort((a, b) => a.price - b.price);

init();

async function init() {
  const tab = await getActiveTab();
  activeTabId = tab?.id || null;

  const state = await getState();
  apiKeyInput.value = state.apiKey || '';
  renderModelOptions(state.model);
  renderStyleOptions(state.translationStyle);
  renderTranslationStatus(state.translationStatusByTab?.[activeTabId]);

  chrome.storage.onChanged.addListener(handleStorageChange);

  apiKeyInput.addEventListener('input', handleApiKeyChange);
  modelSelect.addEventListener('change', handleModelChange);
  translationStyleSelect.addEventListener('change', handleTranslationStyleChange);
  cancelButton.addEventListener('click', sendCancel);
  translateButton.addEventListener('click', sendTranslateRequest);
}

function handleApiKeyChange() {
  clearTimeout(keySaveTimeout);
  const apiKey = apiKeyInput.value.trim();
  keySaveTimeout = setTimeout(async () => {
    await chrome.storage.local.set({ apiKey });
    statusLabel.textContent = 'API ключ сохранён.';
  }, 300);
}

async function handleModelChange() {
  const model = modelSelect.value;
  await chrome.storage.local.set({ model });
  statusLabel.textContent = 'Модель сохранена.';
}

async function handleTranslationStyleChange() {
  const translationStyle = translationStyleSelect.value;
  await chrome.storage.local.set({ translationStyle });
  statusLabel.textContent = 'Стиль перевода сохранён.';
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'model', 'translationStyle', 'translationStatusByTab'], (data) => {
      resolve({
        apiKey: data.apiKey || '',
        model: data.model,
        translationStyle: data.translationStyle,
        translationStatusByTab: data.translationStatusByTab || {}
      });
    });
  });
}

function renderModelOptions(selected) {
  const defaultModel = models[0]?.id;
  const currentModel = selected || defaultModel;

  modelSelect.innerHTML = '';

  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = `${model.name} ($${model.price}/1M токенов)`;
    option.selected = model.id === currentModel;
    modelSelect.appendChild(option);
  });
}

function renderStyleOptions(selected) {
  const defaultStyle = translationStyles[0]?.id;
  const currentStyle = selected || defaultStyle;

  translationStyleSelect.innerHTML = '';

  translationStyles.forEach((style) => {
    const option = document.createElement('option');
    option.value = style.id;
    option.textContent = style.name;
    option.selected = style.id === currentStyle;
    translationStyleSelect.appendChild(option);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendCancel() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' }, () => {
    if (chrome.runtime.lastError) {
      statusLabel.textContent = 'Не удалось связаться со страницей. Обновите её и попробуйте снова.';
      return;
    }
    statusLabel.textContent = 'Перевод для этой страницы отменён.';
  });
}

async function sendTranslateRequest() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'START_TRANSLATION' }, () => {
    if (chrome.runtime.lastError) {
      statusLabel.textContent = 'Не удалось подключиться к странице. Обновите её и попробуйте снова.';
      return;
    }
    statusLabel.textContent = 'Запускаем перевод страницы...';
  });
}

function handleStorageChange(changes) {
  if (changes.translationStatusByTab) {
    const nextStatuses = changes.translationStatusByTab.newValue || {};
    renderTranslationStatus(activeTabId ? nextStatuses[activeTabId] : null);
  }
}

function renderTranslationStatus(status) {
  const defaultText = 'Статус: перевод не выполняется.';
  if (!status) {
    statusLabel.textContent = defaultText;
    return;
  }

  const { completedChunks = 0, totalChunks = 0, message } = status;
  const progress = totalChunks ? ` (${completedChunks}/${totalChunks})` : '';
  statusLabel.textContent = message ? `${message}${progress}` : defaultText;
}
