(function initTaskScheduler() {
  if (globalThis.ntTaskScheduler) return;

  const WINDOW_MS = 60000;
  const DEFAULT_RPM_CAP = 60;
  const DEFAULT_TPM_CAP = 90000;
  const MAX_RPM_CAP = 240;
  const MAX_TPM_CAP = 300000;
  const MIN_RPM_CAP = 10;
  const MIN_TPM_CAP = 5000;

  class SlidingWindow {
    constructor(windowMs = WINDOW_MS) {
      this.windowMs = windowMs;
      this.entries = [];
    }

    add(amount, timestamp) {
      this.entries.push({ timestamp, amount });
    }

    prune(now) {
      while (this.entries.length && this.entries[0].timestamp <= now - this.windowMs) {
        this.entries.shift();
      }
    }

    total() {
      return this.entries.reduce((sum, entry) => sum + entry.amount, 0);
    }

    count() {
      return this.entries.length;
    }

    nextAvailableAt(now) {
      if (!this.entries.length) return now;
      return this.entries[0].timestamp + this.windowMs;
    }
  }

  const createGovernorEntry = () => ({
    rpmWindow: new SlidingWindow(),
    tpmWindow: new SlidingWindow(),
    rpmCap: DEFAULT_RPM_CAP,
    tpmCap: DEFAULT_TPM_CAP,
    backoffUntilMs: 0,
    backoffStreak: 0,
    last429At: 0,
    lastSuccessAt: 0,
    latencyEwmaMs: 0
  });

  class TaskScheduler {
    constructor() {
      this.planByTab = new Map();
      this.governors = new Map();
      this.inFlightByQueue = new Map();
      this.lastTickAt = 0;
    }

    getGovernor(key) {
      if (!this.governors.has(key)) {
        this.governors.set(key, createGovernorEntry());
      }
      return this.governors.get(key);
    }

    startPlan(tabId, plan) {
      if (!tabId) return null;
      const queues = {
        uiTranslate: [],
        contentTranslate: [],
        proofread: [],
        repair: [],
        validate: []
      };
      const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
      tasks.forEach((task) => {
        const type = task?.type || 'contentTranslate';
        if (!queues[type]) return;
        queues[type].push(task);
      });
      const entry = {
        planId: plan?.planId || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        host: plan?.host || '',
        totals: plan?.totals || {},
        queues,
        startedAt: Date.now()
      };
      this.planByTab.set(tabId, entry);
      return entry;
    }

    noteTaskDone(tabId, taskId) {
      const entry = this.planByTab.get(tabId);
      if (!entry || !taskId) return false;
      let removed = false;
      Object.keys(entry.queues).forEach((queueName) => {
        const queue = entry.queues[queueName];
        const idx = queue.findIndex((task) => task?.id === taskId);
        if (idx >= 0) {
          queue.splice(idx, 1);
          removed = true;
        }
      });
      return removed;
    }

    requestSlot({ key, estimatedTokens, queueType }) {
      const now = Date.now();
      const governor = this.getGovernor(key);
      governor.rpmWindow.prune(now);
      governor.tpmWindow.prune(now);
      if (governor.backoffUntilMs && now < governor.backoffUntilMs) {
        return { allowed: false, waitMs: governor.backoffUntilMs - now };
      }
      const rpmUsed = governor.rpmWindow.count();
      const tpmUsed = governor.tpmWindow.total();
      if (rpmUsed >= governor.rpmCap) {
        const waitMs = Math.max(0, governor.rpmWindow.nextAvailableAt(now) - now);
        return { allowed: false, waitMs };
      }
      if (tpmUsed + estimatedTokens > governor.tpmCap) {
        const waitMs = Math.max(0, governor.tpmWindow.nextAvailableAt(now) - now);
        return { allowed: false, waitMs };
      }
      governor.rpmWindow.add(1, now);
      governor.tpmWindow.add(Math.max(0, estimatedTokens || 0), now);
      if (queueType) {
        const current = this.inFlightByQueue.get(queueType) || 0;
        this.inFlightByQueue.set(queueType, current + 1);
      }
      return {
        allowed: true,
        rpmUsed: rpmUsed + 1,
        tpmUsed: tpmUsed + estimatedTokens,
        rpmCap: governor.rpmCap,
        tpmCap: governor.tpmCap
      };
    }

    recordOutcome({ key, status, latencyMs, queueType }) {
      const now = Date.now();
      const governor = this.getGovernor(key);
      if (queueType && this.inFlightByQueue.has(queueType)) {
        const current = this.inFlightByQueue.get(queueType) || 0;
        this.inFlightByQueue.set(queueType, Math.max(0, current - 1));
      }
      if (Number.isFinite(latencyMs)) {
        const alpha = 0.2;
        const prev = governor.latencyEwmaMs || latencyMs;
        governor.latencyEwmaMs = prev + alpha * (latencyMs - prev);
      }
      if (status === 429) {
        governor.last429At = now;
        governor.backoffStreak = Math.min(6, governor.backoffStreak + 1);
        governor.rpmCap = Math.max(MIN_RPM_CAP, Math.round(governor.rpmCap * 0.7));
        governor.tpmCap = Math.max(MIN_TPM_CAP, Math.round(governor.tpmCap * 0.8));
        const base = 1000 * Math.pow(2, governor.backoffStreak);
        const jitter = Math.floor(Math.random() * 400);
        governor.backoffUntilMs = now + base + jitter;
        return { backoffMs: base + jitter };
      }
      governor.lastSuccessAt = now;
      if (!governor.last429At || now - governor.last429At > 60000) {
        governor.rpmCap = Math.min(MAX_RPM_CAP, governor.rpmCap + 1);
        governor.tpmCap = Math.min(MAX_TPM_CAP, governor.tpmCap + 1500);
      }
      return {};
    }

    getTickSnapshot() {
      const queuedByQueue = {
        uiTranslate: 0,
        contentTranslate: 0,
        proofread: 0,
        repair: 0,
        validate: 0
      };
      for (const entry of this.planByTab.values()) {
        Object.keys(queuedByQueue).forEach((queueName) => {
          queuedByQueue[queueName] += entry.queues?.[queueName]?.length || 0;
        });
      }
      const inFlightByQueue = {};
      for (const [queueName, count] of this.inFlightByQueue.entries()) {
        inFlightByQueue[queueName] = count;
      }
      const governorStats = [];
      for (const [key, governor] of this.governors.entries()) {
        governor.rpmWindow.prune(Date.now());
        governor.tpmWindow.prune(Date.now());
        governorStats.push({
          key,
          rpmUsed: governor.rpmWindow.count(),
          tpmUsed: governor.tpmWindow.total(),
          rpmCap: governor.rpmCap,
          tpmCap: governor.tpmCap,
          backoffUntilMs: governor.backoffUntilMs || 0
        });
      }
      return { queuedByQueue, inFlightByQueue, governorStats };
    }
  }

  globalThis.ntTaskScheduler = new TaskScheduler();
})();
