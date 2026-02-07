(function initGuardrails() {
  if (globalThis.ntGuardrails) return;

  const LOG_THROTTLE_MS = 15000;
  const lastLogByKey = new Map();

  class InvariantError extends Error {
    constructor(message, options = {}) {
      super(message);
      this.name = 'InvariantError';
      this.guardrailKind = options.kind || 'unknown';
      this.details = options.details || {};
      this.meta = options.meta || {};
    }
  }

  const shouldLog = () => typeof globalThis.ntJsonLogEnabled === 'function' && globalThis.ntJsonLogEnabled();

  const emitViolation = ({ stage, type, expected, actual, meta }) => {
    if (!shouldLog()) return;
    const key = `${stage || 'unknown'}::${type || 'unknown'}::${meta?.requestId || ''}::${meta?.blockKey || ''}`;
    const now = Date.now();
    const last = lastLogByKey.get(key) || 0;
    if (now - last < LOG_THROTTLE_MS) return;
    lastLogByKey.set(key, now);
    globalThis.ntJsonLog?.({
      kind: 'guardrail.violation',
      ts: now,
      fields: {
        stage,
        type,
        expected,
        actual,
        requestId: meta?.requestId || '',
        blockKey: meta?.blockKey || '',
        model: meta?.model || '',
        host: meta?.host || ''
      }
    }, 'warn');
  };

  const assertCountMatch = (stage, expectedCount, actualCount, meta = {}) => {
    if (!Number.isFinite(expectedCount) || !Number.isFinite(actualCount)) {
      return { ok: true };
    }
    if (expectedCount === actualCount) {
      return { ok: true };
    }
    emitViolation({ stage, type: 'count_mismatch', expected: expectedCount, actual: actualCount, meta });
    return {
      ok: false,
      error: new InvariantError('count mismatch', {
        kind: 'count_mismatch',
        details: { expectedCount, actualCount },
        meta
      })
    };
  };

  const assertIdsSubset = (stage, expectedIdsSet, actualIdsArray, meta = {}) => {
    if (!expectedIdsSet || !Array.isArray(actualIdsArray)) {
      return { ok: true };
    }
    const extras = actualIdsArray.filter((id) => !expectedIdsSet.has(id));
    if (!extras.length) {
      return { ok: true };
    }
    emitViolation({ stage, type: 'ids_subset', expected: expectedIdsSet.size, actual: actualIdsArray.length, meta });
    return {
      ok: false,
      error: new InvariantError('ids subset violation', {
        kind: 'ids_subset',
        details: { extras },
        meta
      })
    };
  };

  const PLACEHOLDER_REGEX = /(\{\{[^}]+\}\}|\{\d+\}|%[sdifo]|<\/?[^>]+>)/g;

  const extractPlaceholders = (text = '') => {
    const matches = String(text || '').match(PLACEHOLDER_REGEX) || [];
    return matches.sort();
  };

  const assertPlaceholdersMatch = (sourceText, translatedText, meta = {}) => {
    const sourcePlaceholders = extractPlaceholders(sourceText);
    const translatedPlaceholders = extractPlaceholders(translatedText);
    const mismatch = sourcePlaceholders.length !== translatedPlaceholders.length ||
      sourcePlaceholders.some((value, index) => value !== translatedPlaceholders[index]);
    if (!mismatch) {
      return { ok: true };
    }
    emitViolation({
      stage: meta?.stage || 'translate',
      type: 'placeholders',
      expected: sourcePlaceholders,
      actual: translatedPlaceholders,
      meta
    });
    return {
      ok: false,
      error: new InvariantError('placeholder mismatch', {
        kind: 'placeholders',
        details: { sourcePlaceholders, translatedPlaceholders },
        meta
      })
    };
  };

  const classifyInvariantViolation = (err) => {
    if (!err || typeof err !== 'object') return { kind: 'unknown', details: {} };
    if (err.guardrailKind) {
      return { kind: err.guardrailKind, details: err.details || {} };
    }
    if (err.name === 'InvariantError') {
      return { kind: 'unknown', details: err.details || {} };
    }
    return { kind: 'unknown', details: {} };
  };

  const guardrails = {
    InvariantError,
    assertCountMatch,
    assertIdsSubset,
    assertPlaceholdersMatch,
    classifyInvariantViolation
  };

  globalThis.ntGuardrails = guardrails;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = guardrails;
  }
})();
