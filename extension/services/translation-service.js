(() => {
  class TranslationService extends LlmServiceBase {
    /**
     * @param {object} params
     * @param {string[]} params.segments
     * @param {string} params.targetLanguage
     * @param {object=} params.contextPayload
     * @param {string} params.modelSpec
     * @param {string} params.apiKey
     * @param {string} params.apiBaseUrl
     * @param {boolean=} params.keepPunctuationTokens
     * @param {object=} params.requestMeta
     * @param {object=} params.requestOptions
     * @param {AbortSignal=} params.requestSignal
     * @returns {Promise<{translations: string[], rawTranslation: string, debug: any[]}>}
     */
    async translateSegments({
      segments,
      targetLanguage,
      contextPayload,
      modelSpec,
      apiKey,
      apiBaseUrl,
      keepPunctuationTokens,
      requestMeta,
      requestOptions,
      requestSignal
    }) {
      const meta = this.buildRequestMeta(requestMeta, { stage: 'translation', purpose: 'main' });
      const result = await translateTexts(
        segments,
        apiKey,
        targetLanguage,
        modelSpec,
        contextPayload,
        apiBaseUrl,
        keepPunctuationTokens,
        meta,
        requestOptions,
        requestSignal
      );
      return {
        translations: result.translations,
        rawTranslation: result.rawTranslation,
        debug: this.annotateDebug(result.debug || [], meta)
      };
    }
  }

  globalThis.TranslationService = TranslationService;
})();
