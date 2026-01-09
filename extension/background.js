const DEFAULT_STATE = {
  apiKey: '',
  model: 'gpt-4.1-mini',
  translationStyle: 'auto',
  contextGenerationEnabled: false
};

const DEFAULT_TRANSLATION_TIMEOUT_MS = 45000;
const MAX_TRANSLATION_TIMEOUT_MS = 180000;
const MODEL_THROUGHPUT_TEST_TIMEOUT_MS = 15000;

const PUNCTUATION_TOKENS = new Map([
  ['«', '⟦PUNC_LGUILLEMET⟧'],
  ['»', '⟦PUNC_RGUILLEMET⟧'],
  ['“', '⟦PUNC_LDQUOTE⟧'],
  ['”', '⟦PUNC_RDQUOTE⟧'],
  ['"', '⟦PUNC_DQUOTE⟧']
]);

const PUNCTUATION_TOKEN_HINT = 'Tokens like ⟦PUNC_DQUOTE⟧ replace double quotes; keep them unchanged and in place.';

async function getState() {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  const merged = { ...DEFAULT_STATE, ...stored };
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
  sendResponse({
    allowed: !!state.apiKey,
    apiKey: state.apiKey,
    model: state.model,
    translationStyle: state.translationStyle,
    contextGenerationEnabled: state.contextGenerationEnabled
  });
}

async function handleTranslateText(message, sendResponse) {
  try {
    const state = await getState();
    if (!state.apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const translations = await translateTexts(
      message.texts,
      state.apiKey,
      message.targetLanguage,
      state.model,
      message.translationStyle || state.translationStyle,
      message.context
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
    if (!state.apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const context = await generateTranslationContext(
      message.text,
      state.apiKey,
      message.targetLanguage,
      state.model
    );
    sendResponse({ success: true, context });
  } catch (error) {
    console.error('Context generation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function handleModelThroughputTest(message, sendResponse) {
  try {
    const state = await getState();
    if (!state.apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const model = message?.model || state.model;
    const result = await runModelThroughputTest(state.apiKey, model);
    await saveModelThroughputResult(model, result);
    sendResponse({ success: true, result });
  } catch (error) {
    const model = message?.model || DEFAULT_STATE.model;
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

async function generateTranslationContext(text, apiKey, targetLanguage = 'ru', model = DEFAULT_STATE.model) {
  if (!text?.trim()) return '';

  const prompt = [
    {
      role: 'system',
      content: [
        'Ты — ассистент переводчика. Составь контекст для качественного перевода.',
        'Не пересказывай текст, не оценивай и не добавляй факты вне источника.',
        'Если информации нет, укажи "не указано".',
        'Фокусируйся на деталях, влияющих на точность, единообразие терминов, стиль и смысл.',
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
        '- что нельзя переводить или что оставлять как есть',
        '',
        '7) Собственные имена и ономастика:',
        '- имена, бренды, продукты, организации, топонимы',
        '- как передавать: перевод/транслитерация/оставить как есть',
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
  model = DEFAULT_STATE.model,
  translationStyle = DEFAULT_STATE.translationStyle,
  context = ''
) {
  if (!Array.isArray(texts) || !texts.length) return [];

  const maxAttempts = 2;
  let lastError = null;
  const throughputInfo = await getModelThroughputInfo(model);
  const timeoutMs = calculateTranslationTimeoutMs(texts, throughputInfo);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
        context
      );
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error('Translation request timed out') : error;

      const isTimeout = error?.name === 'AbortError' || error?.message?.toLowerCase?.().includes('timed out');
      if (attempt < maxAttempts && isTimeout) {
        console.warn(`Translation attempt ${attempt} timed out, retrying...`);
        continue;
      }

      const isLengthIssue = error?.message?.toLowerCase?.().includes('length mismatch');
      if (isLengthIssue && texts.length > 1) {
        console.warn('Falling back to per-item translation due to length mismatch.');
        return await translateIndividually(texts, apiKey, targetLanguage, model, translationStyle, context);
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
  context = ''
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
        PUNCTUATION_TOKEN_HINT,
        styleInstruction ? `Tone/style: ${styleInstruction}` : 'Determine the most appropriate tone/style based on the provided context.',
        context ? `Use this page context to disambiguate phrasing: ${context}` : '',
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
        `Пожалуйста, не изменяй служебные токены пунктуации. ${PUNCTUATION_TOKEN_HINT}`,
        'Фрагменты для перевода:',
        ...tokenizedTexts.map((text, index) => `${index + 1}) ${text}`)
      ]
        .filter(Boolean)
        .join('\n')
    }
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    throw new Error(`Translation request failed: ${response.status} ${errorText}`);
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
      return restorePunctuationTokens(candidate);
    }
    return text;
  });
}

async function translateIndividually(texts, apiKey, targetLanguage, model, translationStyle, context = '') {
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
        context
      );
      results.push(translated);
    } catch (error) {
      console.error('Single-item translation failed, keeping original text.', error);
      results.push(text);
    }
  }

  return results;
}

async function runModelThroughputTest(apiKey, model) {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_THROUGHPUT_TEST_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        max_tokens: 24,
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
