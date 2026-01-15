(() => {
  if (window.__neuroTranslateContentScriptLoaded) {
    return;
  }
  window.__neuroTranslateContentScriptLoaded = true;

let cancelRequested = false;
let translationError = null;
let translationProgress = { completedBlocks: 0, totalBlocks: 0 };
let translationInProgress = false;
let activeTranslationEntries = [];
let originalSnapshot = [];
let translationVisible = false;
let latestContextSummary = '';
let debugEntries = [];

const STORAGE_KEY = 'pageTranslations';
const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const PUNCTUATION_TOKENS = new Map([
  ['«', '⟦PUNC_LGUILLEMET⟧'],
  ['»', '⟦PUNC_RGUILLEMET⟧'],
  ['“', '⟦PUNC_LDQUOTE⟧'],
  ['”', '⟦PUNC_RDQUOTE⟧'],
  ['"', '⟦PUNC_DQUOTE⟧']
]);

restoreFromMemory();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'CANCEL_TRANSLATION') {
    cancelTranslation();
  }

  if (message?.type === 'START_TRANSLATION') {
    startTranslation();
  }

  if (message?.type === 'SET_TRANSLATION_VISIBILITY') {
    setTranslationVisibility(Boolean(message.visible));
  }

  if (message?.type === 'RECALCULATE_BLOCKS') {
    const limit = message.blockLengthLimit;
    Promise.resolve()
      .then(() => recalculateBlockCount(limit))
      .then((result) => {
        if (typeof sendResponse === 'function') {
          sendResponse(result);
        }
      });
    return true;
  }
});

