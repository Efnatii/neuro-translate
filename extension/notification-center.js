(() => {
  class NotificationCenter {
    constructor({ storageKey = 'statusSnapshotsByTab' } = {}) {
      this.storageKey = storageKey;
      /** @type {Map<number, any>} */
      this.snapshotsByTab = new Map();
      /** @type {Map<chrome.runtime.Port, {topics: Set<string>}>} */
      this.subscribers = new Map();
    }

    publish(topic, payload) {
      const envelope = { type: topic, payload };
      for (const [port, subscription] of this.subscribers.entries()) {
        if (!subscription?.topics?.size || subscription.topics.has(topic)) {
          try {
            port.postMessage(envelope);
          } catch (error) {
            this.unsubscribe(port);
          }
        }
      }
    }

    subscribe(port, topics = []) {
      if (!port) return;
      const topicList = Array.isArray(topics) ? topics : [];
      this.subscribers.set(port, { topics: new Set(topicList) });
      port.onDisconnect.addListener(() => {
        this.unsubscribe(port);
      });
    }

    unsubscribe(port) {
      this.subscribers.delete(port);
    }

    async getSnapshot(tabId) {
      if (!Number.isFinite(tabId)) return null;
      if (this.snapshotsByTab.has(tabId)) {
        return this.snapshotsByTab.get(tabId) || null;
      }
      const stored = await this.readSnapshotStore();
      const snapshot = stored?.[tabId] || null;
      if (snapshot) {
        this.snapshotsByTab.set(tabId, snapshot);
      }
      return snapshot;
    }

    async getAllSnapshots() {
      if (this.snapshotsByTab.size) {
        return Array.from(this.snapshotsByTab.values());
      }
      const stored = await this.readSnapshotStore();
      const snapshots = Object.values(stored || {});
      snapshots.forEach((snapshot) => {
        if (snapshot?.tabId != null) {
          this.snapshotsByTab.set(snapshot.tabId, snapshot);
        }
      });
      return snapshots;
    }

    async setSnapshot(tabId, snapshot) {
      if (!Number.isFinite(tabId)) return;
      const normalized = this.normalizeSnapshot(tabId, snapshot);
      this.snapshotsByTab.set(tabId, normalized);
      await this.writeSnapshotStore(tabId, normalized);
    }

    normalizeSnapshot(tabId, snapshot) {
      const progress = snapshot?.progress && typeof snapshot.progress === 'object' ? snapshot.progress : {};
      return {
        tabId,
        url: snapshot?.url || '',
        stage: snapshot?.stage || 'idle',
        progress: {
          completed: Number.isFinite(progress.completed) ? progress.completed : 0,
          total: Number.isFinite(progress.total) ? progress.total : 0,
          inFlight: Number.isFinite(progress.inFlight) ? progress.inFlight : 0,
          applied: Number.isFinite(progress.applied) ? progress.applied : 0
        },
        lastError: snapshot?.lastError ?? snapshot?.error ?? null,
        updatedAt: Number.isFinite(snapshot?.updatedAt) ? snapshot.updatedAt : Date.now()
      };
    }

    async readSnapshotStore() {
      if (!chrome?.storage?.session) return {};
      return new Promise((resolve) => {
        try {
          chrome.storage.session.get({ [this.storageKey]: {} }, (data) => {
            resolve(data?.[this.storageKey] || {});
          });
        } catch (error) {
          resolve({});
        }
      });
    }

    async writeSnapshotStore(tabId, snapshot) {
      if (!chrome?.storage?.session) return;
      return new Promise((resolve) => {
        try {
          chrome.storage.session.get({ [this.storageKey]: {} }, (data) => {
            const store = data?.[this.storageKey] && typeof data[this.storageKey] === 'object'
              ? data[this.storageKey]
              : {};
            store[tabId] = snapshot;
            chrome.storage.session.set({ [this.storageKey]: store }, () => resolve(true));
          });
        } catch (error) {
          resolve(false);
        }
      });
    }
  }

  globalThis.StatusNotificationCenter = NotificationCenter;
  globalThis.ntStatusCenter = globalThis.ntStatusCenter || new NotificationCenter();
})();
