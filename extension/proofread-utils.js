(() => {
  const MAX_PROOFREAD_EDITS = 30;
  const PLACEHOLDER_PATTERN = /⟦[^⟧]*⟧/;
  const ZERO_WIDTH_CHARS = new Set(['\u200B', '\u200C', '\u200D', '\uFEFF']);
  const WHITESPACE_PATTERN =
    /[\s\u00A0\u202F\u2009\u200A\u1680\u2000-\u2008\u2028\u2029\u205F\u3000]/;

  function isZeroWidth(char) {
    return ZERO_WIDTH_CHARS.has(char);
  }

  function isWhitespace(char) {
    return WHITESPACE_PATTERN.test(char);
  }

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

  function normalizeWithSpans(text = '', options = {}) {
    const useNFKC = options.useNFKC !== false;
    let norm = '';
    const spans = [];
    let index = 0;

    while (index < text.length) {
      const codePoint = text.codePointAt(index);
      const char = String.fromCodePoint(codePoint);
      const charLength = char.length;

      if (isZeroWidth(char)) {
        index += charLength;
        continue;
      }

      if (isWhitespace(char)) {
        const runStart = index;
        let runEnd = index + charLength;
        while (runEnd < text.length) {
          const nextCodePoint = text.codePointAt(runEnd);
          const nextChar = String.fromCodePoint(nextCodePoint);
          const nextLength = nextChar.length;
          if (isZeroWidth(nextChar)) {
            runEnd += nextLength;
            continue;
          }
          if (!isWhitespace(nextChar)) break;
          runEnd += nextLength;
        }
        norm += ' ';
        spans.push({ start: runStart, end: runEnd });
        index = runEnd;
        continue;
      }

      const normalizedChar = useNFKC ? char.normalize('NFKC') : char;
      if (normalizedChar) {
        for (let i = 0; i < normalizedChar.length; i += 1) {
          norm += normalizedChar[i];
          spans.push({ start: index, end: index + charLength });
        }
      }

      index += charLength;
    }

    return { norm, spans };
  }

  function normalizeNeedle(text = '', options = {}) {
    return normalizeWithSpans(text, options).norm;
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

  function countMatchingSuffix(reference = '', snippet = '') {
    const maxLength = Math.min(reference.length, snippet.length);
    let count = 0;
    for (let i = 1; i <= maxLength; i += 1) {
      if (reference[reference.length - i] !== snippet[snippet.length - i]) break;
      count += 1;
    }
    return count;
  }

  function countMatchingPrefix(reference = '', snippet = '') {
    const maxLength = Math.min(reference.length, snippet.length);
    let count = 0;
    for (let i = 0; i < maxLength; i += 1) {
      if (reference[i] !== snippet[i]) break;
      count += 1;
    }
    return count;
  }

  function scoreCandidate(normText, candidate, before, after) {
    if (!before && !after) return 0;
    let score = 0;
    if (before) {
      const leftStart = Math.max(0, candidate.start - before.length);
      const leftSnippet = normText.slice(leftStart, candidate.start);
      score += countMatchingSuffix(before, leftSnippet);
    }
    if (after) {
      const rightSnippet = normText.slice(candidate.end, candidate.end + after.length);
      score += countMatchingPrefix(after, rightSnippet);
    }
    return score;
  }

  function filterByScore(candidates, before, after) {
    if (!before && !after) return candidates;
    const total = (before?.length || 0) + (after?.length || 0);
    const minScore = Math.max(1, Math.floor(total * 0.25));
    return candidates.filter((candidate) => candidate.score >= minScore);
  }

  function findCandidates(text, edit, options = {}) {
    const target = typeof edit?.target === 'string' ? edit.target : '';
    if (!target) return [];
    const normalizedText = options.normalizedText ?? normalizeWithSpans(text).norm;
    const normalizedTarget = normalizeNeedle(target);
    if (!normalizedTarget) return [];

    const before =
      typeof edit?.before === 'string' && edit.before ? normalizeNeedle(edit.before) : null;
    const after = typeof edit?.after === 'string' && edit.after ? normalizeNeedle(edit.after) : null;

    const occurrences = findAllOccurrences(normalizedText, normalizedTarget);
    const scored = occurrences.map((candidate) => ({
      ...candidate,
      score: scoreCandidate(normalizedText, candidate, before, after)
    }));

    return filterByScore(scored, before, after);
  }

  function hasPlaceholder(text) {
    return PLACEHOLDER_PATTERN.test(text);
  }

  function validateEdits(text, edits) {
    const validEdits = [];
    const skipped = [];
    const failed = [];
    const normalizedText = normalizeWithSpans(text).norm;
    const fallbackReasons = new Set(['model_violation', 'ambiguous', 'not_found', 'overlap']);

    if (!Array.isArray(edits) || !edits.length) {
      return { validEdits, skipped, failed, fallbackReasons };
    }

    edits.forEach((edit) => {
      if (!edit || typeof edit !== 'object') {
        failed.push({ edit, reason: 'invalid_edit' });
        return;
      }
      const op = edit.op;
      const validOps = new Set(['replace', 'insert_before', 'insert_after', 'delete']);
      if (!validOps.has(op)) {
        failed.push({ edit, reason: 'invalid_op' });
        return;
      }

      const target = typeof edit.target === 'string' ? edit.target : '';
      const replacement = typeof edit.replacement === 'string' ? edit.replacement : null;
      const before = typeof edit.before === 'string' ? edit.before : '';
      const after = typeof edit.after === 'string' ? edit.after : '';

      if (!target) {
        failed.push({ edit, reason: 'model_violation', detail: 'missing_target' });
        return;
      }

      if ([target, before, after, replacement].some((value) => typeof value === 'string' && hasPlaceholder(value))) {
        failed.push({ edit, reason: 'model_violation', detail: 'placeholder' });
        return;
      }

      if (op === 'replace' && typeof replacement !== 'string') {
        failed.push({ edit, reason: 'model_violation', detail: 'missing_replacement' });
        return;
      }
      if ((op === 'insert_before' || op === 'insert_after') && typeof replacement !== 'string') {
        failed.push({ edit, reason: 'model_violation', detail: 'missing_replacement' });
        return;
      }

      if (op === 'replace' && typeof replacement === 'string') {
        const normalizedTarget = normalizeNeedle(target);
        const normalizedReplacement = normalizeNeedle(replacement);
        if (normalizedTarget === normalizedReplacement) {
          skipped.push({ edit, reason: 'no_op' });
          return;
        }
      }

      const normalizedTarget = normalizeNeedle(target);
      if (!normalizedTarget) {
        failed.push({ edit, reason: 'model_violation', detail: 'empty_target' });
        return;
      }

      const candidates = findCandidates(text, edit, { normalizedText });
      if (!candidates.length) {
        failed.push({ edit, reason: 'not_found' });
        return;
      }

      let chosen = null;
      if (Number.isInteger(edit.occurrence)) {
        const occurrence = edit.occurrence;
        if (occurrence < 1 || occurrence > candidates.length) {
          failed.push({ edit, reason: 'invalid_occurrence' });
          return;
        }
        chosen = candidates[occurrence - 1];
      } else if (candidates.length === 1) {
        chosen = candidates[0];
      } else {
        failed.push({ edit, reason: 'ambiguous' });
        return;
      }

      validEdits.push({
        edit,
        startNorm: chosen.start,
        endNorm: chosen.end,
        score: chosen.score
      });
    });

    return { validEdits, skipped, failed, fallbackReasons };
  }

  function resolveOriginalRange(spans, startNorm, endNorm, textLength) {
    if (startNorm < 0 || startNorm > spans.length) {
      return { start: 0, end: 0 };
    }
    if (startNorm === endNorm) {
      const span = spans[startNorm] || spans[startNorm - 1];
      const pos = span ? span.end : textLength;
      return { start: pos, end: pos };
    }
    const startSpan = spans[startNorm];
    const endSpan = spans[endNorm - 1];
    const start = startSpan ? startSpan.start : textLength;
    const end = endSpan ? endSpan.end : textLength;
    return { start, end };
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
    const sorted = [...spans].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return a.end - b.end;
    });

    sorted.forEach((candidate) => {
      const overlapping = accepted.filter((existing) => spansOverlap(existing, candidate));
      if (!overlapping.length) {
        accepted.push(candidate);
        return;
      }

      const highestScore = Math.max(...overlapping.map((item) => item.score ?? 0));
      const candidateScore = candidate.score ?? 0;
      if (candidateScore > highestScore) {
        overlapping.forEach((item) => {
          rejected.push({ edit: item.edit, reason: 'overlap' });
          const index = accepted.indexOf(item);
          if (index >= 0) accepted.splice(index, 1);
        });
        accepted.push(candidate);
      } else {
        rejected.push({ edit: candidate.edit, reason: 'overlap' });
      }
    });

    return { accepted, rejected };
  }

  function applyEdits(text, edits, rewriteText = null, modelInputText = null) {
    const mismatch = assertSameInputApply(modelInputText, text);
    if (modelInputText != null && !mismatch.ok) {
      return {
        ok: false,
        newText: text,
        applied: [],
        failed: [{ reason: 'mismatch', detail: mismatch.detail }],
        skipped: [],
        usedRewrite: false,
        mismatch: true
      };
    }

    const { validEdits, skipped, failed, fallbackReasons } = validateEdits(text, edits);
    const { spans } = normalizeWithSpans(text);
    const resolvedEdits = validEdits.map((entry) => {
      const range = resolveOriginalRange(spans, entry.startNorm, entry.endNorm, text.length);
      let start = range.start;
      let end = range.end;
      let replacement = entry.edit.replacement ?? '';
      if (entry.edit.op === 'insert_before') {
        start = range.start;
        end = range.start;
      }
      if (entry.edit.op === 'insert_after') {
        start = range.end;
        end = range.end;
      }
      if (entry.edit.op === 'delete') {
        replacement = '';
      }
      return {
        edit: entry.edit,
        start,
        end,
        replacement,
        score: entry.score ?? 0
      };
    });

    const { accepted, rejected } = rejectOverlaps(resolvedEdits);
    const failedEdits = failed.concat(rejected);

    const sortedForApply = [...accepted].sort((a, b) => {
      if (b.start !== a.start) return b.start - a.start;
      return b.end - a.end;
    });

    let output = text;
    sortedForApply.forEach((span) => {
      output = output.slice(0, span.start) + span.replacement + output.slice(span.end);
    });

    const applied = accepted.map((span) => ({
      edit: span.edit,
      start: span.start,
      end: span.end
    }));

    const hasFallbackFailure = failedEdits.some((item) => fallbackReasons.has(item.reason));
    const needsFallback =
      hasFallbackFailure || (Array.isArray(edits) && edits.length && applied.length === 0);

    if (needsFallback) {
      if (typeof rewriteText === 'string' && rewriteText) {
        return {
          ok: true,
          newText: rewriteText,
          applied: [],
          failed: failedEdits,
          skipped,
          usedRewrite: true,
          ops: computeDiffOps(text, rewriteText)
        };
      }
      return {
        ok: false,
        newText: text,
        applied: [],
        failed: failedEdits,
        skipped,
        usedRewrite: false
      };
    }

    return {
      ok: failedEdits.length === 0,
      newText: output,
      applied,
      failed: failedEdits,
      skipped,
      usedRewrite: false
    };
  }

  function computeDiffOps(original = '', rewritten = '') {
    if (original === rewritten) return [];

    let prefix = 0;
    const maxPrefix = Math.min(original.length, rewritten.length);
    while (prefix < maxPrefix && original[prefix] === rewritten[prefix]) {
      prefix += 1;
    }

    let suffix = 0;
    const maxSuffix = Math.min(original.length - prefix, rewritten.length - prefix);
    while (
      suffix < maxSuffix &&
      original[original.length - 1 - suffix] === rewritten[rewritten.length - 1 - suffix]
    ) {
      suffix += 1;
    }

    const originalMid = original.slice(prefix, original.length - suffix);
    const rewrittenMid = rewritten.slice(prefix, rewritten.length - suffix);

    if (!originalMid && rewrittenMid) {
      return [{ op: 'insert', start: prefix, end: prefix, text: rewrittenMid }];
    }
    if (originalMid && !rewrittenMid) {
      return [{ op: 'delete', start: prefix, end: prefix + originalMid.length }];
    }
    return [
      {
        op: 'replace',
        start: prefix,
        end: prefix + originalMid.length,
        text: rewrittenMid
      }
    ];
  }

  function debugString(text = '') {
    const suspicious = [];
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const code = char.codePointAt(0);
      if (
        char === '\u00A0' ||
        char === '\u202F' ||
        char === '\u200B' ||
        char === '\u200D' ||
        char === '\uFEFF' ||
        char === '\t' ||
        char === '\n' ||
        char === '\r'
      ) {
        suspicious.push({
          index: i,
          char,
          code: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
        });
      }
    }
    const stringified = JSON.stringify(text);
    console.log(stringified);
    console.log(suspicious);
    return { stringified, suspicious };
  }

  function debugMismatch(modelInputText = '', applyText = '', limit = 40) {
    if (modelInputText === applyText) return { mismatch: false };
    const max = Math.min(modelInputText.length, applyText.length, limit);
    const diffs = [];
    for (let i = 0; i < max; i += 1) {
      if (modelInputText[i] !== applyText[i]) {
        diffs.push({
          index: i,
          modelChar: modelInputText[i],
          applyChar: applyText[i],
          modelCode: `U+${modelInputText.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`,
          applyCode: `U+${applyText.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`
        });
        if (diffs.length >= limit) break;
      }
    }
    console.warn('Mismatch between modelInputText and applyText', diffs);
    return { mismatch: true, diffs };
  }

  function assertSameInputApply(modelInputText, applyText) {
    // НЕЛЬЗЯ отправлять модели склеенный блок и применять патчи к runs/leaf-ндам. Выберите один слой и придерживайтесь.
    if (modelInputText == null || applyText == null) {
      return { ok: true };
    }
    if (modelInputText === applyText) {
      return { ok: true };
    }
    const details = debugMismatch(modelInputText, applyText);
    return { ok: false, detail: details };
  }

  function validateEditsAgainstText(edits, text) {
    const { validEdits, skipped, failed } = validateEdits(text, edits);
    const applicable = validEdits.map((entry) => ({
      edit: entry.edit,
      start: entry.startNorm,
      end: entry.endNorm
    }));
    return {
      ok: failed.length === 0,
      applicable,
      failed,
      skipped
    };
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
          'If edits are unsafe or ambiguous, return rewrite_text instead.',
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
    assertSameInputApply,
    buildProofreadPrompt,
    computeDiffOps,
    debugMismatch,
    debugString,
    findCandidates,
    normalizeLineEndings,
    normalizeNeedle,
    normalizeWithSpans,
    validateEdits,
    validateEditsAgainstText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.ProofreadUtils = api;
  }
})();
