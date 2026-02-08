(() => {
  class NotificationCenter {
    constructor() {
      /** @type {Map<string, Set<Function>>} */
      this.handlersByType = new Map();
    }

    /**
     * @param {string} eventType
     * @param {(payload: any, meta?: any) => void} handler
     * @returns {() => void}
     */
    on(eventType, handler) {
      if (!this.handlersByType.has(eventType)) {
        this.handlersByType.set(eventType, new Set());
      }
      const handlers = this.handlersByType.get(eventType);
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        if (!handlers.size) this.handlersByType.delete(eventType);
      };
    }

    /**
     * @param {string} eventType
     * @param {(payload: any, meta?: any) => void} handler
     * @returns {() => void}
     */
    once(eventType, handler) {
      let unsubscribe = null;
      const wrapped = (payload, meta) => {
        if (unsubscribe) unsubscribe();
        handler(payload, meta);
      };
      unsubscribe = this.on(eventType, wrapped);
      return unsubscribe;
    }

    /**
     * @param {string} eventType
     * @param {any} payload
     * @param {any=} meta
     */
    emit(eventType, payload, meta) {
      const handlers = this.handlersByType.get(eventType);
      if (!handlers) return;
      [...handlers].forEach((handler) => {
        try {
          handler(payload, meta);
        } catch (error) {
          console.error('[NotificationCenter] handler failed', error);
        }
      });
    }
  }

  globalThis.NotificationCenter = NotificationCenter;
  globalThis.ntNotifications = globalThis.ntNotifications || new NotificationCenter();
})();
