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

  saveButton.addEventListener('click', handleSave);
  cancelButton.addEventListener('click', sendCancel);
  blockButton.addEventListener('click', () => updateDomainBlock(true));
  unblockButton.addEventListener('click', () => updateDomainBlock(false));
}

async function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['apiKey', 'enabled', 'blockedDomains'], (data) => {
      resolve({
        apiKey: data.apiKey || '',
        enabled: data.enabled !== false,
        blockedDomains: data.blockedDomains || []
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
    statusLabel.textContent = 'Unable to detect current domain.';
    return;
  }

  if (blockedDomains.includes(currentDomain)) {
    statusLabel.textContent = `${currentDomain} is excluded from translation.`;
  } else {
    statusLabel.textContent = `${currentDomain} is eligible for translation.`;
  }
}

async function handleSave() {
  const apiKey = apiKeyInput.value.trim();
  const enabled = enabledCheckbox.checked;

  await chrome.storage.local.set({ apiKey, enabled });
  statusLabel.textContent = 'Settings saved.';
}

async function sendCancel() {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_TRANSLATION' });
  statusLabel.textContent = 'Translation canceled for this page.';
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