async function startTranslation() {
  if (translationInProgress) {
    reportProgress('Перевод уже выполняется', translationProgress.completedBlocks, translationProgress.totalBlocks);
    return;
  }

  let settings = await requestSettings();
  if (!settings?.allowed) {
    await delay(500);
    settings = await requestSettings();
  }
  if (!settings?.allowed) {
    reportProgress('Перевод недоступен для этой страницы', translationProgress.completedBlocks, translationProgress.totalBlocks);
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
  debugEntries = [];
  latestContextSummary = '';
  await clearTranslationDebugInfo(location.href);

  const textStats = calculateTextLengthStats(nodesWithPath);
  const maxBlockLength = normalizeBlockLength(settings.blockLengthLimit, textStats.averageNodeLength);
  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const blocks = normalizeBlocksByLength(blockGroups, maxBlockLength);
  translationProgress = { completedBlocks: 0, totalBlocks: blocks.length };

  if (!blocks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return;
  }

  cancelRequested = false;
  translationError = null;
  reportProgress('Перевод запущен', 0, blocks.length, 0);

  if (settings.contextGenerationEnabled) {
    reportProgress('Генерация контекста', 0, blocks.length, 0);
    const pageText = buildPageText(nodesWithPath);
    if (pageText) {
      try {
        latestContextSummary = await requestTranslationContext(
          pageText,
          settings.targetLanguage || 'ru'
        );
      } catch (error) {
        console.warn('Context generation failed, continuing without it.', error);
      }
    }
  }

  const averageBlockLength = blocks.length ? Math.round(textStats.totalLength / blocks.length) : 0;
  const initialConcurrency = selectInitialConcurrency(averageBlockLength, blocks.length);
  const maxAllowedConcurrency = Math.max(1, Math.min(6, blocks.length));
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
      if (currentIndex >= blocks.length) {
        releaseSlot();
        return;
      }
      const block = blocks[currentIndex];
      const preparedTexts = block.map(({ node }) =>
        prepareTextForTranslation(node.nodeValue)
      );
      const { uniqueTexts, indexMap } = deduplicateTexts(preparedTexts);
      const blockTranslations = [];
      let proofreadReplacements = [];

      const startTime = performance.now();
      try {
        const keepPunctuationTokens = Boolean(settings.proofreadEnabled);
        const result = await translate(
          uniqueTexts,
          settings.targetLanguage || 'ru',
          settings.translationStyle,
          latestContextSummary,
          keepPunctuationTokens
        );
        const translatedTexts = block.map(({ node, original }, index) => {
          const translationIndex = indexMap[index];
          const translated = result.translations[translationIndex] || node.nodeValue;
          return applyOriginalFormatting(original, translated);
        });

        let finalTranslations = translatedTexts;
        if (settings.proofreadEnabled) {
          try {
            proofreadReplacements = await requestProofreading(
              translatedTexts,
              settings.targetLanguage || 'ru',
              latestContextSummary,
              block.map(({ original }) => original)
            );
            if (proofreadReplacements.length) {
              finalTranslations = applyProofreadingReplacements(translatedTexts, proofreadReplacements);
            }
          } catch (error) {
            console.warn('Proofreading failed, keeping original translations.', error);
          }
        }

        if (keepPunctuationTokens) {
          finalTranslations = finalTranslations.map((text) => restorePunctuationTokens(text));
        }

        block.forEach(({ node, path, original }, index) => {
          const withOriginalFormatting = finalTranslations[index] || node.nodeValue;
          node.nodeValue = withOriginalFormatting;
          blockTranslations.push(withOriginalFormatting);
          updateActiveEntry(path, original, withOriginalFormatting);
        });
        const debugEntry = {
          index: currentIndex + 1,
          original: formatBlockText(block.map(({ original }) => original)),
          translated: formatBlockText(blockTranslations),
          proofread: proofreadReplacements,
          proofreadApplied: Boolean(settings.proofreadEnabled)
        };
        debugEntries.push(debugEntry);
        await saveTranslationDebugInfo(location.href, {
          context: latestContextSummary,
          items: debugEntries,
          updatedAt: Date.now()
        });
      } catch (error) {
        console.error('Block translation failed', error);
        translationError = error;
        cancelRequested = true;
        releaseSlot();
        reportProgress('Ошибка перевода', translationProgress.completedBlocks, blocks.length, activeWorkers);
        return;
      }

      const duration = performance.now() - startTime;
      adjustConcurrency(duration);
      releaseSlot();

      translationProgress.completedBlocks += 1;
      reportProgress('Перевод выполняется', translationProgress.completedBlocks, blocks.length, activeWorkers);
    }
  };

  const workers = Array.from({ length: maxAllowedConcurrency }, () => worker());
  await Promise.all(workers);

  if (translationError) {
    reportProgress('Ошибка перевода', translationProgress.completedBlocks, blocks.length, activeWorkers);
    return;
  }

  if (cancelRequested) {
    reportProgress('Перевод отменён', translationProgress.completedBlocks, blocks.length, activeWorkers);
    return;
  }

  reportProgress('Перевод завершён', translationProgress.completedBlocks, blocks.length, activeWorkers);
  await saveTranslationsToMemory(activeTranslationEntries);
  await setTranslationVisibility(true);
}

async function translate(texts, targetLanguage, translationStyle, context, keepPunctuationTokens = false) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'TRANSLATE_TEXT',
        texts,
        targetLanguage,
        translationStyle,
        context,
        keepPunctuationTokens
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

async function requestProofreading(texts, targetLanguage, context, sourceTexts) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'PROOFREAD_TEXT',
        texts,
        targetLanguage,
        context,
        sourceTexts
      },
      (response) => {
        if (response?.success) {
          resolve(Array.isArray(response.replacements) ? response.replacements : []);
        } else {
          reject(new Error(response?.error || 'Не удалось выполнить вычитку.'));
        }
      }
    );
  });
}

function applyProofreadingReplacements(texts, replacements) {
  return texts.map((text) => {
    let result = text;
    replacements.forEach((replacement) => {
      if (!replacement?.from) return;
      const from = replacement.from;
      const to = replacement.to ?? '';
      result = result.split(from).join(to);
    });
    return result;
  });
}

function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restorePunctuationTokens(text = '') {
  let output = text;
  for (const [punctuation, token] of PUNCTUATION_TOKENS.entries()) {
    const tokenRegex = new RegExp(escapeRegex(token), 'gi');
    output = output.replace(tokenRegex, punctuation);
  }
  return output;
}

