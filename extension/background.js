importScripts('proofread-utils.js');

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
const PUNCTUATION_TOKEN_HINT =
  'Tokens like ⟦PUNC_DQUOTE⟧ replace double quotes; keep them unchanged, in place, and with exact casing.';
const PROOFREAD_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      maxItems: ProofreadUtils.MAX_PROOFREAD_EDITS,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['replace', 'insert_before', 'insert_after', 'delete'] },
          target: { type: 'string' },
          replacement: { type: 'string' },
          occurrence: { type: 'integer', minimum: 1 },
          before: { type: 'string' },
          after: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['op', 'target'],
        additionalProperties: false
      }
    },
    rewrite_text: { type: 'string' }
  },
  required: ['edits'],
  additionalProperties: false
};

function applyPromptCaching(messages, apiBaseUrl = OPENAI_API_URL) {
  if (apiBaseUrl !== OPENAI_API_URL) return messages;
  return messages.map((message) =>
    message.role === 'user' ? { ...message, cache_control: { type: 'ephemeral' } } : message
  );
}

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

function getProviderLabel(provider) {
  return provider === 'deepseek' ? 'DeepSeek' : 'OpenAI';
}

function buildMissingKeyReason(roleLabel, config, model) {
  const providerLabel = getProviderLabel(config.provider);
  return `Перевод недоступен: укажите ключ ${providerLabel} для модели ${model} (${roleLabel}).`;
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

  if (message?.type === 'GET_TAB_ID') {
    sendResponse({ tabId: sender?.tab?.id ?? null });
    return true;
  }

  if (message?.type === 'CANCEL_PAGE_TRANSLATION' && sender?.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: 'CANCEL_TRANSLATION' });
  }

  if (message?.type === 'TRANSLATION_PROGRESS') {
    handleTranslationProgress(message, sender);
  }

  if (message?.type === 'TRANSLATION_CANCELLED') {
    handleTranslationCancelled(message, sender);
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
  try {
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
    let disallowedReason = null;
    if (!hasTranslationKey) {
      disallowedReason = buildMissingKeyReason('перевод', translationConfig, state.translationModel);
    } else if (state.contextGenerationEnabled && !hasContextKey) {
      disallowedReason = buildMissingKeyReason('контекст', contextConfig, state.contextModel);
    } else if (state.proofreadEnabled && !hasProofreadKey) {
      disallowedReason = buildMissingKeyReason('вычитка', proofreadConfig, state.proofreadModel);
    }
    sendResponse({
      allowed:
        hasTranslationKey &&
        (!state.contextGenerationEnabled || hasContextKey) &&
        (!state.proofreadEnabled || hasProofreadKey),
      disallowedReason,
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
  } catch (error) {
    console.error('Failed to fetch settings.', error);
    sendResponse({
      allowed: false,
      disallowedReason:
        'Перевод недоступен: не удалось получить настройки. Перезагрузите страницу и попробуйте снова.'
    });
  }
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

    const { results, rawProofread } = await proofreadTranslation(
      message.blocks,
      apiKey,
      state.proofreadModel,
      apiBaseUrl
    );
    sendResponse({ success: true, results, rawProofread });
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

  const prompt = applyPromptCaching([
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
  ], apiBaseUrl);

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

async function proofreadTranslation(blocks, apiKey, model = DEFAULT_STATE.proofreadModel, apiBaseUrl = OPENAI_API_URL) {
  if (!Array.isArray(blocks) || !blocks.length) return { results: [], rawProofread: [] };

  const normalizedBlocks = blocks.map((block, index) => {
    const blockId = block?.blockId ?? String(index);
    const language = block?.language ?? '';
    const goals = Array.isArray(block?.goals) ? block.goals : [];
    const text = typeof block?.text === 'string' ? block.text : '';
    const { normalized } = ProofreadUtils.normalizeLineEndings(text);
    return { blockId, text: normalized, language, goals };
  });

  const results = [];
  const rawProofread = [];

  for (const block of normalizedBlocks) {
    const prompt = applyPromptCaching(ProofreadUtils.buildProofreadPrompt(block), apiBaseUrl);
    if (prompt?.[0]?.content) {
      prompt[0].content = `${prompt[0].content} ${PUNCTUATION_TOKEN_HINT}`;
    }

    const maxRateLimitRetries = 3;
    let rateLimitRetries = 0;
    let lastRateLimitDelayMs = null;
    let lastError = null;

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
            messages: prompt,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'proofread_edits',
                schema: PROOFREAD_RESPONSE_SCHEMA
              }
            }
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

        const parsed = parseJsonObjectFlexible(content, 'proofread');
        const edits = Array.isArray(parsed?.edits) ? parsed.edits : [];
        const parsedRewriteText = typeof parsed?.rewrite_text === 'string' ? parsed.rewrite_text : null;
        const rewriteText =
          parsedRewriteText && parsedRewriteText.length > 0 ? parsedRewriteText : block.text;

        results.push({ blockId: block.blockId, edits, rewriteText });
        rawProofread.push({ blockId: block.blockId, raw: content });
        break;
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
          const waitSeconds = Math.max(
            1,
            Math.ceil((lastRateLimitDelayMs || error?.retryAfterMs || 30000) / 1000)
          );
          const waitMs = waitSeconds * 1000;
          console.warn(`Proofreading rate limit reached—waiting ${waitSeconds}s before retrying.`);
          await sleep(waitMs);
          continue;
        }

        throw lastError;
      }
    }
  }

  return { results, rawProofread };
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
      if (error?.rawTranslation) {
        lastRawTranslation = error.rawTranslation;
      }

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
  allowRefusalRetry = true,
  allowLengthRetry = true
) {
  const tokenizedTexts = texts.map(applyPunctuationTokens);

  const prompt = applyPromptCaching([
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
        'If page context is provided in the user message, use it only for disambiguation; never introduce new facts.',
        'Do not translate, quote, paraphrase, or include the context text in the output unless it is required to translate the source segments.',
        'If no context is provided, do not invent context or add assumptions.',
        'Never include page context text in the translations unless it is explicitly part of the source segments.',
        'Respond only with a JSON object containing the translated segments in the same order as the input segments under a "translations" array.',
        'Do not add commentary.'
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

  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
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

  let translations;
  try {
    translations = parseTranslationsResponse(content, texts.length);
  } catch (error) {
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
        false
      );
      lengthRetryIndices.forEach((index, retryPosition) => {
        if (retryResults?.[retryPosition]) {
          translations[index] = retryResults[retryPosition];
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
  allowRefusalRetry = true,
  allowLengthRetry = true
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
        messages: applyPromptCaching(
          [
            { role: 'system', content: 'Reply with the word OK.' },
            { role: 'user', content: 'OK' }
          ],
          apiBaseUrl
        )
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
  chrome.runtime.sendMessage({
    type: 'TRANSLATION_VISIBILITY_CHANGED',
    tabId,
    visible: Boolean(message.visible)
  });
}

async function handleTranslationCancelled(message, sender) {
  const tabId = message?.tabId ?? sender?.tab?.id;
  if (!tabId) return;
  const { translationStatusByTab = {}, translationVisibilityByTab = {} } = await chrome.storage.local.get({
    translationStatusByTab: {},
    translationVisibilityByTab: {}
  });
  delete translationStatusByTab[tabId];
  translationVisibilityByTab[tabId] = false;
  await chrome.storage.local.set({ translationStatusByTab, translationVisibilityByTab });
  chrome.runtime.sendMessage({ type: 'TRANSLATION_CANCELLED', tabId });
}
