const DEFAULT_TRANSLATION_TIMEOUT_MS = 45000;
const MAX_TRANSLATION_TIMEOUT_MS = 180000;
const PUNCTUATION_TOKENS = new Map([
  ['«', '⟦PUNC_LGUILLEMET⟧'],
  ['»', '⟦PUNC_RGUILLEMET⟧'],
  ['“', '⟦PUNC_LDQUOTE⟧'],
  ['”', '⟦PUNC_RDQUOTE⟧'],
  ['"', '⟦PUNC_DQUOTE⟧']
]);
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

function isRetryableStatus(status) {
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

function storageLocalGet(keysOrDefaults, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    let hasCompleted = false;
    const timeoutId = setTimeout(() => {
      if (hasCompleted) return;
      hasCompleted = true;
      reject(new Error('storageLocalGet timeout'));
    }, timeoutMs);
    try {
      chrome.storage.local.get(keysOrDefaults, (items) => {
        if (hasCompleted) return;
        hasCompleted = true;
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
          return;
        }
        if (!items || typeof items !== 'object') {
          resolve({});
          return;
        }
        resolve(items);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function getModelThroughputInfo(model) {
  try {
    const { modelThroughputById = {} } = await storageLocalGet({ modelThroughputById: {} });
    return modelThroughputById?.[model] || null;
  } catch (error) {
    console.warn('Failed to read model throughput info, using defaults.', error);
    return null;
  }
}

function calculateTranslationTimeoutMs(texts, throughputInfo) {
  if (!throughputInfo?.tokensPerSecond || throughputInfo.tokensPerSecond <= 0) {
    return DEFAULT_TRANSLATION_TIMEOUT_MS;
  }

  const totalChars = texts.reduce((sum, text) => sum + (text?.length || 0), 0);
  const estimatedTokens = Math.max(1, Math.ceil(totalChars / 4) + 200);
  const estimatedMs = (estimatedTokens / throughputInfo.tokensPerSecond) * 1000;
  const paddedMs = estimatedMs * 2.5;

  return Math.min(Math.max(DEFAULT_TRANSLATION_TIMEOUT_MS, Math.round(paddedMs)), MAX_TRANSLATION_TIMEOUT_MS);
}

async function translateTexts(
  texts,
  apiKey,
  targetLanguage = 'ru',
  model,
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  keepPunctuationTokens = false
) {
  if (!Array.isArray(texts) || !texts.length) return { translations: [], rawTranslation: '' };

  const maxTimeoutAttempts = 2;
  const maxRetryableRetries = 3;
  let timeoutAttempts = 0;
  let retryableRetries = 0;
  let lastError = null;
  let lastRetryDelayMs = null;
  let lastRawTranslation = '';
  const debugPayloads = [];
  const appendParseIssue = (issue) => {
    if (!issue) return;
    const last = debugPayloads[debugPayloads.length - 1];
    if (last) {
      if (!Array.isArray(last.parseIssues)) {
        last.parseIssues = [];
      }
      last.parseIssues.push(issue);
      return;
    }
    debugPayloads.push({
      phase: 'TRANSLATE',
      model,
      latencyMs: null,
      usage: null,
      costUsd: null,
      inputChars: null,
      outputChars: null,
      request: null,
      response: null,
      parseIssues: [issue]
    });
  };
  const throughputInfo = await getModelThroughputInfo(model);
  const timeoutMs = calculateTranslationTimeoutMs(texts, throughputInfo);

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await performTranslationRequest(
        texts,
        apiKey,
        targetLanguage,
        model,
        controller.signal,
        context,
        apiBaseUrl,
        !keepPunctuationTokens
      );
      lastRawTranslation = result.rawTranslation;
      if (Array.isArray(result?.debug)) {
        debugPayloads.push(...result.debug);
      }
      return {
        translations: result.translations,
        rawTranslation: result.rawTranslation,
        debug: debugPayloads
      };
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error('Translation request timed out') : error;
      if (error?.rawTranslation) {
        lastRawTranslation = error.rawTranslation;
      }
      if (error?.debugPayload) {
        debugPayloads.push(error.debugPayload);
      }

      const isTimeout = error?.name === 'AbortError' || error?.message?.toLowerCase?.().includes('timed out');
      if (isTimeout && timeoutAttempts < maxTimeoutAttempts - 1) {
        timeoutAttempts += 1;
        appendParseIssue('retry:timeout');
        console.warn('Translation attempt timed out, retrying...');
        continue;
      }

      const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
      const isRetryable = isRetryableStatus(error?.status) || error?.isRetryable || isRateLimit;
      if (isRetryable && retryableRetries < maxRetryableRetries) {
        retryableRetries += 1;
        const retryDelayMs = calculateRetryDelayMs(retryableRetries, error?.retryAfterMs);
        lastRetryDelayMs = retryDelayMs;
        const retryLabel = isRateLimit ? 'rate-limited' : 'temporarily unavailable';
        appendParseIssue('retry:retryable');
        console.warn(`Translation attempt ${retryLabel}, retrying after ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }

      const isLengthIssue = error?.message?.toLowerCase?.().includes('length mismatch');
      if (isLengthIssue && texts.length > 1) {
        console.warn('Falling back to per-item translation due to length mismatch.');
        appendParseIssue('fallback:per-item');
        const translations = await translateIndividually(
          texts,
          apiKey,
          targetLanguage,
          model,
          context,
          apiBaseUrl,
          keepPunctuationTokens,
          debugPayloads
        );
        return { translations, rawTranslation: lastRawTranslation, debug: debugPayloads };
      }

      if (isRateLimit) {
        const waitSeconds = Math.max(1, Math.ceil((lastRetryDelayMs || error?.retryAfterMs || 30000) / 1000));
        throw new Error(`Rate limit reached—please retry in ${waitSeconds} seconds.`);
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function performTranslationRequest(
  texts,
  apiKey,
  targetLanguage,
  model,
  signal,
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  restorePunctuation = true,
  strictTargetLanguage = false,
  allowRefusalRetry = true,
  allowLengthRetry = true
) {
  const tokenizedTexts = texts.map(applyPunctuationTokens);
  const inputChars = tokenizedTexts.reduce((sum, text) => sum + (text?.length || 0), 0) + (context?.length || 0);

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: [
        'You are a professional translator.',
        'Translate every element of the provided "texts" list into the target language with natural, idiomatic phrasing that preserves meaning and readability.',
        'Never omit, add, or generalize information. Preserve modality, tense, aspect, tone, and level of certainty.',
        'You may add or adjust punctuation marks for naturalness, but do not change punctuation tokens.',
        'Preserve numbers, units, currencies, dates, and formatting unless explicitly instructed otherwise.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Translate proper names, titles, and terms; when unsure, transliterate them instead of leaving them unchanged unless they are established brands or standard in the target language.',
        'Do not leave any source text untranslated. Do not copy the source text verbatim except for placeholders, markup, punctuation tokens, or text that is already in the target language.',
        'The final output must be entirely in the target language with no source-language fragments.',
        'Ensure terminology consistency within the same request.',
        strictTargetLanguage
          ? `Every translation must be in ${targetLanguage}. If a phrase would normally remain in the source language, transliterate it into ${targetLanguage} instead.`
          : null,
        PUNCTUATION_TOKEN_HINT,
        'Determine the most appropriate tone/style based on the provided context.',
        'If page context is provided in the user message, use it only for disambiguation; never introduce new facts.',
        'Do not translate, quote, paraphrase, or include the context text in the output unless it is required to translate the source segments.',
        'If no context is provided, do not invent context or add assumptions.',
        'Never include page context text in the translations unless it is explicitly part of the source segments.',
        'Respond only with a JSON object containing the translated segments in the same order as the input segments under a "translations" array.',
        'Do not add commentary.',
        `Target language: ${targetLanguage}.`
      ]
        .filter(Boolean)
        .join(' ')
    },
    {
      role: 'user',
      content: [
        `Translate the following segments into ${targetLanguage}.`,
        'Determine the style automatically based on context.',
        context
          ? [
              'Use the page context for disambiguation only.',
              'Do not translate, quote, paraphrase, or include the context text in the output unless it is required to translate the source segments.',
              `Page context (do not translate): <<<CONTEXT_START>>>${context}<<<CONTEXT_END>>>`
            ].join('\n')
          : '',
        'Do not omit or add information; preserve modality, tense, aspect, tone, and level of certainty.',
        'You may add or adjust punctuation marks for naturalness, but do not change punctuation tokens.',
        'Preserve numbers, units, currencies, dates, and formatting unless explicitly instructed otherwise.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Translate names/titles/terms; if unsure, transliterate rather than leaving them untranslated, except for established brands.',
        'Do not leave any source text untranslated. Do not copy segments verbatim except for placeholders, markup, punctuation tokens, or text already in the target language.',
        `Ensure the output is entirely in ${targetLanguage} with no source-language fragments.`,
        'Never include page context text in the translations unless it is explicitly part of the source segments.',
        'Keep terminology consistent within a single request.',
        strictTargetLanguage
          ? `Every translation must be in ${targetLanguage}. If something would typically remain in the source language, transliterate it into ${targetLanguage} instead.`
          : null,
        `Do not change punctuation service tokens. ${PUNCTUATION_TOKEN_HINT}`,
        `Return only a JSON object with a "translations" array containing exactly ${tokenizedTexts.length} items, one per segment, in the same order.`,
        'Segments to translate:',
        '<<<SEGMENTS_START>>>',
        ...tokenizedTexts.map((text) => text),
        '<<<SEGMENTS_END>>>'
      ]
        .filter(Boolean)
        .join('\n')
    }
  ], apiBaseUrl);

  const requestPayload = {
    model,
    messages: prompt,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'translations',
        schema: {
          type: 'object',
          properties: {
            translations: {
              type: 'array',
              minItems: tokenizedTexts.length,
              maxItems: tokenizedTexts.length,
              items: { type: 'string' }
            }
          },
          required: ['translations'],
          additionalProperties: false
        }
      }
    }
  };
  const startedAt = Date.now();
  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorPayload = null;
    try {
      errorPayload = JSON.parse(errorText);
    } catch (parseError) {
      errorPayload = null;
    }
    const retryAfterMs = parseRetryAfterMs(response, errorPayload);
    const sanitizedErrorText = isHtmlPayload(errorText)
      ? response.statusText || 'Bad Gateway'
      : errorText;
    const errorMessage =
      errorPayload?.error?.message || errorPayload?.message || sanitizedErrorText || 'Unknown error';
    const error = new Error(`Translation request failed: ${response.status} ${errorMessage}`);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs;
    error.isRateLimit = response.status === 429 || response.status === 503;
    error.isRetryable = isRetryableStatus(response.status);
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No translation returned');
  }
  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const costUsd = calculateUsageCost(usage, model);
  const debugPayload = {
    phase: 'TRANSLATE',
    model,
    latencyMs,
    usage,
    costUsd,
    inputChars,
    outputChars: content?.length || 0,
    request: requestPayload,
    response: content,
    parseIssues: []
  };
  const debugPayloads = [debugPayload];

  let translations;
  try {
    translations = parseTranslationsResponse(content, texts.length);
  } catch (error) {
    if (error && typeof error === 'object') {
      debugPayload.parseIssues.push(error?.message || 'parse-error');
      error.debugPayload = debugPayload;
    }
    if (error && typeof error === 'object') {
      error.rawTranslation = content;
    }
    throw error;
  }
  const refusalIndices = translations
    .map((translation, index) => (isRefusalOrLimitTranslation(translation) ? index : null))
    .filter((value) => Number.isInteger(value));

  if (allowRefusalRetry && refusalIndices.length) {
    refusalIndices.forEach((index) => {
      console.warn('Translation refusal/limit detected; retrying segment individually.', {
        segmentIndex: index,
        text: texts[index]
      });
    });

    const retryTexts = refusalIndices.map((index) => texts[index]);
    const retryResults = await translateIndividually(
      retryTexts,
      apiKey,
      targetLanguage,
      model,
      context,
      apiBaseUrl,
      !restorePunctuation,
      false,
      true,
      debugPayloads
    );

    refusalIndices.forEach((index, retryPosition) => {
      const retryCandidate = retryResults?.[retryPosition];
      if (typeof retryCandidate === 'string' && retryCandidate.trim() && !isRefusalOrLimitTranslation(retryCandidate)) {
        translations[index] = retryCandidate;
        return;
      }

      console.warn('Translation refusal persisted after retry; keeping source segment.', {
        segmentIndex: index,
        text: texts[index],
        retry: retryCandidate
      });
      translations[index] = texts[index];
    });
  }

  if (!strictTargetLanguage && targetLanguage?.toLowerCase?.().startsWith('ru')) {
    const retryIndices = translations
      .map((translation, index) =>
        shouldRetryRussianTranslation(texts[index] || '', translation || '') ? index : null
      )
      .filter((value) => Number.isInteger(value));

    if (retryIndices.length) {
      const retryTexts = retryIndices.map((index) => texts[index]);
      const retryResults = await performTranslationRequest(
        retryTexts,
        apiKey,
        targetLanguage,
        model,
        signal,
        context,
        apiBaseUrl,
        restorePunctuation,
        true,
        allowRefusalRetry
      );
      const retryTranslations = retryResults?.translations || [];
      if (Array.isArray(retryResults?.debug)) {
        debugPayloads.push(...retryResults.debug);
      }

      retryIndices.forEach((index, retryPosition) => {
        if (retryTranslations?.[retryPosition]) {
          translations[index] = retryTranslations[retryPosition];
        }
      });
    }
  }

  if (allowLengthRetry) {
    const lengthRetryIndices = translations
      .map((translation, index) =>
        shouldRetryTranslationLength(texts[index] || '', translation || '') ? index : null
      )
      .filter((value) => Number.isInteger(value));

    if (lengthRetryIndices.length) {
      const retryTexts = lengthRetryIndices.map((index) => texts[index]);
      console.warn('Translation length anomaly detected; retrying segments individually.', {
        segmentIndices: lengthRetryIndices
      });
      const retryResults = await translateIndividually(
        retryTexts,
        apiKey,
        targetLanguage,
        model,
        context,
        apiBaseUrl,
        !restorePunctuation,
        allowRefusalRetry,
        false,
        debugPayloads
      );
      lengthRetryIndices.forEach((index, retryPosition) => {
        if (retryResults?.[retryPosition]) {
          translations[index] = retryResults[retryPosition];
        }
      });
    }
  }

  translations = await repairTranslationsForLanguage(
    texts,
    translations,
    apiKey,
    targetLanguage,
    model,
    context,
    apiBaseUrl,
    debugPayloads
  );

  return {
    translations: texts.map((text, index) => {
      const candidate = translations[index];
      if (typeof candidate === 'string' && candidate.trim()) {
        return restorePunctuation ? restorePunctuationTokens(candidate) : candidate;
      }
      return text;
    }),
    rawTranslation: content,
    debug: debugPayloads
  };
}

async function performTranslationRepairRequest(
  items,
  apiKey,
  targetLanguage,
  model,
  signal,
  context = '',
  apiBaseUrl = OPENAI_API_URL
) {
  const normalizedItems = items.map((item) => ({
    id: item.id,
    source: applyPunctuationTokens(item.source || ''),
    draft: applyPunctuationTokens(item.draft || '')
  }));
  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: [
        'You are a professional translator.',
        'You receive source text and a draft translation that may contain untranslated fragments.',
        'Fix the draft so the output is fully in the target language with no source-language fragments.',
        'Preserve meaning, formatting, punctuation tokens, placeholders, markup, code, numbers, units, and links.',
        'Do not add or remove information. Do not add commentary.',
        `Target language: ${targetLanguage}.`,
        PUNCTUATION_TOKEN_HINT
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Repair the following translations into ${targetLanguage}.`,
        context
          ? [
              'Use the page context only for disambiguation.',
              'Do not translate or include the context in the output.',
              `Context (do not translate): <<<CONTEXT_START>>>${context}<<<CONTEXT_END>>>`
            ].join('\n')
          : '',
        'Return only JSON with a "translations" array matching the input order.',
        'Items: (JSON array of {id, source, draft})',
        JSON.stringify(normalizedItems)
      ]
        .filter(Boolean)
        .join('\n')
    }
  ], apiBaseUrl);

  const requestPayload = {
    model,
    messages: prompt,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'translations_repair',
        schema: {
          type: 'object',
          properties: {
            translations: {
              type: 'array',
              minItems: normalizedItems.length,
              maxItems: normalizedItems.length,
              items: { type: 'string' }
            }
          },
          required: ['translations'],
          additionalProperties: false
        }
      }
    }
  };
  const startedAt = Date.now();
  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Repair request failed: ${response.status} ${errorText}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No repair translation returned');
  }
  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const costUsd = calculateUsageCost(usage, model);
  const debugPayload = {
    phase: 'TRANSLATE_REPAIR',
    model,
    latencyMs,
    usage,
    costUsd,
    inputChars: normalizedItems.reduce(
      (sum, item) => sum + (item.source?.length || 0) + (item.draft?.length || 0),
      0
    ),
    outputChars: content?.length || 0,
    request: requestPayload,
    response: content,
    parseIssues: []
  };

  let translations = null;
  try {
    translations = parseTranslationsResponse(content, normalizedItems.length);
  } catch (error) {
    debugPayload.parseIssues.push(error?.message || 'parse-error');
    throw error;
  }

  return {
    translations: translations.map((text) => restorePunctuationTokens(text)),
    rawTranslation: content,
    debug: debugPayload
  };
}

