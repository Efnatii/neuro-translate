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
let debugState = null;
let tpmLimiter = null;
let tpmSettings = {
  outputRatioByRole: {
    translation: 0.6,
    context: 0.4,
    proofread: 0.5
  },
  safetyBufferTokens: 100
};

const STORAGE_KEY = 'pageTranslations';
const DEBUG_STORAGE_KEY = 'translationDebugByUrl';
const RATE_LIMIT_RETRY_ATTEMPTS = 2;
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

  if (message?.type === 'GET_TRANSLATION_VISIBILITY') {
    Promise.resolve()
      .then(async () => {
        const storedEntries = activeTranslationEntries.length
          ? []
          : await getStoredTranslations(location.href);
        const hasTranslations = Boolean(
          activeTranslationEntries.length > 0 ||
          storedEntries.length > 0
        );
        if (typeof sendResponse === 'function') {
          sendResponse({ visible: translationVisible, hasTranslations });
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
    reportProgress(
      settings?.disallowedReason || 'Перевод недоступен для этой страницы',
      translationProgress.completedBlocks,
      translationProgress.totalBlocks
    );
    return;
  }

  if (!translationVisible) {
    await setTranslationVisibility(true);
  }

  configureTpmLimiter(settings);
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
      if (chrome.runtime.lastError) {
        console.error('Failed to reach extension background script.', chrome.runtime.lastError.message);
        resolve({
          allowed: false,
          disallowedReason:
            'Не удалось связаться с фоном расширения. Перезагрузите вкладку или расширение.'
        });
        return;
      }
      if (response) {
        resolve(response);
        return;
      }
      console.warn('Settings response is empty without runtime error.');
      if (!response) {
        resolve({
          allowed: false,
          disallowedReason:
            'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.'
        });
        return;
      }
      resolve(response);
    });
  });
}

