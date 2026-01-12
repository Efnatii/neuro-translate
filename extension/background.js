const DEFAULT_STATE = {
  apiKey: '',
  deepseekApiKey: '',
  translationModel: 'gpt-4.1-mini',
  contextModel: 'gpt-4.1-mini',
  proofreadModel: 'gpt-4.1-mini',
  translationStyle: 'auto',
  contextGenerationEnabled: false,
  proofreadEnabled: false
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

const PUNCTUATION_TOKEN_HINT = 'Tokens like ⟦PUNC_DQUOTE⟧ replace double quotes; keep them unchanged and in place.';

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
  const stored = await chrome.storage.local.get({ ...DEFAULT_STATE, model: null });
  const merged = { ...DEFAULT_STATE, ...stored };
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
    proofreadEnabled: state.proofreadEnabled
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
        'Ты — ассистент переводчика. Составь контекст для качественного перевода.',
        'Не пересказывай текст, не оценивай и не добавляй факты вне источника.',
        'Если информации нет, укажи "не указано".',
        'Фокусируйся на деталях, влияющих на точность, единообразие терминов, стиль и смысл.',
        'Не предлагай оставлять имена/названия/термины без перевода, если это не явно указано в тексте.',
        'Ответ должен быть структурированным и лаконичным.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Проанализируй исходный текст и составь контекст для перевода на ${targetLanguage}.`,
        'Нужны максимально полезные детали для переводчика.',
        'Формат — строго по разделам ниже (кратко, пунктами).',
        '',
        '1) Тип текста и назначение:',
        '- жанр/домен (художественный, техдок, маркетинг, UI, новости и т.п.)',
        '- цель (информировать, убедить, инструктировать, описать, продать и т.п.)',
        '- предполагаемая аудитория (если явно видно)',
        '',
        '2) Сеттинг:',
        '- место действия, география, организации/локации (если указано)',
        '- время/эпоха/период (если указано)',
        '',
        '3) Участники/персонажи:',
        '- имена/роли/должности',
        '- пол/род/местоимения (если явно указано)',
        '- говорящие/адресаты (кто кому говорит)',
        '',
        '4) Отношения и социальные связи:',
        '- отношения между персонажами (если явно есть)',
        '- статус/иерархия (начальник‑подчинённый, клиент‑служба поддержки и т.п.)',
        '',
        '5) Сюжетные/фактологические опорные точки:',
        '- ключевые события/факты, которые нельзя исказить',
        '',
        '6) Терминология и единообразие:',
        '- термины/понятия/аббревиатуры, которые должны переводиться одинаково',
        '- рекомендуемые варианты перевода, если явно вытекают из контекста',
        '- что нельзя переводить или что оставлять как есть (только если это прямо следует из текста)',
        '',
        '7) Собственные имена и ономастика:',
        '- имена, бренды, продукты, организации, топонимы',
        '- как передавать: перевод/транслитерация/оставить как есть (оставлять как есть только при явном указании)',
        '',
        '8) Тональность и стиль:',
        '- официальный/разговорный/нейтральный/художественный/ирония и т.п.',
        '- уровень формальности и вежливости (ты/вы, обращения)',
        '',
        '9) Лингвистические особенности:',
        '- сленг, жаргон, диалект, архаизмы',
        '- игра слов/идиомы (если есть)',
        '- цитаты/цитируемая речь',
        '',
        '10) Формат и технические требования:',
        '- единицы измерения, валюты, даты, форматы',
        '- требования к краткости/структуре',
        '- повторяющиеся шаблоны/плейсхолдеры (если есть)',
        '',
        'Текст:',
        text,
        '',
        'Выводи только разделы с краткими пунктами.',
        'Если раздел не заполнен — напиши "не указано".'
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
  const prompt = [
    {
      role: 'system',
      content: [
        'You are a strict proofreading engine for translated text.',
        'Return only a JSON array of objects with "from" and "to" fields.',
        'Each object describes an exact substring to replace ("from") and the replacement ("to").',
        'Never add commentary, explanations, or extra keys.',
        'Improve fluency and naturalness so the translation reads like it was written by a native speaker.',
        'Fix grammar, agreement, punctuation, typos, or terminology consistency as needed.',
        'You may rephrase locally to improve naturalness, but never change meaning or add/remove information.',
        'Do not reorder sentences unless it is required for naturalness in the target language.',
        'Never introduce, duplicate, or delete punctuation tokens like ⟦PUNC_DQUOTE⟧.',
        'If a punctuation token appears in the translated text, keep it unchanged and in the same position.',
        'Use the source text only to verify correctness and preserve meaning.',
        context ? 'Use the provided translation context to maintain terminology consistency.' : '',
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
        context ? `Context: ${context}` : '',
        normalizedSourceTexts.length ? 'Source text:' : '',
        ...normalizedSourceTexts.map((text) => text),
        'Translated text:',
        ...texts.map((text) => text)
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
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Proofread request failed: ${response.status} ${errorText}`);
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
    natural: 'Нейтральный, плавный русский без буквального калькирования.',
    conversational: 'Разговорный, тёплый тон с живыми оборотами без лишней фамильярности.',
    formal: 'Деловой, аккуратный тон с чёткими формулировками.',
    creative: 'Выразительный и образный тон, но без потери смысла.'
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
        'Preserve numbers, units, currencies, dates, and formatting unless explicitly instructed otherwise.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Translate proper names, titles, and terms; when unsure, transliterate them instead of leaving them unchanged unless they are established brands or standard in the target language.',
        'Ensure terminology consistency within the same request.',
        PUNCTUATION_TOKEN_HINT,
        styleInstruction ? `Tone/style: ${styleInstruction}` : 'Determine the most appropriate tone/style based on the provided context.',
        context ? `Use this page context only to disambiguate phrasing; never introduce new facts: ${context}` : '',
        'Respond only with translations in the same order, one per line, without numbering or commentary.'
      ]
        .filter(Boolean)
        .join(' ')
    },
    {
      role: 'user',
      content: [
        `Переведи следующие фрагменты на ${targetLanguage}.`,
        styleInstruction ? `Стиль: ${styleInstruction}` : 'Определи стиль автоматически на основе контекста.',
        context ? `Контекст страницы: ${context}` : '',
        'Не опускай и не добавляй информацию; сохраняй модальность, время, аспект, тон и степень уверенности.',
        'Сохраняй числа, единицы, валюты, даты и форматирование, если явно не указано иное.',
        'Не изменяй плейсхолдеры, разметку и код (например, {name}, {{count}}, <tag>, **bold**).',
        'Переводи имена/названия/термины; если не уверен — транслитерируй, не оставляй без перевода, кроме устоявшихся брендов.',
        'Следи за единообразием терминов внутри одного запроса.',
        `Пожалуйста, не изменяй служебные токены пунктуации. ${PUNCTUATION_TOKEN_HINT}`,
        'Фрагменты для перевода:',
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

  for (const text of texts) {
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
    } catch (error) {
      console.error('Single-item translation failed, keeping original text.', error);
      results.push(text);
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

function restorePunctuationTokens(text = '') {
  let output = text;
  for (const [punctuation, token] of PUNCTUATION_TOKENS.entries()) {
    output = output.split(token).join(punctuation);
  }
  return output;
}

async function handleTranslationProgress(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  const status = {
    completedChunks: message.completedChunks || 0,
    totalChunks: message.totalChunks || 0,
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
