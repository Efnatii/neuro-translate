(function initPagePreflight() {
  if (globalThis.ntPagePreflight) return;

  const DEFAULT_OUTPUT_RATIO = 0.6;
  const DEFAULT_CONTEXT_PROMPT_RATIO_FULL = 0.2;
  const DEFAULT_CONTEXT_PROMPT_RATIO_SHORT = 0.07;

  const estimateTokensFromText = (text = '') => {
    const length = String(text || '').length;
    if (!length) return 0;
    return Math.ceil(length / 4) * 1.6;
  };

  const normalizeSegmentKey = (text = '') => {
    const trimmed = String(text || '').trim().toLowerCase();
    if (!trimmed) return '';
    return trimmed.replace(/\s+/g, ' ');
  };

  const ensureArray = (value) => (Array.isArray(value) ? value : []);

  const summarizeSegments = (segments) => {
    const totalTokens = segments.reduce((sum, segment) => sum + (segment.estimatedTokens || 0), 0);
    const totalChars = segments.reduce((sum, segment) => sum + (segment.text?.length || 0), 0);
    const avgTokens = segments.length ? totalTokens / segments.length : 0;
    const avgChars = segments.length ? totalChars / segments.length : 0;
    return { totalTokens, totalChars, avgTokens, avgChars };
  };

  const pickContextModeHint = ({ settings, uiRatio, estimatedPromptTokens }) => {
    if (!settings?.contextGenerationEnabled) return 'NONE';
    if (uiRatio >= 0.55 && estimatedPromptTokens >= 20000) return 'NONE';
    if (estimatedPromptTokens >= 45000) return 'SHORT';
    return settings?.contextGenerationEnabled ? 'FULL' : 'NONE';
  };

  const computeBatchHint = ({ totalSegments, avgTokens }) => {
    if (totalSegments >= 200 && avgTokens < 18) return 12;
    if (totalSegments >= 120 && avgTokens < 22) return 10;
    if (totalSegments >= 80 && avgTokens < 28) return 8;
    if (totalSegments >= 40 && avgTokens < 32) return 6;
    return 4;
  };

  const computeProofreadBatchHint = ({ totalSegments, avgTokens }) => {
    if (totalSegments >= 160 && avgTokens < 18) return 10;
    if (totalSegments >= 80 && avgTokens < 22) return 8;
    if (totalSegments >= 40 && avgTokens < 28) return 6;
    return 4;
  };

  const computeConcurrencyHint = ({ blockCount, avgBlockLength, avgTokens, totalSegments, singleBlock }) => {
    if (singleBlock) return 1;
    if (avgBlockLength >= 1200 || avgTokens >= 80) return Math.min(3, Math.max(1, blockCount));
    if (totalSegments >= 200) return Math.min(6, Math.max(1, blockCount));
    if (totalSegments >= 80) return Math.min(4, Math.max(1, blockCount));
    return Math.min(3, Math.max(1, blockCount));
  };

  const buildPlanTasks = ({ blocks, uiBlockIndices, segmentsByBlock, estimatedTokensByBlock }) => {
    const tasks = [];
    blocks.forEach((block, index) => {
      const blockSegments = segmentsByBlock[index] || [];
      const estimatedTokens = estimatedTokensByBlock[index] || 0;
      const blockElement = block?.[0]?.blockElement;
      const blockKey = blockElement?.getAttribute?.('data-nt-block-key') || `block_${index}`;
      const uiMode = uiBlockIndices.has(index);
      tasks.push({
        id: `translate_${blockKey}`,
        type: uiMode ? 'uiTranslate' : 'contentTranslate',
        blockKey,
        host: location.host || '',
        segments: blockSegments,
        estimatedTokens,
        uiMode,
        canBatch: true,
        contextMode: uiMode ? 'NONE' : 'SHORT',
        maxTokensHint: null
      });
    });
    return tasks;
  };

  const buildPagePlan = (doc, targetLang, settings = {}) => {
    const helpers = globalThis.ntPagePreflightHelpers || {};
    const stats = {
      ts: Date.now(),
      url: location.href,
      scannedTextNodes: 0,
      nonEmptyTextNodes: 0,
      candidatesBeforeFilters: 0,
      candidatesAfterFilters: 0,
      filtered: {
        empty: 0,
        whitespaceOnly: 0,
        tooShort: 0,
        tooLong: 0,
        duplicate: 0,
        hidden: 0,
        inScriptStyle: 0,
        nonTranslatableTag: 0,
        alreadyTranslated: 0,
        other: 0
      },
      notes: []
    };
    const recordNote = (note) => {
      if (!note) return;
      if (stats.notes.length >= 10) return;
      stats.notes.push(note);
    };
    const collectTextNodes = helpers.collectTextNodes || ((root) => {
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          stats.scannedTextNodes += 1;
          if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      let current;
      while ((current = walker.nextNode())) {
        nodes.push(current);
      }
      return nodes;
    });
    const groupTextNodesByBlock = helpers.groupTextNodesByBlock;
    const normalizeBlocksByLength = helpers.normalizeBlocksByLength;
    const calculateTextLengthStats = helpers.calculateTextLengthStats;
    const normalizeBlockLength = helpers.normalizeBlockLength;
    const isUiBlock = helpers.isUiBlock || (() => false);
    const getNodePath = helpers.getNodePath || (() => []);
    const computeTextHash = helpers.computeTextHash || ((text) => text.length);
    const getOriginalHash = helpers.getOriginalHash || ((original, originalHash) => originalHash || computeTextHash(original || ''));

    const textNodes = collectTextNodes(doc.body, stats, recordNote);
    stats.candidatesBeforeFilters = stats.nonEmptyTextNodes || textNodes.length;
    stats.candidatesAfterFilters = textNodes.length;
    const nodesWithPath = textNodes.map((node) => ({
      node,
      path: getNodePath(node),
      original: node.nodeValue,
      originalHash: computeTextHash(node.nodeValue || '')
    }));

    const textStats = calculateTextLengthStats
      ? calculateTextLengthStats(nodesWithPath)
      : { totalLength: 0, averageNodeLength: 0 };
    const maxBlockLength = normalizeBlockLength
      ? normalizeBlockLength(settings.blockLengthLimit, textStats.averageNodeLength)
      : settings.blockLengthLimit || 1200;
    const blockGroups = groupTextNodesByBlock
      ? groupTextNodesByBlock(nodesWithPath)
      : [nodesWithPath];
    const blocks = normalizeBlocksByLength
      ? normalizeBlocksByLength(blockGroups, maxBlockLength)
      : blockGroups;

    const uiBlockIndices = new Set();
    const segmentsByBlock = [];
    const estimatedTokensByBlock = [];
    const allSegments = [];
    let uiSegmentsCount = 0;
    let contentSegmentsCount = 0;

    blocks.forEach((block, index) => {
      const blockElement = block?.[0]?.blockElement;
      const blockTexts = block.map(({ original }) => original);
      const uiMode = isUiBlock(blockElement, blockTexts);
      if (uiMode) {
        uiBlockIndices.add(index);
      }
      const segments = [];
      let blockTokenEstimate = 0;
      block.forEach((segment, segmentIndex) => {
        const text = String(segment.original || '');
        const estimatedTokens = estimateTokensFromText(text);
        const key = normalizeSegmentKey(text);
        const entry = {
          id: `${index}:${segmentIndex}`,
          text,
          key,
          estimatedTokens,
          uiMode,
          blockIndex: index,
          segmentIndex
        };
        segments.push(entry);
        allSegments.push(entry);
        blockTokenEstimate += estimatedTokens;
        if (uiMode) {
          uiSegmentsCount += 1;
        } else {
          contentSegmentsCount += 1;
        }
      });
      segmentsByBlock[index] = segments;
      estimatedTokensByBlock[index] = blockTokenEstimate;
    });

    const outputRatio = settings?.outputRatioByRole?.translation ?? DEFAULT_OUTPUT_RATIO;
    const segmentSummary = summarizeSegments(allSegments);
    let uniqueSegments = 0;
    const dedupModule = globalThis.ntSegmentDedup;
    if (dedupModule?.buildSegmentDedupPlan) {
      const dedupPlan = dedupModule.buildSegmentDedupPlan({ blocks, uiBlockIndices });
      uniqueSegments = dedupPlan?.stats?.uniqueSegments || 0;
    } else {
      const uniqueKeys = new Set(allSegments.map((segment) => segment.key).filter(Boolean));
      uniqueSegments = uniqueKeys.size || allSegments.length;
    }

    const uiRatio = allSegments.length ? uiSegmentsCount / allSegments.length : 0;
    const contextModeHint = pickContextModeHint({
      settings,
      uiRatio,
      estimatedPromptTokens: segmentSummary.totalTokens
    });
    const contextRatio =
      contextModeHint === 'FULL'
        ? DEFAULT_CONTEXT_PROMPT_RATIO_FULL
        : contextModeHint === 'SHORT'
          ? DEFAULT_CONTEXT_PROMPT_RATIO_SHORT
          : 0;
    const estimatedPromptTokens = Math.round(segmentSummary.totalTokens * (1 + contextRatio));
    const estimatedOutputTokens = Math.round(segmentSummary.totalTokens * outputRatio);

    const tasks = buildPlanTasks({
      blocks,
      uiBlockIndices,
      segmentsByBlock,
      estimatedTokensByBlock
    });

    const hints = {
      suggestedBatchSizeTranslate: computeBatchHint({ totalSegments: allSegments.length, avgTokens: segmentSummary.avgTokens }),
      suggestedBatchSizeProofread: computeProofreadBatchHint({ totalSegments: allSegments.length, avgTokens: segmentSummary.avgTokens }),
      suggestedContextMode: contextModeHint,
      suggestedConcurrency: computeConcurrencyHint({
        blockCount: blocks.length,
        avgBlockLength: textStats.averageNodeLength,
        avgTokens: segmentSummary.avgTokens,
        totalSegments: allSegments.length,
        singleBlock: Boolean(settings?.singleBlockConcurrency)
      })
    };

    return {
      host: location.host || '',
      targetLang: targetLang || '',
      totals: {
        blocks: blocks.length,
        segments: allSegments.length,
        uiSegments: uiSegmentsCount,
        contentSegments: contentSegmentsCount,
        uniqueSegments,
        estimatedPromptTokens,
        estimatedOutputTokens
      },
      tasks,
      hints,
      debug: stats
    };
  };

  globalThis.ntPagePreflight = {
    buildPagePlan,
    estimateTokensFromText
  };
})();