async function requestTranslationContext(text, targetLanguage) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'GENERATE_CONTEXT',
        text,
        targetLanguage
      },
      (response) => {
        if (response?.success) {
          resolve(response.context || '');
        } else {
          reject(new Error(response?.error || 'Не удалось сгенерировать контекст.'));
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

function calculateMaxBlockLength(averageNodeLength) {
  const scaled = averageNodeLength * 6;
  return Math.min(1500, Math.max(800, Math.round(scaled || 0)));
}

function normalizeBlockLength(limit, averageNodeLength) {
  const parsed = Number(limit);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.round(parsed);
  }
  return calculateMaxBlockLength(averageNodeLength);
}

function selectInitialConcurrency(averageBlockLength, blockCount) {
  let concurrency;
  if (averageBlockLength >= 1300) {
    concurrency = 1;
  } else if (averageBlockLength >= 1100) {
    concurrency = 2;
  } else if (averageBlockLength >= 900) {
    concurrency = 3;
  } else {
    concurrency = 4;
  }

  return Math.min(Math.max(concurrency, 1), Math.max(1, blockCount));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recalculateBlockCount(blockLengthLimit) {
  if (translationInProgress) {
    return { updated: false, totalBlocks: translationProgress.totalBlocks || 0 };
  }
  const textNodes = collectTextNodes(document.body);
  const nodesWithPath = textNodes.map((node) => ({
    node,
    path: getNodePath(node),
    original: node.nodeValue
  }));
  const textStats = calculateTextLengthStats(nodesWithPath);
  const maxBlockLength = normalizeBlockLength(blockLengthLimit, textStats.averageNodeLength);
  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const blocks = normalizeBlocksByLength(blockGroups, maxBlockLength);
  translationProgress = { completedBlocks: 0, totalBlocks: blocks.length };
  if (!blocks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return { updated: true, totalBlocks: 0, message: 'Перевод не требуется' };
  }
  reportProgress('Готово к переводу', 0, blocks.length, 0);
  return { updated: true, totalBlocks: blocks.length, message: 'Готово к переводу' };
}

function normalizeBlocksByLength(blocks, maxLength) {
  const normalized = [];
  blocks.forEach((block) => {
    if (block.length) {
      normalized.push(block);
    }
  });

  return mergeAdjacentBlocksByLength(normalized, maxLength);
}

function mergeAdjacentBlocksByLength(blocks, maxLength) {
  const merged = [];
  let current = [];
  let currentLength = 0;

  blocks.forEach((block) => {
    const blockLength = getBlockLength(block);
    if (!current.length) {
      current = block.slice();
      currentLength = blockLength;
      return;
    }

    if (currentLength + blockLength <= maxLength) {
      current.push(...block);
      currentLength += blockLength;
      return;
    }

    merged.push(current);
    current = block.slice();
    currentLength = blockLength;
  });

  if (current.length) merged.push(current);
  return merged;
}

function getBlockLength(block) {
  return block.reduce((sum, entry) => sum + (entry.node.nodeValue?.length || 0), 0);
}

function buildPageText(nodesWithPath, maxLength) {
  const combined = nodesWithPath
    .map(({ node }) => node?.nodeValue || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!combined) return '';
  if (!maxLength || combined.length <= maxLength) return combined;
  return combined.slice(0, maxLength).trimEnd();
}

function formatBlockText(texts) {
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

function reportProgress(message, completedBlocks, totalBlocks, inProgressBlocks = 0) {
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_PROGRESS',
    message,
    completedBlocks,
    totalBlocks,
    inProgressBlocks
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

async function saveTranslationDebugInfo(url, data) {
  if (!url) return;
  const existing = await getTranslationDebugObject();
  existing[url] = data;
  await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: existing });
}

async function clearTranslationDebugInfo(url) {
  const existing = await getTranslationDebugObject();
  delete existing[url];
  await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: existing });
}

async function getTranslationsObject() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve(data?.[STORAGE_KEY] || {});
    });
  });
}

async function getTranslationDebugObject() {
  return new Promise((resolve) => {
    chrome.storage.local.get([DEBUG_STORAGE_KEY], (data) => {
      resolve(data?.[DEBUG_STORAGE_KEY] || {});
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
  await clearTranslationDebugInfo(location.href);
  activeTranslationEntries = [];
  await setTranslationVisibility(false);
  reportProgress('Перевод отменён', translationProgress.completedBlocks, translationProgress.totalBlocks);
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
})();
