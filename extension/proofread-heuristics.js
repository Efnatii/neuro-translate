const PROOFREAD_AUTO_SCORE_THRESHOLD = 8;
const PROOFREAD_AUTO_SCORE_PARTIAL_MAX = 25;

function countMatches(text = '', regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function countLetters(text = '') {
  return countMatches(text, /[\p{L}]/gu);
}

function countLettersByScript(text = '', script) {
  if (!text) return 0;
  switch (script) {
    case 'cyrillic':
      return countMatches(text, /[\p{Script=Cyrillic}]/gu);
    case 'arabic':
      return countMatches(text, /[\p{Script=Arabic}]/gu);
    case 'hebrew':
      return countMatches(text, /[\p{Script=Hebrew}]/gu);
    case 'devanagari':
      return countMatches(text, /[\p{Script=Devanagari}]/gu);
    case 'japanese':
      return countMatches(text, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
    case 'hangul':
      return countMatches(text, /[\p{Script=Hangul}]/gu);
    case 'han':
      return countMatches(text, /[\p{Script=Han}]/gu);
    case 'latin':
    default:
      return countMatches(text, /[\p{Script=Latin}]/gu);
  }
}

function getExpectedScript(targetLang = '') {
  const normalized = targetLang.toLowerCase();
  if (
    normalized.startsWith('ru') ||
    normalized.startsWith('uk') ||
    normalized.startsWith('bg') ||
    normalized.startsWith('sr') ||
    normalized.startsWith('mk')
  ) {
    return 'cyrillic';
  }
  if (normalized.startsWith('ar')) return 'arabic';
  if (normalized.startsWith('he')) return 'hebrew';
  if (normalized.startsWith('hi')) return 'devanagari';
  if (normalized.startsWith('ja')) return 'japanese';
  if (normalized.startsWith('ko')) return 'hangul';
  if (normalized.startsWith('zh')) return 'han';
  if (
    normalized.startsWith('en') ||
    normalized.startsWith('de') ||
    normalized.startsWith('fr') ||
    normalized.startsWith('es') ||
    normalized.startsWith('it') ||
    normalized.startsWith('pt')
  ) {
    return 'latin';
  }
  return 'latin';
}

function extractPlaceholders(text = '') {
  const matches = text.match(/(\{\{[^}]+\}\}|\{[0-9]+\}|%[sd]|<[^>]+>|\[[^\]]+\])/g);
  return matches ? matches.sort() : [];
}

function arraysEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function isEmptyOrNearEmpty(source = '', translation = '') {
  const sourceLetters = countLetters(source);
  const trimmed = String(translation || '').trim();
  if (!trimmed && sourceLetters) return true;
  if (trimmed && !countLetters(trimmed) && sourceLetters) return true;
  return false;
}

function hasBadChars(text = '') {
  if (!text) return false;
  if (text.includes('\ufffd')) return true;
  return /[\u0000-\u001f\u007f-\u009f]/.test(text);
}

function hasWeirdSpacing(text = '') {
  if (!text) return false;
  if (/[ \t]{3,}/.test(text)) return true;
  if (/\s+[,.!?;:]/.test(text)) return true;
  if (/[.!?][A-Za-zА-Яа-я]/.test(text)) return true;
  return false;
}

function hasPunctuationImbalance(text = '') {
  if (!text) return false;
  return /(\.{3,}|[!?]{2,}|[,;:]{3,})/.test(text);
}

function hasBracketMismatch(text = '') {
  if (!text) return false;
  const pairs = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['«', '»']
  ];
  return pairs.some(([open, close]) => countMatches(text, new RegExp(`\\${open}`, 'g')) !== countMatches(text, new RegExp(`\\${close}`, 'g')));
}

function hasLeftoverSourceScript(text = '', targetLang = '') {
  const totalLetters = countLetters(text);
  if (!totalLetters || totalLetters < 12) return false;
  const expectedScript = getExpectedScript(targetLang);
  const expectedLetters = countLettersByScript(text, expectedScript);
  const expectedRatio = expectedLetters / totalLetters;
  return expectedRatio < 0.8;
}

function hasMixedLangTokens(text = '', targetLang = '') {
  const normalized = targetLang.toLowerCase();
  if (!normalized.startsWith('ru')) return false;
  if ((text || '').length < 40) return false;
  return /\b(the|and|with|from|this|that|your|you|for|not|are|was)\b/i.test(text);
}

function hasLengthOutlier(source = '', translation = '') {
  const sourceLength = (source || '').trim().length;
  const translationLength = (translation || '').trim().length;
  if (sourceLength < 30) return false;
  if (!translationLength) return true;
  const ratio = translationLength / sourceLength;
  return ratio < 0.45 || ratio > 2.2;
}

