export type ProofreadInput = {
  blockId: string;
  text: string;
  language: string;
  goals?: string[];
};

export type EditOperation = 'replace' | 'insert_before' | 'insert_after' | 'delete';

export type AnchorEdit = {
  op: EditOperation;
  target: string;
  replacement?: string;
  occurrence: number;
  before?: string;
  after?: string;
  rationale?: string;
};

export type ProofreadResponse = {
  edits: AnchorEdit[];
  rewrite?: { text: string };
};

export type EditSpan = {
  edit: AnchorEdit;
  start: number;
  end: number;
  applyStart: number;
  applyEnd: number;
  confidence: number;
};

export type EditResult = {
  edit: AnchorEdit;
  status: 'applied' | 'failed';
  reason?: string;
  start?: number;
  end?: number;
};

export type ApplyEditsResult = {
  ok: boolean;
  newText: string;
  applied: EditResult[];
  failed: EditResult[];
};

export function normalizeBlockText(text: string) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function findTargetOccurrences(text: string, target: string) {
  const indices: number[] = [];
  if (!target) return indices;
  let fromIndex = 0;
  while (fromIndex <= text.length) {
    const idx = text.indexOf(target, fromIndex);
    if (idx === -1) break;
    indices.push(idx);
    fromIndex = idx + Math.max(1, target.length);
  }
  return indices;
}

function matchesContext(text: string, start: number, target: string, before?: string, after?: string) {
  if (before) {
    const beforeSlice = text.slice(Math.max(0, start - before.length), start);
    if (beforeSlice !== before) return false;
  }
  if (after) {
    const afterStart = start + target.length;
    const afterSlice = text.slice(afterStart, afterStart + after.length);
    if (afterSlice !== after) return false;
  }
  return true;
}

export function findCandidateIndices(
  text: string,
  target: string,
  before?: string,
  after?: string
) {
  const indices = findTargetOccurrences(text, target);
  if (!indices.length) return [];
  if (!before && !after) return indices;
  const candidates = indices.filter((index) => matchesContext(text, index, target, before, after));
  return candidates.length ? candidates : indices;
}

export function resolveEditSpan(text: string, edit: AnchorEdit): EditSpan | null {
  if (!edit.target) {
    return null;
  }

  const resolvedCandidates = findCandidateIndices(text, edit.target, edit.before, edit.after);
  if (!resolvedCandidates.length) return null;

  if (resolvedCandidates.length > 1) {
    if (!Number.isInteger(edit.occurrence) || edit.occurrence < 1) {
      return null;
    }
    const picked = resolvedCandidates[edit.occurrence - 1];
    if (picked === undefined) return null;
    const span = buildSpan(edit, picked);
    return span;
  }

  const picked = resolvedCandidates[0];
  if (picked === undefined) return null;
  return buildSpan(edit, picked);
}

function buildSpan(edit: AnchorEdit, start: number): EditSpan {
  const end = start + edit.target.length;
  const isInsertBefore = edit.op === 'insert_before';
  const isInsertAfter = edit.op === 'insert_after';
  const applyStart = isInsertAfter ? end : start;
  const applyEnd = isInsertBefore || isInsertAfter ? applyStart : end;
  const confidence =
    edit.target.length +
    (edit.before ? Math.min(edit.before.length, 60) : 0) +
    (edit.after ? Math.min(edit.after.length, 60) : 0) +
    (Number.isInteger(edit.occurrence) ? 5 : 0);
  return { edit, start, end, applyStart, applyEnd, confidence };
}

function isOverlapping(a: EditSpan, b: EditSpan) {
  const startA = a.applyStart;
  const endA = a.applyEnd;
  const startB = b.applyStart;
  const endB = b.applyEnd;
  return startA < endB && startB < endA;
}

function shouldKeepLeft(overlapLeft: EditSpan, overlapRight: EditSpan) {
  if (overlapLeft.confidence !== overlapRight.confidence) {
    return overlapLeft.confidence > overlapRight.confidence;
  }
  return overlapLeft.applyStart <= overlapRight.applyStart;
}

