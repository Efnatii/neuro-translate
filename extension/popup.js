const apiKeyInput = document.getElementById('apiKey');
const modelSelect = document.getElementById('model');
const statusLabel = document.getElementById('status');

const cancelButton = document.getElementById('cancel');
const translateButton = document.getElementById('translate');

let keySaveTimeout = null;
let activeTabId = null;

const models = [
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', price: 0.15 },
  { id: 'gpt-5-nano', name: 'GPT-5 Nano', price: 0.2 },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', price: 0.6 },
  { id: 'gpt-5-mini', name: 'GPT-5 Mini', price: 0.9 }
].sort((a, b) => a.price - b.price);

init();

async function init() {
  const tab = await getActiveTab();
  activeTabId = tab?.id || null;

  const state = await getState();
  apiKeyInput.value = state.apiKey || '';
  renderModelOptions(state.model);
  renderTranslationStatus(state.translationStatusByTab?.[activeTabId]);

  chrome.storage.onChanged.addListener(handleStorageChange);

  apiKeyInput.addEventListener('input', handleApiKeyChange);
  modelSelect.addEventListener('change', handleModelChange);
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

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'model', 'translationStatusByTab'], (data) => {
      resolve({
        apiKey: data.apiKey || '',
        model: data.model,
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function sendCancel() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
  statusLabel.textContent = 'Перевод для этой страницы отменён.';
}

async function sendTranslateRequest() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'START_TRANSLATION' });
  statusLabel.textContent = 'Запускаем перевод страницы...';
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