async function translatePage(settings) {
  const textNodes = collectTextNodes(document.body);
  const existingDebugStore = await getTranslationDebugObject();
  const existingDebugEntry = existingDebugStore?.[location.href];
  const existingContext =
    settings.contextGenerationEnabled && typeof existingDebugEntry?.context === 'string'
      ? existingDebugEntry.context.trim()
      : '';
  const nodesWithPath = textNodes.map((node) => ({
    node,
    path: getNodePath(node),
    original: node.nodeValue,
    originalHash: computeTextHash(node.nodeValue || '')
  }));
  originalSnapshot = nodesWithPath.map(({ path, original, originalHash }) => ({
    path,
    original,
    originalHash
  }));
  activeTranslationEntries = [];
  debugEntries = [];
  debugState = null;
  latestContextSummary = existingContext;
  await clearTranslationDebugInfo(location.href);

  const textStats = calculateTextLengthStats(nodesWithPath);
  const maxBlockLength = normalizeBlockLength(settings.blockLengthLimit, textStats.averageNodeLength);
  const blockGroups = groupTextNodesByBlock(nodesWithPath);
  const blocks = normalizeBlocksByLength(blockGroups, maxBlockLength);
  translationProgress = { completedBlocks: 0, totalBlocks: blocks.length };
  await initializeDebugState(blocks, settings);
  if (latestContextSummary) {
    await updateDebugContext(latestContextSummary, 'done');
  }

  if (!blocks.length) {
    reportProgress('Перевод не требуется', 0, 0);
    return;
  }

  cancelRequested = false;
  translationError = null;
  reportProgress('Перевод запущен', 0, blocks.length, 0);

  if (settings.contextGenerationEnabled && !latestContextSummary) {
    await updateDebugContextStatus('in_progress');
    reportProgress('Генерация контекста', 0, blocks.length, 0);
    const pageText = buildPageText(nodesWithPath);
    if (pageText) {
      try {
        latestContextSummary = await requestTranslationContext(
          pageText,
          settings.targetLanguage || 'ru'
        );
        await updateDebugContext(latestContextSummary, 'done');
      } catch (error) {
        console.warn('Context generation failed, continuing without it.', error);
        await updateDebugContext(latestContextSummary, 'failed');
      }
    } else {
      await updateDebugContext(latestContextSummary, 'done');
    }
  }

  const averageBlockLength = blocks.length ? Math.round(textStats.totalLength / blocks.length) : 0;
  const initialConcurrency = selectInitialConcurrency(averageBlockLength, blocks.length);
  const maxAllowedConcurrency = Math.max(1, Math.min(6, blocks.length));
  const requestDurations = [];
  let dynamicMaxConcurrency = initialConcurrency;
  let activeTranslationWorkers = 0;
  let activeProofreadWorkers = 0;
  let translationQueueDone = false;
  const translationQueue = [];
  const proofreadQueue = [];
  const translationQueueKeys = new Set();
  const proofreadQueueKeys = new Set();
  const proofreadConcurrency = Math.max(1, Math.min(4, blocks.length));

  const getBlockKey = (block) =>
    block
      .map(({ path, original, originalHash }) => {
        const hashValue = getOriginalHash(original, originalHash);
        return `${JSON.stringify(path)}::${original}::${hashValue ?? 'nohash'}`;
      })
      .join('||');

  const enqueueTranslationBlock = (block, index) => {
    const key = getBlockKey(block);
    if (translationQueueKeys.has(key)) {
      return false;
    }
    translationQueueKeys.add(key);
    translationQueue.push({ block, index, key });
    return true;
  };

  const enqueueProofreadTask = (task) => {
    if (!task?.key || proofreadQueueKeys.has(task.key)) {
      return false;
    }
    proofreadQueueKeys.add(task.key);
    proofreadQueue.push(task);
    return true;
  };

  const acquireTranslationSlot = async () => {
    while (activeTranslationWorkers >= dynamicMaxConcurrency && !cancelRequested) {
      await delay(50);
    }
    activeTranslationWorkers += 1;
  };

  const releaseTranslationSlot = () => {
    activeTranslationWorkers = Math.max(0, activeTranslationWorkers - 1);
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

  const translationWorker = async () => {
    while (true) {
      if (cancelRequested) return;
      await acquireTranslationSlot();

      if (cancelRequested) {
        releaseTranslationSlot();
        return;
      }

      const queuedItem = translationQueue.shift();
      if (!queuedItem) {
        releaseTranslationSlot();
        return;
      }
      const currentIndex = queuedItem.index;
      const block = queuedItem.block;
      await updateDebugEntry(currentIndex + 1, {
        translationStatus: 'in_progress',
        proofreadStatus: settings.proofreadEnabled ? 'pending' : 'disabled'
      });
      reportProgress('Перевод выполняется');
      const preparedTexts = block.map(({ original }) =>
        prepareTextForTranslation(original)
      );
      const { uniqueTexts, indexMap } = deduplicateTexts(preparedTexts);
      const blockTranslations = [];

      const startTime = performance.now();
      try {
        const keepPunctuationTokens = Boolean(settings.proofreadEnabled);
        const result = await translate(
          uniqueTexts,
          settings.targetLanguage || 'ru',
          latestContextSummary,
          keepPunctuationTokens
        );
        if (result.translations.length !== uniqueTexts.length) {
          throw new Error(
            `Translation length mismatch: expected ${uniqueTexts.length}, got ${result.translations.length}`
          );
        }
        const translatedTexts = block.map(({ original }, index) => {
          const translationIndex = indexMap[index];
          if (translationIndex == null || translationIndex < 0 || translationIndex >= result.translations.length) {
            throw new Error(`Translation index mismatch at segment ${index}`);
          }
          const translated = result.translations[translationIndex] || original;
          return applyOriginalFormatting(original, translated);
        });
        if (translatedTexts.length !== block.length) {
          throw new Error(`Block translation length mismatch: expected ${block.length}, got ${translatedTexts.length}`);
        }

        let finalTranslations = translatedTexts;
        if (keepPunctuationTokens) {
          finalTranslations = finalTranslations.map((text) => restorePunctuationTokens(text));
        }

        block.forEach(({ node, path, original, originalHash }, index) => {
          if (!shouldApplyTranslation(node, original, originalHash)) {
            blockTranslations.push(node.nodeValue);
            return;
          }
          const withOriginalFormatting = finalTranslations[index] || node.nodeValue;
          if (translationVisible) {
            node.nodeValue = withOriginalFormatting;
          }
          blockTranslations.push(withOriginalFormatting);
          updateActiveEntry(path, original, withOriginalFormatting, originalHash);
        });
        await updateDebugEntry(currentIndex + 1, {
          translated: formatBlockText(blockTranslations),
          translatedSegments: translatedTexts,
          translationStatus: 'done',
          translationRaw: result.rawTranslation || ''
        });

        if (settings.proofreadEnabled) {
          enqueueProofreadTask({
            block,
            index: currentIndex,
            key: queuedItem.key,
            translatedTexts,
            originalTexts: block.map(({ original }) => original)
          });
        }
      } catch (error) {
        console.error('Block translation failed', error);
        translationError = error;
        cancelRequested = true;
        await updateDebugEntry(currentIndex + 1, {
          translationStatus: 'failed',
          proofreadStatus: settings.proofreadEnabled ? 'failed' : 'disabled'
        });
        releaseTranslationSlot();
        reportProgress(
          'Ошибка перевода',
          translationProgress.completedBlocks,
          totalBlocks,
          activeTranslationWorkers
        );
        return;
      }

      const duration = performance.now() - startTime;
      adjustConcurrency(duration);
      releaseTranslationSlot();

      translationProgress.completedBlocks += 1;
      reportProgress(
        'Перевод выполняется',
        translationProgress.completedBlocks,
        totalBlocks,
        activeTranslationWorkers
      );
    }
  };

  const proofreadWorker = async () => {
    while (true) {
      if (cancelRequested) return;
      const task = proofreadQueue.shift();
      if (!task) {
        if (translationQueueDone) return;
        await delay(50);
        continue;
      }

      activeProofreadWorkers += 1;
      try {
        await updateDebugEntry(task.index + 1, { proofreadStatus: 'in_progress' });
        const proofreadResult = await requestProofreading({
          segments: task.translatedTexts,
          sourceBlock: formatBlockText(task.originalTexts),
          translatedBlock: formatBlockText(task.translatedTexts),
          context: latestContextSummary || '',
          language: settings.targetLanguage || 'ru'
        });
        const revisedSegments = Array.isArray(proofreadResult.translations)
          ? proofreadResult.translations
          : [];
        const proofreadSummary = [];
        let finalTranslations = task.translatedTexts.map((text, index) => {
          const revision = revisedSegments[index];
          if (typeof revision === 'string' && revision.length > 0) {
            proofreadSummary.push({ segmentIndex: index, revisedText: revision });
            return revision;
          }
          return text;
        });
        finalTranslations = finalTranslations.map((text, index) =>
          applyOriginalFormatting(task.originalTexts[index], text)
        );
        finalTranslations = finalTranslations.map((text) => restorePunctuationTokens(text));
        if (finalTranslations.length !== task.block.length) {
          throw new Error(
            `Proofread length mismatch: expected ${task.block.length}, got ${finalTranslations.length}`
          );
        }

        task.block.forEach(({ node, path, original, originalHash }, index) => {
          if (!shouldApplyTranslation(node, original, originalHash)) {
            return;
          }
          const withOriginalFormatting = finalTranslations[index] || node.nodeValue;
          if (translationVisible) {
            node.nodeValue = withOriginalFormatting;
          }
          updateActiveEntry(path, original, withOriginalFormatting, originalHash);
        });

        const rawProofreadPayload = proofreadResult.rawProofread || '';
        const rawProofread =
          typeof rawProofreadPayload === 'string'
            ? rawProofreadPayload
            : JSON.stringify(rawProofreadPayload, null, 2);
        await updateDebugEntry(task.index + 1, {
          proofreadStatus: 'done',
          proofread: proofreadSummary,
          proofreadRaw: rawProofread
        });
        reportProgress('Вычитка выполняется');
      } catch (error) {
        console.warn('Proofreading failed, keeping original translations.', error);
        await updateDebugEntry(task.index + 1, {
          proofreadStatus: 'failed',
          proofread: []
        });
        reportProgress('Вычитка выполняется');
      } finally {
        activeProofreadWorkers = Math.max(0, activeProofreadWorkers - 1);
      }
    }
  };

  blocks.forEach((block, index) => {
    enqueueTranslationBlock(block, index);
  });
  translationProgress.totalBlocks = translationQueue.length;
  const totalBlocks = translationProgress.totalBlocks;

  if (totalBlocks !== blocks.length) {
    reportProgress('Перевод запущен', translationProgress.completedBlocks, totalBlocks, 0);
  }

  const workers = Array.from({ length: maxAllowedConcurrency }, () => translationWorker());
  const proofreadWorkers = settings.proofreadEnabled
    ? Array.from({ length: proofreadConcurrency }, () => proofreadWorker())
    : [];
  await Promise.all(workers);
  translationQueueDone = true;
  await Promise.all(proofreadWorkers);

  if (translationError) {
    reportProgress('Ошибка перевода', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
    return;
  }

  if (cancelRequested) {
    reportProgress('Перевод отменён', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
    return;
  }

  reportProgress('Перевод завершён', translationProgress.completedBlocks, totalBlocks, activeTranslationWorkers);
  await saveTranslationsToMemory(activeTranslationEntries);
}

async function translate(texts, targetLanguage, context, keepPunctuationTokens = false) {
  const estimatedTokens = estimateTokensForRole('translation', {
    texts,
    context
  });
  await ensureTpmBudget('translation', estimatedTokens);
  await incrementDebugAiRequestCount();
  return withRateLimitRetry(
    () =>
      sendRuntimeMessage(
        {
          type: 'TRANSLATE_TEXT',
          texts,
          targetLanguage,
          context,
          keepPunctuationTokens
        },
        'Не удалось выполнить перевод.'
      ),
    'Translation'
  );
}

async function requestProofreading(payload) {
  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  const sourceBlock = payload?.sourceBlock || '';
  const translatedBlock = payload?.translatedBlock || '';
  const context = payload?.context || '';
  const estimatedTokens = estimateTokensForRole('proofread', {
    texts: segments,
    context,
    sourceTexts: [sourceBlock, translatedBlock]
  });
  await ensureTpmBudget('proofread', estimatedTokens);
  await incrementDebugAiRequestCount();
  return withRateLimitRetry(
    async () => {
      const response = await sendRuntimeMessage(
        {
          type: 'PROOFREAD_TEXT',
          segments,
          sourceBlock,
          translatedBlock,
          context,
          language: payload?.language || ''
        },
        'Не удалось выполнить вычитку.'
      );
      return {
        translations: Array.isArray(response.translations) ? response.translations : [],
        rawProofread: response.rawProofread || ''
      };
    },
    'Proofreading'
  );
}

function sendRuntimeMessage(payload, fallbackError) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || fallbackError));
        return;
      }
      if (response?.success) {
        resolve(response);
        return;
      }
      reject(new Error(response?.error || fallbackError));
    });
  });
}