function hasValidReplacement(edit: AnchorEdit) {
  if (edit.op === 'replace' || edit.op === 'insert_before' || edit.op === 'insert_after') {
    return typeof edit.replacement === 'string';
  }
  return true;
}

export function validateEditsAgainstText(edits: AnchorEdit[], text: string): ApplyEditsResult {
  const normalizedText = normalizeBlockText(text);
  const applied: EditResult[] = [];
  const failed: EditResult[] = [];
  const spans: EditSpan[] = [];

  edits.forEach((edit) => {
    if (!edit || typeof edit !== 'object') {
      failed.push({ edit, status: 'failed', reason: 'Invalid edit object.' } as EditResult);
      return;
    }
    if (!hasValidReplacement(edit)) {
      failed.push({ edit, status: 'failed', reason: 'Missing replacement text.' });
      return;
    }
    const occurrences = findTargetOccurrences(normalizedText, edit.target);
    if (occurrences.length > 1 && (!edit.before && !edit.after)) {
      failed.push({
        edit,
        status: 'failed',
        reason: 'Ambiguous target; before/after anchors are required for repeated targets.'
      });
      return;
    }
    const span = resolveEditSpan(normalizedText, edit);
    if (!span) {
      failed.push({ edit, status: 'failed', reason: 'Target not found or ambiguous.' });
      return;
    }
    spans.push(span);
  });

  const sortedSpans = [...spans].sort((a, b) => a.applyStart - b.applyStart);
  const rejected = new Set<EditSpan>();

  for (let i = 0; i < sortedSpans.length; i += 1) {
    const current = sortedSpans[i];
    if (rejected.has(current)) continue;
    for (let j = i + 1; j < sortedSpans.length; j += 1) {
      const next = sortedSpans[j];
      if (rejected.has(next)) continue;
      if (!isOverlapping(current, next)) break;
      const keepLeft = shouldKeepLeft(current, next);
      const rejectedSpan = keepLeft ? next : current;
      rejected.add(rejectedSpan);
      failed.push({
        edit: rejectedSpan.edit,
        status: 'failed',
        reason: 'Overlapping edit; dropped for safety.',
        start: rejectedSpan.applyStart,
        end: rejectedSpan.applyEnd
      });
      if (!keepLeft) break;
    }
  }

  const acceptedSpans = sortedSpans.filter((span) => !rejected.has(span));
  for (const span of acceptedSpans) {
    applied.push({
      edit: span.edit,
      status: 'applied',
      start: span.applyStart,
      end: span.applyEnd
    });
  }

  return {
    ok: failed.length === 0,
    newText: normalizedText,
    applied,
    failed
  };
}

export function applyEdits(text: string, edits: AnchorEdit[]): ApplyEditsResult {
  const validation = validateEditsAgainstText(edits, text);
  if (!validation.applied.length) {
    return { ...validation, newText: normalizeBlockText(text) };
  }

  const normalizedText = normalizeBlockText(text);
  const spans = validation.applied
    .map((result) => {
      const span = resolveEditSpan(normalizedText, result.edit);
      return span ? { span, edit: result.edit } : null;
    })
    .filter((value): value is { span: EditSpan; edit: AnchorEdit } => Boolean(value))
    .sort((a, b) => b.span.applyStart - a.span.applyStart);

  let output = normalizedText;
  for (const { span, edit } of spans) {
    const replacement = edit.replacement ?? '';
    if (edit.op === 'replace') {
      output = output.slice(0, span.applyStart) + replacement + output.slice(span.applyEnd);
    } else if (edit.op === 'delete') {
      output = output.slice(0, span.applyStart) + output.slice(span.applyEnd);
    } else if (edit.op === 'insert_before' || edit.op === 'insert_after') {
      output = output.slice(0, span.applyStart) + replacement + output.slice(span.applyStart);
    }
  }

  return {
    ok: validation.failed.length === 0,
    newText: output,
    applied: validation.applied,
    failed: validation.failed
  };
}