function buildSegmentHeuristic({ source, translation, targetLang }) {
  const reasons = [];
  let score = 0;
  let critical = false;

  if (hasBadChars(translation)) {
    reasons.push('badChar');
    score += 5;
    critical = true;
  }
  if (isEmptyOrNearEmpty(source, translation)) {
    reasons.push('emptyOrNearEmpty');
    score += 5;
    critical = true;
  }
  const sourcePlaceholders = extractPlaceholders(source);
  const translationPlaceholders = extractPlaceholders(translation);
  if (!arraysEqual(sourcePlaceholders, translationPlaceholders)) {
    reasons.push('placeholderMismatch');
    score += 5;
    critical = true;
  }
  if (hasWeirdSpacing(translation)) {
    reasons.push('weirdSpacing');
    score += 2;
  }
  if (hasPunctuationImbalance(translation)) {
    reasons.push('punctuationImbalance');
    score += 2;
  }
  if (hasBracketMismatch(translation)) {
    reasons.push('bracketMismatch');
    score += 2;
  }
  if (hasLeftoverSourceScript(translation, targetLang)) {
    reasons.push('leftoverSourceScript');
    score += 3;
  }
  if (hasLengthOutlier(source, translation)) {
    reasons.push('lengthOutlier');
    score += 3;
  }
  if (hasMixedLangTokens(translation, targetLang)) {
    reasons.push('mixedLangTokens');
    score += 2;
  }

  return {
    score,
    reasons,
    critical,
    sourcePlaceholders,
    translationPlaceholders
  };
}

function shouldProofreadBatch({ targetLang, texts, translations, blockMeta = {} }) {
  const sources = Array.isArray(texts) ? texts : [];
  const translated = Array.isArray(translations) ? translations : [];
  const totalSegments = Math.max(sources.length, translated.length);
  const segmentScores = [];
  let totalScore = 0;
  let maxScore = 0;
  let criticalCount = 0;
  let placeholderMismatchCount = 0;
  let emptyCount = 0;
  let badCharCount = 0;
  let totalLength = 0;
  const batchReasons = new Set();

  for (let index = 0; index < totalSegments; index += 1) {
    const source = sources[index] || '';
    const translation = translated[index] || '';
    totalLength += (translation || '').length;
    const heuristic = buildSegmentHeuristic({ source, translation, targetLang });
    if (heuristic.reasons.includes('placeholderMismatch')) placeholderMismatchCount += 1;
    if (heuristic.reasons.includes('emptyOrNearEmpty')) emptyCount += 1;
    if (heuristic.reasons.includes('badChar')) badCharCount += 1;
    if (heuristic.critical) criticalCount += 1;
    if (heuristic.score > 0) {
      heuristic.reasons.forEach((reason) => batchReasons.add(reason));
    }
    totalScore += heuristic.score;
    maxScore = Math.max(maxScore, heuristic.score);
    segmentScores.push({
      index,
      score: heuristic.score,
      reasons: heuristic.reasons,
      critical: heuristic.critical
    });
  }

  const avgLen = totalSegments ? totalLength / totalSegments : 0;
  const cappedScore = Math.min(60, totalScore);
  const hasCritical = criticalCount > 0;
  const reasons = Array.from(batchReasons);

  let run = false;
  if (hasCritical) {
    run = true;
  } else if (cappedScore >= PROOFREAD_AUTO_SCORE_THRESHOLD) {
    run = true;
  }

  if (!hasCritical && avgLen < 25) {
    run = false;
    reasons.push('avgLenShort');
  }

  if (!hasCritical && totalSegments === 1 && avgLen < 40) {
    run = false;
    reasons.push('singleShortSegment');
  }

  if (blockMeta?.uiLike) {
    run = false;
    reasons.push('uiLike');
  }

  if (blockMeta?.uiMode) {
    run = false;
    reasons.push('uiMode');
  }

  const stats = {
    avgLen,
    criticalCount,
    placeholderMismatchCount,
    emptyCount,
    badCharCount,
    maxSegmentScore: maxScore
  };

  return {
    run,
    reasons,
    score: cappedScore,
    stats,
    segmentScores,
    thresholds: {
      run: PROOFREAD_AUTO_SCORE_THRESHOLD,
      partialMax: PROOFREAD_AUTO_SCORE_PARTIAL_MAX
    }
  };
}

globalThis.ntProofreadHeuristics = {
  shouldProofreadBatch
};
