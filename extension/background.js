const DEFAULT_STATE = {
  apiKey: ''
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
  sendResponse({
    allowed: !!state.apiKey,
    apiKey: state.apiKey
  });
}

async function handleTranslateText(message, sendResponse) {
  try {
    const state = await getState();
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
  if (!Array.isArray(texts) || !texts.length) return [];

  const prompt = [
    {
      role: 'system',
      content: [
        'You are a translation engine.',
        `Translate each user provided string into ${targetLanguage}.`,
        'Return a JSON object with a "translations" array where each item',
        'is the translation for the corresponding input string.',
        'Only return valid JSON and nothing else.'
      ].join(' ')
    },
    {
      role: 'user',
      content: JSON.stringify({ texts })
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
          model: 'gpt-5-mini',
          messages: prompt,
          response_format: { type: 'json_object' }
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

      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed?.translations)) {
        throw new Error('Unexpected translation format');
      }

      return texts.map((text, index) => parsed.translations[index] || text);
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
