importScripts('ai-common.js');
importScripts('translation-service.js');
importScripts('context-service.js');
importScripts('proofread-service.js');

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

const MODEL_THROUGHPUT_TEST_TIMEOUT_MS = 15000;

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

    const { translations, rawProofread } = await proofreadTranslation(
      message.segments,
      message.sourceBlock,
      message.translatedBlock,
      message.context,
      message.language,
      apiKey,
      state.proofreadModel,
      apiBaseUrl
    );
    sendResponse({ success: true, translations, rawProofread });
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
