(function initSegmentDedup() {
  if (globalThis.ntSegmentDedup) return;

  const WHITESPACE_RE = /\s+/g;
  const MARKUP_RE = /<[^>]+>/;
  const PLACEHOLDER_RE = /\{\d+\}|%[sdifo]|\{\{[^}]+}}/i;

  const normalizeForDedup = (text = '') => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    return trimmed.replace(WHITESPACE_RE, ' ');
  };

  const isDedupSafe = (text, { maxLength = 250 } = {}) => {
    if (!text) return false;
    if (text.length > maxLength) return false;
    if (MARKUP_RE.test(text)) return false;
    if (PLACEHOLDER_RE.test(text)) return false;
    return true;
  };

  const buildSegmentDedupPlan = ({
    blocks = [],
    uiBlockIndices = new Set(),
    shortLength = 60,
    minCount = 3,
    maxLength = 250
  } = {}) => {
    const segmentRefs = [];
    const normalizedMap = new Map();
    const segmentKeysByBlock = blocks.map((block) => new Array(block.length).fill(''));

    blocks.forEach((block, blockIndex) => {
      if (uiBlockIndices?.has?.(blockIndex)) {
        return;
      }
      const isUiBlock = false;
      block.forEach((segment, segmentIndex) => {
        const original = String(segment?.original || '');
        const normalized = normalizeForDedup(original);
        const allowDedup = Boolean(normalized) && isDedupSafe(original, { maxLength });
        segmentRefs.push({
          blockIndex,
          segmentIndex,
          original,
          normalized,
          allowDedup,
          isUiBlock
        });
        if (allowDedup) {
          const existing = normalizedMap.get(normalized);
          if (existing) {
            existing.count += 1;
          } else {
            normalizedMap.set(normalized, { count: 1, sample: original });
          }
        }
      });
    });

    const isEligibleForDedup = (ref) => {
      if (!ref.allowDedup) return false;
      const entry = normalizedMap.get(ref.normalized);
      if (!entry || entry.count < 2) return false;
      if (ref.isUiBlock) return true;
      if (ref.original.length <= shortLength) return true;
      return entry.count >= minCount;
    };

    segmentRefs.forEach((ref) => {
      const eligible = isEligibleForDedup(ref);
      const key = eligible ? ref.normalized : `unique:${ref.blockIndex}:${ref.segmentIndex}`;
      segmentKeysByBlock[ref.blockIndex][ref.segmentIndex] = key;
    });

    const entries = new Map();
    segmentRefs.forEach((ref) => {
      const key = segmentKeysByBlock[ref.blockIndex][ref.segmentIndex];
      let entry = entries.get(key);
      if (!entry) {
        const isNormalizedKey = key === ref.normalized;
        entry = {
          key,
          sourceTextOriginal: ref.original,
          occurrences: [],
          count: 0,
          dedupEligible: isNormalizedKey
        };
        entries.set(key, entry);
      }
      entry.count += 1;
      entry.occurrences.push({
        blockIndex: ref.blockIndex,
        segmentIndex: ref.segmentIndex,
        node: blocks?.[ref.blockIndex]?.[ref.segmentIndex]?.node || null
      });
    });

    const totalSegments = segmentRefs.length;
    const uniqueSegments = entries.size;
    const dedupedSegments = Math.max(0, totalSegments - uniqueSegments);

    return {
      entries,
      segmentKeysByBlock,
      stats: {
        totalSegments,
        uniqueSegments,
        dedupedSegments
      }
    };
  };

  globalThis.ntSegmentDedup = {
    normalizeForDedup,
    buildSegmentDedupPlan
  };
})();
