(function initModelRouter() {
  if (globalThis.ntModelRouter) return;

  const shouldLogJson = () =>
    typeof globalThis.ntJsonLogEnabled === 'function' && globalThis.ntJsonLogEnabled();

  const emitJsonLog = (eventObject) => {
    if (!shouldLogJson()) return;
    if (typeof globalThis.ntJsonLog === 'function') {
      globalThis.ntJsonLog(eventObject);
    }
  };

  const getThroughputState = (operationType, model) => {
    const controller = globalThis.ntThroughputController;
    if (!controller || typeof controller.getStateSnapshot !== 'function') {
      return {
        concurrencyLimit: 1,
        inFlight: 0,
        last429At: 0,
        backoffUntilMs: 0,
        emaLatencyMs: 0,
        recent429Count: 0,
        recentErrors: 0
      };
    }
    const key = globalThis.ntThroughputKey
      ? globalThis.ntThroughputKey(operationType, model)
      : `${operationType || 'unknown'}::${model || 'unknown'}`;
    return controller.getStateSnapshot(key);
  };

  const buildCostRankMap = (modelSpecs = []) => {
    const ranks = new Map();
    modelSpecs.forEach((spec, index) => {
      const parsed = typeof parseModelSpec === 'function' ? parseModelSpec(spec) : { id: spec, tier: 'standard' };
      const modelId = parsed.id || spec;
      if (!modelId || ranks.has(modelId)) return;
      const entry = typeof getModelEntry === 'function' ? getModelEntry(modelId, parsed.tier || 'standard') : null;
      const cost = Number.isFinite(entry?.sum_1M) ? entry.sum_1M : null;
      ranks.set(modelId, Number.isFinite(cost) ? cost : index + 1000);
    });
    return ranks;
  };

  const scoreModel = (state) => {
    const concurrency = Math.max(1, state.concurrencyLimit || 1);
    const inFlightRatio = (state.inFlight || 0) / concurrency;
    const emaLatency = Number.isFinite(state.emaLatencyMs) ? state.emaLatencyMs : 0;
    const recent429 = Number.isFinite(state.recent429Count) ? state.recent429Count : 0;
    const queueDepth = 0;
    return (
      inFlightRatio * 1.5 +
      (emaLatency / 2000) * 1.0 +
      recent429 * 3.0 +
      queueDepth * 0.5
    );
  };

  const selectModel = ({
    type,
    preferredModel,
    allowedModels,
    allowMoreExpensiveFallback = false,
    allowCheaperFallback = true,
    operationType,
    requestId,
    estimatedTokens,
    host
  }) => {
    const candidates = Array.isArray(allowedModels) ? allowedModels.filter(Boolean) : [];
    if (!candidates.length) {
      return { chosenSpec: preferredModel, reason: 'no_candidates', candidatesCount: 0 };
    }
    const parsedPreferred = typeof parseModelSpec === 'function'
      ? parseModelSpec(preferredModel)
      : { id: preferredModel, tier: 'standard' };
    const preferredId = parsedPreferred.id || preferredModel;
    const costRankMap = buildCostRankMap(candidates);
    const preferredCost = costRankMap.get(preferredId);
    const filtered = candidates.filter((spec) => {
      const parsed = typeof parseModelSpec === 'function' ? parseModelSpec(spec) : { id: spec, tier: 'standard' };
      const id = parsed.id || spec;
      if (!id) return false;
      if (!allowMoreExpensiveFallback && Number.isFinite(preferredCost)) {
        const candidateCost = costRankMap.get(id);
        if (Number.isFinite(candidateCost) && candidateCost > preferredCost) return false;
      }
      if (!allowCheaperFallback && Number.isFinite(preferredCost)) {
        const candidateCost = costRankMap.get(id);
        if (Number.isFinite(candidateCost) && candidateCost < preferredCost) return false;
      }
      return true;
    });
    const usable = filtered.length ? filtered : candidates;
    const now = Date.now();
    const scored = usable.map((spec) => {
      const parsed = typeof parseModelSpec === 'function' ? parseModelSpec(spec) : { id: spec, tier: 'standard' };
      const modelId = parsed.id || spec;
      const state = getThroughputState(operationType, modelId);
      return {
        spec,
        modelId,
        state,
        score: scoreModel(state),
        backoffUntilMs: state.backoffUntilMs || 0,
        isBackoff: state.backoffUntilMs && state.backoffUntilMs > now
      };
    });
    const available = scored.filter((entry) => !entry.isBackoff);
    const pool = available.length ? available : scored;
    pool.sort((a, b) => a.score - b.score);
    const best = pool[0];
    let chosen = best;
    let reason = 'best_score';
    if (type === 'ui') {
      const cheapest = pool.reduce((acc, entry) => {
        const cost = costRankMap.get(entry.modelId) ?? Infinity;
        if (!acc) return { entry, cost };
        return cost < acc.cost ? { entry, cost } : acc;
      }, null);
      if (cheapest?.entry) {
        chosen = cheapest.entry;
        reason = 'ui_cheapest';
      }
    } else if (type === 'validate' || type === 'repair') {
      const preferredEntry = pool.find((entry) => entry.modelId === preferredId);
      if (preferredEntry && !preferredEntry.isBackoff) {
        chosen = preferredEntry;
        reason = 'validate_preferred';
      }
    } else {
      const preferredEntry = pool.find((entry) => entry.modelId === preferredId);
      if (preferredEntry) {
        if (preferredEntry.score <= best.score + 0.3) {
          chosen = preferredEntry;
          reason = 'preferred_close';
        }
      }
    }

    emitJsonLog({
      kind: 'model_router.choice',
      ts: now,
      fields: {
        requestId,
        taskType: type,
        preferredModel: preferredId,
        chosenModel: chosen?.modelId || preferredId,
        reason,
        candidatesCount: usable.length,
        estimatedTokens: Number.isFinite(estimatedTokens) ? estimatedTokens : null,
        host
      }
    });

    if (chosen?.modelId && chosen?.modelId !== preferredId && chosen?.isBackoff) {
      emitJsonLog({
        kind: 'model_router.fallback',
        ts: now,
        fields: {
          requestId,
          taskType: type,
          fromModel: preferredId,
          toModel: chosen.modelId,
          backoffUntilMs: chosen.backoffUntilMs
        }
      });
    } else if (chosen?.modelId && chosen?.modelId !== preferredId) {
      const preferredEntry = scored.find((entry) => entry.modelId === preferredId);
      if (preferredEntry?.isBackoff) {
        emitJsonLog({
          kind: 'model_router.fallback',
          ts: now,
          fields: {
            requestId,
            taskType: type,
            fromModel: preferredId,
            toModel: chosen.modelId,
            backoffUntilMs: preferredEntry.backoffUntilMs
          }
        });
      }
    }

    return { chosenSpec: chosen?.spec || preferredModel, reason, candidatesCount: usable.length };
  };

  globalThis.ntModelRouter = {
    selectModel
  };
}());
