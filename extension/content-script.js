let cancelRequested = false;
let translationError = null;
let translationProgress = { completedChunks: 0, totalChunks: 0 };
let translationInProgress = false;
let activeTranslationEntries = [];
let originalSnapshot = [];
let translationVisible = false;

const STORAGE_KEY = 'pageTranslations';

restoreFromMemory();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelTranslation();
  }

  if (message?.type === 'START_TRANSLATION') {
    startTranslation();
  }

  if (message?.type === 'SET_TRANSLATION_VISIBILITY') {
    setTranslationVisibility(Boolean(message.visible));
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

  const textStats = calculateTextLengthStats(nodesWithPath);
  const maxChunkLength = calculateMaxChunkLength(textStats.averageNodeLength);
  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const chunks = chunkBlocks(blockGroups, maxChunkLength);
  translationProgress = { completedChunks: 0, totalChunks: chunks.length };

  if (!chunks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return;
  }

  cancelRequested = false;
  translationError = null;
  reportProgress('Перевод запущен', 0, chunks.length);

  const averageChunkLength = chunks.length ? Math.round(textStats.totalLength / chunks.length) : 0;
  const initialConcurrency = selectInitialConcurrency(averageChunkLength, chunks.length);
  const maxAllowedConcurrency = Math.max(1, Math.min(6, chunks.length));
  const requestDurations = [];
  let dynamicMaxConcurrency = initialConcurrency;
  let nextIndex = 0;
  let activeWorkers = 0;

  const acquireSlot = async () => {
    while (activeWorkers >= dynamicMaxConcurrency && !cancelRequested) {
      await delay(50);
    }
    activeWorkers += 1;
  };

  const releaseSlot = () => {
    activeWorkers = Math.max(0, activeWorkers - 1);
  };

  const adjustConcurrency = (durationMs) => {
    requestDurations.push(durationMs);
    if (requestDurations.length > 5) requestDurations.shift();
    const averageDuration =
      requestDurations.reduce((sum, value) => sum + value, 0) / requestDurations.length;

    if (averageDuration > 4500 && dynamicMaxConcurrency > 1) {
      dynamicMaxConcurrency = Math.max(1, dynamicMaxConcurrency - 1);
    } else if (averageDuration < 2500 && dynamicMaxConcurrency < maxAllowedConcurrency) {
      dynamicMaxConcurrency += 1;
    }
  };

  const worker = async () => {
    while (true) {
      if (cancelRequested) return;
      await acquireSlot();

      if (cancelRequested) {
        releaseSlot();
        return;
      }

      const currentIndex = nextIndex++;
      if (currentIndex >= chunks.length) {
        releaseSlot();
        return;
      }
      const chunk = chunks[currentIndex];
      const preparedTexts = chunk.map(({ node }) => prepareTextForTranslation(node.nodeValue));
      const { uniqueTexts, indexMap } = deduplicateTexts(preparedTexts);
      const chunkContext = buildChunkContext(chunk);

      const startTime = performance.now();
      try {
        const result = await translate(
          uniqueTexts,
          settings.targetLanguage || 'ru',
          settings.translationStyle,
          chunkContext
        );
        chunk.forEach(({ node, path, original }, index) => {
          const translationIndex = indexMap[index];
          const translated = result.translations[translationIndex] || node.nodeValue;
          const withOriginalFormatting = applyOriginalFormatting(original, translated);
          node.nodeValue = withOriginalFormatting;
          updateActiveEntry(path, original, withOriginalFormatting);
        });
      } catch (error) {
        console.error('Chunk translation failed', error);
        translationError = error;
        cancelRequested = true;
        reportProgress('Ошибка перевода', translationProgress.completedChunks, chunks.length);
        releaseSlot();
        return;
      }

      const duration = performance.now() - startTime;
      adjustConcurrency(duration);
      releaseSlot();

      translationProgress.completedChunks += 1;
      reportProgress('Перевод выполняется', translationProgress.completedChunks, chunks.length);
    }
  };

  const workers = Array.from({ length: maxAllowedConcurrency }, () => worker());
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
  await setTranslationVisibility(true);
}

async function translate(texts, targetLanguage, translationStyle, context) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_TEXT',
        texts,
        targetLanguage,
        translationStyle,
        context
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

function deduplicateTexts(texts) {
  const uniqueTexts = [];
  const indexMap = [];
  const seen = new Map();

  texts.forEach((text) => {
    if (!seen.has(text)) {
      seen.set(text, uniqueTexts.length);
      uniqueTexts.push(text);
    }
    indexMap.push(seen.get(text));
  });

  return { uniqueTexts, indexMap };
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

function calculateTextLengthStats(nodesWithPath) {
  const totalLength = nodesWithPath.reduce(
    (sum, { node }) => sum + (node?.nodeValue?.length || 0),
    0
  );
  const averageNodeLength = nodesWithPath.length ? totalLength / nodesWithPath.length : 0;
  return { totalLength, averageNodeLength };
}

function calculateMaxChunkLength(averageNodeLength) {
  const scaled = averageNodeLength * 6;
  return Math.min(1500, Math.max(800, Math.round(scaled || 0)));
}

function selectInitialConcurrency(averageChunkLength, chunkCount) {
  let concurrency;
  if (averageChunkLength >= 1300) {
    concurrency = 1;
  } else if (averageChunkLength >= 1100) {
    concurrency = 2;
  } else if (averageChunkLength >= 900) {
    concurrency = 3;
  } else {
    concurrency = 4;
  }

  return Math.min(Math.max(concurrency, 1), Math.max(1, chunkCount));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function buildChunkContext(chunk, maxLength = 500) {
  const combined = chunk
    .map(({ node }) => (node?.nodeValue || '').trim())
    .filter(Boolean)
    .join(' ');

  const normalized = combined.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength).trimEnd();
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
    await setTranslationVisibility(true);
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
  await setTranslationVisibility(false);
  reportProgress('Перевод отменён', translationProgress.completedChunks, translationProgress.totalChunks);
}

async function setTranslationVisibility(visible) {
  translationVisible = visible;
  if (translationVisible) {
    await restoreTranslations();
  } else {
    const entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
    if (entriesToRestore.length) {
      restoreOriginal(entriesToRestore);
    }
  }
  notifyVisibilityChange();
}

async function restoreTranslations() {
  const storedEntries = activeTranslationEntries.length ? activeTranslationEntries : await getStoredTranslations(location.href);
  if (!storedEntries.length) return;

  const restoredSnapshot = [];
  const updatedEntries = [];

  storedEntries.forEach(({ path, translated, original }) => {
    const node = findNodeByPath(path);
    if (!node) return;
    const originalValue = typeof original === 'string' ? original : node.nodeValue;
    node.nodeValue = translated;
    restoredSnapshot.push({ path, original: originalValue });
    updatedEntries.push({ path, original: originalValue, translated });
  });

  if (restoredSnapshot.length) {
    originalSnapshot = restoredSnapshot;
    activeTranslationEntries = updatedEntries;
  }
}

function notifyVisibilityChange() {
  chrome.runtime.sendMessage({ type: 'UPDATE_TRANSLATION_VISIBILITY', visible: translationVisible });
}
