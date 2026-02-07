(function initBatchPrewarm() {
  if (globalThis.ntBatchPrewarm) return;

  const MAX_BATCH_REQUESTS_PER_PAGE = 5000;
  const MAX_BATCH_BYTES = 200 * 1024 * 1024;
  const DEFAULT_SEGMENTS_PER_REQUEST = 1;

  const normalizeWhitespace = (text = '') => String(text || '').trim().replace(/\s+/g, ' ');

  const hashString = (text = '') => {
    let hash = 5381;
    const value = String(text || '');
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) + hash) + value.charCodeAt(i);
      hash |= 0;
    }
    return (hash >>> 0).toString(16);
  };

  const buildCustomId = ({ host, targetLang, segmentKey }) => {
    const safeHost = host || 'unknown';
    const safeLang = targetLang || 'unknown';
    return `${safeHost}::${safeLang}::${hashString(segmentKey)}`;
  };

  const pickBatchEndpoint = (apiBaseUrl) => {
    if (typeof isChatCompletionsEndpoint === 'function' && isChatCompletionsEndpoint(apiBaseUrl)) {
      return '/v1/responses';
    }
    return '/v1/responses';
  };

  const pickBatchModel = (state, stage = 'translation') => {
    const registry = typeof getModelRegistry === 'function' ? getModelRegistry() : null;
    const list = stage === 'translation' ? state.translationModelList : state.translationModelList;
    const defaultModel = state.translationModel;
    const normalizedList = Array.isArray(list) ? list : [defaultModel];
    const resolvedList = normalizedList.map((spec) => (typeof formatModelSpec === 'function'
      ? formatModelSpec(parseModelSpec(spec).id, parseModelSpec(spec).tier)
      : spec));
    const selectedSpec = resolvedList[0];
    const selectedEntry = registry?.byKey?.[selectedSpec] || null;
    const selectedPrice = selectedEntry?.sum_1M ?? null;
    const candidates = resolvedList
      .map((spec) => registry?.byKey?.[spec])
      .filter(Boolean)
      .filter((entry) => {
        if (selectedPrice == null) return true;
        return entry.sum_1M == null || entry.sum_1M <= selectedPrice;
      })
      .sort((a, b) => (a.sum_1M ?? Infinity) - (b.sum_1M ?? Infinity));
    return candidates[0]?.id || selectedEntry?.id || defaultModel;
  };

  const buildBatchPrompt = (texts, targetLang) => {
    const count = texts.length;
    const content = [
      `Target language: ${targetLang}.`,
      `Return only JSON with a \"translations\" array containing exactly ${count} items in the same order.`,
      'Do not add commentary.',
      'Segments:',
      '<<<SEGMENTS_START>>>'
    ];
    texts.forEach((text) => {
      content.push(text);
    });
    content.push('<<<SEGMENTS_END>>>');
    return content.join('\n');
  };

  const buildResponseFormat = (count) => ({
    type: 'json_schema',
    json_schema: {
      name: 'translate_batch',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          translations: {
            type: 'array',
            minItems: count,
            maxItems: count,
            items: { type: 'string' }
          }
        },
        required: ['translations']
      }
    }
  });

  const buildBatchRequestBody = ({ texts, targetLang, model, endpoint }) => {
    const prompt = buildBatchPrompt(texts, targetLang);
    if (endpoint === '/v1/chat/completions') {
      return {
        model,
        messages: [
          { role: 'system', content: typeof TRANSLATE_SYSTEM_PROMPT === 'string' ? TRANSLATE_SYSTEM_PROMPT : 'You are a professional translator.' },
          { role: 'user', content: prompt }
        ],
        response_format: buildResponseFormat(texts.length),
        temperature: 0.2,
        max_tokens: Math.max(120, Math.min(600, 120 * texts.length))
      };
    }
    return {
      model,
      input: [
        { role: 'system', content: typeof TRANSLATE_SYSTEM_PROMPT === 'string' ? TRANSLATE_SYSTEM_PROMPT : 'You are a professional translator.' },
        { role: 'user', content: prompt }
      ],
      response_format: buildResponseFormat(texts.length),
      temperature: 0.2,
      max_output_tokens: Math.max(120, Math.min(600, 120 * texts.length))
    };
  };

  const buildBatchJsonl = ({ items, host, targetLang, model, endpoint, segmentsPerRequest }) => {
    const safeItems = Array.isArray(items) ? items : [];
    const requestMap = {};
    const requests = [];
    const chunkSize = Math.max(1, segmentsPerRequest || DEFAULT_SEGMENTS_PER_REQUEST);
    for (let i = 0; i < safeItems.length; i += chunkSize) {
      const chunk = safeItems.slice(i, i + chunkSize);
      if (!chunk.length) continue;
      const texts = chunk.map((entry) => entry.text);
      const body = buildBatchRequestBody({ texts, targetLang, model, endpoint });
      const customId = buildCustomId({
        host,
        targetLang,
        segmentKey: chunk.map((entry) => entry.segmentKey).join('|')
      });
      requestMap[customId] = {
        items: chunk,
        expectedCount: texts.length
      };
      requests.push({
        custom_id: customId,
        method: 'POST',
        url: endpoint,
        body
      });
      if (requests.length >= MAX_BATCH_REQUESTS_PER_PAGE) break;
    }
    const jsonlText = requests.map((line) => JSON.stringify(line)).join('\n');
    const inputBytes = new TextEncoder().encode(jsonlText).length;
    return {
      jsonlText,
      requestMap,
      requestCount: requests.length,
      inputBytes
    };
  };

  const extractResponseText = (body) => {
    if (!body) return '';
    if (typeof body.output_text === 'string') return body.output_text;
    if (Array.isArray(body.output) && body.output.length) {
      const contentParts = body.output.flatMap((item) => item?.content || []);
      const text = contentParts
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('');
      if (text) return text;
    }
    if (body.choices?.length) {
      if (typeof extractAssistantTextFromChatCompletion === 'function') {
        return extractAssistantTextFromChatCompletion(body, {});
      }
      const messageContent = body.choices?.[0]?.message?.content;
      if (typeof messageContent === 'string') return messageContent;
    }
    if (typeof body === 'string') return body;
    return '';
  };

  const parseBatchOutput = ({ jsonlText, requestMap }) => {
    const lines = String(jsonlText || '').split(/\n+/).filter(Boolean);
    const results = [];
    let errors = 0;
    lines.forEach((line) => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        errors += 1;
        return;
      }
      const customId = parsed?.custom_id;
      const responseBody = parsed?.response?.body || parsed?.response || null;
      if (!customId || !requestMap?.[customId]) {
        errors += 1;
        return;
      }
      if (parsed?.error) {
        errors += 1;
        return;
      }
      const content = extractResponseText(responseBody);
      if (!content) {
        errors += 1;
        return;
      }
      const expectedCount = requestMap[customId]?.expectedCount || 1;
      let translations = null;
      try {
        if (typeof parseTranslationsResponse === 'function') {
          translations = parseTranslationsResponse(content, expectedCount, { enforceLength: true });
        }
      } catch (error) {
        translations = null;
      }
      if (!Array.isArray(translations) || translations.length !== expectedCount) {
        errors += 1;
        return;
      }
      results.push({ customId, translations });
    });
    return { results, errors };
  };

  const normalizeUiKey = (text = '') => normalizeWhitespace(text).toLowerCase();

  const applyBatchToMemory = async ({ storageGet, storageSet, host, targetLang, requestMap, parsed }) => {
    const { results } = parsed;
    if (!results.length) {
      return { tmWrites: 0 };
    }
    const { ntUiTranslationMemory = {}, ntTranslationMemory = {} } = await storageGet({
      ntUiTranslationMemory: {},
      ntTranslationMemory: {}
    });
    let tmWrites = 0;
    const now = Date.now();
    results.forEach((entry) => {
      const mapping = requestMap[entry.customId];
      if (!mapping?.items || !entry.translations) return;
      mapping.items.forEach((item, index) => {
        const translation = entry.translations[index];
        if (!translation) return;
        const segmentKey = item.segmentKey;
        if (item?.source === 'ui') {
          const uiKey = `${targetLang}::${host}::${segmentKey || normalizeUiKey(item.text)}`;
          ntUiTranslationMemory[uiKey] = { translation, ts: now, hitCount: 0 };
          tmWrites += 1;
          return;
        }
        const genericKey = `${targetLang}::${host}::${segmentKey}`;
        ntTranslationMemory[genericKey] = { translation, ts: now, hitCount: 0 };
        tmWrites += 1;
      });
    });
    await storageSet({ ntUiTranslationMemory, ntTranslationMemory });
    return { tmWrites };
  };

  globalThis.ntBatchPrewarm = {
    MAX_BATCH_REQUESTS_PER_PAGE,
    MAX_BATCH_BYTES,
    pickBatchEndpoint,
    pickBatchModel,
    buildBatchJsonl,
    parseBatchOutput,
    applyBatchToMemory
  };
})();
