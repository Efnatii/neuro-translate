function clampTimeout(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Exported via globalThis for MV3 importScripts usage.
function getLlmTimeoutMs({
  role,
  tier,
  model,
  textsCount,
  totalChars,
  attemptIndex
} = {}) {
  const normalizedRole = typeof role === 'string' ? role.toLowerCase() : '';
  const normalizedTier = tier === 'flex' ? 'flex' : 'standard';
  const safeTextsCount = Number.isFinite(textsCount) ? textsCount : 0;
  const safeTotalChars = Number.isFinite(totalChars) ? totalChars : 0;
  const _model = model || '';
  const _attemptIndex = Number.isFinite(attemptIndex) ? attemptIndex : 0;

  if (normalizedRole === 'translate' || normalizedRole === 'translation') {
    const base = normalizedTier === 'flex' ? 180000 : 90000;
    const batchBonus = 1000 * Math.min(200, safeTextsCount);
    const charsBonus = 50 * Math.min(10000, safeTotalChars);
    return clampTimeout(base + batchBonus + charsBonus, 60000, 300000);
  }

  if (normalizedRole === 'proofread') {
    const base = normalizedTier === 'flex' ? 150000 : 75000;
    return clampTimeout(base, 60000, 240000);
  }

  if (normalizedRole === 'context_full' || normalizedRole === 'context_short') {
    const base = normalizedTier === 'flex' ? 180000 : 90000;
    return clampTimeout(base, 60000, 240000);
  }

  const fallbackBase = normalizedTier === 'flex' ? 180000 : 90000;
  return clampTimeout(fallbackBase, 60000, 240000);
}

globalThis.getLlmTimeoutMs = getLlmTimeoutMs;
