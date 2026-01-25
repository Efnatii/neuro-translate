const NT_PING_TYPE = 'NT_PING';

function isSupportedTabUrl(url) {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return normalized.startsWith('http://') || normalized.startsWith('https://') || normalized.startsWith('file://');
}

function isInjectableTabUrl(url) {
  if (!url) return false;
  const normalized = url.toLowerCase();
  return normalized.startsWith('http://') || normalized.startsWith('https://');
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

    try {
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
    } catch (error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      resolve({ ok: false, reason: error?.message || 'ping-failed' });
    }
  });
}

async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script.js'],
      world: 'ISOLATED'
    });
    return { ok: true };
  } catch (error) {
    console.warn('Failed to inject content script', error);
    return { ok: false, reason: error?.message || 'inject-failed' };
  }
}

function requestContentScriptInjection(tabId) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'ENSURE_CONTENT_SCRIPT', tabId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: chrome.runtime.lastError.message });
        return;
      }
      if (!response?.ok) {
        resolve({ ok: false, reason: response?.reason || 'inject-failed' });
        return;
      }
      resolve({ ok: true });
    });
  });
}

async function ensureConnected(tabId, options = {}) {
  const pingTimeoutMs = options.pingTimeoutMs ?? 700;
  const retryCount = Number.isFinite(options.retryCount) ? options.retryCount : 2;
  const retryDelayMs = options.retryDelayMs ?? 200;
  const useBackgroundInjection = options.useBackgroundInjection ?? true;

  let pingResult = await pingContentScript(tabId, pingTimeoutMs);
  if (pingResult.ok) {
    return { ok: true };
  }

  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    const injected = useBackgroundInjection
      ? await requestContentScriptInjection(tabId)
      : await ensureContentScriptInjected(tabId);
    if (!injected.ok) {
      return { ok: false, reason: injected.reason || 'inject-failed' };
    }
    if (retryDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    pingResult = await pingContentScript(tabId, pingTimeoutMs + 200);
    if (pingResult.ok) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'content-script-unavailable' };
}

function sendMessageToTab(tabId, message, expectResponse = false) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, response: expectResponse ? response : undefined });
      });
    } catch (error) {
      resolve({ ok: false, reason: error?.message || 'send-failed' });
    }
  });
}

function isConnectionError(reason = '') {
  const normalized = String(reason).toLowerCase();
  return (
    normalized.includes('could not establish connection') ||
    normalized.includes('receiving end does not exist') ||
    normalized.includes('no receiver')
  );
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

  if (!options.skipEnsureConnection) {
    const connectionResult = await ensureConnected(tabId, {
      pingTimeoutMs: options.pingTimeoutMs ?? 700,
      retryCount: options.retryCount,
      retryDelayMs: options.retryDelayMs,
      useBackgroundInjection: options.useBackgroundInjection
    });
    if (!connectionResult.ok) {
      return { ok: false, reason: connectionResult.reason || 'content-script-unavailable' };
    }
  }

  const initialSend = await sendMessageToTab(tabId, message, options.expectResponse);
  if (
    initialSend.ok ||
    options.skipEnsureConnection ||
    !isConnectionError(initialSend.reason)
  ) {
    return initialSend;
  }
  const reconnected = await ensureConnected(tabId, {
    pingTimeoutMs: options.pingTimeoutMs ?? 700,
    retryCount: 1,
    retryDelayMs: options.retryDelayMs ?? 200,
    useBackgroundInjection: options.useBackgroundInjection
  });
  if (!reconnected.ok) {
    return { ok: false, reason: reconnected.reason || initialSend.reason || 'content-script-unavailable' };
  }
  return sendMessageToTab(tabId, message, options.expectResponse);
}
