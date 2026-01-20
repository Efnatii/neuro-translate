const NT_PING_TYPE = 'NT_PING';

function isSupportedTabUrl(url) {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('file://');
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve(null);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(tab || null);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let resolved = false;
    let timeoutId;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      if (timeoutId) clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(handleUpdated);
      resolve(result);
    };

    const handleUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') {
        finish(true);
      }
    };

    chrome.tabs.onUpdated.addListener(handleUpdated);
    timeoutId = setTimeout(() => finish(false), timeoutMs);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish(false);
        return;
      }
      if (tab?.status === 'complete') {
        finish(true);
      }
    });
  });
}

function pingContentScript(tabId, timeoutMs = 700) {
  return new Promise((resolve) => {
    let finished = false;
    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    chrome.tabs.sendMessage(tabId, { type: NT_PING_TYPE }, (response) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, response });
    });
  });
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js']
    });
    return { ok: true };
  } catch (error) {
    console.warn('Failed to inject content script', error);
    return { ok: false, reason: error?.message || 'inject-failed' };
  }
}

function sendMessageToTab(tabId, message, expectResponse = false) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      resolve({ ok: true, response: expectResponse ? response : undefined });
    });
  });
}

async function sendMessageToTabSafe(tab, message, options = {}) {
  const tabId = typeof tab === 'number' ? tab : tab?.id;
  if (!tabId) {
    return { ok: false, reason: 'tab-not-found' };
  }

  let tabInfo = typeof tab === 'object' ? tab : null;
  if (!tabInfo) {
    tabInfo = await getTabById(tabId);
  }
  if (!tabInfo) {
    return { ok: false, reason: 'tab-not-found' };
  }
  if (!isSupportedTabUrl(tabInfo.url)) {
    return { ok: false, reason: 'unsupported-url' };
  }

  if (tabInfo.status && tabInfo.status !== 'complete') {
    const ready = await waitForTabComplete(tabId, options.waitTimeoutMs ?? 10000);
    if (!ready) {
      return { ok: false, reason: 'tab-not-ready' };
    }
  }

  const pingResult = await pingContentScript(tabId, options.pingTimeoutMs ?? 700);
  if (!pingResult.ok) {
    const injected = await ensureContentScriptInjected(tabId);
    if (!injected.ok) {
      return { ok: false, reason: injected.reason || 'inject-failed' };
    }
    const pingRetry = await pingContentScript(tabId, options.pingTimeoutMs ?? 900);
    if (!pingRetry.ok) {
      return { ok: false, reason: 'content-script-unavailable' };
    }
  }

  return sendMessageToTab(tabId, message, options.expectResponse);
}
