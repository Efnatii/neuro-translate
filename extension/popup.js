const apiKeyInput = document.getElementById('apiKey');
const statusLabel = document.getElementById('status');

const cancelButton = document.getElementById('cancel');
const translateButton = document.getElementById('translate');

let keySaveTimeout = null;

init();

async function init() {
  const state = await getState();
  apiKeyInput.value = state.apiKey || '';
  renderTranslationStatus(state.translationStatus);

  chrome.storage.onChanged.addListener(handleStorageChange);

  apiKeyInput.addEventListener('input', handleApiKeyChange);
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

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'translationStatus'], (data) => {
      resolve({
        apiKey: data.apiKey || '',
        translationStatus: data.translationStatus
      });
    });
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
  if (changes.translationStatus) {
    renderTranslationStatus(changes.translationStatus.newValue);
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
