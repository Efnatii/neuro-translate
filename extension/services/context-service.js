(() => {
  class ContextService extends LlmServiceBase {
    /**
     * @param {object} params
     * @param {string} params.text
     * @param {string} params.targetLanguage
     * @param {string} params.modelSpec
     * @param {string} params.apiKey
     * @param {string} params.apiBaseUrl
     * @param {object=} params.requestMeta
     * @param {object=} params.requestOptions
     * @param {AbortSignal=} params.requestSignal
     * @returns {Promise<{context: string, debug: any[]}>}
     */
    async buildContext({ text, targetLanguage, modelSpec, apiKey, apiBaseUrl, requestMeta, requestOptions, requestSignal }) {
      const meta = this.buildRequestMeta(requestMeta, { stage: 'context', purpose: 'main' });
      const result = await generateTranslationContext(
        text,
        apiKey,
        targetLanguage,
        modelSpec,
        apiBaseUrl,
        meta,
        requestOptions,
        requestSignal
      );
      return {
        context: result.context,
        debug: this.annotateDebug(result.debug || [], meta)
      };
    }

    /**
     * @param {object} params
     * @param {string} params.text
     * @param {string} params.targetLanguage
     * @param {string} params.modelSpec
     * @param {string} params.apiKey
     * @param {string} params.apiBaseUrl
     * @param {object=} params.requestMeta
     * @param {object=} params.requestOptions
     * @param {AbortSignal=} params.requestSignal
     * @returns {Promise<{context: string, debug: any[]}>}
     */
    async buildShortContext({ text, targetLanguage, modelSpec, apiKey, apiBaseUrl, requestMeta, requestOptions, requestSignal }) {
      const meta = this.buildRequestMeta(requestMeta, { stage: 'context', purpose: 'short' });
      const result = await generateShortTranslationContext(
        text,
        apiKey,
        targetLanguage,
        modelSpec,
        apiBaseUrl,
        meta,
        requestOptions,
        requestSignal
      );
      return {
        context: result.context,
        debug: this.annotateDebug(result.debug || [], meta)
      };
    }
  }

  globalThis.ContextService = ContextService;
})();
