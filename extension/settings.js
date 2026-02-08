(() => {
  const DEFAULT_TPM_LIMITS_BY_MODEL = {
    default: 200000,
    'gpt-4.1-mini': 200000,
    'gpt-4.1': 300000,
    'gpt-4o-mini': 200000,
    'gpt-4o': 300000,
    'o4-mini': 200000
  };

  const DEFAULT_OUTPUT_RATIO_BY_ROLE = {
    translation: 0.6,
    context: 0.4,
    proofread: 0.5
  };

  const DEFAULT_TPM_SAFETY_BUFFER_TOKENS = 100;

  const DEFAULT_STATE = {
    apiKey: '',
    openAiOrganization: '',
    openAiProject: '',
    translationModel: 'gpt-4.1-mini',
    contextModel: 'gpt-4.1-mini',
    proofreadModel: 'gpt-4.1-mini',
    translationModelList: ['gpt-4.1-mini:standard'],
    contextModelList: ['gpt-4.1-mini:standard'],
    proofreadModelList: ['gpt-4.1-mini:standard'],
    contextGenerationEnabled: false,
    proofreadEnabled: false,
    batchTurboMode: 'off',
    proofreadMode: 'auto',
    singleBlockConcurrency: false,
    assumeOpenAICompatibleApi: false,
    blockLengthLimit: 1200,
    tpmLimitsByModel: DEFAULT_TPM_LIMITS_BY_MODEL,
    outputRatioByRole: DEFAULT_OUTPUT_RATIO_BY_ROLE,
    tpmSafetyBufferTokens: DEFAULT_TPM_SAFETY_BUFFER_TOKENS
  };

  const STATE_CACHE_KEYS = new Set([
    'apiKey',
    'openAiOrganization',
    'openAiProject',
    'translationModel',
    'contextModel',
    'proofreadModel',
    'translationModelList',
    'contextModelList',
    'proofreadModelList',
    'contextGenerationEnabled',
    'proofreadEnabled',
    'batchTurboMode',
    'proofreadMode',
    'singleBlockConcurrency',
    'assumeOpenAICompatibleApi',
    'blockLengthLimit',
    'tpmLimitsByModel',
    'outputRatioByRole',
    'tpmSafetyBufferTokens'
  ]);

  const sanitizeSettings = (raw, defaults = DEFAULT_STATE) => {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const base = defaults && typeof defaults === 'object' ? defaults : {};
    const result = { ...base };
    const allowedKeys = new Set([...Object.keys(base), ...Object.keys(source)]);

    const normalizeList = (value, fallback) => {
      if (Array.isArray(value)) {
        const filtered = value.filter((entry) => typeof entry === 'string' && entry.trim());
        return filtered.length ? filtered : fallback || [];
      }
      if (typeof value === 'string' && value.trim()) {
        return [value.trim()];
      }
      return fallback || [];
    };

    allowedKeys.forEach((key) => {
      if (!Object.prototype.hasOwnProperty.call(source, key) && Object.keys(base).length > 0) {
        return;
      }
      const value = source[key];
      const fallback = base[key];
      switch (key) {
        case 'apiKey':
        case 'openAiOrganization':
        case 'openAiProject':
        case 'translationModel':
        case 'contextModel':
        case 'proofreadModel': {
          result[key] = typeof value === 'string' ? value : value == null ? '' : String(value);
          break;
        }
        case 'translationModelList':
        case 'contextModelList':
        case 'proofreadModelList': {
          result[key] = normalizeList(value, fallback);
          break;
        }
        case 'contextGenerationEnabled':
        case 'proofreadEnabled':
        case 'singleBlockConcurrency':
        case 'assumeOpenAICompatibleApi': {
          result[key] = Boolean(value);
          break;
        }
        case 'batchTurboMode': {
          const allowedModes = new Set(['off', 'prewarm_ui', 'prewarm_dedup_all']);
          result[key] = allowedModes.has(value) ? value : fallback;
          break;
        }
        case 'proofreadMode': {
          const allowedModes = new Set(['auto', 'always', 'never']);
          result[key] = allowedModes.has(value) ? value : fallback;
          break;
        }
        case 'blockLengthLimit':
        case 'tpmSafetyBufferTokens': {
          const numValue = Number(value);
          result[key] = Number.isFinite(numValue) ? numValue : fallback;
          break;
        }
        case 'tpmLimitsByModel':
        case 'outputRatioByRole': {
          result[key] = value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
          break;
        }
        default: {
          if (Object.keys(base).length === 0 || key in base) {
            result[key] = value;
          }
        }
      }
    });

    return result;
  };

  const pickStateForCache = (state) => {
    const source = state && typeof state === 'object' ? state : {};
    const output = {};
    for (const key of STATE_CACHE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        output[key] = source[key];
      }
    }
    return output;
  };

  globalThis.NT_SETTINGS = {
    DEFAULT_STATE,
    DEFAULT_TPM_LIMITS_BY_MODEL,
    DEFAULT_OUTPUT_RATIO_BY_ROLE,
    DEFAULT_TPM_SAFETY_BUFFER_TOKENS,
    STATE_CACHE_KEYS,
    sanitizeSettings,
    pickStateForCache
  };
})();