async function repairTranslationsForLanguage(
  texts,
  translations,
  apiKey,
  targetLanguage,
  model,
  context,
  apiBaseUrl,
  debugPayloads
) {
  const repairItems = [];
  const repairIndices = [];
  translations.forEach((translated, index) => {
    if (needsLanguageRepair(texts[index] || '', translated || '', targetLanguage)) {
      repairIndices.push(index);
      repairItems.push({ id: String(index), source: texts[index], draft: translated });
    }
  });
  if (!repairItems.length) {
    return translations;
  }

  if (Array.isArray(debugPayloads)) {
    const last = debugPayloads[debugPayloads.length - 1];
    if (last) {
      if (!Array.isArray(last.parseIssues)) {
        last.parseIssues = [];
      }
      last.parseIssues.push('fallback:language-repair');
    } else {
      debugPayloads.push({
        phase: 'TRANSLATE',
        model,
        latencyMs: null,
        usage: null,
        costUsd: null,
        inputChars: null,
        outputChars: null,
        request: null,
        response: null,
        parseIssues: ['fallback:language-repair']
      });
    }
  }

  try {
    const repairResult = await performTranslationRepairRequest(
      repairItems,
      apiKey,
      targetLanguage,
      model,
      undefined,
      context,
      apiBaseUrl
    );
    if (repairResult?.debug && Array.isArray(debugPayloads)) {
      if (!Array.isArray(repairResult.debug.parseIssues)) {
        repairResult.debug.parseIssues = [];
      }
      repairResult.debug.parseIssues.push('fallback:language-repair');
      debugPayloads.push(repairResult.debug);
    }
    repairIndices.forEach((index, position) => {
      const candidate = repairResult.translations?.[position];
      if (typeof candidate === 'string' && candidate.trim()) {
        translations[index] = candidate;
      }
    });
  } catch (error) {
    console.warn('Translation repair failed; keeping original translations.', error);
  }

  return translations;
}

