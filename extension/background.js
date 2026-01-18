const DEFAULT_TPM_LIMITS_BY_MODEL = {
  default: 200000,
  'gpt-4.1-mini': 200000,
  'gpt-4.1': 300000,
  'gpt-4o-mini': 200000,
  'gpt-4o': 300000,
  'o4-mini': 200000,
  'deepseek-chat': 200000,
  'deepseek-reasoner': 100000
};
const DEFAULT_OUTPUT_RATIO_BY_ROLE = {
  translation: 0.6,
  context: 0.4,
  proofread: 0.5
};
const DEFAULT_TPM_SAFETY_BUFFER_TOKENS = 100;

const DEFAULT_STATE = {
  apiKey: '',
  deepseekApiKey: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  contextGenerationEnabled: false,
  proofreadEnabled: false,
  blockLengthLimit: 1200,
  tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
  outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
  tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
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
const PROOFREAD_SEGMENT_TOKEN = '⟦SEGMENT_BREAK⟧';

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

function getTpmLimitForModel(model, tpmLimitsByModel) {
  if (!tpmLimitsByModel || typeof tpmLimitsByModel !== 'object') {
    return DEFAULT_TPM_LIMITS_BY_MODEL.default;
  }
  const fallback = tpmLimitsByModel.default ?? DEFAULT_TPM_LIMITS_BY_MODEL.default;
  return tpmLimitsByModel[model] ?? fallback;
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
  const tpmLimitsByRole = {
    translation: getTpmLimitForModel(state.translationModel, state.tpmLimitsByModel),
    context: getTpmLimitForModel(state.contextModel, state.tpmLimitsByModel),
    proofread: getTpmLimitForModel(state.proofreadModel, state.tpmLimitsByModel)
  };
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
    contextGenerationEnabled: state.contextGenerationEnabled,
    proofreadEnabled: state.proofreadEnabled,
    blockLengthLimit: state.blockLengthLimit,
    tpmLimitsByRole,
    outputRatioByRole: state.outputRatioByRole || DEFAULT_OUTPUT_RATIO_BY_ROLE,
    tpmSafetyBufferTokens:
      Number.isFinite(state.tpmSafetyBufferTokens) && state.tpmSafetyBufferTokens >= 0
        ? state.tpmSafetyBufferTokens
        : DEFAULT_TPM_SAFETY_BUFFER_TOKENS
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

    const { translations, rawTranslation } = await translateTexts(
      message.texts,
      apiKey,
      message.targetLanguage,
      state.translationModel,
      message.context,
      apiBaseUrl,
      message.keepPunctuationTokens
    );
    sendResponse({ success: true, translations, rawTranslation });
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

    const { replacements, rawProofread } = await proofreadTranslation(
      message.texts,
      apiKey,
      message.targetLanguage,
      state.proofreadModel,
      apiBaseUrl,
      message.context,
      message.sourceTexts
    );
    sendResponse({ success: true, replacements, rawProofread });
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
  if (!Array.isArray(texts) || !texts.length) return { replacements: [], rawProofread: '' };

  const expectedSegments = texts.length;
  const normalizedSourceTexts = Array.isArray(sourceTexts) ? sourceTexts : [];
  const segmentDelimiter = `\n${PROOFREAD_SEGMENT_TOKEN}\n`;
  const combinedSourceText = normalizedSourceTexts.join(segmentDelimiter);
  const combinedTranslatedText = texts.join(segmentDelimiter);
  const maxRateLimitRetries = 3;
  let rateLimitRetries = 0;
  let lastRateLimitDelayMs = null;
  let lastError = null;
  const prompt = [
    {
      role: 'system',
      content: [
        'You are a flexible proofreading engine focused on readability and clear meaning in translated text.',
        `Return the revised segments as a plain list with exactly ${expectedSegments} lines, in the same order as the input segments.`,
        'If a segment requires no corrections, return an empty string for that segment.',
        'Never add commentary, explanations, numbering, or extra markup.',
        'Do not wrap the output in markdown code fences.',
        'Prioritize readability and clarity of meaning over strict literalness.',
        'Improve fluency and naturalness so the translation reads like it was written by a native speaker.',
        'Fix grammar, agreement, punctuation, typos, or terminology consistency as needed.',
        'You may add or adjust punctuation marks for naturalness, but do not modify punctuation tokens.',
        'You may rephrase more freely to improve readability and to раскрыть смысл яснее, but never change meaning or add/remove information.',
        'Avoid over-editing when the text is already clear and natural.',
        'Do not reorder sentences unless it is required for readability or naturalness in the target language.',
        'Never move text between segments; keep every edit entirely within its original segment.',
        'Do not merge or split segments; each segment must stay as a single unit.',
        'Preserve the relative order of sentences within each segment.',
        'Never introduce, duplicate, or delete punctuation tokens like ⟦PUNC_DQUOTE⟧.',
        'If a punctuation token appears in the translated text, keep it unchanged and in the same position.',
        `Segments are separated by the token ${PROOFREAD_SEGMENT_TOKEN}; keep it unchanged and in place.`,
        'Do not include the segment separator in any line.',
        'Use the source text only to verify correctness and preserve meaning.',
        context
          ? 'Rely on the provided translation context to maintain terminology consistency and resolve ambiguity.'
          : 'If no context is provided, do not invent context or add assumptions.',
        PUNCTUATION_TOKEN_HINT,
        'Return only the list.'
      ]
        .filter(Boolean)
        .join(' ')
    },
    ...(context
      ? [
          {
            role: 'user',
            content: `Translation context (metadata only; do not quote or restate it): ${context}`
          }
        ]
      : []),
    {
      role: 'user',
      content: [
        `Target language: ${targetLanguage}.`,
        `Review the translated text below and return only the revised segments as a list with exactly ${expectedSegments} lines.`,
        `The translated text is split by ${PROOFREAD_SEGMENT_TOKEN}; array index 0 corresponds to segmentIndex 0.`,
        'If a segment needs no corrections, return an empty string in its place.',
        'Use the context metadata only for disambiguation; do not quote or include it in the output.',
        normalizedSourceTexts.length ? `Source text (segments separated by ${PROOFREAD_SEGMENT_TOKEN}):` : '',
        normalizedSourceTexts.length ? combinedSourceText : '',
        'Translated text:',
        combinedTranslatedText
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

      const parsed = parseLineList(content, texts.length, 'proofread');
      const replacements = parsed
        .map((item, index) => {
          const revisedText = typeof item === 'string' ? item : '';
          if (!revisedText) return null;
          return { segmentIndex: index, revisedText };
        })
        .filter(Boolean);

      return { replacements, rawProofread: content };
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
        const waitMs = waitSeconds * 1000;
        console.warn(`Proofreading rate limit reached—waiting ${waitSeconds}s before retrying.`);
        await sleep(waitMs);
        continue;
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

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

function isRetryableStatus(status) {
  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status);
}

async function translateTexts(
  texts,
  apiKey,
  targetLanguage = 'ru',
  model = DEFAULT_STATE.translationModel,
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
      return result;
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error('Translation request timed out') : error;

      const isTimeout = error?.name === 'AbortError' || error?.message?.toLowerCase?.().includes('timed out');
      if (isTimeout && timeoutAttempts < maxTimeoutAttempts - 1) {
        timeoutAttempts += 1;
        console.warn(`Translation attempt timed out, retrying...`);
        continue;
      }

      const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
      const isRetryable = isRetryableStatus(error?.status) || error?.isRetryable || isRateLimit;
      if (isRetryable && retryableRetries < maxRetryableRetries) {
        retryableRetries += 1;
        const retryDelayMs = calculateRetryDelayMs(retryableRetries, error?.retryAfterMs);
        lastRetryDelayMs = retryDelayMs;
        const retryLabel = isRateLimit ? 'rate-limited' : 'temporarily unavailable';
        console.warn(`Translation attempt ${retryLabel}, retrying after ${retryDelayMs}ms...`);
        await sleep(retryDelayMs);
        continue;
      }

      const isLengthIssue = error?.message?.toLowerCase?.().includes('length mismatch');
      if (isLengthIssue && texts.length > 1) {
        console.warn('Falling back to per-item translation due to length mismatch.');
        const translations = await translateIndividually(
          texts,
          apiKey,
          targetLanguage,
          model,
          context,
          apiBaseUrl,
          keepPunctuationTokens
        );
        return { translations, rawTranslation: lastRawTranslation };
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

  throw lastError || new Error('Translation failed');
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
  allowRefusalRetry = true
) {
  const tokenizedTexts = texts.map(applyPunctuationTokens);

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
        strictTargetLanguage
          ? `Every translation must be in ${targetLanguage}. If a phrase would normally remain in the source language, transliterate it into ${targetLanguage} instead.`
          : null,
        PUNCTUATION_TOKEN_HINT,
        'Determine the most appropriate tone/style based on the provided context.',
        context
          ? 'Rely on the provided page context for disambiguation only; never introduce new facts. Do not quote, paraphrase, or include the context text in the output unless it is required to translate the source segments.'
          : 'If no context is provided, do not invent context or add assumptions.',
        'Never include page context text in the translations unless it is explicitly part of the source segments.',
        'Return a list of strings with exactly the same number of lines as the input segments, in the same order.',
        'Never include numbering, commentary, or markdown code fences.'
      ]
        .filter(Boolean)
        .join(' ')
    },
    ...(context
      ? [
          {
            role: 'user',
            content: `Page context (metadata only; do not translate or restate it): ${context}`
          }
        ]
      : []),
    {
      role: 'user',
      content: [
        `Translate the following segments into ${targetLanguage}.`,
        'Determine the style automatically based on context.',
        'Use the context metadata only for disambiguation; do not quote or include it in the output unless it is required to translate the source segments.',
        'Do not omit or add information; preserve modality, tense, aspect, tone, and level of certainty.',
        'You may add or adjust punctuation marks for naturalness, but do not change punctuation tokens.',
        'Preserve numbers, units, currencies, dates, and formatting unless explicitly instructed otherwise.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Translate names/titles/terms; if unsure, transliterate rather than leaving them untranslated, except for established brands.',
        'Do not leave any source text untranslated. Do not copy segments verbatim except for placeholders, markup, punctuation tokens, or text already in the target language.',
        'Never include page context text in the translations unless it is explicitly part of the source segments.',
        'Keep terminology consistent within a single request.',
        strictTargetLanguage
          ? `Every translation must be in ${targetLanguage}. If something would typically remain in the source language, transliterate it into ${targetLanguage} instead.`
          : null,
        `Do not change punctuation service tokens. ${PUNCTUATION_TOKEN_HINT}`,
        `Return a list with exactly ${texts.length} lines in the same order; use an empty string if a segment is empty.`,
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

  const parsed = parseLineList(content, texts.length, 'translation');
  const translations = parsed.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
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
      false
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

      retryIndices.forEach((index, retryPosition) => {
        if (retryTranslations?.[retryPosition]) {
          translations[index] = retryTranslations[retryPosition];
        }
      });
    }
  }

  return {
    translations: texts.map((text, index) => {
      const candidate = translations[index];
      if (typeof candidate === 'string' && candidate.trim()) {
        return restorePunctuation ? restorePunctuationTokens(candidate) : candidate;
      }
      return text;
    }),
    rawTranslation: content
  };
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

function isHtmlPayload(payload = '') {
  if (typeof payload !== 'string') return false;
  const trimmed = payload.trim().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.includes('<html');
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
  context = '',
  apiBaseUrl = OPENAI_API_URL,
  keepPunctuationTokens = false,
  allowRefusalRetry = true
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
          allowRefusalRetry
        );
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

function parseLineList(content, expectedLength, label = 'response') {
  const normalizeString = (value = '') =>
    value.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const tryParseJsonArray = (value = '') => {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) return null;
      return parsed.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
    } catch (error) {
      return null;
    }
  };
  const collapseSingleItemLines = (lines) => {
    if (!Array.isArray(lines) || !lines.length) return null;
    if (lines.length === 1) return lines;
    const combined = lines.join('\n').trim();
    return combined ? [combined] : [''];
  };
  const collapseConsecutiveBlankLines = (lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return lines;
    const collapsed = [];
    for (const line of lines) {
      if (line === '' && collapsed[collapsed.length - 1] === '') continue;
      collapsed.push(line);
    }
    return collapsed;
  };

  const normalizedContent = normalizeString(String(content ?? '')).trim();
  const jsonArray = tryParseJsonArray(normalizedContent);
  if (jsonArray) {
    const jsonLines = jsonArray.map((line) => (typeof line === 'string' ? line.trim() : String(line ?? '').trim()));
    if (!expectedLength || jsonLines.length === expectedLength) return jsonLines;
    const message = `${label} response length mismatch: expected ${expectedLength}, got ${jsonLines.length}`;
    if (label === 'proofread') {
      console.warn(`${message}. Using best-effort JSON parsing.`);
      const bestEffort = jsonLines.slice(0, expectedLength);
      while (bestEffort.length < expectedLength) bestEffort.push('');
      return bestEffort;
    }
    console.warn(message);
    throw new Error(message);
  }

  const rawLines = normalizedContent.replace(/\r\n/g, '\n').split('\n');
  if (expectedLength) {
    while (rawLines.length > expectedLength && rawLines[rawLines.length - 1] === '') {
      rawLines.pop();
    }
  }
  const lines = rawLines.map((line) => line.trim());

  if (expectedLength && lines.length !== expectedLength) {
    const isBlankLineSeparatorPattern =
      lines.length === expectedLength * 2 - 1 &&
      lines.every((line, index) => (index % 2 === 1 ? line === '' : true));
    const isTrailingBlankSeparatorPattern =
      lines.length === expectedLength * 2 &&
      lines[lines.length - 1] === '' &&
      lines.slice(0, -1).every((line, index) => (index % 2 === 1 ? line === '' : true));
    if (isBlankLineSeparatorPattern || isTrailingBlankSeparatorPattern) {
      console.warn(
        `${label} response length mismatch: expected ${expectedLength}, got ${lines.length}. Collapsing blank-line separators.`
      );
      return lines.filter((_, index) => index % 2 === 0).slice(0, expectedLength);
    }
    const collapsedBlankLines = collapseConsecutiveBlankLines(lines);
    if (collapsedBlankLines.length === expectedLength && collapsedBlankLines.length !== lines.length) {
      console.warn(
        `${label} response length mismatch: expected ${expectedLength}, got ${lines.length}. Collapsing consecutive blank lines.`
      );
      return collapsedBlankLines;
    }
    if (expectedLength === 1 && lines.length > 1) {
      console.warn(
        `${label} response length mismatch for single item: expected 1, got ${lines.length}. Combining lines.`
      );
      return collapseSingleItemLines(lines);
    }
    const message = `${label} response length mismatch: expected ${expectedLength}, got ${lines.length}`;
    if (label === 'proofread') {
      console.warn(`${message}. Using best-effort parsing.`);
      const bestEffort = lines.slice(0, expectedLength);
      while (bestEffort.length < expectedLength) bestEffort.push('');
      return bestEffort;
    }
    console.warn(message);
    throw new Error(message);
  }

  return lines;
}

function countMatches(value = '', regex) {
  if (!value) return 0;
  const matches = value.match(regex);
  return matches ? matches.length : 0;
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
