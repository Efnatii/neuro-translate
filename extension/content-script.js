let cancelRequested = false;
let translationError = null;
let translationProgress = { completedChunks: 0, totalChunks: 0 };
let translationInProgress = false;
let activeTranslationEntries = [];
let originalSnapshot = [];

const STORAGE_KEY = 'pageTranslations';

restoreFromMemory();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelTranslation();
  }

  if (message?.type === 'START_TRANSLATION') {
    startTranslation();
  }
});

async function startTranslation() {
  if (translationInProgress) {
    reportProgress('Перевод уже выполняется', translationProgress.completedChunks, translationProgress.totalChunks);
    return;
  }

  const settings = await requestSettings();
  if (!settings?.allowed) {
    reportProgress('Перевод недоступен для этой страницы', translationProgress.completedChunks, translationProgress.totalChunks);
    return;
  }

  translationInProgress = true;
  try {
    await translatePage(settings);
  } finally {
    translationInProgress = false;
  }
}

async function requestSettings() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS', url: location.href }, (response) => {
      resolve(response);
    });
  });
}

async function translatePage(settings) {
  const textNodes = collectTextNodes(document.body);
  const nodesWithPath = textNodes.map((node) => ({
    node,
    path: getNodePath(node),
    original: node.nodeValue
  }));
  originalSnapshot = nodesWithPath.map(({ path, original }) => ({ path, original }));
  activeTranslationEntries = [];

  const chunks = chunkNodes(nodesWithPath, 800);
  translationProgress = { completedChunks: 0, totalChunks: chunks.length };

  if (!chunks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return;
  }

  cancelRequested = false;
  translationError = null;
  reportProgress('Перевод запущен', 0, chunks.length);

  const maxConcurrency = Math.min(4, chunks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      if (cancelRequested) return;
      const currentIndex = nextIndex++;
      if (currentIndex >= chunks.length) return;
      const chunk = chunks[currentIndex];
      const texts = chunk.map(({ node }) => node.nodeValue);

      try {
        const result = await translate(texts, settings.targetLanguage || 'ru');
        chunk.forEach(({ node, path, original }, index) => {
          const translated = result.translations[index] || node.nodeValue;
          node.nodeValue = translated;
          updateActiveEntry(path, original, translated);
        });
      } catch (error) {
        console.error('Chunk translation failed', error);
        translationError = error;
        cancelRequested = true;
        reportProgress('Ошибка перевода', translationProgress.completedChunks, chunks.length);
        return;
      }

      translationProgress.completedChunks += 1;
      reportProgress('Перевод выполняется', translationProgress.completedChunks, chunks.length);
    }
  };

  const workers = Array.from({ length: maxConcurrency }, () => worker());
  await Promise.all(workers);

  if (translationError) {
    reportProgress('Ошибка перевода', translationProgress.completedChunks, chunks.length);
    return;
  }

  if (cancelRequested) {
    reportProgress('Перевод отменён', translationProgress.completedChunks, chunks.length);
    return;
  }

  reportProgress('Перевод завершён', translationProgress.completedChunks, chunks.length);
  await saveTranslationsToMemory(activeTranslationEntries);
}

async function translate(texts, targetLanguage) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_TEXT',
        texts,
        targetLanguage
      },
      (response) => {
        if (response?.success) {
          resolve(response);
        } else {
          reject(new Error(response?.error || 'Не удалось выполнить перевод.'));
        }
      }
    );
  });
}

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const parent = node.parentNode;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.nodeName.toLowerCase();
      if (['script', 'style', 'noscript', 'code', 'pre'].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  const nodes = [];
  let current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}

function chunkNodes(nodes, maxLength) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  nodes.forEach((entry) => {
    const text = entry.node.nodeValue;
    if (currentLength + text.length > maxLength && currentChunk.length) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLength = 0;
    }
    currentChunk.push(entry);
    currentLength += text.length;
  });

  if (currentChunk.length) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function reportProgress(message, completedChunks, totalChunks) {
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_PROGRESS',
    message,
    completedChunks,
    totalChunks
  });
}

async function restoreFromMemory() {
  const stored = await getStoredTranslations(location.href);
  if (!stored?.length) return;

  const restoredSnapshot = [];
  stored.forEach(({ path, translated, original }) => {
    const node = findNodeByPath(path);
    if (node) {
      const originalValue = typeof original === 'string' ? original : node.nodeValue;
      activeTranslationEntries.push({ path, original: originalValue, translated });
      restoredSnapshot.push({ path, original: originalValue });
      node.nodeValue = translated;
    }
  });
  if (restoredSnapshot.length) {
    originalSnapshot = restoredSnapshot;
  }
}

function getNodePath(node) {
  const path = [];
  let current = node;
  while (current && current !== document.body) {
    const parent = current.parentNode;
    if (!parent) break;
    const index = Array.prototype.indexOf.call(parent.childNodes, current);
    path.unshift(index);
    current = parent;
  }
  return path;
}

function findNodeByPath(path) {
  let current = document.body;
  for (const index of path) {
    if (!current?.childNodes?.[index]) return null;
    current = current.childNodes[index];
  }
  return current && current.nodeType === Node.TEXT_NODE ? current : null;
}

function updateActiveEntry(path, original, translated) {
  const existingIndex = activeTranslationEntries.findIndex((entry) => isSamePath(entry.path, path));
  if (existingIndex >= 0) {
    activeTranslationEntries[existingIndex] = { path, original, translated };
  } else {
    activeTranslationEntries.push({ path, original, translated });
  }
}

function isSamePath(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

async function saveTranslationsToMemory(entries) {
  const filtered = entries.filter(({ translated }) => translated && translated.trim());
  const existing = await getTranslationsObject();
  existing[location.href] = filtered;
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
}

async function getStoredTranslations(url) {
  const existing = await getTranslationsObject();
  return existing[url] || [];
}

async function clearStoredTranslations(url) {
  const existing = await getTranslationsObject();
  delete existing[url];
  await chrome.storage.local.set({ [STORAGE_KEY]: existing });
}

async function getTranslationsObject() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve(data?.[STORAGE_KEY] || {});
    });
  });
}

function restoreOriginal(entries) {
  entries.forEach(({ path, original }) => {
    const node = findNodeByPath(path);
    if (node && typeof original === 'string') {
      node.nodeValue = original;
    }
  });
}

async function cancelTranslation() {
  cancelRequested = true;
  const entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
  if (entriesToRestore.length) {
    restoreOriginal(entriesToRestore);
  }
  await clearStoredTranslations(location.href);
  activeTranslationEntries = [];
  reportProgress('Перевод отменён', translationProgress.completedChunks, translationProgress.totalChunks);
}