function parseRateLimitDelayMs(error) {
  const message = error?.message;
  if (!message) return null;
  const match = message.match(/retry in\s+(\d+(?:\.\d+)?)\s*seconds/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1000, Math.round(seconds * 1000));
}

async function withRateLimitRetry(requestFn, label) {
  let attempt = 0;
  while (true) {
    try {
      return await requestFn();
    } catch (error) {
      const delayMs = parseRateLimitDelayMs(error);
      if (!delayMs || attempt >= RATE_LIMIT_RETRY_ATTEMPTS || cancelRequested) {
        throw error;
      }
      attempt += 1;
      console.warn(`${label} rate-limited, retrying after ${Math.ceil(delayMs / 1000)}s...`);
      await delay(delayMs);
    }
  }
}

function formatLogDetails(details) {
  if (details === null || details === undefined) return '';
  try {
    const serialized = JSON.stringify(details);
    return serialized ? ` ${serialized}` : '';
  } catch (error) {
    return ` ${String(details)}`;
  }
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
  const estimatedTokens = estimateTokensForRole('context', {
    texts: [text]
  });
  await ensureTpmBudget('context', estimatedTokens);
  await incrementDebugAiRequestCount();
  const response = await sendRuntimeMessage(
    {
      type: 'GENERATE_CONTEXT',
      text,
      targetLanguage
    },
    'Не удалось сгенерировать контекст.'
  );
  return response.context || '';
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
    entry.blockElement = blockElement;
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

function configureTpmLimiter(settings = {}) {
  const limitsByRole = settings?.tpmLimitsByRole || {};
  tpmSettings = {
    outputRatioByRole: {
      ...tpmSettings.outputRatioByRole,
      ...(settings?.outputRatioByRole || {})
    },
    safetyBufferTokens: Number.isFinite(settings?.tpmSafetyBufferTokens)
      ? settings.tpmSafetyBufferTokens
      : tpmSettings.safetyBufferTokens
  };
  tpmLimiter = createTpmLimiter(limitsByRole, tpmSettings.safetyBufferTokens);
}

function createTpmLimiter(limitsByRole = {}, safetyBufferTokens = 0) {
  const entriesByRole = new Map();
  const windowMs = 60000;

  const getEntries = (role) => {
    if (!entriesByRole.has(role)) {
      entriesByRole.set(role, []);
    }
    return entriesByRole.get(role);
  };

  const prune = (role, now) => {
    const entries = getEntries(role);
    while (entries.length && entries[0].timestamp <= now - windowMs) {
      entries.shift();
    }
  };

  const getUsedTokens = (role, now) => {
    prune(role, now);
    const entries = getEntries(role);
    return entries.reduce((sum, entry) => sum + entry.tokens, 0);
  };

  const recordUsage = (role, tokens, now) => {
    const entries = getEntries(role);
    entries.push({ timestamp: now, tokens });
  };

  const getNextAvailableDelay = (role, now) => {
    const entries = getEntries(role);
    if (!entries.length) return 0;
    const earliest = entries[0];
    const expiresAt = earliest.timestamp + windowMs;
    return Math.max(25, expiresAt - now + 25);
  };

  const waitForBudget = async (role, tokens) => {
    const limit = Number(limitsByRole?.[role]);
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }

    const bufferedLimit = Math.max(0, limit - safetyBufferTokens);
    if (tokens > bufferedLimit) {
      recordUsage(role, tokens, Date.now());
      return;
    }

    while (true) {
      const now = Date.now();
      const used = getUsedTokens(role, now);
      if (used + tokens <= bufferedLimit) {
        recordUsage(role, tokens, now);
        return;
      }
      const waitMs = getNextAvailableDelay(role, now);
      await delay(waitMs || 50);
    }
  };

  return { waitForBudget };
}

