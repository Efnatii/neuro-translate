(() => {
  const DEFAULT_THROTTLE_MS = 7000;

  class UserNotifier {
    constructor() {
      this.lastProgressByTab = new Map();
      this.lastNotifiedAtByTab = new Map();
      this.doneNotifiedByTab = new Set();
    }

    /**
     * @param {number} tabId
     * @param {number} percent
     * @param {string} message
     * @param {number=} throttleMs
     */
    notifyProgress(tabId, percent, message, throttleMs = DEFAULT_THROTTLE_MS) {
      if (!Number.isFinite(tabId)) return;
      const now = Date.now();
      const last = this.lastNotifiedAtByTab.get(tabId) || 0;
      if (now - last < throttleMs) return;
      const lastPercent = this.lastProgressByTab.get(tabId) || 0;
      if (percent < lastPercent && percent < 100) return;
      this.lastProgressByTab.set(tabId, percent);
      this.lastNotifiedAtByTab.set(tabId, now);
      this.doneNotifiedByTab.delete(tabId);
      this.showNotification(`Перевод: ${percent}%`, message || 'В процессе перевода', tabId);
    }

    /**
     * @param {number} tabId
     */
    notifyDone(tabId) {
      if (!Number.isFinite(tabId) || this.doneNotifiedByTab.has(tabId)) return;
      this.doneNotifiedByTab.add(tabId);
      this.showNotification('Перевод завершён', 'Готово', tabId);
    }

    /**
     * @param {number} tabId
     * @param {string} reason
     */
    notifyError(tabId, reason) {
      if (!Number.isFinite(tabId)) return;
      this.doneNotifiedByTab.delete(tabId);
      this.showNotification('Ошибка перевода', reason || 'Не удалось завершить перевод', tabId);
    }

    /**
     * @param {string} title
     * @param {string} message
     * @param {number} tabId
     */
    showNotification(title, message, tabId) {
      if (!chrome.notifications?.create) return;
      const id = `nt_${tabId}_${Date.now()}`;
      try {
        chrome.notifications.create(id, {
          type: 'basic',
          title,
          message: message || ''
        });
      } catch (error) {
        // Ignore notification failures (e.g., permission missing).
      }
    }
  }

  globalThis.UserNotifier = UserNotifier;
  globalThis.ntUserNotifier = globalThis.ntUserNotifier || new UserNotifier();
})();
