const apiKeyInput = document.getElementById('apiKey');
const enabledCheckbox = document.getElementById('enabled');
const statusLabel = document.getElementById('status');

const saveButton = document.getElementById('save');
const cancelButton = document.getElementById('cancel');
const blockButton = document.getElementById('blockDomain');
const unblockButton = document.getElementById('unblockDomain');

let currentDomain = null;

init();

async function init() {
  const state = await getState();
  apiKeyInput.value = state.apiKey || '';
  enabledCheckbox.checked = !!state.enabled;
  currentDomain = await getActiveDomain();
  renderDomainStatus(state.blockedDomains || []);
  renderTranslationStatus(state.translationStatus);

  chrome.storage.onChanged.addListener(handleStorageChange);

  saveButton.addEventListener('click', handleSave);
  cancelButton.addEventListener('click', sendCancel);
  blockButton.addEventListener('click', () => updateDomainBlock(true));
  unblockButton.addEventListener('click', () => updateDomainBlock(false));
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'enabled', 'blockedDomains', 'translationStatus'], (data) => {
      resolve({
        apiKey: data.apiKey || '',
        enabled: data.enabled !== false,
        blockedDomains: data.blockedDomains || [],
        translationStatus: data.translationStatus
      });
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getActiveDomain() {
  const tab = await getActiveTab();
  try {
    return new URL(tab.url).hostname;
  } catch (error) {
    return null;
  }
}

function renderDomainStatus(blockedDomains) {
  if (!currentDomain) {
    statusLabel.textContent = 'Не удалось определить домен.';
    return;
  }

  if (blockedDomains.includes(currentDomain)) {
    statusLabel.textContent = `${currentDomain} исключён из перевода.`;
  } else {
    statusLabel.textContent = `${currentDomain} доступен для перевода.`;
  }
}

async function handleSave() {
  const apiKey = apiKeyInput.value.trim();
  const enabled = enabledCheckbox.checked;

  await chrome.storage.local.set({ apiKey, enabled });
  statusLabel.textContent = 'Настройки сохранены.';
}

async function sendCancel() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
  statusLabel.textContent = 'Перевод для этой страницы отменён.';
}

async function updateDomainBlock(block) {
  const domain = currentDomain;
  if (!domain) return;

  const state = await getState();
  const blocked = new Set(state.blockedDomains || []);
  if (block) {
    blocked.add(domain);
  } else {
    blocked.delete(domain);
  }

  const blockedDomains = Array.from(blocked);
  await chrome.storage.local.set({ blockedDomains });
  renderDomainStatus(blockedDomains);
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
