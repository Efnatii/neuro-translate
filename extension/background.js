const DEFAULT_STATE = {
  apiKey: '',
  enabled: true,
  blockedDomains: []
};

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
    handleTranslationProgress(message);
  }

  if (message?.type === 'GET_TRANSLATION_STATUS') {
    handleGetTranslationStatus(sendResponse);
    return true;
  }

  return false;
});

async function handleGetSettings(message, sendResponse) {
  const state = await getState();
  const domain = safeGetDomain(message.url);
  const blocked = domain && state.blockedDomains?.includes(domain);
  sendResponse({
    allowed: state.enabled && !blocked && !!state.apiKey,
    enabled: state.enabled,
    blocked,
    apiKey: state.apiKey,
    blockedDomains: state.blockedDomains,
    domain
  });
}

async function handleTranslateText(message, sendResponse) {
  try {
    const state = await getState();
    if (!state.enabled) {
      sendResponse({ success: false, error: 'Translator is disabled.' });
      return;
    }

    if (!state.apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const translations = await translateTexts(message.texts, state.apiKey, message.targetLanguage);
    sendResponse({ success: true, translations });
  } catch (error) {
    console.error('Translation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function translateTexts(texts, apiKey, targetLanguage = 'ru') {
  const translations = [];
  for (const text of texts) {
    const translated = await translateSingle(text, apiKey, targetLanguage);
    translations.push(translated || text);
  }
  return translations;
}

async function translateSingle(text, apiKey, targetLanguage) {
  const body = {
    model: 'gpt-5-nano',
    messages: [
      {
        role: 'system',
        content: `You are a translation engine. Translate the user text into ${targetLanguage}. Only return the translated text.`
      },
      {
        role: 'user',
        content: text
      }
    ],
    temperature: 0.3
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
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

  return content.trim();
}

function safeGetDomain(urlString) {
  try {
    const url = new URL(urlString);
    return url.hostname;
  } catch (error) {
    return null;
  }
}

async function handleTranslationProgress(message) {
  const status = {
    completedChunks: message.completedChunks || 0,
    totalChunks: message.totalChunks || 0,
    message: message.message || '',
    timestamp: Date.now()
  };
  await chrome.storage.local.set({ translationStatus: status });
}

async function handleGetTranslationStatus(sendResponse) {
  const { translationStatus } = await chrome.storage.local.get({ translationStatus: null });
  sendResponse(translationStatus);
}
