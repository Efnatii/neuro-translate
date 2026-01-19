function storageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (items) => {
        if (chrome.runtime.lastError) {
          console.warn('storageGet failed:', chrome.runtime.lastError);
          resolve({});
          return;
        }
        resolve(items && typeof items === 'object' ? items : {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function storageSet(items) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(items, () => {
        if (chrome.runtime.lastError) {
          console.warn('storageSet failed:', chrome.runtime.lastError);
          resolve();
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

globalThis.storageGet = storageGet;
globalThis.storageSet = storageSet;
