(function initUiTranslationMemory() {
  if (globalThis.ntUiTranslationMemory) return;

  const STORAGE_KEY = 'ntUiTranslationMemory';
  const GENERIC_STORAGE_KEY = 'ntTranslationMemory';
  const MAX_ENTRIES = 20000;
  const TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const WHITESPACE_RE = /\s+/g;

  const hasChrome = typeof chrome !== 'undefined' && chrome?.storage?.local;
  const storageLocal = hasChrome ? chrome.storage.local : null;

  let loaded = false;
  let loadPromise = null;
  let savePromise = null;
  const memory = new Map();
  const genericMemory = new Map();
  const stats = {
    hits: 0,
    misses: 0,
    evictions: 0
  };

  const normalizeUiKey = (text = '') =>
    String(text || '').trim().replace(WHITESPACE_RE, ' ').toLowerCase();
  const normalizeGenericKey = (text = '') =>
    String(text || '').trim().replace(WHITESPACE_RE, ' ');

  const detectCaseStyle = (text = '') => {
    const letters = text.match(/\p{L}+/gu);
    if (!letters || !letters.length) return 'mixed';
    const raw = letters.join('');
    if (!raw) return 'mixed';
    const upper = raw.toLocaleUpperCase();
    const lower = raw.toLocaleLowerCase();
    if (raw === upper) return 'upper';
    if (raw === lower) return 'lower';
    const words = text.split(WHITESPACE_RE).filter(Boolean);
    const titleLike = words.length > 0 && words.every((word) => {
      const first = word.charAt(0);
      const rest = word.slice(1);
      return first === first.toLocaleUpperCase() && rest === rest.toLocaleLowerCase();
    });
    return titleLike ? 'title' : 'mixed';
  };

  const applyCaseStyle = (text = '', style = 'mixed') => {
    if (!text) return text;
    if (style === 'upper') return text.toLocaleUpperCase();
    if (style === 'lower') return text.toLocaleLowerCase();
    if (style === 'title') {
      return text
        .split(WHITESPACE_RE)
        .map((word) => {
          if (!word) return word;
          return word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase();
        })
        .join(' ');
    }
    return text;
  };

  const ensureLoaded = async () => {
    if (loaded) return;
    if (!storageLocal) {
      loaded = true;
      return;
    }
    if (loadPromise) return loadPromise;
    loadPromise = new Promise((resolve) => {
      storageLocal.get({ [STORAGE_KEY]: {}, [GENERIC_STORAGE_KEY]: {} }, (result) => {
        const payload = result?.[STORAGE_KEY] || {};
        Object.entries(payload).forEach(([key, value]) => {
          if (!key || !value) return;
          memory.set(key, value);
        });
        const genericPayload = result?.[GENERIC_STORAGE_KEY] || {};
        Object.entries(genericPayload).forEach(([key, value]) => {
          if (!key || !value) return;
          genericMemory.set(key, value);
        });
        loaded = true;
        resolve();
      });
    });
    return loadPromise;
  };

  const persist = () => {
    if (!storageLocal) return Promise.resolve();
    if (savePromise) return savePromise;
    const payload = Object.fromEntries(memory.entries());
    const genericPayload = Object.fromEntries(genericMemory.entries());
    savePromise = new Promise((resolve) => {
      storageLocal.set({ [STORAGE_KEY]: payload, [GENERIC_STORAGE_KEY]: genericPayload }, () => {
        savePromise = null;
        resolve();
      });
    });
    return savePromise;
  };

  const pruneExpired = () => {
    const now = Date.now();
    let pruned = false;
    memory.forEach((value, key) => {
      if (!value?.ts || now - value.ts > TTL_MS) {
        memory.delete(key);
        pruned = true;
      }
    });
    return pruned;
  };

  const enforceLimit = () => {
    if (memory.size <= MAX_ENTRIES && genericMemory.size <= MAX_ENTRIES) return 0;
    const entries = Array.from(memory.entries());
    const genericEntries = Array.from(genericMemory.entries());
    entries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
    genericEntries.sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
    const removeCount = Math.max(0, entries.length - MAX_ENTRIES);
    const genericRemoveCount = Math.max(0, genericEntries.length - MAX_ENTRIES);
    for (let i = 0; i < removeCount; i += 1) {
      memory.delete(entries[i][0]);
    }
    for (let i = 0; i < genericRemoveCount; i += 1) {
      genericMemory.delete(genericEntries[i][0]);
    }
    stats.evictions += removeCount + genericRemoveCount;
    return removeCount + genericRemoveCount;
  };

  const getUiTranslation = async (text, lang, host) => {
    await ensureLoaded();
    const baseKey = normalizeUiKey(text);
    if (!baseKey) {
      stats.misses += 1;
      return null;
    }
    const key = `${lang || ''}::${host || ''}::${baseKey}`;
    const entry = memory.get(key);
    if (!entry) {
      stats.misses += 1;
      return null;
    }
    const now = Date.now();
    if (!entry.ts || now - entry.ts > TTL_MS) {
      memory.delete(key);
      stats.misses += 1;
      return null;
    }
    entry.ts = now;
    entry.hitCount = Number.isFinite(entry.hitCount) ? entry.hitCount + 1 : 1;
    stats.hits += 1;
    const style = detectCaseStyle(text);
    return applyCaseStyle(entry.translation || '', style);
  };

  const setUiTranslation = async (text, translation, lang, host) => {
    await ensureLoaded();
    const baseKey = normalizeUiKey(text);
    if (!baseKey || !translation) return;
    const key = `${lang || ''}::${host || ''}::${baseKey}`;
    memory.set(key, {
      translation,
      ts: Date.now(),
      hitCount: 0
    });
    pruneExpired();
    enforceLimit();
    await persist();
  };

  const bulkGet = async (texts, lang, host) => {
    await ensureLoaded();
    pruneExpired();
    const translations = [];
    let hits = 0;
    let misses = 0;
    const now = Date.now();
    (texts || []).forEach((text) => {
      const baseKey = normalizeUiKey(text);
      if (!baseKey) {
        translations.push(null);
        misses += 1;
        return;
      }
      const key = `${lang || ''}::${host || ''}::${baseKey}`;
      const entry = memory.get(key);
      if (!entry || !entry.ts || now - entry.ts > TTL_MS) {
        if (entry) memory.delete(key);
        translations.push(null);
        misses += 1;
        return;
      }
      entry.ts = now;
      entry.hitCount = Number.isFinite(entry.hitCount) ? entry.hitCount + 1 : 1;
      hits += 1;
      const style = detectCaseStyle(text);
      translations.push(applyCaseStyle(entry.translation || '', style));
    });
    stats.hits += hits;
    stats.misses += misses;
    await persist();
    return { translations, hits, misses, size: memory.size, evictions: stats.evictions };
  };

  const bulkSet = async (texts, translations, lang, host) => {
    await ensureLoaded();
    const now = Date.now();
    (texts || []).forEach((text, index) => {
      const translation = translations?.[index];
      const baseKey = normalizeUiKey(text);
      if (!baseKey || !translation) return;
      const key = `${lang || ''}::${host || ''}::${baseKey}`;
      memory.set(key, {
        translation,
        ts: now,
        hitCount: 0
      });
    });
    pruneExpired();
    enforceLimit();
    await persist();
    return { size: memory.size, evictions: stats.evictions };
  };

  const bulkGetByKey = async (keys, lang, host) => {
    await ensureLoaded();
    pruneExpired();
    const translations = [];
    let hits = 0;
    let misses = 0;
    const now = Date.now();
    (keys || []).forEach((key) => {
      const normalizedKey = normalizeGenericKey(key);
      if (!normalizedKey) {
        translations.push(null);
        misses += 1;
        return;
      }
      const fullKey = `${lang || ''}::${host || ''}::${normalizedKey}`;
      const entry = genericMemory.get(fullKey);
      if (!entry || !entry.ts || now - entry.ts > TTL_MS) {
        if (entry) genericMemory.delete(fullKey);
        translations.push(null);
        misses += 1;
        return;
      }
      entry.ts = now;
      entry.hitCount = Number.isFinite(entry.hitCount) ? entry.hitCount + 1 : 1;
      hits += 1;
      translations.push(entry.translation || '');
    });
    stats.hits += hits;
    stats.misses += misses;
    await persist();
    return { translations, hits, misses, size: genericMemory.size, evictions: stats.evictions };
  };

  const bulkSetByKey = async (keys, translations, lang, host) => {
    await ensureLoaded();
    const now = Date.now();
    (keys || []).forEach((key, index) => {
      const translation = translations?.[index];
      const normalizedKey = normalizeGenericKey(key);
      if (!normalizedKey || !translation) return;
      const fullKey = `${lang || ''}::${host || ''}::${normalizedKey}`;
      genericMemory.set(fullKey, {
        translation,
        ts: now,
        hitCount: 0
      });
    });
    pruneExpired();
    enforceLimit();
    await persist();
    return { size: genericMemory.size, evictions: stats.evictions };
  };

  const getStats = () => ({
    hits: stats.hits,
    misses: stats.misses,
    size: memory.size,
    evictions: stats.evictions
  });

  globalThis.ntUiTranslationMemory = {
    getUiTranslation,
    setUiTranslation,
    bulkGet,
    bulkSet,
    getStats
  };
  globalThis.ntNormalizeUiKey = normalizeUiKey;
  globalThis.ntTranslationMemory = {
    bulkGetByKey,
    bulkSetByKey
  };
}());
