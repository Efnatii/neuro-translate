const DEFAULT_STATE = {
  apiKey: '',
  deepseekApiKey: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  translationStyle: 'auto',
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  blockLengthLimit: 1200
};

const DEFAULT_TRANSLATION_TIMEOUT_MS = 45000;
const MAX_TRANSLATION_TIMEOUT_MS = 180000;
const MODEL_THROUGHPUT_TEST_TIMEOUT_MS = 15000;
const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

const PUNCTUATION_TOKENS = new Map([
  ['«', '⟦PUNC_LGUILLEMET⟧'],
  ['»', '⟦PUNC_RGUILLEMET⟧'],
  ['“', '⟦PUNC_LDQUOTE⟧'],
  ['”', '⟦PUNC_RDQUOTE⟧'],
  ['"', '⟦PUNC_DQUOTE⟧']
]);

const PUNCTUATION_TOKEN_HINT =
  'Tokens like ⟦PUNC_DQUOTE⟧ replace double quotes; keep them unchanged, in place, and with exact casing.';

function isDeepseekModel(model = '') {
  return model.startsWith('deepseek');
}

function getApiConfigForModel(model, state) {
  if (isDeepseekModel(model)) {
    return {
      apiKey: state.deepseekApiKey,
      apiBaseUrl: DEEPSEEK_API_URL,
      provider: 'deepseek'
    };
  }

  return {
    apiKey: state.apiKey,
    apiBaseUrl: OPENAI_API_URL,
    provider: 'openai'
  };
}

async function getState() {
  const stored = await chrome.storage.local.get({ ...DEFAULT_STATE, model: null, chunkLengthLimit: null });
  const merged = { ...DEFAULT_STATE, ...stored };
  if (!merged.blockLengthLimit && stored.chunkLengthLimit) {
    merged.blockLengthLimit = stored.chunkLengthLimit;
  }
  if (!merged.translationModel && merged.model) {
    merged.translationModel = merged.model;
  }
  if (!merged.contextModel && merged.model) {
    merged.contextModel = merged.model;
  }
  if (merged.translationStyle !== 'auto') {
    merged.translationStyle = 'auto';
  }
  return merged;
}

async function saveState(partial) {
  const current = await getState();
  const next = { ...current, ...partial };
  await chrome.storage.local.set(next);
  return next;
}

chrome.runtime.onInstalled.addListener(async () => {
  await saveState({});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'GET_SETTINGS') {
    handleGetSettings(message, sendResponse);
    return true;
  }

  if (message?.type === 'TRANSLATE_TEXT') {
    handleTranslateText(message, sendResponse);
    return true;
  }

  if (message?.type === 'GENERATE_CONTEXT') {
    handleGenerateContext(message, sendResponse);
    return true;
  }

  if (message?.type === 'PROOFREAD_TEXT') {
    handleProofreadText(message, sendResponse);
    return true;
  }

  if (message?.type === 'RUN_MODEL_THROUGHPUT_TEST') {
    handleModelThroughputTest(message, sendResponse);
    return true;
  }

  if (message?.type === 'CANCEL_PAGE_TRANSLATION' && sender?.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'CANCEL_TRANSLATION' });
  }

  if (message?.type === 'TRANSLATION_PROGRESS') {
    handleTranslationProgress(message, sender);
  }

  if (message?.type === 'UPDATE_TRANSLATION_VISIBILITY') {
    handleTranslationVisibility(message, sender);
  }

  if (message?.type === 'GET_TRANSLATION_STATUS') {
    handleGetTranslationStatus(sendResponse, sender?.tab?.id);
    return true;
  }

  return false;
});