async function translateIndividually(
  texts,
  apiKey,
  targetLanguage,
  model,
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  keepPunctuationTokens = false,
  allowRefusalRetry = true,
  allowLengthRetry = true,
  debugPayloads = null
) {
  const results = [];
  const maxRetryableRetries = 3;

  for (const text of texts) {
    let retryableRetries = 0;

    while (true) {
      try {
        const result = await performTranslationRequest(
          [text],
          apiKey,
          targetLanguage,
          model,
          undefined,
          context,
          apiBaseUrl,
          !keepPunctuationTokens,
          false,
          allowRefusalRetry,
          allowLengthRetry
        );
        if (Array.isArray(result?.debug) && Array.isArray(debugPayloads)) {
          debugPayloads.push(...result.debug);
        }
        results.push(result.translations[0]);
        break;
      } catch (error) {
        const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
        const isRetryable = isRetryableStatus(error?.status) || error?.isRetryable || isRateLimit;
        if (isRetryable && retryableRetries < maxRetryableRetries) {
          retryableRetries += 1;
          const retryDelayMs = calculateRetryDelayMs(retryableRetries, error?.retryAfterMs);
          const retryLabel = isRateLimit ? 'rate-limited' : 'temporarily unavailable';
          console.warn(`Single-item translation ${retryLabel}, retrying after ${retryDelayMs}ms...`);
          await sleep(retryDelayMs);
          continue;
        }

        console.error('Single-item translation failed, keeping original text.', error);
        results.push(text);
        break;
      }
    }
  }

  return results;
}

