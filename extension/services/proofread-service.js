(() => {
  class ProofreadService extends LlmServiceBase {
    /**
     * @param {object} params
     * @param {Array<{id: string, text: string}>} params.segments
     * @param {string=} params.sourceBlock
     * @param {string=} params.translatedBlock
     * @param {string=} params.mode
     * @param {object=} params.contextPayload
     * @param {string} params.modelSpec
     * @param {string} params.apiKey
     * @param {string} params.apiBaseUrl
     * @param {object=} params.requestMeta
     * @param {object=} params.requestOptions
     * @param {AbortSignal=} params.requestSignal
     * @param {string=} params.language
     * @returns {Promise<{translations: string[], rawProofread: string, debug: any[]}>}
     */
    async proofreadSegments({
      segments,
      sourceBlock,
      translatedBlock,
      mode,
      contextPayload,
      modelSpec,
      apiKey,
      apiBaseUrl,
      requestMeta,
      requestOptions,
      requestSignal,
      language
    }) {
      const meta = this.buildRequestMeta(requestMeta, { stage: 'proofread', purpose: 'main' });
      const result = await proofreadTranslation(
        segments,
        sourceBlock,
        translatedBlock,
        contextPayload,
        mode,
        language,
        apiKey,
        modelSpec,
        apiBaseUrl,
        meta,
        requestOptions,
        requestSignal
      );
      return {
        translations: result.translations,
        rawProofread: result.rawProofread,
        debug: this.annotateDebug(result.debug || [], meta)
      };
    }
  }

  globalThis.ProofreadService = ProofreadService;
})();
