(() => {
  class NtJobManager {
    constructor(options = {}) {
      this.entries = new Map();
      // Keep job entries around long enough to coordinate parallel RPCs per jobId.
      this.defaultTtlMs = options.defaultTtlMs ?? 10 * 60 * 1000;
      this.cleanupIntervalMs = options.cleanupIntervalMs ?? Math.min(this.defaultTtlMs, 2 * 60 * 1000);

      if (this.defaultTtlMs > 0 && this.cleanupIntervalMs > 0) {
        this.cleanupTimer = setInterval(() => {
          this.cleanupStale(this.defaultTtlMs);
        }, this.cleanupIntervalMs);
        if (typeof this.cleanupTimer.unref === 'function') {
          this.cleanupTimer.unref();
        }
      }
    }

    acquire(jobId, meta = {}) {
      if (!jobId) return null;

      // A single AbortController is shared per jobId while refCount tracks parallel RPCs.
      const now = Date.now();
      let entry = this.entries.get(jobId);
      const isNew = !entry;

      if (!entry) {
        entry = {
          jobId,
          tabId: meta.tabId ?? null,
          stage: meta.stage || '',
          abortController: new AbortController(),
          createdAt: now,
          lastSeenAt: now,
          refCount: 0,
          cancelledAt: null,
          cancelReason: null
        };
        this.entries.set(jobId, entry);
        console.info('[JobManager] Created job', { jobId, tabId: entry.tabId, stage: entry.stage });
      }

      if (!isNew) {
        if (meta.tabId != null) {
          entry.tabId = meta.tabId;
        }
        if (meta.stage) {
          entry.stage = meta.stage;
        }
      }

      entry.lastSeenAt = now;
      entry.refCount += 1;
      console.info('[JobManager] acquire', {
        jobId,
        refCount: entry.refCount,
        stage: entry.stage,
        tabId: entry.tabId
      });

      let released = false;
      const release = () => {
        if (released) return;
        released = true;

        const current = this.entries.get(jobId);
        if (!current) return;

        current.refCount = Math.max(0, current.refCount - 1);
        current.lastSeenAt = Date.now();
        console.info('[JobManager] release', {
          jobId,
          refCount: current.refCount,
          stage: current.stage,
          tabId: current.tabId
        });
      };

      return { entry, release };
    }

    cancel(jobId, reason = 'cancelled') {
      const entry = this.entries.get(jobId);
      if (!entry) return false;

      entry.cancelledAt = Date.now();
      entry.cancelReason = reason;
      entry.lastSeenAt = entry.cancelledAt;
      console.info('[JobManager] cancel', {
        jobId,
        reason,
        stage: entry.stage,
        tabId: entry.tabId
      });

      try {
        entry.abortController.abort(reason);
      } catch (error) {
        // ignore
      }
      return true;
    }

    get(jobId) {
      return this.entries.get(jobId) ?? null;
    }

    cleanupStale(ttlMs = this.defaultTtlMs) {
      if (!ttlMs) return 0;

      const now = Date.now();
      let removed = 0;
      for (const [jobId, entry] of this.entries) {
        if (entry.refCount === 0 && now - entry.lastSeenAt > ttlMs) {
          this.entries.delete(jobId);
          removed += 1;
        }
      }

      if (removed) {
        console.info('[JobManager] cleaned up stale jobs', { removed });
      }

      return removed;
    }
  }

  globalThis.NtJobManager = NtJobManager;
})();