async function handleGetSettings(message, sendResponse) {
  const state = await getState();
  const translationConfig = getApiConfigForModel(state.translationModel, state);
  const contextConfig = getApiConfigForModel(state.contextModel, state);
  const proofreadConfig = getApiConfigForModel(state.proofreadModel, state);
  const hasTranslationKey = Boolean(translationConfig.apiKey);
  const hasContextKey = Boolean(contextConfig.apiKey);
  const hasProofreadKey = Boolean(proofreadConfig.apiKey);
  sendResponse({
    allowed:
      hasTranslationKey &&
      (!state.contextGenerationEnabled || hasContextKey) &&
      (!state.proofreadEnabled || hasProofreadKey),
    apiKey: state.apiKey,
    translationModel: state.translationModel,
    contextModel: state.contextModel,
    proofreadModel: state.proofreadModel,
    translationStyle: state.translationStyle,
    contextGenerationEnabled: state.contextGenerationEnabled,
    proofreadEnabled: state.proofreadEnabled,
    blockLengthLimit: state.blockLengthLimit
  });
}

async function handleTranslateText(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.translationModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const translations = await translateTexts(
      message.texts,
      apiKey,
      message.targetLanguage,
      state.translationModel,
      message.translationStyle || state.translationStyle,
      message.context,
      apiBaseUrl,
      message.keepPunctuationTokens
    );
    sendResponse({ success: true, translations });
  } catch (error) {
    console.error('Translation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleGenerateContext(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.contextModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const context = await generateTranslationContext(
      message.text,
      apiKey,
      message.targetLanguage,
      state.contextModel,
      apiBaseUrl
    );
    sendResponse({ success: true, context });
  } catch (error) {
    console.error('Context generation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleProofreadText(message, sendResponse) {
  try {
    const state = await getState();
    const { apiKey, apiBaseUrl } = getApiConfigForModel(state.proofreadModel, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const replacements = await proofreadTranslation(
      message.texts,
      apiKey,
      message.targetLanguage,
      state.proofreadModel,
      apiBaseUrl,
      message.context,
      message.sourceTexts
    );
    sendResponse({ success: true, replacements });
  } catch (error) {
    console.error('Proofreading failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleModelThroughputTest(message, sendResponse) {
  try {
    const state = await getState();
    const model = message?.model || state.translationModel;
    const { apiKey, apiBaseUrl } = getApiConfigForModel(model, state);
    if (!apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const result = await runModelThroughputTest(apiKey, model, apiBaseUrl);
    await saveModelThroughputResult(model, result);
    sendResponse({ success: true, result });
  } catch (error) {
    const model = message?.model || DEFAULT_STATE.translationModel;
    const failure = {
      success: false,
      error: error?.message || 'Throughput test failed',
      timestamp: Date.now(),
      model
    };
    await saveModelThroughputResult(model, failure);
    sendResponse({ success: false, error: failure.error });
  }
}

async function generateTranslationContext(
  text,
  apiKey,
  targetLanguage = 'ru',
  model = DEFAULT_STATE.contextModel,
  apiBaseUrl = OPENAI_API_URL
) {
  if (!text?.trim()) return '';

  const prompt = [
    {
      role: 'system',
      content: [
        'You are a translator assistant. Produce context that improves translation quality.',
        'Do not paraphrase the text, do not evaluate it, and do not add facts not present in the source.',
        'If information is missing, write "not specified".',
        'Focus on details that affect accuracy, terminology consistency, style, and meaning.',
        'Do not suggest leaving names/titles/terms untranslated unless explicitly stated in the text.',
        'Your response must be structured and concise.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Analyze the source text and produce translation context for ${targetLanguage}.`,
        'Provide the most useful details for the translator.',
        'Format strictly by the sections below (brief, bullet points).',
        '',
        '1) Text type and purpose:',
        '- genre/domain (fiction, tech docs, marketing, UI, news, etc.)',
        '- goal (inform, persuade, instruct, describe, sell, etc.)',
        '- intended audience (if explicitly clear)',
        '',
        '2) Setting:',
        '- place, geography, organizations/locations (if stated)',
        '- time/era/period (if stated)',
        '',
        '3) Participants/characters:',
        '- names/roles/titles',
        '- gender/pronouns (if explicitly stated)',
        '- speakers/addressees (who speaks to whom)',
        '',
        '4) Relationships and social ties:',
        '- relationships between characters (if explicit)',
        '- status/hierarchy (manager-subordinate, customer-support, etc.)',
        '',
        '5) Plot/factual anchor points:',
        '- key events/facts that must not be distorted',
        '',
        '6) Terminology and consistency:',
        '- terms/concepts/abbreviations that must be translated consistently',
        '- recommended translations if clearly implied by context',
        '- what must not be translated or must be left as-is (only if explicitly stated)',
        '',
        '7) Proper names and onomastics:',
        '- names, brands, products, organizations, toponyms',
        '- how to render: translate/transliterate/leave as-is (leave as-is only with explicit instruction)',
        '',
        '8) Tone and style:',
        '- formal/informal/neutral/literary/ironic, etc.',
        '- level of formality and politeness (tu/vous, honorifics)',
        '',
        '9) Linguistic features:',
        '- slang, jargon, dialect, archaisms',
        '- wordplay/idioms (if any)',
        '- quotes/quoted speech',
        '',
        '10) Format and technical requirements:',
        '- units, currencies, dates, formats',
        '- brevity/structure requirements',
        '- recurring templates/placeholders (if any)',
        '',
        'Text:',
        text,
        '',
        'Output only the sections with brief bullet points.',
        'If a section is empty, write "not specified".'
      ].join('\n')
    }
  ];

  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Context request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No context returned');
  }

  return typeof content === 'string' ? content.trim() : '';
}

async function proofreadTranslation(
  texts,
  apiKey,
  targetLanguage = 'ru',
  model = DEFAULT_STATE.proofreadModel,
  apiBaseUrl = OPENAI_API_URL,
  context = '',
  sourceTexts = []
) {
  if (!Array.isArray(texts) || !texts.length) return [];

  const normalizedSourceTexts = Array.isArray(sourceTexts) ? sourceTexts : [];
  const maxRateLimitRetries = 3;
  let rateLimitRetries = 0;
  let lastRateLimitDelayMs = null;
  let lastError = null;
  const prompt = [
    {
      role: 'system',
      content: [
        'You are a flexible proofreading engine focused on readability and clear meaning in translated text.',
        'Return only a JSON array of objects with "from" and "to" fields.',
        'Each object describes an exact substring to replace ("from") and the replacement ("to").',
        'Never add commentary, explanations, or extra keys.',
        'Prioritize readability and clarity of meaning over strict literalness.',
        'Improve fluency and naturalness so the translation reads like it was written by a native speaker.',
        'Fix grammar, agreement, punctuation, typos, or terminology consistency as needed.',
        'You may add or adjust punctuation marks for naturalness, but do not modify punctuation tokens.',
        'You may rephrase more freely to improve readability and to раскрыть смысл яснее, but never change meaning or add/remove information.',
        'Avoid over-editing when the text is already clear and natural.',
        'Do not reorder sentences unless it is required for readability or naturalness in the target language.',
        'Never introduce, duplicate, or delete punctuation tokens like ⟦PUNC_DQUOTE⟧.',
        'If a punctuation token appears in the translated text, keep it unchanged and in the same position.',
        'Use the source text only to verify correctness and preserve meaning.',
        context
          ? 'Rely on the provided translation context to maintain terminology consistency and resolve ambiguity.'
          : 'If no context is provided, do not invent context or add assumptions.',
        PUNCTUATION_TOKEN_HINT,
        'If no corrections are needed, return an empty JSON array: [].'
      ]
        .filter(Boolean)
        .join(' ')
    },
    {
      role: 'user',
      content: [
        `Target language: ${targetLanguage}.`,
        'Review the translated text below and return only the JSON array of replacements.',
        context ? `Context (use it as the only disambiguation aid): ${context}` : '',
        normalizedSourceTexts.length ? 'Source text:' : '',
        ...normalizedSourceTexts.map((text) => text),
        'Translated text:',
        ...texts.map((text) => text)
      ]
        .filter(Boolean)
        .join('\n')
    }
  ];

  while (true) {
    try {
      const response = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: prompt
        })
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
        const errorMessage =
          errorPayload?.error?.message || errorPayload?.message || errorText || 'Unknown error';
        const error = new Error(`Proofread request failed: ${response.status} ${errorMessage}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs;
        error.isRateLimit = response.status === 429 || response.status === 503;
        throw error;
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('No proofreading result returned');
      }

      const parsed = safeParseArray(content, null);
      if (!Array.isArray(parsed)) {
        throw new Error('Unexpected proofreading format');
      }

      return parsed
        .map((item) => {
          if (!item || typeof item !== 'object') return null;
          const from = typeof item.from === 'string' ? item.from : '';
          const to = typeof item.to === 'string' ? item.to : '';
          if (!from) return null;
          return { from, to };
        })
        .filter(Boolean);
    } catch (error) {
      lastError = error;
      const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
      if (isRateLimit && rateLimitRetries < maxRateLimitRetries) {
        rateLimitRetries += 1;
        const retryDelayMs = calculateRetryDelayMs(rateLimitRetries, error?.retryAfterMs);
        lastRateLimitDelayMs = retryDelayMs;
        console.warn(`Proofreading rate-limited, retrying after ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }

      if (isRateLimit) {
        const waitSeconds = Math.max(1, Math.ceil((lastRateLimitDelayMs || error?.retryAfterMs || 30000) / 1000));
        throw new Error(`Rate limit reached—please retry in ${waitSeconds} seconds.`);
      }

      throw lastError;
    }
  }
}

async function getModelThroughputInfo(model) {
  const { modelThroughputById = {} } = await chrome.storage.local.get({ modelThroughputById: {} });
  return modelThroughputById?.[model] || null;
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
  model = DEFAULT_STATE.translationModel,
  translationStyle = DEFAULT_STATE.translationStyle,
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  keepPunctuationTokens = false
) {
  if (!Array.isArray(texts) || !texts.length) return [];

  const maxTimeoutAttempts = 2;
  const maxRateLimitRetries = 3;
  let timeoutAttempts = 0;
  let rateLimitRetries = 0;
  let lastError = null;
  let lastRateLimitDelayMs = null;
  const throughputInfo = await getModelThroughputInfo(model);
  const timeoutMs = calculateTranslationTimeoutMs(texts, throughputInfo);

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await performTranslationRequest(
        texts,
        apiKey,
        targetLanguage,
        model,
        translationStyle,
        controller.signal,
        context,
        apiBaseUrl,
        !keepPunctuationTokens
      );
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error('Translation request timed out') : error;

      const isTimeout = error?.name === 'AbortError' || error?.message?.toLowerCase?.().includes('timed out');
      if (isTimeout && timeoutAttempts < maxTimeoutAttempts - 1) {
        timeoutAttempts += 1;
        console.warn(`Translation attempt timed out, retrying...`);
        continue;
      }

      const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
      if (isRateLimit && rateLimitRetries < maxRateLimitRetries) {
        rateLimitRetries += 1;
        const retryDelayMs = calculateRetryDelayMs(rateLimitRetries, error?.retryAfterMs);
        lastRateLimitDelayMs = retryDelayMs;
        console.warn(`Translation attempt rate-limited, retrying after ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }

      const isLengthIssue = error?.message?.toLowerCase?.().includes('length mismatch');
      if (isLengthIssue && texts.length > 1) {
        console.warn('Falling back to per-item translation due to length mismatch.');
        return await translateIndividually(
          texts,
          apiKey,
          targetLanguage,
          model,
          translationStyle,
          context,
          apiBaseUrl,
          keepPunctuationTokens
        );
      }

      if (isRateLimit) {
        const waitSeconds = Math.max(1, Math.ceil((lastRateLimitDelayMs || error?.retryAfterMs || 30000) / 1000));
        throw new Error(`Rate limit reached—please retry in ${waitSeconds} seconds.`);
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Translation failed');
}

async function performTranslationRequest(
  texts,
  apiKey,
  targetLanguage,
  model,
  translationStyle,
  signal,
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  restorePunctuation = true
) {
  const tokenizedTexts = texts.map(applyPunctuationTokens);
  const styleHints = {
    natural: 'Neutral, smooth Russian without literal calques.',
    conversational: 'Conversational, warm tone with vivid phrasing and no excessive familiarity.',
    formal: 'Business-like, precise tone with clear wording.',
    creative: 'Expressive, imagery-rich tone without losing meaning.'
  };

  const isAutoStyle = translationStyle === 'auto';
  const styleInstruction = isAutoStyle ? null : styleHints?.[translationStyle] || styleHints.natural;

  const prompt = [
    {
      role: 'system',
      content: [
        'You are a fluent Russian translator.',
        `Translate every element of the provided "texts" list into ${targetLanguage} with natural, idiomatic phrasing that preserves meaning and readability.`,
        'Never omit, add, or generalize information. Preserve modality, tense, aspect, tone, and level of certainty.',
        'You may add or adjust punctuation marks for naturalness, but do not change punctuation tokens.',
        'Preserve numbers, units, currencies, dates, and formatting unless explicitly instructed otherwise.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Translate proper names, titles, and terms; when unsure, transliterate them instead of leaving them unchanged unless they are established brands or standard in the target language.',
        'Do not leave any source text untranslated. Do not copy the source text verbatim except for placeholders, markup, punctuation tokens, or text that is already in the target language.',
        'Ensure terminology consistency within the same request.',
        PUNCTUATION_TOKEN_HINT,
        styleInstruction ? `Tone/style: ${styleInstruction}` : 'Determine the most appropriate tone/style based on the provided context.',
        context
          ? `Rely on the provided page context for disambiguation only; never introduce new facts: ${context}`
          : 'If no context is provided, do not invent context or add assumptions.',
        'Respond only with translations in the same order, one per line, without numbering or commentary.'
      ]
        .filter(Boolean)
        .join(' ')
    },
    {
      role: 'user',
      content: [
        `Translate the following segments into ${targetLanguage}.`,
        styleInstruction ? `Style: ${styleInstruction}` : 'Determine the style automatically based on context.',
        context ? `Page context (use it for disambiguation only): ${context}` : '',
        'Do not omit or add information; preserve modality, tense, aspect, tone, and level of certainty.',
        'You may add or adjust punctuation marks for naturalness, but do not change punctuation tokens.',
        'Preserve numbers, units, currencies, dates, and formatting unless explicitly instructed otherwise.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Translate names/titles/terms; if unsure, transliterate rather than leaving them untranslated, except for established brands.',
        'Do not leave any source text untranslated. Do not copy segments verbatim except for placeholders, markup, punctuation tokens, or text already in the target language.',
        'Keep terminology consistent within a single request.',
        `Do not change punctuation service tokens. ${PUNCTUATION_TOKEN_HINT}`,
        'Segments to translate:',
        ...tokenizedTexts.map((text) => text)
      ]
        .filter(Boolean)
        .join('\n')
    }
  ];

  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: prompt
    }),
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
    const errorMessage =
      errorPayload?.error?.message || errorPayload?.message || errorText || 'Unknown error';
    const error = new Error(`Translation request failed: ${response.status} ${errorMessage}`);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs;
    error.isRateLimit = response.status === 429 || response.status === 503;
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No translation returned');
  }

  const parsed = safeParseArray(content, texts.length);
  if (!Array.isArray(parsed)) {
    throw new Error('Unexpected translation format');
  }

  return texts.map((text, index) => {
    const candidate = parsed[index];
    if (typeof candidate === 'string' && candidate.trim()) {
      return restorePunctuation ? restorePunctuationTokens(candidate) : candidate;
    }
    return text;
  });
}

function parseRetryAfterMs(response, errorPayload) {
  const retryAfterHeader = response?.headers?.get?.('Retry-After');
  if (retryAfterHeader) {
    const asSeconds = Number(retryAfterHeader);
    if (!Number.isNaN(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }
    const asDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(asDate)) {
      const deltaMs = asDate - Date.now();
      if (deltaMs > 0) return deltaMs;
    }
  }

  const retryAfterSeconds =
    errorPayload?.error?.retry_after ??
    errorPayload?.error?.retry_after_seconds ??
    errorPayload?.retry_after ??
    errorPayload?.retry_after_seconds;
  if (typeof retryAfterSeconds === 'number' && retryAfterSeconds >= 0) {
    return Math.round(retryAfterSeconds * 1000);
  }

  const retryAfterMs = errorPayload?.error?.retry_after_ms ?? errorPayload?.retry_after_ms;
  if (typeof retryAfterMs === 'number' && retryAfterMs >= 0) {
    return Math.round(retryAfterMs);
  }

  const message =
    errorPayload?.error?.message ||
    errorPayload?.message ||
    errorPayload?.error?.detail ||
    errorPayload?.detail ||
    '';
  const retryAfterFromMessageMs = parseRetryAfterMsFromMessage(message);
  if (typeof retryAfterFromMessageMs === 'number' && retryAfterFromMessageMs >= 0) {
    return Math.round(retryAfterFromMessageMs);
  }

  return null;
}

function parseRetryAfterMsFromMessage(message = '') {
  if (typeof message !== 'string' || !message.trim()) return null;
  const retryMatch = message.match(/try again in\s*([\d.]+)\s*(ms|msec|millis|s|sec|secs|seconds)/i);
  if (retryMatch) {
    const value = Number(retryMatch[1]);
    if (Number.isNaN(value)) return null;
    const unit = retryMatch[2].toLowerCase();
    if (unit.startsWith('m')) return Math.round(value);
    return Math.round(value * 1000);
  }

  const retryMsMatch = message.match(/retry(?:ing)? in\s*([\d.]+)\s*(ms|msec|millis|s|sec|secs|seconds)/i);
  if (retryMsMatch) {
    const value = Number(retryMsMatch[1]);
    if (Number.isNaN(value)) return null;
    const unit = retryMsMatch[2].toLowerCase();
    if (unit.startsWith('m')) return Math.round(value);
    return Math.round(value * 1000);
  }

  return null;
}

function calculateRetryDelayMs(attempt, retryAfterMs) {
  const baseDelayMs = 1000;
  const exponentialDelayMs = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const jitterMs = Math.floor(Math.random() * 250);
  const computedDelayMs = exponentialDelayMs + jitterMs;
  const fallbackDelayMs = retryAfterMs ? Math.max(retryAfterMs, computedDelayMs) : computedDelayMs;
  return Math.min(fallbackDelayMs, 30000);
}

function sleep(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

async function translateIndividually(
  texts,
  apiKey,
  targetLanguage,
  model,
  translationStyle,
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  keepPunctuationTokens = false
) {
  const results = [];
  const maxRateLimitRetries = 3;

  for (const text of texts) {
    let rateLimitRetries = 0;

    while (true) {
      try {
        const [translated] = await performTranslationRequest(
          [text],
          apiKey,
          targetLanguage,
          model,
          translationStyle,
          undefined,
          context,
          apiBaseUrl,
          !keepPunctuationTokens
        );
        results.push(translated);
        break;
      } catch (error) {
        const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
        if (isRateLimit && rateLimitRetries < maxRateLimitRetries) {
          rateLimitRetries += 1;
          const retryDelayMs = calculateRetryDelayMs(rateLimitRetries, error?.retryAfterMs);
          console.warn(`Single-item translation rate-limited, retrying after ${retryDelayMs}ms...`);
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

async function runModelThroughputTest(apiKey, model, apiBaseUrl = OPENAI_API_URL) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_THROUGHPUT_TEST_TIMEOUT_MS);

  try {
    const response = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 24,
        messages: [
          { role: 'system', content: 'Reply with the word OK.' },
          { role: 'user', content: 'OK' }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Throughput test failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    const durationMs = Math.max(1, Math.round(performance.now() - startedAt));
    const totalTokens = Number(data?.usage?.total_tokens) || null;
    const tokensPerSecond = totalTokens ? Number((totalTokens / (durationMs / 1000)).toFixed(2)) : null;

    return {
      success: true,
      model,
      durationMs,
      totalTokens,
      tokensPerSecond,
      timestamp: Date.now()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveModelThroughputResult(model, result) {
  if (!model) return;
  const { modelThroughputById = {} } = await chrome.storage.local.get({ modelThroughputById: {} });
  modelThroughputById[model] = result;
  await chrome.storage.local.set({ modelThroughputById });
}

function safeParseArray(content, expectedLength) {
  const normalizeString = (value = '') =>
    value.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

  const parsePlainText = (value) => {
    const lines = normalizeString(value)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (!lines.length) return null;

    if (expectedLength && lines.length !== expectedLength) {
      if (expectedLength === 1 && lines.length > 1) {
        console.warn(
          `Translation response length mismatch for single item: expected 1, got ${lines.length}. Collapsing into one string.`
        );
        return [lines.join(' ')];
      }
      const message = `Translation response length mismatch: expected ${expectedLength}, got ${lines.length}`;
      console.warn(message);
      throw new Error(message);
    }

    return lines;
  };

  const tryJsonParse = (value) => {
    try {
      const parsed = JSON.parse(normalizeString(value));
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.translations)) return parsed.translations;
      return null;
    } catch (error) {
      return null;
    }
  };

  const extractFromObject = (value) => {
    if (!value || typeof value !== 'object') return null;

    if (Array.isArray(value.translations)) return value.translations;
    if (Array.isArray(value.output_json?.translations)) return value.output_json.translations;

    if (Array.isArray(value)) {
      const outputPart = value.find((part) => part?.type === 'output_json' && part?.output_json);
      if (Array.isArray(outputPart?.output_json?.translations)) return outputPart.output_json.translations;

      const textParts = value
        .filter((part) => typeof part?.text === 'string')
        .map((part) => part.text)
        .join('');
      if (textParts) return tryJsonParse(textParts);
    }

    return null;
  };

  const parsed =
    typeof content === 'string'
      ? tryJsonParse(content) || parsePlainText(content)
      : extractFromObject(content) || tryJsonParse(JSON.stringify(content)) || parsePlainText(JSON.stringify(content));

  if (!Array.isArray(parsed)) {
    console.warn('Failed to parse translation response as JSON array, received:', content);
    return null;
  }

  if (expectedLength && parsed.length !== expectedLength) {
    if (expectedLength === 1 && parsed.length > 1) {
      console.warn(
        `Translation response length mismatch for single item: expected 1, got ${parsed.length}. Collapsing into one string.`
      );
      return [parsed.join(' ')];
    }

    const message = `Translation response length mismatch: expected ${expectedLength}, got ${parsed.length}`;
    console.warn(message);
    throw new Error(message);
  }

  return parsed;
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

async function handleTranslationProgress(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  const status = {
    completedBlocks: message.completedBlocks || 0,
    totalBlocks: message.totalBlocks || 0,
    inProgressBlocks: message.inProgressBlocks || 0,
    message: message.message || '',
    timestamp: Date.now()
  };
  const { translationStatusByTab = {} } = await chrome.storage.local.get({ translationStatusByTab: {} });
  translationStatusByTab[tabId] = status;
  await chrome.storage.local.set({ translationStatusByTab });
}

async function handleGetTranslationStatus(sendResponse, tabId) {
  const { translationStatusByTab = {} } = await chrome.storage.local.get({ translationStatusByTab: {} });
  sendResponse(translationStatusByTab[tabId] || null);
}

async function handleTranslationVisibility(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;
  const { translationVisibilityByTab = {} } = await chrome.storage.local.get({ translationVisibilityByTab: {} });
  translationVisibilityByTab[tabId] = Boolean(message.visible);
  await chrome.storage.local.set({ translationVisibilityByTab });
}
