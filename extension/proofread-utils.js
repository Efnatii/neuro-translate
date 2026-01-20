(() => {
  const MAX_PROOFREAD_EDITS = 30;

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

  function resolveOccurrence(edit, candidates) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    const occurrence = Number.isInteger(edit.occurrence) ? edit.occurrence : 1;
    if (occurrence < 1 || occurrence > candidates.length) return null;
    return candidates[occurrence - 1];
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
    if (!Number.isInteger(edit.occurrence) || edit.occurrence < 1) {
      return { valid: false, reason: 'invalid_occurrence' };
    }
    if (op === 'replace' || op === 'insert_before' || op === 'insert_after') {
      if (typeof edit.replacement !== 'string') {
        return { valid: false, reason: 'missing_replacement' };
      }
    }
    return { valid: true };
  }

  function computeConfidence(edit, candidatesCount) {
    let score = 0;
    if (edit.before) score += 2;
    if (edit.after) score += 2;
    if (Number.isInteger(edit.occurrence)) score += 1;
    if (candidatesCount === 1) score += 2;
    return score;
  }

  function buildEditSpan(edit, match, index, candidatesCount) {
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
      index,
      confidence: computeConfidence(edit, candidatesCount)
    };
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
        failed.push({ edit, reason: shapeCheck.reason });
        return;
      }
      const candidates = findCandidates(text, edit);
      const match = resolveOccurrence(edit, candidates);
      if (!match) {
        failed.push({
          edit,
          reason: candidates.length ? 'ambiguous_target' : 'target_not_found'
        });
        return;
      }
      spans.push(buildEditSpan(edit, match, index, candidates.length));
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

  function resolveOverlaps(spans) {
    const accepted = [];
    const rejected = [];
    const sorted = [...spans].sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.index - b.index;
    });
    sorted.forEach((candidate) => {
      const hasOverlap = accepted.some((existing) => spansOverlap(existing, candidate));
      if (hasOverlap) {
        rejected.push({ edit: candidate.edit, reason: 'overlap' });
        return;
      }
      accepted.push(candidate);
    });
    return { accepted, rejected };
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

  function applyEdits(text, edits) {
    const { normalized, lineEnding } = normalizeLineEndings(text);
    const { spans, failed } = collectEditSpans(edits, normalized);
    const { accepted, rejected } = resolveOverlaps(spans);
    const failedEdits = failed.concat(rejected);

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
      failed: failedEdits
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
          'If a target appears multiple times, include occurrence and before/after anchors.',
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
