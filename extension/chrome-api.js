(() => {
  const root = typeof self !== 'undefined' ? self : window;
  if (root.chromeApi) return;

  const getBrowserInfo = () => ({
    userAgent: root?.navigator?.userAgent || 'unknown',
    platform: root?.navigator?.platform || 'unknown'
  });

  const wrapWithCallback = (fn, ...args) =>
    new Promise((resolve, reject) => {
      try {
        fn(...args, (...callbackArgs) => {
          const lastError = root?.chrome?.runtime?.lastError;
          if (lastError) {
            reject(lastError);
            return;
          }
          resolve(callbackArgs.length > 1 ? callbackArgs : callbackArgs[0]);
        });
      } catch (error) {
        reject(error);
      }
    });

  const wrapWithCallbackSafe = (fn, ...args) =>
    new Promise((resolve) => {
      try {
        fn(...args, (...callbackArgs) => {
          const lastError = root?.chrome?.runtime?.lastError || null;
          resolve({
            result: callbackArgs.length > 1 ? callbackArgs : callbackArgs[0],
            lastError
          });
        });
      } catch (error) {
        resolve({ result: undefined, lastError: error });
      }
    });

  const createDebugLogger = (scope, isEnabled) => (message, details = {}) => {
    if (!isEnabled?.()) return;
    const timestamp = new Date().toISOString();
    console.debug(`[${timestamp}] [${scope}] ${message}`, {
      ...details,
      browser: getBrowserInfo()
    });
  };

  root.chromeApi = {
    sendMessage: (...args) => wrapWithCallback(root.chrome.runtime.sendMessage, ...args),
    sendMessageSafe: (...args) => wrapWithCallbackSafe(root.chrome.runtime.sendMessage, ...args),
    storageGet: (area, keys) => wrapWithCallback(root.chrome.storage[area].get, keys),
    storageSet: (area, items) => wrapWithCallback(root.chrome.storage[area].set, items),
    storageRemove: (area, keys) => wrapWithCallback(root.chrome.storage[area].remove, keys),
    tabsQuery: (query) => wrapWithCallback(root.chrome.tabs.query, query),
    tabsReload: (tabId) => wrapWithCallback(root.chrome.tabs.reload, tabId),
    tabsCreate: (createProperties) => wrapWithCallback(root.chrome.tabs.create, createProperties),
    tabsSendMessage: (tabId, message) => wrapWithCallback(root.chrome.tabs.sendMessage, tabId, message),
    tabsSendMessageSafe: (tabId, message) =>
      wrapWithCallbackSafe(root.chrome.tabs.sendMessage, tabId, message),
    executeScript: (details) => wrapWithCallback(root.chrome.scripting.executeScript, details),
    getBrowserInfo
  };

  root.createDebugLogger = createDebugLogger;
})();
