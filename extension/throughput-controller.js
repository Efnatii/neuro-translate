(function initThroughputController() {
  if (globalThis.ntThroughputController) return;

  const DEFAULT_CONCURRENCY = 6;
  const MIN_CONCURRENCY = 1;
  const MAX_CONCURRENCY = 12;
  const EMA_ALPHA = 0.2;
  const STATE_LOG_INTERVAL_MS = 2000;
  const SUCCESS_COOLDOWN_MS = 30000;

  const stateByKey = new Map();
  const lastStateLogByKey = new Map();

  const shouldLogJson = () =>
    typeof globalThis.ntJsonLogEnabled === 'function' && globalThis.ntJsonLogEnabled();

  const emitJsonLog = (eventObject) => {
    if (!shouldLogJson()) return;
    if (typeof globalThis.ntJsonLog === 'function') {
      globalThis.ntJsonLog(eventObject);
    }
  };

  const getState = (key) => {
    if (!stateByKey.has(key)) {
      stateByKey.set(key, {
        concurrencyLimit: DEFAULT_CONCURRENCY,
        inFlight: 0,
        last429At: 0,
        backoffUntilMs: 0,
        backoffMs: 0,
        emaLatencyMs: null,
        lastLatencyMs: null,
        recentErrors: 0,
        recent429Count: 0,
        lastIncreaseAt: 0
      });
    }
    return stateByKey.get(key);
  };

  const isLatencyStable = (state) => {
    if (!state.emaLatencyMs || !state.lastLatencyMs) return false;
    if (state.emaLatencyMs <= 0) return false;
    const delta = Math.abs(state.lastLatencyMs - state.emaLatencyMs) / state.emaLatencyMs;
    return delta <= 0.3;
  };

  const maybeLogState = (key, state) => {
    const now = Date.now();
    const lastLog = lastStateLogByKey.get(key) || 0;
    if (now - lastLog < STATE_LOG_INTERVAL_MS) return;
    lastStateLogByKey.set(key, now);
    emitJsonLog({
      kind: 'throughput.state',
      ts: now,
      fields: {
        key,
        concurrencyLimit: state.concurrencyLimit,
        inFlight: state.inFlight,
        backoffUntilMs: state.backoffUntilMs,
        last429At: state.last429At,
        emaLatencyMs: state.emaLatencyMs
      }
    });
  };

  const applyBackoff = (key, state) => {
    const now = Date.now();
    const nextBase = Math.max(1000, state.backoffMs ? state.backoffMs * 2 : 1000);
    const jitter = Math.floor(Math.random() * 250);
    const backoffMs = Math.min(60000, nextBase) + jitter;
    state.backoffMs = backoffMs;
    state.backoffUntilMs = now + backoffMs;
    state.last429At = now;
    state.recent429Count += 1;
    state.concurrencyLimit = Math.max(MIN_CONCURRENCY, state.concurrencyLimit - 1);
    emitJsonLog({
      kind: 'throughput.429',
      ts: now,
      fields: {
        key,
        backoffMs,
        newConcurrencyLimit: state.concurrencyLimit,
        concurrencyLimit: state.concurrencyLimit
      }
    });
  };

  const maybeIncreaseConcurrency = (state) => {
    const now = Date.now();
    if (now - state.last429At <= SUCCESS_COOLDOWN_MS) return;
    if (now - state.lastIncreaseAt <= SUCCESS_COOLDOWN_MS) return;
    if (!isLatencyStable(state)) return;
    if (state.recentErrors > 0) return;
    if (state.concurrencyLimit >= MAX_CONCURRENCY) return;
    state.concurrencyLimit += 1;
    state.lastIncreaseAt = now;
  };

  const acquire = async (key) => {
    const state = getState(key);
    while (true) {
      const now = Date.now();
      if (now < state.backoffUntilMs) {
        await sleep(Math.min(250, state.backoffUntilMs - now));
        continue;
      }
      if (state.inFlight < state.concurrencyLimit) {
        state.inFlight += 1;
        maybeLogState(key, state);
        return;
      }
      await sleep(25);
    }
  };

  const release = (key, outcome) => {
    const state = getState(key);
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (outcome === 'rate_limited') {
      applyBackoff(key, state);
    } else if (outcome === 'transient_error') {
      state.recentErrors += 1;
      if (state.recentErrors >= 3) {
        state.concurrencyLimit = Math.max(MIN_CONCURRENCY, state.concurrencyLimit - 1);
        state.recentErrors = 0;
      }
    } else if (outcome === 'success') {
      state.recentErrors = Math.max(0, state.recentErrors - 1);
      state.recent429Count = Math.max(0, state.recent429Count - 1);
      maybeIncreaseConcurrency(state);
    }
    maybeLogState(key, state);
  };

  const getStateSnapshot = (key) => {
    const state = getState(key);
    return {
      concurrencyLimit: state.concurrencyLimit,
      inFlight: state.inFlight,
      last429At: state.last429At,
      backoffUntilMs: state.backoffUntilMs,
      emaLatencyMs: state.emaLatencyMs,
      recent429Count: state.recent429Count,
      recentErrors: state.recentErrors
    };
  };

  const noteRequestStats = (key, { estimatedTokens, actualTokens, latencyMs } = {}) => {
    const state = getState(key);
    if (Number.isFinite(latencyMs)) {
      state.lastLatencyMs = latencyMs;
      if (state.emaLatencyMs == null) {
        state.emaLatencyMs = latencyMs;
      } else {
        state.emaLatencyMs = state.emaLatencyMs + EMA_ALPHA * (latencyMs - state.emaLatencyMs);
      }
    }
    if (Number.isFinite(actualTokens)) {
      state.lastActualTokens = actualTokens;
    } else if (Number.isFinite(estimatedTokens)) {
      state.lastEstimatedTokens = estimatedTokens;
    }
    maybeLogState(key, state);
  };

  globalThis.ntThroughputController = {
    acquire,
    release,
    noteRequestStats,
    getStateSnapshot
  };
  globalThis.ntThroughputKey = (operationType, model) =>
    `${operationType || 'unknown'}::${model || 'unknown'}`;
}());
