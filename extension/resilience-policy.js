(function initResiliencePolicy() {
  if (globalThis.ntResiliencePolicy) return;

  const MAX_ATTEMPTS_TOTAL = 8;
  const MAX_TIMEOUTS = 3;
  const MAX_RATE_LIMITS = 4;
  const MAX_ELAPSED_MS = 12 * 60 * 1000;
  const MAX_MODE_LEVEL = 5;
  const STATE_LOG_THROTTLE_MS = 2000;
  const PROOFREAD_DISABLE_WINDOW_MS = 15 * 60 * 1000;

  const stateByKey = new Map();

  const nowMs = () => Date.now();

  const getLogger = () => {
    if (typeof globalThis.ntJsonLog === 'function') {
      return (event) => globalThis.ntJsonLog(event);
    }
    if (typeof globalThis.ntPageJsonLog === 'function') {
      return (event) => globalThis.ntPageJsonLog(event);
    }
    return null;
  };

  const emitLog = (kind, fields) => {
    const logFn = getLogger();
    if (!logFn) return;
    logFn({ kind, ts: nowMs(), fields });
  };

  const getOrCreateState = (key) => {
    if (!key) return null;
    if (!stateByKey.has(key)) {
      stateByKey.set(key, {
        key,
        attemptsTotal: 0,
        timeouts: 0,
        rateLimits: 0,
        startedAtMs: nowMs(),
        modeLevel: 0,
        lastError: null,
        disabledProofreadUntilMs: 0,
        lastLogAtMs: 0
      });
    }
    return stateByKey.get(key);
  };

  const toPublicState = (state) => {
    if (!state) return null;
    return {
      attemptsTotal: state.attemptsTotal,
      timeouts: state.timeouts,
      rateLimits: state.rateLimits,
      startedAtMs: state.startedAtMs,
      modeLevel: state.modeLevel,
      lastError: state.lastError,
      disabledProofreadUntilMs: state.disabledProofreadUntilMs
    };
  };

  const getState = (key) => {
    const state = getOrCreateState(key);
    return toPublicState(state);
  };

  const shouldEscalate = (key, errorType) => {
    const state = getOrCreateState(key);
    if (!state) return false;
    const elapsedMs = nowMs() - state.startedAtMs;
    if (elapsedMs >= MAX_ELAPSED_MS) return true;
    if (state.attemptsTotal >= MAX_ATTEMPTS_TOTAL) return true;
    if (state.timeouts >= MAX_TIMEOUTS) return true;
    if (state.rateLimits >= MAX_RATE_LIMITS) return true;
    if (!errorType) return false;
    if (state.modeLevel >= MAX_MODE_LEVEL) return false;
    if (['count_mismatch', 'schema', 'rate_limited', 'timeout'].includes(errorType)) return true;
    if (errorType === 'transient' && state.attemptsTotal >= 2) return true;
    return false;
  };

  const escalate = (key, reason) => {
    const state = getOrCreateState(key);
    if (!state) return 0;
    const fromLevel = state.modeLevel;
    const toLevel = Math.min(MAX_MODE_LEVEL, fromLevel + 1);
    state.modeLevel = toLevel;
    emitLog('resilience.escalate', {
      key,
      fromLevel,
      toLevel,
      reason: reason || 'auto',
      lastErrorType: state.lastError?.type || ''
    });
    return toLevel;
  };

  const applyModeToOptions = (modeLevel, requestOptions = null) => {
    const base = requestOptions && typeof requestOptions === 'object' ? requestOptions : {};
    const resilience = { ...(base.resilience || {}) };

    resilience.modeLevel = Number.isFinite(modeLevel) ? modeLevel : 0;

    if (resilience.modeLevel >= 1) {
      resilience.splitDepth = Math.max(resilience.splitDepth || 0, 2);
    }
    if (resilience.modeLevel >= 2) {
      resilience.forceAlternateModel = true;
    }
    if (resilience.modeLevel >= 3) {
      resilience.forceShortContext = true;
      resilience.maxContextChars = Math.min(resilience.maxContextChars || 800, 800);
      resilience.maxCompletionTokens = Math.min(resilience.maxCompletionTokens || 1200, 1200);
    }
    if (resilience.modeLevel >= 4) {
      resilience.proofreadMode = 'delta';
    }
    if (resilience.modeLevel >= 5) {
      resilience.forceNoContext = true;
      resilience.perSegment = true;
    }

    const patched = { ...base, resilience };
    if (Number.isFinite(resilience.maxCompletionTokens)) {
      patched.maxCompletionTokens = resilience.maxCompletionTokens;
    }
    return patched;
  };

  const recordOutcome = (key, outcome, stats = {}) => {
    const state = getOrCreateState(key);
    if (!state) return;
    state.attemptsTotal += 1;
    if (outcome === 'timeout') {
      state.timeouts += 1;
    }
    if (outcome === 'rate_limited') {
      state.rateLimits += 1;
    }
    if (stats?.errorMessage || stats?.errorType) {
      state.lastError = {
        type: stats?.errorType || outcome || 'error',
        message: stats?.errorMessage || '',
        ts: nowMs()
      };
    }
    if (Number.isFinite(stats?.disabledProofreadUntilMs)) {
      state.disabledProofreadUntilMs = Math.max(state.disabledProofreadUntilMs, stats.disabledProofreadUntilMs);
    }

    const elapsedMs = nowMs() - state.startedAtMs;
    if (elapsedMs >= MAX_ELAPSED_MS && state.modeLevel < MAX_MODE_LEVEL) {
      state.modeLevel = MAX_MODE_LEVEL;
    }

    const logNow = nowMs();
    if (logNow - state.lastLogAtMs >= STATE_LOG_THROTTLE_MS || state.attemptsTotal <= 2) {
      state.lastLogAtMs = logNow;
      emitLog('resilience.state', {
        key,
        modeLevel: state.modeLevel,
        attemptsTotal: state.attemptsTotal,
        timeouts: state.timeouts,
        rateLimits: state.rateLimits,
        elapsedMs
      });
    }

    if (outcome === 'success') {
      emitLog('resilience.done', {
        key,
        finalModeLevel: state.modeLevel,
        attemptsTotal: state.attemptsTotal,
        elapsedMs
      });
    }

    if (outcome === 'disable_proofread') {
      state.disabledProofreadUntilMs = Math.max(state.disabledProofreadUntilMs, nowMs() + PROOFREAD_DISABLE_WINDOW_MS);
    }
  };

  globalThis.ntResiliencePolicy = {
    getState,
    shouldEscalate,
    escalate,
    applyModeToOptions,
    recordOutcome,
    constants: {
      MAX_ATTEMPTS_TOTAL,
      MAX_TIMEOUTS,
      MAX_RATE_LIMITS,
      MAX_ELAPSED_MS,
      MAX_MODE_LEVEL,
      PROOFREAD_DISABLE_WINDOW_MS
    }
  };
})();