function parseJsonArrayStrict(content, expectedLength, label = 'response') {
  const normalizeString = (value = '') =>
    value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  const normalizedContent = normalizeString(String(content ?? '')).trim();
  if (!normalizedContent.startsWith('[') || !normalizedContent.endsWith(']')) {
    throw new Error(`${label} response is not a JSON array.`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch (error) {
    throw new Error(`${label} response JSON parsing failed.`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${label} response is not a JSON array.`);
  }

  const normalizedArray = parsed.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
  if (expectedLength && normalizedArray.length !== expectedLength) {
    throw new Error(`${label} response length mismatch: expected ${expectedLength}, got ${normalizedArray.length}`);
  }

  return normalizedArray;
}

function parseJsonArrayFlexible(content, expectedLength, label = 'response') {
  try {
    return parseJsonArrayStrict(content, expectedLength, label);
  } catch (error) {
    console.warn(`${label} response strict parsing failed; attempting to extract JSON array.`, error);
  }

  const extracted = extractJsonArray(content, label);
  const normalizedArray = extracted.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
  if (expectedLength && normalizedArray.length !== expectedLength) {
    throw new Error(`${label} response length mismatch: expected ${expectedLength}, got ${normalizedArray.length}`);
  }

  return normalizedArray;
}

function parseJsonObjectFlexible(content = '', label = 'response') {
  const normalizeString = (value = '') =>
    value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  const normalizedContent = normalizeString(String(content ?? '')).trim();
  if (!normalizedContent) {
    throw new Error(`${label} response is empty.`);
  }

  let parsed = null;
  try {
    parsed = JSON.parse(normalizedContent);
  } catch (error) {
    const startIndex = normalizedContent.indexOf('{');
    const endIndex = normalizedContent.lastIndexOf('}');
    if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
      throw new Error(`${label} response does not contain a JSON object.`);
    }

    const slice = normalizedContent.slice(startIndex, endIndex + 1);
    try {
      parsed = JSON.parse(slice);
    } catch (innerError) {
      throw new Error(`${label} response JSON parsing failed.`);
    }
  }

  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`${label} response is not a JSON object.`);
  }

  return parsed;
}

function parseTranslationsResponse(content, expectedLength) {
  try {
    const parsed = parseJsonObjectFlexible(content, 'translation');
    const translations = parsed?.translations;
    if (!Array.isArray(translations)) {
      throw new Error('translation response is missing translations array.');
    }
    const normalizedArray = translations.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
    if (expectedLength && normalizedArray.length !== expectedLength) {
      throw new Error(
        `translation response length mismatch: expected ${expectedLength}, got ${normalizedArray.length}`
      );
    }
    return normalizedArray;
  } catch (error) {
    console.warn('Translation response object parsing failed; falling back to array parsing.', error);
  }

  return parseJsonArrayFlexible(content, expectedLength, 'translation');
}

function extractJsonArray(content = '', label = 'response') {
  const normalizeString = (value = '') =>
    value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  const normalizedContent = normalizeString(String(content ?? '')).trim();
  if (!normalizedContent) {
    throw new Error(`${label} response is empty.`);
  }

  const startIndex = normalizedContent.indexOf('[');
  const endIndex = normalizedContent.lastIndexOf(']');
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    throw new Error(`${label} response does not contain a JSON array.`);
  }

  const slice = normalizedContent.slice(startIndex, endIndex + 1);
  let parsed = null;
  try {
    parsed = JSON.parse(slice);
  } catch (error) {
    throw new Error(`${label} response JSON parsing failed.`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`${label} response is not a JSON array.`);
  }

  return parsed;
}

function countMatches(value = '', regex) {
  if (!value) return 0;
  const matches = value.match(regex);
  return matches ? matches.length : 0;
}

function getLanguageScript(language = '') {
  const normalized = language.toLowerCase();
  if (
    normalized.startsWith('ru') ||
    normalized.startsWith('uk') ||
    normalized.startsWith('bg') ||
    normalized.startsWith('sr') ||
    normalized.startsWith('mk')
  ) {
    return 'cyrillic';
  }
  if (normalized.startsWith('ar')) return 'arabic';
  if (normalized.startsWith('he')) return 'hebrew';
  if (normalized.startsWith('hi')) return 'devanagari';
  if (normalized.startsWith('ja')) return 'japanese';
  if (normalized.startsWith('ko')) return 'hangul';
  if (normalized.startsWith('zh')) return 'han';
  return 'latin';
}

function countLettersByScript(text = '', script) {
  if (!text) return 0;
  switch (script) {
    case 'cyrillic':
      return countMatches(text, /[\p{Script=Cyrillic}]/gu);
    case 'arabic':
      return countMatches(text, /[\p{Script=Arabic}]/gu);
    case 'hebrew':
      return countMatches(text, /[\p{Script=Hebrew}]/gu);
    case 'devanagari':
      return countMatches(text, /[\p{Script=Devanagari}]/gu);
    case 'japanese':
      return countMatches(text, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
    case 'hangul':
      return countMatches(text, /[\p{Script=Hangul}]/gu);
    case 'han':
      return countMatches(text, /[\p{Script=Han}]/gu);
    case 'latin':
    default:
      return countMatches(text, /[\p{Script=Latin}]/gu);
  }
}

function detectDominantScript(text = '') {
  const scripts = ['cyrillic', 'latin', 'arabic', 'hebrew', 'devanagari', 'japanese', 'hangul', 'han'];
  let best = null;
  let bestCount = 0;
  scripts.forEach((script) => {
    const count = countLettersByScript(text, script);
    if (count > bestCount) {
      bestCount = count;
      best = script;
    }
  });
  return bestCount > 0 ? best : null;
}

function needsLanguageRepair(source = '', translated = '', targetLanguage = '') {
  const sourceNormalized = normalizeTextForComparison(source);
  const translatedNormalized = normalizeTextForComparison(translated);
  if (!translatedNormalized) return false;
  const totalLetters = countMatches(translated, /[\p{L}]/gu);
  if (!totalLetters || totalLetters < 6) return false;
  const targetScript = getLanguageScript(targetLanguage);
  const targetLetters = countLettersByScript(translated, targetScript);
  const targetRatio = totalLetters ? targetLetters / totalLetters : 0;
  const sourceScript = detectDominantScript(source);
  if (
    sourceNormalized &&
    sourceNormalized === translatedNormalized &&
    sourceScript &&
    sourceScript !== targetScript &&
    totalLetters >= 6
  ) {
    return true;
  }
  if (sourceScript && sourceScript !== targetScript) {
    const sourceLetters = countLettersByScript(translated, sourceScript);
    if (sourceLetters / totalLetters >= 0.35 && totalLetters >= 10) {
      return true;
    }
  }
  return targetRatio < 0.35 && totalLetters >= 12;
}

function normalizeTextForComparison(value = '') {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRefusalOrLimitTranslation(translated = '') {
  const normalized = normalizeTextForComparison(translated);
  if (!normalized) return false;

  const refusalPatterns = [
    /слишком\s+(?:больш|длинн|объ[её]м|много)\b/,
    /(?:текст|запрос|ввод|объем)\s+слишком\s+(?:длинн|больш|объ[её]м|много)\b/,
    /пожалуйста\s+(?:сократит|укоротит|сделайт)\s+(?:текст|запрос|сообщени)/,
    /пожалуйста\s+(?:предоставьте|пришлите)\s+более\s+коротк/,
    /(?:не\s+могу|невозможн)\s+перевест/,
    /не\s+уда[её]тся\s+перевест/,
    /please\s+(?:provide|send|give)\s+(?:a\s+)?shorter/,
    /please\s+(?:shorten|reduce)\s+(?:the\s+)?(?:text|request|input)/,
    /(?:text|request|input)\s+is\s+too\s+long/,
    /request\s+too\s+(?:large|long)/,
    /(?:cannot|can\s+t|unable\s+to)\s+translate/
  ];

  return refusalPatterns.some((pattern) => pattern.test(normalized));
}

function shouldRetryRussianTranslation(source = '', translated = '') {
  const normalizedSource = normalizeTextForComparison(source);
  const normalizedTranslated = normalizeTextForComparison(translated);
  if (!normalizedSource || !normalizedTranslated) return false;

  const cyrillicCount = countMatches(translated, /[\p{Script=Cyrillic}]/gu);
  const latinCount = countMatches(translated, /[\p{Script=Latin}]/gu);
  const sourceCyrillicCount = countMatches(source, /[\p{Script=Cyrillic}]/gu);
  const sourceLatinCount = countMatches(source, /[\p{Script=Latin}]/gu);
  const sourceWordCount = normalizedSource ? normalizedSource.split(' ').length : 0;
  const translatedWordCount = normalizedTranslated ? normalizedTranslated.split(' ').length : 0;
  const sourceLetterCount = countMatches(source, /[\p{L}]/gu);
  const translatedLetterCount = countMatches(translated, /[\p{L}]/gu);

  if (
    normalizedSource === normalizedTranslated &&
    sourceCyrillicCount === 0 &&
    sourceLatinCount > 0 &&
    (sourceWordCount >= 2 || sourceLetterCount >= 10)
  ) {
    return true;
  }

  if (
    cyrillicCount === 0 &&
    latinCount > 0 &&
    sourceCyrillicCount === 0 &&
    sourceLatinCount > 0 &&
    (translatedWordCount >= 3 || translatedLetterCount >= 18)
  ) {
    return true;
  }

  return false;
}

function shouldRetryTranslationLength(source = '', translated = '') {
  const sourceTrimmed = (source || '').replace(/\s+/g, '');
  const translatedTrimmed = (translated || '').replace(/\s+/g, '');
  const sourceLength = Array.from(sourceTrimmed).length;
  const translatedLength = Array.from(translatedTrimmed).length;

  if (!sourceLength || !translatedLength) return false;
  if (sourceLength < 12 && translatedLength < 12) return false;

  const ratio = translatedLength / sourceLength;
  const diff = Math.abs(translatedLength - sourceLength);
  const isTooLong = ratio >= 2.4 && diff >= 12;
  const isTooShort = ratio <= 0.45 && diff >= 12;

  return isTooLong || isTooShort;
}

function applyPunctuationTokens(text = '') {
  let output = text;
  for (const [punctuation, token] of PUNCTUATION_TOKENS.entries()) {
    output = output.split(punctuation).join(token);
  }
  return output;
}

function escapeRegex(value = '') {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function restorePunctuationTokens(text = '') {
  let output = text;
  for (const [punctuation, token] of PUNCTUATION_TOKENS.entries()) {
    const tokenRegex = new RegExp(escapeRegex(token), 'gi');
    output = output.replace(tokenRegex, punctuation);
  }
  return output;
}
