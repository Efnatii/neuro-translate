(() => {
  class LlmServiceBase {
    /**
     * @param {{client?: any, promptBuilder?: any}=} options
     */
    constructor({ client, promptBuilder } = {}) {
      this.client = client;
      this.promptBuilder = promptBuilder;
    }

    /**
     * @param {object=} meta
     * @param {object=} overrides
     * @returns {object}
     */
    buildRequestMeta(meta = {}, overrides = {}) {
      const merged = { ...(meta || {}), ...(overrides || {}) };
      const requestId = merged.requestId || (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`);
      return {
        ...merged,
        requestId,
        parentRequestId: merged.parentRequestId || '',
        stage: merged.stage || '',
        purpose: merged.purpose || 'main'
      };
    }

    /**
     * @param {Array<object>} debugPayloads
     * @param {object} meta
     * @returns {Array<object>}
     */
    annotateDebug(debugPayloads = [], meta = {}) {
      if (!Array.isArray(debugPayloads)) return [];
      return debugPayloads.map((payload) => ({ ...payload, meta }));
    }

    /**
     * @param {string} text
     * @returns {any}
     */
    safeJsonParse(text) {
      try {
        return JSON.parse(text);
      } catch (error) {
        return null;
      }
    }
  }

  globalThis.LlmServiceBase = LlmServiceBase;
})();
