const DEFAULT_STATE = {
  apiKey: '',
  model: 'gpt-4.1-nano'
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
    handleTranslationProgress(message, sender);
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
    model: state.model
  });
}

async function handleTranslateText(message, sendResponse) {
  try {
    const state = await getState();
    if (!state.apiKey) {
      sendResponse({ success: false, error: 'API key is missing.' });
      return;
    }

    const translations = await translateTexts(message.texts, state.apiKey, message.targetLanguage, state.model);
    sendResponse({ success: true, translations });
  } catch (error) {
    console.error('Translation failed', error);
    sendResponse({ success: false, error: error?.message || 'Unknown error' });
  }
}

async function translateTexts(texts, apiKey, targetLanguage = 'ru', model = DEFAULT_STATE.model) {
  if (!Array.isArray(texts) || !texts.length) return [];

  const delimiter = '|||';
  const prompt = [
    {
      role: 'system',
      content: [
        'You are a translation engine.',
        `Translate each user provided string into ${targetLanguage}.`,
        `Return the translations joined by the delimiter "${delimiter}" in the same order.`,
        'Do not add numbering, explanations, or any extra text.'
      ].join(' ')
    },
    {
      role: 'user',
      content: texts.join(`\n${delimiter}\n`)
    }
  ];

  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);

    try {
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
        signal: controller.signal
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

      const translations = content.split(delimiter).map((text) => text.trim());
      if (!translations.length) {
        throw new Error('Unexpected translation format');
      }

      return texts.map((text, index) => translations[index] || text);
    } catch (error) {
      if (error?.name === 'AbortError') {
        lastError = new Error('Translation request timed out');
      } else {
        lastError = error;
      }

      const isTimeout = error?.name === 'AbortError' || error?.message?.toLowerCase?.().includes('timed out');
      if (attempt < maxAttempts && isTimeout) {
        console.warn(`Translation attempt ${attempt} timed out, retrying...`);
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Translation failed');
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
