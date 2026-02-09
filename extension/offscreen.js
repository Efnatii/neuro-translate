(() => {
  const OFFSCREEN_TAG = '[offscreen-llm]';
  const handlers = new Map();

  const translationService = new TranslationService({ client: globalThis.ntOpenAiClient });
  const contextService = new ContextService({ client: globalThis.ntOpenAiClient });
  const proofreadService = new ProofreadService({ client: globalThis.ntOpenAiClient });

  handlers.set('translate_text', async (payload) => {
    console.info(`${OFFSCREEN_TAG} translate_text`);
    return translationService.translateSegments(payload);
  });
  handlers.set('generate_context', async (payload) => {
    console.info(`${OFFSCREEN_TAG} generate_context`);
    return contextService.buildContext(payload);
  });
  handlers.set('generate_short_context', async (payload) => {
    console.info(`${OFFSCREEN_TAG} generate_short_context`);
    return contextService.buildShortContext(payload);
  });
  handlers.set('proofread_text', async (payload) => {
    console.info(`${OFFSCREEN_TAG} proofread_text`);
    return proofreadService.proofreadSegments(payload);
  });

  const serializeError = (error) => ({
    message: error?.message || String(error),
    name: error?.name || 'Error',
    stack: error?.stack || '',
    status: error?.status,
    isTimeout: Boolean(error?.isTimeout),
    isCancelled: Boolean(error?.isCancelled),
    isRateLimit: Boolean(error?.isRateLimit),
    isContextOverflow: Boolean(error?.isContextOverflow),
    retryAfterMs: error?.retryAfterMs ?? null
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'OFFSCREEN_LLM_REQUEST') return;
    const { correlationId, action, payload } = message;
    const handler = handlers.get(action);
    if (!handler) {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_LLM_RESPONSE',
        correlationId,
        error: { message: `Unknown offscreen action: ${action}` }
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(payload))
      .then((result) => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_LLM_RESPONSE',
          correlationId,
          result
        });
      })
      .catch((error) => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_LLM_RESPONSE',
          correlationId,
          error: serializeError(error)
        });
      });
  });
})();
