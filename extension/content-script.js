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

  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const chunks = chunkBlocks(blockGroups, 1800);
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
      const texts = chunk.map(({ node }) => prepareTextForTranslation(node.nodeValue));

      try {
        const result = await translate(
          texts,
          settings.targetLanguage || 'ru',
          settings.translationStyle
        );
        chunk.forEach(({ node, path, original }, index) => {
          const translated = result.translations[index] || node.nodeValue;
          const withOriginalFormatting = applyOriginalFormatting(original, translated);
          node.nodeValue = withOriginalFormatting;
          updateActiveEntry(path, original, withOriginalFormatting);
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

async function translate(texts, targetLanguage, translationStyle) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_TEXT',
        texts,
        targetLanguage,
        translationStyle
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

function groupTextNodesByBlock(nodesWithPath) {
  const blocks = [];
  let currentBlock = null;
  let currentBlockElement = null;

  nodesWithPath.forEach((entry) => {
    const blockElement = findBlockAncestor(entry.node);
    if (blockElement !== currentBlockElement) {
      currentBlockElement = blockElement;
      currentBlock = [];
      blocks.push(currentBlock);
    }
    currentBlock.push(entry);
  });

  return blocks;
}

function findBlockAncestor(node) {
  let current = node.parentNode;
  while (current && current !== document.body) {
    if (isBlockElement(current)) return current;
    current = current.parentNode;
  }
  return document.body;
}

function isBlockElement(element) {
  const tag = element.nodeName.toLowerCase();
  const blockTags = new Set([
    'p',
    'div',
    'section',
    'article',
    'header',
    'footer',
    'aside',
    'main',
    'nav',
    'li',
    'ul',
    'ol',
    'pre',
    'blockquote',
    'figure',
    'figcaption'
  ]);
  if (blockTags.has(tag)) return true;

  const display = window.getComputedStyle(element)?.display || '';
  return ['block', 'flex', 'grid', 'table', 'list-item', 'flow-root'].some((value) => display.includes(value));
}

function chunkBlocks(blocks, maxLength) {
  const chunks = [];
  let currentChunk = [];
  let currentLength = 0;

  const pushChunk = () => {
    if (currentChunk.length) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentLength = 0;
    }
  };

  blocks.forEach((block) => {
    const blockLength = block.reduce((sum, entry) => sum + (entry.node.nodeValue?.length || 0), 0);

    if (blockLength > maxLength && block.length) {
      const splitBlocks = splitOversizedBlock(block, maxLength);
      splitBlocks.forEach((splitBlock) => {
        const splitLength = splitBlock.reduce((sum, entry) => sum + (entry.node.nodeValue?.length || 0), 0);
        if (currentLength + splitLength > maxLength) {
          pushChunk();
        }
        currentChunk.push(...splitBlock);
        currentLength += splitLength;
        pushChunk();
      });
      return;
    }

    if (currentLength + blockLength > maxLength && currentChunk.length) {
      pushChunk();
    }

    currentChunk.push(...block);
    currentLength += blockLength;
  });

  pushChunk();
  return chunks;
}

function splitOversizedBlock(block, maxLength) {
  const splits = [];
  let current = [];
  let length = 0;

  block.forEach((entry) => {
    const textLength = entry.node.nodeValue?.length || 0;
    if (length + textLength > maxLength && current.length) {
      splits.push(current);
      current = [];
      length = 0;
    }
    current.push(entry);
    length += textLength;
  });

  if (current.length) splits.push(current);
  return splits;
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

function prepareTextForTranslation(text) {
  const { core } = extractWhitespaceAndCore(text);
  return core;
}

function applyOriginalFormatting(original, translated) {
  const { prefix, suffix } = extractWhitespaceAndCore(original);
  const adjustedCase = matchFirstLetterCase(original, translated || '');
  const trimmed = typeof adjustedCase === 'string' ? adjustedCase.trim() : '';
  return `${prefix}${trimmed}${suffix}`;
}

function extractWhitespaceAndCore(text = '') {
  const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return {
    prefix: match?.[1] || '',
    core: match?.[2] || text,
    suffix: match?.[3] || ''
  };
}

function matchFirstLetterCase(original, translated) {
  const desiredCase = getFirstLetterCase(original);
  if (!desiredCase) return translated;

  const match = translated.match(/\p{L}/u);
  if (!match || match.index === undefined) return translated;

  const index = match.index;
  const letter = match[0];

  if (desiredCase === 'upper') {
    const upper = letter.toLocaleUpperCase();
    return upper === letter
      ? translated
      : translated.slice(0, index) + upper + translated.slice(index + 1);
  }

  const lower = letter.toLocaleLowerCase();
  return lower === letter
    ? translated
    : translated.slice(0, index) + lower + translated.slice(index + 1);
}

function getFirstLetterCase(text) {
  const match = text.match(/\p{L}/u);
  if (!match) return null;

  const letter = match[0];
  if (letter === letter.toLocaleUpperCase() && letter !== letter.toLocaleLowerCase()) {
    return 'upper';
  }
  if (letter === letter.toLocaleLowerCase() && letter !== letter.toLocaleUpperCase()) {
    return 'lower';
  }
  return null;
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
