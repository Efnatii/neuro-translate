(() => {
  // Retryable codes: transient overloads/timeouts/rate-limits should be re-attempted with backoff by caller.
  const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

  class OpenAiClient {
    /**
     * @param {{apiBaseUrl?: string}=} options
     */
    constructor({ apiBaseUrl } = {}) {
      this.apiBaseUrl = apiBaseUrl || 'https://api.openai.com/v1';
    }

    /**
     * @param {object} params
     * @param {string} params.apiKey
     * @param {string} params.model
     * @param {Array<{role: string, content: string}>} params.messages
     * @param {object=} params.response_format
     * @param {number=} params.timeoutMs
     * @param {object=} params.requestOptions
     * @returns {Promise<{data: any, content: string}>}
     */
    async chatCompletions({ apiKey, model, messages, response_format, timeoutMs, requestOptions }) {
      const controller = new AbortController();
      // Timeout is enforced via AbortController to avoid hanging network requests.
      const timeoutId = Number.isFinite(timeoutMs)
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

      const payload = {
        model,
        messages,
        ...(response_format ? { response_format } : {}),
        ...(requestOptions && typeof requestOptions === 'object' ? requestOptions : {})
      };

      let attempt = 0;
      const maxRetries = 2;
      let lastError = null;

      try {
        while (attempt <= maxRetries) {
          attempt += 1;
          try {
            const response = await fetch(`${this.apiBaseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`
              },
              body: JSON.stringify(payload),
              signal: controller.signal
            });

            if (!response.ok) {
              const errorText = await response.text();
              if (RETRYABLE_STATUS_CODES.has(response.status) && attempt <= maxRetries) {
                continue;
              }
              throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            const content = data?.choices?.[0]?.message?.content || '';
            return { data, content };
          } catch (error) {
            lastError = error;
            if (attempt > maxRetries) throw error;
          }
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      throw lastError || new Error('OpenAI request failed');
    }
  }

  globalThis.OpenAiClient = OpenAiClient;
  globalThis.ntOpenAiClient = globalThis.ntOpenAiClient || new OpenAiClient();
})();
