(() => {
  const MAX_PROOFREAD_EDITS = 30;
  const PLACEHOLDER_PATTERN = /⟦[^\]]+⟧/;
  const ZERO_WIDTH_PATTERN = /[\u200B-\u200D\uFEFF]/;
  const UNUSUAL_CHAR_LABELS = new Map([
    ['\u00A0', 'NBSP'],
    ['\u200B', 'ZWSP'],
    ['\u200C', 'ZWNJ'],
    ['\u200D', 'ZWJ'],
    ['\uFEFF', 'ZWNBSP'],
    ['\u2013', 'EN DASH'],
    ['\u2014', 'EM DASH'],
    ['\u2015', 'HORIZONTAL BAR'],
    ['\u2212', 'MINUS SIGN'],
    ['\u2018', 'LEFT SINGLE QUOTE'],
    ['\u2019', 'RIGHT SINGLE QUOTE'],
    ['\u201C', 'LEFT DOUBLE QUOTE'],
    ['\u201D', 'RIGHT DOUBLE QUOTE'],
    ['\u00AB', 'LEFT ANGLE QUOTE'],
    ['\u00BB', 'RIGHT ANGLE QUOTE']
  ]);

  function detectLineEnding(text = '') {
    if (text.includes('\r\n')) return '\r\n';
    if (text.includes('\r')) return '\r';
    return '\n';
  }

  function normalizeLineEndings(text = '') {
    const lineEnding = detectLineEnding(text);
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return { normalized, lineEnding };
  }

  function restoreLineEndings(text = '', lineEnding = '\n') {
    if (lineEnding === '\n') return text;
    return text.replace(/\n/g, lineEnding);
  }

  function normalizeForComparison(text = '') {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function findAllOccurrences(text = '', target = '') {
    if (!target) return [];
    const matches = [];
    let startIndex = 0;
    while (startIndex <= text.length) {
      const index = text.indexOf(target, startIndex);
      if (index === -1) break;
      matches.push({ start: index, end: index + target.length });
      startIndex = index + Math.max(1, target.length);
    }
    return matches;
  }

  function matchesContext(text, match, before, after) {
    if (before) {
      if (match.start < before.length) return false;
      const snippet = text.slice(match.start - before.length, match.start);
      if (snippet !== before) return false;
    }
    if (after) {
      if (match.end + after.length > text.length) return false;
      const snippet = text.slice(match.end, match.end + after.length);
      if (snippet !== after) return false;
    }
    return true;
  }

  function findCandidates(text, edit) {
    const target = edit?.target || '';
    const occurrences = findAllOccurrences(text, target);
    const before = typeof edit.before === 'string' && edit.before ? edit.before : null;
    const after = typeof edit.after === 'string' && edit.after ? edit.after : null;
    if (!before && !after) {
      return occurrences;
    }
    return occurrences.filter((match) => matchesContext(text, match, before, after));
  }

  function hasContext(edit) {
    return Boolean(
      (typeof edit.before === 'string' && edit.before) || (typeof edit.after === 'string' && edit.after)
    );
  }

  function validateEditShape(edit) {
    if (!edit || typeof edit !== 'object') {
      return { valid: false, reason: 'invalid_edit' };
    }
    const op = edit.op;
    const validOps = new Set(['replace', 'insert_before', 'insert_after', 'delete']);
    if (!validOps.has(op)) {
      return { valid: false, reason: 'invalid_op' };
    }
    if (typeof edit.target !== 'string' || !edit.target) {
      return { valid: false, reason: 'missing_target' };
    }
    if (op === 'replace' || op === 'insert_before' || op === 'insert_after') {
      if (typeof edit.replacement !== 'string') {
        return { valid: false, reason: 'missing_replacement' };
      }
    }
    return { valid: true };
  }

  function hasPlaceholder(text) {
    return PLACEHOLDER_PATTERN.test(text);
  }

  function isNoOp(edit) {
    if (typeof edit.replacement !== 'string') return false;
    const normalizedTarget = normalizeForComparison(edit.target);
    const normalizedReplacement = normalizeForComparison(edit.replacement);
    return normalizedTarget === normalizedReplacement;
  }

  function buildEditSpan(edit, match, index) {
    const op = edit.op;
    let start = match.start;
    let end = match.end;
    let replacement = edit.replacement;
    if (op === 'insert_before') {
      start = match.start;
      end = match.start;
    }
    if (op === 'insert_after') {
      start = match.end;
      end = match.end;
    }
    if (op === 'delete') {
      replacement = '';
    }
    return {
      edit,
      start,
      end,
      replacement: replacement ?? '',
      index
    };
  }

  function buildFailed(edit, reason, detail) {
    return detail ? { edit, reason, detail } : { edit, reason };
  }

  function resolveOccurrence(edit, candidates) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    if (!Number.isInteger(edit.occurrence)) return null;
    const occurrence = edit.occurrence;
    if (occurrence < 1 || occurrence > candidates.length) return null;
    return candidates[occurrence - 1];
  }

  function collectEditSpans(edits, text) {
    const spans = [];
    const failed = [];
    if (!Array.isArray(edits) || !edits.length) {
      return { spans, failed };
    }

    edits.forEach((edit, index) => {
      const shapeCheck = validateEditShape(edit);
      if (!shapeCheck.valid) {
        failed.push(buildFailed(edit, shapeCheck.reason));
        return;
      }
      if (hasPlaceholder(edit.target)) {
        failed.push(buildFailed(edit, 'model_violation', 'placeholder_target'));
        return;
      }
      if (isNoOp(edit)) {
        failed.push(buildFailed(edit, 'no_op'));
        return;
      }
      if (!text.includes(edit.target)) {
        failed.push(buildFailed(edit, 'model_violation', 'target_not_found'));
        return;
      }
      const candidates = findCandidates(text, edit);
      if (candidates.length > 1 && !hasContext(edit)) {
        failed.push(buildFailed(edit, 'model_violation', 'missing_context'));
        return;
      }
      const match = resolveOccurrence(edit, candidates);
      if (!match) {
        failed.push(
          buildFailed(edit, candidates.length ? 'ambiguous' : 'target_not_found')
        );
        return;
      }
      spans.push(buildEditSpan(edit, match, index));
    });

    return { spans, failed };
  }

  function spansOverlap(a, b) {
    const aIsInsert = a.start === a.end;
    const bIsInsert = b.start === b.end;
    if (aIsInsert && bIsInsert) {
      return a.start === b.start;
    }
    if (aIsInsert) {
      return a.start >= b.start && a.start <= b.end;
    }
    if (bIsInsert) {
      return b.start >= a.start && b.start <= a.end;
    }
    return a.start < b.end && b.start < a.end;
  }

  function rejectOverlaps(spans) {
    const accepted = [];
    const rejected = [];
    const sorted = [...spans].sort((a, b) => a.index - b.index);
    sorted.forEach((candidate) => {
      const hasOverlap = accepted.some((existing) => spansOverlap(existing, candidate));
      if (hasOverlap) {
        rejected.push(buildFailed(candidate.edit, 'overlap'));
        return;
      }
      accepted.push(candidate);
    });
    return { accepted, rejected };
  }

  function shouldFallback(failed) {
    return failed.some((item) => item.reason === 'model_violation' || item.reason === 'ambiguous');
  }

  function validateEditsAgainstText(edits, text) {
    const { normalized } = normalizeLineEndings(text);
    const { spans, failed } = collectEditSpans(edits, normalized);
    const applicable = spans.map((span) => ({
      edit: span.edit,
      start: span.start,
      end: span.end
    }));
    return {
      ok: failed.length === 0,
      applicable,
      failed
    };
  }

  function applyEdits(text, edits, rewriteText = null) {
    const { normalized, lineEnding } = normalizeLineEndings(text);
    const { spans, failed } = collectEditSpans(edits, normalized);
    const { accepted, rejected } = rejectOverlaps(spans);
    const failedEdits = failed.concat(rejected);

    if (failedEdits.length && shouldFallback(failedEdits)) {
      if (typeof rewriteText === 'string' && rewriteText) {
        return {
          ok: false,
          newText: rewriteText,
          applied: [],
          failed: failedEdits,
          usedRewrite: true
        };
      }
      return {
        ok: false,
        newText: text,
        applied: [],
        failed: failedEdits,
        usedRewrite: false
      };
    }

    const sortedForApply = [...accepted].sort((a, b) => {
      if (b.start !== a.start) return b.start - a.start;
      return b.end - a.end;
    });

    let output = normalized;
    sortedForApply.forEach((span) => {
      output = output.slice(0, span.start) + span.replacement + output.slice(span.end);
    });

    return {
      ok: failedEdits.length === 0,
      newText: restoreLineEndings(output, lineEnding),
      applied: accepted.map((span) => ({
        edit: span.edit,
        start: span.start,
        end: span.end
      })),
      failed: failedEdits,
      usedRewrite: false
    };
  }

  function normalizeForLooseMatch(text = '') {
    return text
      .replace(/\u00A0/g, ' ')
      .replace(ZERO_WIDTH_PATTERN, '')
      .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"');
  }

  function buildNormalizationMap(text = '') {
    let normalized = '';
    const indexMap = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const normalizedChar = normalizeForLooseMatch(char);
      if (!normalizedChar) {
        continue;
      }
      normalized += normalizedChar;
      for (let j = 0; j < normalizedChar.length; j += 1) {
        indexMap.push(i);
      }
    }
    return { normalized, indexMap };
  }

  function formatCodePoints(text = '') {
    return Array.from(text).map((char) => {
      const codePoint = char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
      const label = UNUSUAL_CHAR_LABELS.get(char) || '';
      return `${char} U+${codePoint}${label ? ` (${label})` : ''}`;
    });
  }

  function debugTargetNotFound(text, target, options = {}) {
    const contextRadius = Number.isInteger(options.contextRadius) ? options.contextRadius : 20;
    const maxMatches = Number.isInteger(options.maxMatches) ? options.maxMatches : 5;
    const { normalized, indexMap } = buildNormalizationMap(text);
    const normalizedTarget = normalizeForLooseMatch(target);
    if (!normalizedTarget) {
      return [];
    }
    const matches = [];
    let startIndex = 0;
    while (startIndex <= normalized.length) {
      const index = normalized.indexOf(normalizedTarget, startIndex);
      if (index === -1) break;
      matches.push(index);
      if (matches.length >= maxMatches) break;
      startIndex = index + Math.max(1, normalizedTarget.length);
    }

    return matches.map((matchIndex) => {
      const originalStart = indexMap[matchIndex] ?? 0;
      const originalEndIndex = indexMap[Math.min(matchIndex + normalizedTarget.length - 1, indexMap.length - 1)];
      const originalEnd = Number.isInteger(originalEndIndex) ? originalEndIndex + 1 : originalStart + 1;
      const contextStart = Math.max(0, originalStart - contextRadius);
      const contextEnd = Math.min(text.length, originalEnd + contextRadius);
      const context = text.slice(contextStart, contextEnd);
      return {
        context,
        contextRange: [contextStart, contextEnd],
        codePoints: formatCodePoints(context)
      };
    });
  }

  function buildProofreadPrompt(input) {
    const blockId = input?.blockId ?? '';
    const text = input?.text ?? '';
    const language = input?.language ?? '';
    const goals = Array.isArray(input?.goals) ? input.goals.filter(Boolean) : [];
    return [
      {
        role: 'system',
        content: [
          'You are a precise proofreading engine.',
          'Return only JSON that matches the provided schema.',
          'Use anchor-based edits only; never return start/end indices.',
          'Each edit must target an exact fragment from the original block.',
          'If a target appears multiple times, include before/after anchors.',
          'Keep formatting, whitespace, Markdown, and punctuation tokens unchanged except for local fixes.',
          'Avoid over-editing; keep meaning identical.',
          `Limit to at most ${MAX_PROOFREAD_EDITS} edits per block.`,
          'If edits are unsafe or ambiguous, return rewrite.text instead.',
          'Never include any extra commentary outside the JSON object.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          `Block ID: ${blockId}`,
          `Language: ${language}`,
          goals.length ? `Goals:\n- ${goals.join('\n- ')}` : '',
          'Block text:',
          text
        ]
          .filter(Boolean)
          .join('\n')
      }
    ];
  }

  const api = {
    MAX_PROOFREAD_EDITS,
    applyEdits,
    buildProofreadPrompt,
    debugTargetNotFound,
    findCandidates,
    normalizeLineEndings,
    restoreLineEndings,
    validateEditsAgainstText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.ProofreadUtils = api;
  }
})();
