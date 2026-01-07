const DEFAULT_STATE = {
  apiKey: '',
  model: 'gpt-4.1-mini',
  translationStyle: 'natural'
};

const PUNCTUATION_TOKENS = new Map([
  ['…', '⟦PUNC_ELLIPSIS⟧'],
  ['.', '⟦PUNC_DOT⟧'],
  [',', '⟦PUNC_COMMA⟧'],
  ['!', '⟦PUNC_EXCLAMATION⟧'],
  ['?', '⟦PUNC_QUESTION⟧'],
  [':', '⟦PUNC_COLON⟧'],
  [';', '⟦PUNC_SEMICOLON⟧'],
  ['—', '⟦PUNC_EM_DASH⟧'],
  ['–', '⟦PUNC_EN_DASH⟧'],
  ['«', '⟦PUNC_LGUILLEMET⟧'],
  ['»', '⟦PUNC_RGUILLEMET⟧'],
  ['“', '⟦PUNC_LDQUOTE⟧'],
  ['”', '⟦PUNC_RDQUOTE⟧'],
  ['‘', '⟦PUNC_LSQUOTE⟧'],
  ['’', '⟦PUNC_RSQUOTE⟧'],
  ['"', '⟦PUNC_DQUOTE⟧'],
  ["'", '⟦PUNC_SQUOTE⟧'],
  ['(', '⟦PUNC_LPAREN⟧'],
  [')', '⟦PUNC_RPAREN⟧'],
  ['[', '⟦PUNC_LBRACKET⟧'],
  [']', '⟦PUNC_RBRACKET⟧'],
  ['{', '⟦PUNC_LBRACE⟧'],
  ['}', '⟦PUNC_RBRACE⟧']
]);

const PUNCTUATION_TOKEN_HINT = 'Tokens like ⟦PUNC_COMMA⟧ replace punctuation; keep them unchanged and in place.';
const PUNCTUATION_CODE_TO_TOKEN = new Map(
  Array.from(PUNCTUATION_TOKENS.values()).map((token) => [token.replace(/[⟦⟧]/g, ''), token])
);
const PUNCTUATION_ALIAS_TO_TOKEN = new Map([
  ['PUNC_QUOTE', '⟦PUNC_DQUOTE⟧'],
  ['PUNC_LQUOTE', '⟦PUNC_LDQUOTE⟧'],
  ['PUNC_RQUOTE', '⟦PUNC_RDQUOTE⟧'],
  ['PUNC_APOSTROPHE', '⟦PUNC_SQUOTE⟧']
]);

async function getState() {
  const stored = await chrome.storage.local.get(DEFAULT_STATE);
  return { ...DEFAULT_STATE, ...stored };
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
    translationStyle: state.translationStyle
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

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

  const styleInstruction =
    styleHints?.[translationStyle] || styleHints.natural;

  const prompt = [
    {
      role: 'system',
      content: [
        'You are a fluent Russian translator.',
        `Translate every element of the provided "texts" list into ${targetLanguage} with natural, idiomatic phrasing that preserves meaning and readability.`,
        PUNCTUATION_TOKEN_HINT,
        `Tone/style: ${styleInstruction}`,
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
        `Стиль: ${styleInstruction}`,
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
  let output = normalizePunctuationTokens(text);
  for (const [punctuation, token] of PUNCTUATION_TOKENS.entries()) {
    output = output.split(token).join(punctuation);
  }
  return output;
}

function normalizePunctuationTokens(text = '') {
  const replaceCode = (code, original) => {
    if (PUNCTUATION_CODE_TO_TOKEN.has(code)) {
      return PUNCTUATION_CODE_TO_TOKEN.get(code);
    }
    if (PUNCTUATION_ALIAS_TO_TOKEN.has(code)) {
      return PUNCTUATION_ALIAS_TO_TOKEN.get(code);
    }
    return original;
  };

  const normalizedBracketed = text.replace(/[\[{<](PUNC_[A-Z_]+)[\]}>]/g, (match, code) =>
    replaceCode(code, match)
  );

  return normalizedBracketed.replace(/(?<!⟦)\b(PUNC_[A-Z_]+)\b(?!⟧)/gu, (match, code) =>
    replaceCode(code, match)
  );
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