function estimateTokensForRole(role, { texts = [], context = '', sourceTexts = [] } = {}) {
  const allTexts = Array.isArray(texts) ? texts : [texts];
  const allSources = Array.isArray(sourceTexts) ? sourceTexts : [sourceTexts];
  const inputChars = [context, ...allTexts, ...allSources]
    .filter((item) => typeof item === 'string' && item.length)
    .reduce((sum, item) => sum + item.length, 0);
  const inputTokens = Math.max(1, Math.ceil(inputChars / 4));
  const ratio = Number(tpmSettings?.outputRatioByRole?.[role]);
  const outputRatio = Number.isFinite(ratio) ? ratio : 0.5;
  const estimatedOutput = Math.ceil(inputTokens * outputRatio);
  return inputTokens + estimatedOutput;
}

async function ensureTpmBudget(role, tokens) {
  if (!tpmLimiter || !Number.isFinite(tokens) || tokens <= 0) {
    return;
  }
  await tpmLimiter.waitForBudget(role, tokens);
}

function recalculateBlockCount(blockLengthLimit) {
  if (translationInProgress) {
    return { updated: false, totalBlocks: translationProgress.totalBlocks || 0 };
  }
  const textNodes = collectTextNodes(document.body);
  const nodesWithPath = textNodes.map((node) => ({
    node,
    path: getNodePath(node),
    original: node.nodeValue,
    originalHash: computeTextHash(node.nodeValue || '')
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
  const snapshot = getProgressSnapshot();
  const resolvedCompleted = Number.isFinite(snapshot?.completedBlocks)
    ? snapshot.completedBlocks
    : completedBlocks || 0;
  const resolvedTotal = Number.isFinite(snapshot?.totalBlocks) ? snapshot.totalBlocks : totalBlocks || 0;
  const resolvedInProgress = Number.isFinite(snapshot?.inProgressBlocks)
    ? snapshot.inProgressBlocks
    : inProgressBlocks || 0;
  translationProgress = {
    completedBlocks: resolvedCompleted,
    totalBlocks: resolvedTotal,
    inProgressBlocks: resolvedInProgress
  };
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_PROGRESS',
    message,
    completedBlocks: resolvedCompleted,
    totalBlocks: resolvedTotal,
    inProgressBlocks: resolvedInProgress
  });
}

function getProgressSnapshot() {
  if (Array.isArray(debugEntries) && debugEntries.length) {
    return computeTranslationProgress(debugEntries);
  }
  return null;
}

function computeTranslationProgress(entries) {
  const totalBlocks = entries.length;
  let completedBlocks = 0;
  let inProgressBlocks = 0;
  let failedBlocks = 0;

  entries.forEach((entry) => {
    const status = getOverallEntryStatus(entry);
    if (status === 'done') {
      completedBlocks += 1;
    } else if (status === 'in_progress') {
      inProgressBlocks += 1;
    } else if (status === 'failed') {
      failedBlocks += 1;
    }
  });

  return {
    completedBlocks,
    totalBlocks,
    inProgressBlocks,
    failedBlocks
  };
}

function getOverallEntryStatus(entry) {
  if (!entry) return 'pending';
  const translationStatus = normalizeEntryStatus(entry.translationStatus, entry.translated);
  const proofreadApplied = entry.proofreadApplied !== false;
  const proofreadStatus = normalizeEntryStatus(
    entry.proofreadStatus,
    entry.proofread,
    proofreadApplied
  );

  if (translationStatus === 'failed') return 'failed';
  if (proofreadApplied) {
    if (proofreadStatus === 'failed') return 'failed';
    if (translationStatus === 'done' && proofreadStatus === 'done') return 'done';
    if (translationStatus === 'in_progress' || proofreadStatus === 'in_progress') return 'in_progress';
    if (translationStatus === 'done' && proofreadStatus === 'pending') return 'in_progress';
    return 'pending';
  }

  if (translationStatus === 'done') return 'done';
  if (translationStatus === 'in_progress') return 'in_progress';
  return 'pending';
}

function normalizeEntryStatus(status, value, proofreadApplied = true) {
  if (status) return status;
  if (proofreadApplied === false) return 'disabled';
  if (Array.isArray(value)) {
    return 'done';
  }
  if (typeof value === 'string' && value.trim()) {
    return 'done';
  }
  return 'pending';
}

async function restoreFromMemory() {
  const stored = await getStoredTranslations(location.href);
  if (!stored?.length) return;

  const restoredSnapshot = [];
  stored.forEach(({ path, translated, original, originalHash }) => {
    const node = findNodeByPath(path);
    if (node) {
      const originalValue = typeof original === 'string' ? original : node.nodeValue;
      const resolvedOriginalHash = getOriginalHash(originalValue, originalHash);
      if (!shouldApplyTranslation(node, originalValue, resolvedOriginalHash)) {
        return;
      }
      activeTranslationEntries.push({
        path,
        original: originalValue,
        originalHash: resolvedOriginalHash,
        translated
      });
      restoredSnapshot.push({ path, original: originalValue, originalHash: resolvedOriginalHash });
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

function computeTextHash(text = '') {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function getOriginalHash(original, originalHash) {
  if (Number.isFinite(originalHash)) {
    return originalHash;
  }
  if (typeof original === 'string') {
    return computeTextHash(original);
  }
  return null;
}

function shouldApplyTranslation(node, original, originalHash) {
  const currentText = node?.nodeValue ?? '';
  if (typeof original === 'string') {
    return currentText === original;
  }
  if (Number.isFinite(originalHash)) {
    return computeTextHash(currentText) === originalHash;
  }
  return false;
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

function updateActiveEntry(path, original, translated, originalHash) {
  const existingIndex = activeTranslationEntries.findIndex((entry) => isSamePath(entry.path, path));
  const resolvedOriginalHash = getOriginalHash(original, originalHash);
  if (existingIndex >= 0) {
    activeTranslationEntries[existingIndex] = {
      path,
      original,
      originalHash: resolvedOriginalHash,
      translated
    };
  } else {
    activeTranslationEntries.push({
      path,
      original,
      originalHash: resolvedOriginalHash,
      translated
    });
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

async function resetTranslationDebugInfo(url) {
  if (!url) return;
  const existing = await getTranslationDebugObject();
  const entry = existing[url];
  if (!entry) return;
  const context = typeof entry.context === 'string' ? entry.context : '';
  const contextStatus = entry.contextStatus || (context ? 'done' : 'pending');
  existing[url] = {
    context,
    contextStatus,
    items: [],
    aiRequestCount: 0,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [DEBUG_STORAGE_KEY]: existing });
}

async function initializeDebugState(blocks, settings = {}) {
  const proofreadEnabled = Boolean(settings.proofreadEnabled);
  debugEntries = blocks.map((block, index) => ({
    index: index + 1,
    original: formatBlockText(block.map(({ original }) => original)),
    originalSegments: block.map(({ original }) => original),
    translated: '',
    translatedSegments: [],
    translationRaw: '',
    proofread: [],
    proofreadRaw: '',
    proofreadApplied: proofreadEnabled,
    translationStatus: 'pending',
    proofreadStatus: proofreadEnabled ? 'pending' : 'disabled'
  }));
  debugState = {
    context: '',
    contextStatus: settings.contextGenerationEnabled ? 'pending' : 'disabled',
    items: debugEntries,
    aiRequestCount: 0,
    updatedAt: Date.now()
  };
  await saveTranslationDebugInfo(location.href, debugState);
}

async function persistDebugState() {
  if (!debugState) return;
  debugState.updatedAt = Date.now();
  debugState.items = debugEntries;
  await saveTranslationDebugInfo(location.href, debugState);
}

async function updateDebugContext(context, status) {
  if (!debugState) return;
  debugState.context = typeof context === 'string' ? context : debugState.context || '';
  if (status) {
    debugState.contextStatus = status;
  }
  await persistDebugState();
}

async function updateDebugContextStatus(status) {
  if (!debugState) return;
  debugState.contextStatus = status;
  await persistDebugState();
}

async function updateDebugEntry(index, updates = {}) {
  const entry = debugEntries.find((item) => item.index === index);
  if (!entry) return;
  Object.assign(entry, updates);
  await persistDebugState();
}

async function incrementDebugAiRequestCount() {
  if (!debugState) return;
  const currentCount = Number.isFinite(debugState.aiRequestCount) ? debugState.aiRequestCount : 0;
  debugState.aiRequestCount = currentCount + 1;
  await persistDebugState();
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
  if (!Array.isArray(entries) || !entries.length) return;
  let restoredCount = 0;
  entries.forEach(({ path, original }) => {
    const node = findNodeByPath(path);
    if (!node) {
      console.warn(`Missing node while restoring original.${formatLogDetails({ path })}`);
      return;
    }
    if (typeof original !== 'string') {
      console.warn(`Missing original text while restoring.${formatLogDetails({ path })}`);
      return;
    }
    node.nodeValue = original;
    restoredCount += 1;
  });
  if (restoredCount !== entries.length) {
    console.warn(
      `Not all originals restored.${formatLogDetails({
        restoredCount,
        totalEntries: entries.length
      })}`
    );
  }
}

async function cancelTranslation() {
  cancelRequested = true;
  const entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
  if (entriesToRestore.length) {
    restoreOriginal(entriesToRestore);
  }
  await clearStoredTranslations(location.href);
  await resetTranslationDebugInfo(location.href);
  activeTranslationEntries = [];
  originalSnapshot = [];
  debugState = null;
  translationProgress = { completedBlocks: 0, totalBlocks: 0, inProgressBlocks: 0 };
  translationVisible = false;
  notifyVisibilityChange();
  reportProgress('Перевод отменён', 0, 0, 0);
  const tabId = await getActiveTabId();
  chrome.runtime.sendMessage({ type: 'TRANSLATION_CANCELLED', tabId });
}

function getActiveTabId() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_TAB_ID' }, (response) => {
      resolve(response?.tabId ?? null);
    });
  });
}

async function setTranslationVisibility(visible) {
  translationVisible = visible;
  if (translationVisible) {
    await restoreTranslations();
  } else {
    let entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
    if (!entriesToRestore.length) {
      await hydrateStoredTranslations();
      entriesToRestore = activeTranslationEntries.length ? activeTranslationEntries : originalSnapshot;
    }
    if (entriesToRestore.length) {
      restoreOriginal(entriesToRestore);
    }
  }
  notifyVisibilityChange();
}

async function hydrateStoredTranslations() {
  if (activeTranslationEntries.length) return;
  const storedEntries = await getStoredTranslations(location.href);
  if (!storedEntries.length) return;
  activeTranslationEntries = storedEntries.map(({ path, translated, original, originalHash }) => ({
    path,
    translated,
    original,
    originalHash
  }));
  if (!originalSnapshot.length) {
    originalSnapshot = storedEntries.map(({ path, original, originalHash }) => ({
      path,
      original,
      originalHash
    }));
  }
}

async function restoreTranslations() {
  const storedEntries = activeTranslationEntries.length ? activeTranslationEntries : await getStoredTranslations(location.href);
  if (!storedEntries.length) return;

  const restoredSnapshot = [];
  const updatedEntries = [];
  let appliedCount = 0;

  storedEntries.forEach(({ path, translated, original, originalHash }) => {
    const node = findNodeByPath(path);
    const originalValue = typeof original === 'string' ? original : node?.nodeValue;
    const resolvedOriginalHash = getOriginalHash(originalValue, originalHash);
    if (!node) {
      console.warn(`Missing node while restoring translation.${formatLogDetails({ path })}`);
    } else {
      node.nodeValue = translated;
      appliedCount += 1;
      restoredSnapshot.push({
        path,
        original: originalValue,
        originalHash: resolvedOriginalHash
      });
    }
    updatedEntries.push({
      path,
      original: originalValue,
      originalHash: resolvedOriginalHash,
      translated
    });
  });

  if (appliedCount !== storedEntries.length) {
    console.warn(
      `Not all translations restored.${formatLogDetails({
        appliedCount,
        totalEntries: storedEntries.length
      })}`
    );
  }

  if (updatedEntries.length) {
    originalSnapshot = updatedEntries.map(({ path, original, originalHash }) => ({
      path,
      original,
      originalHash
    }));
    activeTranslationEntries = updatedEntries;
  }
}

function notifyVisibilityChange() {
  chrome.runtime.sendMessage({ type: 'UPDATE_TRANSLATION_VISIBILITY', visible: translationVisible });
}
})();
