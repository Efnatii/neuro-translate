(() => {
  function deepClone(value) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(value);
      } catch (error) {
        // Fall through to JSON clone.
      }
    }
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return value;
    }
  }

  class StateStore {
    /**
     * @param {chrome.storage.StorageArea=} storageArea
     */
    constructor(storageArea = chrome.storage?.local) {
      this.storageArea = storageArea;
      /** @type {Record<string, any>} */
      this.state = {};
      this.ready = false;
      /** @type {Set<Function>} */
      this.listeners = new Set();
    }

    /**
     * @param {Record<string, any>} initialDefaults
     * @returns {Promise<Record<string, any>>}
     */
    async load(initialDefaults) {
      const defaults = initialDefaults && typeof initialDefaults === 'object' ? initialDefaults : {};
      let stored = {};
      if (this.storageArea && typeof this.storageArea.get === 'function') {
        try {
          stored = await new Promise((resolve, reject) => {
            this.storageArea.get(defaults, (items) => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
              }
              resolve(items && typeof items === 'object' ? items : {});
            });
          });
        } catch (error) {
          console.warn('[StateStore] Failed to load from storage.', error);
          stored = {};
        }
      }
      this.state = { ...defaults, ...stored };
      this.ready = true;
      return this.get();
    }

    /**
     * @returns {Record<string, any>}
     */
    get() {
      return { ...this.state };
    }

    /**
     * @returns {{state: Record<string, any>, ts: number}}
     */
    snapshot() {
      return { state: deepClone(this.state), ts: Date.now() };
    }

    /**
     * @returns {boolean}
     */
    isReady() {
      return this.ready;
    }

    /**
     * @param {Record<string, any>} partial
     * @param {any=} meta
     * @returns {Promise<{changedKeys: string[], values: Record<string, any>, ts: number}>}
     */
    async set(partial, meta) {
      const safePartial = partial && typeof partial === 'object' ? { ...partial } : {};
      this.state = { ...this.state, ...safePartial };
      if (this.storageArea && typeof this.storageArea.set === 'function') {
        try {
          await new Promise((resolve, reject) => {
            this.storageArea.set(safePartial, () => {
              if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
              }
              resolve();
            });
          });
        } catch (error) {
          console.warn('[StateStore] Failed to persist patch.', error);
        }
      }
      const patch = {
        changedKeys: Object.keys(safePartial),
        values: safePartial,
        ts: Date.now()
      };
      this.emitPatch(patch, meta);
      return patch;
    }

    /**
     * @param {string|Record<string, any>} path
     * @param {any=} value
     * @param {any=} meta
     * @returns {Promise<{changedKeys: string[], values: Record<string, any>, ts: number}>}
     */
    async patch(path, value, meta) {
      if (typeof path === 'string') {
        return this.set({ [path]: value }, meta);
      }
      return this.set(path && typeof path === 'object' ? path : {}, meta);
    }

    /**
     * @param {(payload: {patch: {changedKeys: string[], values: Record<string, any>, ts: number}, state: Record<string, any>}, meta?: any) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    /**
     * @param {{changedKeys: string[], values: Record<string, any>, ts: number}} patch
     * @param {any=} meta
     */
    emitPatch(patch, meta) {
      const snapshot = this.get();
      if (globalThis.ntNotifications) {
        globalThis.ntNotifications.emit('STATE_PATCH', { patch, state: snapshot }, meta);
      }
      this.listeners.forEach((listener) => {
        try {
          listener({ patch, state: snapshot }, meta);
        } catch (error) {
          console.error('[StateStore] listener failed', error);
        }
      });
    }
  }

  globalThis.StateStore = StateStore;
  globalThis.ntStateStore = globalThis.ntStateStore || new StateStore();
})();
