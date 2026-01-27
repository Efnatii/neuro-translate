const PROOFREAD_SCHEMA_NAME = 'proofread_translations';
const PROOFREAD_MAX_CHARS_PER_CHUNK = 4000;
const PROOFREAD_MAX_ITEMS_PER_CHUNK = 30;
const PROOFREAD_MISSING_RATIO_THRESHOLD = 0.2;
const PROOFREAD_MAX_OUTPUT_TOKENS = 4096;
const PROOFREAD_SYSTEM_PROMPT = [
  'You are an expert translation proofreader and editor.',
  'Follow the selected PROOFREAD_MODE instructions exactly.',
  'PROOFREAD_MODE=NOISE_CLEANUP: remove noise, normalize to the target language, fix strange insertions, preserve meaning, keep placeholders/tags unchanged, do not add new meaning.',
  'PROOFREAD_MODE=READABILITY_REWRITE: rewrite for maximum clarity and naturalness while preserving meaning exactly; improve readability, phrasing, punctuation, and flow.',
  'If text is already perfect, return it unchanged.',
  'Do not add, omit, or distort information. If rewriting, keep the meaning exactly. Do not hallucinate.',
  'Do not reorder content across segments or change which segment contains which information.',
  'Preserve modality, tense, aspect, tone, and level of certainty.',
  'Keep numbers, units, currencies, dates, and formatting intact unless they are clearly incorrect.',
  'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
  'Keep punctuation tokens unchanged and in place.',
  PUNCTUATION_TOKEN_HINT,
  'Use the source block only to verify meaning; do not translate it or copy it into the output.',
  'Use the translated block as context to maintain consistency across segments.',
  'Never include the context text, source block, or translated block in the output unless it is already part of the segments.',
  'Return a JSON object with an "items" array.',
  'Each item must include the original "id" and the corrected "text" string.',
  'Do not add, remove, or reorder items. Keep ids unchanged.',
  'If a segment does not need edits, return the original text unchanged.'
].join(' ');

function normalizeContextPayload(context) {
  if (!context) {
    return {
      text: '',
      mode: '',
      baseAnswer: '',
      baseAnswerIncluded: false,
      fullText: '',
      shortText: ''
    };
  }
  if (typeof context === 'string') {
    return {
      text: context,
      mode: '',
      baseAnswer: '',
      baseAnswerIncluded: false,
      fullText: '',
      shortText: ''
    };
  }
  if (typeof context === 'object') {
    const normalized = {
      text: context.text || context.contextText || '',
      mode: context.mode || context.contextMode || '',
      baseAnswer: context.baseAnswer || '',
      baseAnswerIncluded: Boolean(context.baseAnswerIncluded),
      fullText: context.fullText || context.fullContextText || context.contextFull || '',
      shortText: context.shortText || context.shortContextText || context.contextShort || ''
    };
    if (!normalized.fullText && normalized.mode === 'FULL' && normalized.text) {
      normalized.fullText = normalized.text;
    }
    if (!normalized.shortText && normalized.mode === 'SHORT' && normalized.text) {
      normalized.shortText = normalized.text;
    }
    return normalized;
  }
  return {
    text: '',
    mode: '',
    baseAnswer: '',
    baseAnswerIncluded: false,
    fullText: '',
    shortText: ''
  };
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function computeTextHash(text = '') {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

function normalizeRequestMeta(meta = {}, overrides = {}) {
  const merged = { ...(meta || {}), ...(overrides || {}) };
  return {
    requestId: merged.requestId || createRequestId(),
    parentRequestId: merged.parentRequestId || '',
    blockKey: merged.blockKey || '',
    stage: merged.stage || '',
    purpose: merged.purpose || 'main',
    attempt: Number.isFinite(merged.attempt) ? merged.attempt : 0,
    triggerSource: merged.triggerSource || '',
    forceFullContextOnRetry: Boolean(merged.forceFullContextOnRetry)
  };
}

function resolveContextPolicy(contextPayload, purpose) {
  const normalized = normalizeContextPayload(contextPayload);
  if (!normalized.text) {
    return purpose && purpose !== 'main' ? 'minimal' : 'none';
  }
  if (normalized.mode === 'SHORT') return 'minimal';
  return 'full';
}

function resolveEffectiveContextMode(requestMeta, normalizedContext) {
  const triggerSource = requestMeta?.triggerSource || '';
  const purpose = requestMeta?.purpose || '';
  if (triggerSource === 'manual') return 'FULL';
  if (triggerSource === 'retry' || triggerSource === 'validate') return 'SHORT';
  if (purpose && purpose !== 'main') return 'SHORT';
  if (normalizedContext?.mode === 'SHORT') return 'SHORT';
  if (normalizedContext?.mode === 'FULL') return 'FULL';
  if (normalizedContext?.text) return 'FULL';
  return 'NONE';
}

function buildEffectiveContext(contextPayload, requestMeta) {
  const normalized = normalizeContextPayload(contextPayload);
  const mode = resolveEffectiveContextMode(requestMeta, normalized);
  let text = '';
  if (mode === 'FULL') {
    text = normalized.fullText || (normalized.mode === 'FULL' ? normalized.text : '') || normalized.text || '';
  } else if (mode === 'SHORT') {
    text = normalized.shortText || (normalized.mode === 'SHORT' ? normalized.text : '') || '';
  }
  const baseAnswer = normalized.baseAnswer || '';
  const baseAnswerIncluded = Boolean(normalized.baseAnswerIncluded);
  const contextMissing = (mode === 'FULL' || mode === 'SHORT') && !text;
  if (contextMissing) {
    console.warn('Context mode requires text but none was provided.', {
      mode,
      triggerSource: requestMeta?.triggerSource,
      purpose: requestMeta?.purpose
    });
  }
  return {
    mode,
    text,
    length: text.length,
    hash: text ? computeTextHash(text) : 0,
    baseAnswer,
    baseAnswerIncluded,
    contextMissing
  };
}

function buildContextPolicy(mode) {
  if (mode === 'FULL') return 'full';
  if (mode === 'SHORT') return 'minimal';
  return 'none';
}

function buildContextTypeUsed(mode) {
  if (mode === 'FULL') return 'FULL';
  if (mode === 'SHORT') return 'SHORT';
  return '';
}

function getRetryContextPayload(contextPayload, requestMeta) {
  const normalized = normalizeContextPayload(contextPayload);
  return {
    text: normalized.shortText || (normalized.mode === 'SHORT' ? normalized.text : '') || '',
    mode: 'SHORT',
    baseAnswer: normalized.baseAnswer || '',
    baseAnswerIncluded: Boolean(normalized.baseAnswerIncluded),
    fullText: '',
    shortText: normalized.shortText || ''
  };
}

function attachRequestMeta(payload, requestMeta, effectiveContext) {
  if (!payload || typeof payload !== 'object') return payload;
  const contextMode = buildContextPolicy(effectiveContext?.mode);
  const contextTypeUsed = buildContextTypeUsed(effectiveContext?.mode);
  return {
    ...payload,
    requestId: payload.requestId || requestMeta.requestId,
    parentRequestId: payload.parentRequestId || requestMeta.parentRequestId || '',
    blockKey: payload.blockKey || requestMeta.blockKey || '',
    stage: payload.stage || requestMeta.stage || '',
    purpose: payload.purpose || requestMeta.purpose || '',
    attempt: Number.isFinite(payload.attempt) ? payload.attempt : requestMeta.attempt,
    triggerSource: payload.triggerSource || requestMeta.triggerSource || '',
    contextMode: payload.contextMode || contextMode,
    contextTypeUsed: payload.contextTypeUsed || contextTypeUsed,
    contextHash: payload.contextHash ?? (effectiveContext?.hash ?? 0),
    contextLength: payload.contextLength ?? (effectiveContext?.length ?? 0),
    contextTextSent: payload.contextTextSent ?? effectiveContext?.text,
    contextMissing: payload.contextMissing ?? effectiveContext?.contextMissing,
    baseAnswerIncluded: payload.baseAnswerIncluded ?? effectiveContext?.baseAnswerIncluded,
    manualArtifactsUsed:
      payload.manualArtifactsUsed ??
      (effectiveContext?.baseAnswerIncluded ? { baseAnswerIncluded: true } : {})
  };
}

function createChildRequestMeta(baseMeta, overrides = {}) {
  const parentRequestId = overrides.parentRequestId || baseMeta?.requestId || '';
  return normalizeRequestMeta(
    {
      ...(baseMeta || {}),
      ...overrides,
      parentRequestId,
      requestId: overrides.requestId || ''
    },
    { stage: baseMeta?.stage }
  );
}

function buildProofreadPrompt(input, strict = false, extraReminder = '') {
  const items = Array.isArray(input?.items) ? input.items : [];
  const sourceBlock = input?.sourceBlock ?? '';
  const translatedBlock = input?.translatedBlock ?? '';
  const language = input?.language ?? '';
  const proofreadMode = input?.proofreadMode === 'NOISE_CLEANUP' ? 'NOISE_CLEANUP' : 'READABILITY_REWRITE';
  const normalizedContext = normalizeContextPayload(input?.context);
  const contextText = normalizedContext.text || '';
  const contextMode = normalizedContext.mode === 'SHORT' ? 'SHORT' : 'FULL';
  const baseAnswerText =
    normalizedContext.baseAnswerIncluded && normalizedContext.baseAnswer
      ? `PREVIOUS BASE ANSWER (FULL): <<<BASE_ANSWER_START>>>${normalizedContext.baseAnswer}<<<BASE_ANSWER_END>>>`
      : '';

  const messages = [
    {
      role: 'system',
      content: [
        PROOFREAD_SYSTEM_PROMPT,
        strict
          ? 'Strict mode: return every input id exactly once in the output items array.'
          : '',
        extraReminder,
        'Return only JSON, without commentary.'
      ]
        .filter(Boolean)
        .join(' ')
    },
  ];

  messages.push({
    role: 'user',
    content: [`PROOFREAD_MODE: ${proofreadMode}.`, language ? `Target language: ${language}` : '']
      .filter(Boolean)
      .join('\n')
  });

  if (contextText) {
    messages.push({
      role: 'user',
      content: [
        language ? `Target language: ${language}` : '',
        `Context (${contextMode}): <<<CONTEXT_START>>>${contextText}<<<CONTEXT_END>>>`
      ]
        .filter(Boolean)
        .join('\n')
    });
  }

  if (baseAnswerText) {
    messages.push({
      role: 'assistant',
      content: baseAnswerText
    });
  }

  messages.push({
    role: 'user',
    content: [
      language ? `Target language: ${language}` : '',
      sourceBlock ? `Source block: <<<SOURCE_BLOCK_START>>>${sourceBlock}<<<SOURCE_BLOCK_END>>>` : '',
      translatedBlock
        ? `Translated block: <<<TRANSLATED_BLOCK_START>>>${translatedBlock}<<<TRANSLATED_BLOCK_END>>>`
        : '',
      `Expected items count: ${items.length}.`,
      'Segments to proofread (JSON array of {id, text}):',
      JSON.stringify(items)
    ]
      .filter(Boolean)
      .join('\n')
  });

  return messages;
}

async function proofreadTranslation(
  segments,
  sourceBlock,
  translatedBlock,
  context,
  proofreadMode,
  language,
  apiKey,
  model,
  apiBaseUrl = OPENAI_API_URL,
  requestMeta = null
) {
  if (!Array.isArray(segments) || !segments.length) {
    return { translations: [], rawProofread: '' };
  }

  const baseRequestMeta = normalizeRequestMeta(requestMeta, { stage: 'proofread', purpose: 'main' });
  const { items, originalById } = normalizeProofreadSegments(segments);
  const chunks = chunkProofreadItems(items);
  const revisionsById = new Map();
  const rawProofreadParts = [];
  const debugPayloads = [];
  const normalizedContext = normalizeContextPayload(context);
  const baseEffectiveContext = buildEffectiveContext(normalizedContext, baseRequestMeta);
  // Proofread retries are distinct LLM calls; avoid full context unless explicitly forced.
  const retryContextPayload = getRetryContextPayload(normalizedContext, baseRequestMeta);
  const appendParseIssue = (issue) => {
    if (!issue) return;
    const last = debugPayloads[debugPayloads.length - 1];
    if (last) {
      if (!Array.isArray(last.parseIssues)) {
        last.parseIssues = [];
      }
      last.parseIssues.push(issue);
      return;
    }
    debugPayloads.push(
      attachRequestMeta(
        {
          phase: 'PROOFREAD',
          model,
          latencyMs: null,
          usage: null,
          inputChars: null,
          outputChars: null,
          request: null,
          response: null,
          parseIssues: [issue]
        },
        baseRequestMeta,
        baseEffectiveContext
      )
    );
  };

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    let result = await requestProofreadChunk(
      chunk,
      { sourceBlock, translatedBlock, context: normalizedContext, language, proofreadMode },
      apiKey,
      model,
      apiBaseUrl,
      { strict: false, requestMeta: baseRequestMeta, purpose: 'main' }
    );
    rawProofreadParts.push(result.rawProofread);
    if (Array.isArray(result.debug)) {
      debugPayloads.push(...result.debug);
    }
    let quality = evaluateProofreadResult(chunk, result.itemsById, result.parseError);
    logProofreadChunk('proofread', index, chunks.length, chunk.length, quality, result.parseError);
    if (quality.isPoor) {
      console.warn('Proofread chunk incomplete, retrying with strict instructions.', {
        chunkIndex: index + 1,
        missing: quality.missingCount,
        received: quality.receivedCount
      });
      appendParseIssue('retry:retryable');
      result = await requestProofreadChunk(
        chunk,
        { sourceBlock, translatedBlock, context: retryContextPayload, language, proofreadMode },
        apiKey,
        model,
        apiBaseUrl,
        {
          strict: true,
          requestMeta: createChildRequestMeta(baseRequestMeta, {
            purpose: 'retry',
            attempt: baseRequestMeta.attempt + 1,
            triggerSource: 'retry'
          }),
          purpose: 'retry'
        }
      );
      rawProofreadParts.push(result.rawProofread);
      if (Array.isArray(result.debug)) {
        debugPayloads.push(...result.debug);
      }
      quality = evaluateProofreadResult(chunk, result.itemsById, result.parseError);
      logProofreadChunk('proofread-retry', index, chunks.length, chunk.length, quality, result.parseError);
    }

    if (quality.isPoor && chunk.length > 1) {
      console.info('Proofread chunk still incomplete after strict retry, retrying with higher max tokens.', {
        chunkIndex: index + 1,
        missing: quality.missingCount,
        received: quality.receivedCount,
        threshold: PROOFREAD_MISSING_RATIO_THRESHOLD
      });
      appendParseIssue('retry:retryable');
      result = await requestProofreadChunk(
        chunk,
        { sourceBlock, translatedBlock, context: retryContextPayload, language, proofreadMode },
        apiKey,
        model,
        apiBaseUrl,
        {
          strict: true,
          maxTokensOverride: 1.5,
          extraReminder: 'Return every input id exactly once. Do not omit any ids.',
          requestMeta: createChildRequestMeta(baseRequestMeta, {
            purpose: 'retry',
            attempt: baseRequestMeta.attempt + 2,
            triggerSource: 'retry'
          }),
          purpose: 'retry'
        }
      );
      rawProofreadParts.push(result.rawProofread);
      if (Array.isArray(result.debug)) {
        debugPayloads.push(...result.debug);
      }
      quality = evaluateProofreadResult(chunk, result.itemsById, result.parseError);
      logProofreadChunk('proofread-retry-expanded', index, chunks.length, chunk.length, quality, result.parseError);
    }

    if (quality.isPoor && chunk.length > 1) {
      console.warn('Proofread chunk still incomplete, falling back to per-item requests.', {
        chunkIndex: index + 1,
        missing: quality.missingCount,
        received: quality.receivedCount,
        threshold: PROOFREAD_MISSING_RATIO_THRESHOLD
      });
      appendParseIssue('fallback:per-item');
      for (const item of chunk) {
        const singleResult = await requestProofreadChunk(
          [item],
          { sourceBlock, translatedBlock, context: retryContextPayload, language, proofreadMode },
          apiKey,
          model,
          apiBaseUrl,
          {
            strict: true,
            requestMeta: createChildRequestMeta(baseRequestMeta, {
              purpose: 'retry',
              attempt: baseRequestMeta.attempt + 3,
              triggerSource: 'retry'
            }),
            purpose: 'retry'
          }
        );
        rawProofreadParts.push(singleResult.rawProofread);
        if (Array.isArray(singleResult.debug)) {
          debugPayloads.push(...singleResult.debug);
        }
        const singleQuality = evaluateProofreadResult([item], singleResult.itemsById, singleResult.parseError);
        logProofreadChunk('proofread-single', index, chunks.length, 1, singleQuality, singleResult.parseError);
        const revision = singleResult.itemsById.get(item.id);
        if (revision !== undefined) {
          revisionsById.set(item.id, revision);
        } else if (originalById.has(item.id)) {
          revisionsById.set(item.id, originalById.get(item.id));
        }
      }
      continue;
    }

    for (const item of chunk) {
      if (result.itemsById.has(item.id)) {
        revisionsById.set(item.id, result.itemsById.get(item.id));
      } else if (originalById.has(item.id)) {
        revisionsById.set(item.id, originalById.get(item.id));
      }
    }
  }

  const translations = items.map((item) => {
    const revision = revisionsById.get(String(item.id));
    const originalText = originalById.get(String(item.id)) || '';
    if (typeof revision === 'string') {
      if (revision.trim()) {
      return revision;
      }
      return originalText;
    }
    return originalText;
  });

  const repairedTranslations = await repairProofreadSegments(
    items,
    translations,
    originalById,
    apiKey,
    model,
    apiBaseUrl,
    language,
    debugPayloads,
    baseRequestMeta
  );

  const rawProofread = rawProofreadParts.filter(Boolean).join('\n\n---\n\n');
  return { translations: repairedTranslations, rawProofread, debug: debugPayloads };
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

function chunkProofreadItems(items) {
  const chunks = [];
  let current = [];
  let currentSize = 0;

  items.forEach((item) => {
    const textSize = typeof item.text === 'string' ? item.text.length : 0;
    const estimatedSize = textSize + 30;
    if (
      current.length &&
      (current.length >= PROOFREAD_MAX_ITEMS_PER_CHUNK ||
        currentSize + estimatedSize > PROOFREAD_MAX_CHARS_PER_CHUNK)
    ) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(item);
    currentSize += estimatedSize;
  });

  if (current.length) {
    chunks.push(current);
  }

  return chunks;
}

function normalizeProofreadItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const id = item?.id;
      if (id === null || id === undefined) return null;
      const text = typeof item?.text === 'string' ? item.text : String(item?.text ?? '');
      return { id: String(id), text };
    })
    .filter(Boolean);
}

function normalizeProofreadSegments(segments) {
  if (!Array.isArray(segments)) return { items: [], originalById: new Map() };
  const items = [];
  const originalById = new Map();
  segments.forEach((segment, index) => {
    if (segment && typeof segment === 'object') {
      const id = segment.id ?? String(index);
      const text = typeof segment.text === 'string' ? segment.text : String(segment.text ?? '');
      items.push({ id: String(id), text });
      originalById.set(String(id), text);
      return;
    }
    const text = typeof segment === 'string' ? segment : String(segment ?? '');
    const id = String(index);
    items.push({ id, text });
    originalById.set(id, text);
  });
  return { items, originalById };
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

function getLanguageScript(language = '') {
  const normalized = language.toLowerCase();
  if (
    normalized.startsWith('ru') ||
    normalized.startsWith('uk') ||
    normalized.startsWith('bg') ||
    normalized.startsWith('sr') ||
    normalized.startsWith('mk')
  ) {
    return 'cyrillic';
  }
  if (normalized.startsWith('ar')) return 'arabic';
  if (normalized.startsWith('he')) return 'hebrew';
  if (normalized.startsWith('hi')) return 'devanagari';
  if (normalized.startsWith('ja')) return 'japanese';
  if (normalized.startsWith('ko')) return 'hangul';
  if (normalized.startsWith('zh')) return 'han';
  return 'latin';
}

function countLettersByScript(text = '', script) {
  if (!text) return 0;
  switch (script) {
    case 'cyrillic':
      return countMatches(text, /[\p{Script=Cyrillic}]/gu);
    case 'arabic':
      return countMatches(text, /[\p{Script=Arabic}]/gu);
    case 'hebrew':
      return countMatches(text, /[\p{Script=Hebrew}]/gu);
    case 'devanagari':
      return countMatches(text, /[\p{Script=Devanagari}]/gu);
    case 'japanese':
      return countMatches(text, /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
    case 'hangul':
      return countMatches(text, /[\p{Script=Hangul}]/gu);
    case 'han':
      return countMatches(text, /[\p{Script=Han}]/gu);
    case 'latin':
    default:
      return countMatches(text, /[\p{Script=Latin}]/gu);
  }
}

function detectDominantScript(text = '') {
  const scripts = ['cyrillic', 'latin', 'arabic', 'hebrew', 'devanagari', 'japanese', 'hangul', 'han'];
  let best = null;
  let bestCount = 0;
  scripts.forEach((script) => {
    const count = countLettersByScript(text, script);
    if (count > bestCount) {
      bestCount = count;
      best = script;
    }
  });
  return bestCount > 0 ? best : null;
}

function needsLanguageRepair(source = '', translated = '', targetLanguage = '') {
  const sourceNormalized = normalizeTextForComparison(source);
  const translatedNormalized = normalizeTextForComparison(translated);
  if (!translatedNormalized) return false;
  const totalLetters = countMatches(translated, /[\p{L}]/gu);
  if (!totalLetters || totalLetters < 6) return false;
  const targetScript = getLanguageScript(targetLanguage);
  const targetLetters = countLettersByScript(translated, targetScript);
  const targetRatio = totalLetters ? targetLetters / totalLetters : 0;
  const sourceScript = detectDominantScript(source);
  if (
    sourceNormalized &&
    sourceNormalized === translatedNormalized &&
    sourceScript &&
    sourceScript !== targetScript &&
    totalLetters >= 6
  ) {
    return true;
  }
  if (sourceScript && sourceScript !== targetScript) {
    const sourceLetters = countLettersByScript(translated, sourceScript);
    if (sourceLetters / totalLetters >= 0.35 && totalLetters >= 10) {
      return true;
    }
  }
  return targetRatio < 0.35 && totalLetters >= 12;
}

function evaluateProofreadResult(expectedItems, itemsById, parseError) {
  const expectedIds = expectedItems.map((item) => String(item.id));
  const missingIds = expectedIds.filter((id) => !itemsById.has(id));
  const missingCount = missingIds.length;
  const receivedCount = itemsById.size;
  const total = expectedIds.length;
  const missingRatio = total ? missingCount / total : 0;
  const isPoor =
    Boolean(parseError) ||
    (total === 1 ? missingCount === 1 : missingCount >= Math.max(2, Math.ceil(total * PROOFREAD_MISSING_RATIO_THRESHOLD)));
  return { missingCount, receivedCount, missingRatio, isPoor };
}

function logProofreadChunk(label, index, totalChunks, chunkSize, quality, parseError) {
  const summary = {
    chunk: `${index + 1}/${totalChunks}`,
    size: chunkSize,
    received: quality.receivedCount,
    missing: quality.missingCount
  };
  if (parseError) {
    console.warn(`Proofread chunk parse issue (${label}).`, { ...summary, error: parseError });
    return;
  }
  console.info(`Proofread chunk processed (${label}).`, summary);
}

function buildProofreadBodyPreview(payload, maxLength = 800) {
  if (payload == null) return null;
  let raw = '';
  try {
    raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch (error) {
    raw = String(payload);
  }
  if (!raw) return null;
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}…`;
}

async function requestProofreadChunk(items, metadata, apiKey, model, apiBaseUrl, options = {}) {
  const { strict = false, maxTokensOverride = null, extraReminder = '' } = options;
  const requestMeta = normalizeRequestMeta(options.requestMeta, {
    stage: 'proofread',
    purpose: options.purpose || 'main'
  });
  const normalizedContext = normalizeContextPayload(metadata?.context);
  const effectiveContext = buildEffectiveContext(normalizedContext, requestMeta);
  const triggerSource = requestMeta?.triggerSource || '';
  let resolvedShortContextText = effectiveContext.text || '';
  let resolvedManualOutputs = '';
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    if (!resolvedShortContextText) {
      resolvedShortContextText =
        normalizedContext.shortText || (normalizedContext.mode === 'SHORT' ? normalizedContext.text : '') || '';
    }
    let matchedEntry = null;
    let matchedState = null;
    let matchedUpdatedAt = -1;
    try {
      const debugByUrl = await new Promise((resolve) => {
        try {
          chrome.storage.local.get({ translationDebugByUrl: {} }, (data) => {
            resolve(data?.translationDebugByUrl || {});
          });
        } catch (error) {
          resolve({});
        }
      });
      const states = debugByUrl && typeof debugByUrl === 'object' ? Object.values(debugByUrl) : [];
      for (const state of states) {
        const items = Array.isArray(state?.items) ? state.items : [];
        let entry = null;
        if (requestMeta.parentRequestId) {
          entry = items.find((item) => {
            const list = Array.isArray(item?.proofreadDebug) ? item.proofreadDebug : [];
            return list.some((payload) => payload?.requestId === requestMeta.parentRequestId);
          });
        }
        if (!entry && requestMeta.blockKey) {
          entry = items.find((item) => item?.blockKey === requestMeta.blockKey);
        }
        if (!entry) continue;
        const updatedAt = Number.isFinite(state?.updatedAt) ? state.updatedAt : 0;
        if (!matchedState || updatedAt >= matchedUpdatedAt) {
          matchedState = state;
          matchedEntry = entry;
          matchedUpdatedAt = updatedAt;
        }
      }
    } catch (error) {
      // ignore lookup errors
    }
    if (!resolvedShortContextText && matchedState) {
      resolvedShortContextText =
        (typeof matchedState?.contextShort === 'string' ? matchedState.contextShort.trim() : '') || '';
      if (!resolvedShortContextText && matchedState?.contextShortRefId && typeof getDebugRaw === 'function') {
        try {
          const rawRecord = await getDebugRaw(matchedState.contextShortRefId);
          resolvedShortContextText = rawRecord?.value?.text || rawRecord?.value?.response || '';
        } catch (error) {
          resolvedShortContextText = '';
        }
      }
    }
    if (matchedEntry) {
      const debugList = Array.isArray(matchedEntry.proofreadDebug) ? matchedEntry.proofreadDebug : [];
      const manualPayloads = debugList.filter((payload) => payload?.triggerSource === 'manual');
      const manualParts = manualPayloads.map((payload, index) => {
        let responseText = '';
        if (payload?.response != null) {
          try {
            responseText = typeof payload.response === 'string' ? payload.response : JSON.stringify(payload.response);
          } catch (error) {
            responseText = String(payload.response);
          }
        }
        const parseIssues = Array.isArray(payload?.parseIssues) ? payload.parseIssues.join(', ') : '';
        const header = `Manual attempt ${index + 1}${payload?.phase ? ` (${payload.phase})` : ''}`;
        return [
          header,
          responseText ? `Response: ${responseText}` : 'Response: (empty)',
          parseIssues ? `Parse issues: ${parseIssues}` : ''
        ]
          .filter(Boolean)
          .join('\n');
      });
      resolvedManualOutputs = manualParts.join('\n\n');
    }
    if (!resolvedManualOutputs) {
      resolvedManualOutputs = '(no manual outputs found)';
    }
    if (!resolvedShortContextText) {
      resolvedShortContextText = '(short context missing: bundle not found)';
      console.warn('Retry/validate short context missing; using placeholder.', {
        triggerSource,
        requestId: requestMeta.requestId,
        parentRequestId: requestMeta.parentRequestId,
        blockKey: requestMeta.blockKey
      });
    }
    if (resolvedShortContextText !== effectiveContext.text) {
      effectiveContext.text = resolvedShortContextText;
      effectiveContext.length = resolvedShortContextText.length;
      effectiveContext.hash = resolvedShortContextText ? computeTextHash(resolvedShortContextText) : 0;
      effectiveContext.contextMissing = (effectiveContext.mode === 'FULL' || effectiveContext.mode === 'SHORT')
        ? !resolvedShortContextText
        : false;
    }
  }
  const prompt = applyPromptCaching(
    buildProofreadPrompt(
      {
        items,
        sourceBlock: metadata?.sourceBlock,
        translatedBlock: metadata?.translatedBlock,
        context: {
          text: effectiveContext.text,
          mode: effectiveContext.mode,
          baseAnswer: effectiveContext.baseAnswer,
          baseAnswerIncluded: effectiveContext.baseAnswerIncluded
        },
        language: metadata?.language,
        proofreadMode: metadata?.proofreadMode
      },
      strict,
      extraReminder
    ),
    apiBaseUrl
  );
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    const manualOutputsText = resolvedManualOutputs || '(no manual outputs found)';
    const envelope = [
      '-----BEGIN RETRY/VALIDATE CONTEXT ENVELOPE-----',
      '[SHORT CONTEXT (GLOBAL)]',
      resolvedShortContextText || '(short context missing: bundle not found)',
      '',
      '[PREVIOUS MANUAL ATTEMPTS (OUTPUTS ONLY; NO FULL CONTEXT)]',
      manualOutputsText,
      '-----END RETRY/VALIDATE CONTEXT ENVELOPE-----'
    ].join('\n');
    if (Array.isArray(prompt)) {
      const firstUserIndex = prompt.findIndex((message) => message?.role === 'user');
      if (firstUserIndex >= 0) {
        prompt.splice(firstUserIndex, 0, { role: 'user', content: envelope });
      } else {
        prompt.push({ role: 'user', content: envelope });
      }
    }
  }
  const itemsChars = items.reduce((sum, item) => sum + (item?.text?.length || 0), 0);
  const inputChars =
    itemsChars +
    (effectiveContext?.text?.length || 0) +
    (metadata?.sourceBlock?.length || 0) +
    (metadata?.translatedBlock?.length || 0);
  const approxOut =
    Math.ceil(itemsChars / 4) +
    Math.ceil(items.length * 12) +
    200;
  const baseMaxTokens = Math.min(PROOFREAD_MAX_OUTPUT_TOKENS, Math.max(512, approxOut));
  const adjustedMaxTokens =
    maxTokensOverride == null
      ? baseMaxTokens
      : Math.min(
          PROOFREAD_MAX_OUTPUT_TOKENS,
          Math.max(512, Math.ceil(baseMaxTokens * maxTokensOverride))
        );
  const maxTokens = adjustedMaxTokens;

  const requestPayload = {
    model,
    messages: prompt,
    max_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: PROOFREAD_SCHEMA_NAME,
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: items.length,
              maxItems: items.length,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['id', 'text'],
                additionalProperties: false
              }
            }
          },
          required: ['items'],
          additionalProperties: false
        }
      }
    }
  };
  applyPromptCacheParams(requestPayload, apiBaseUrl, model, 'neuro-translate:proofread:v1');
  const startedAt = Date.now();
  let response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload)
  });

  if (!response.ok) {
    let errorText = await response.text();
    let errorPayload = null;
    try {
      errorPayload = JSON.parse(errorText);
    } catch (parseError) {
      errorPayload = null;
    }
    const stripped = stripUnsupportedPromptCacheParams(
      requestPayload,
      model,
      response.status,
      errorPayload,
      errorText
    );
    if (response.status === 400 && stripped.changed) {
      console.warn('prompt_cache_* param not supported by model; retrying without cache params.', {
        model,
        status: response.status
      });
      response = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestPayload)
      });
      if (!response.ok) {
        errorText = await response.text();
        try {
          errorPayload = JSON.parse(errorText);
        } catch (parseError) {
          errorPayload = null;
        }
      }
    }
    if (!response.ok) {
      const retryAfterMs = parseRetryAfterMs(response, errorPayload);
      const errorMessage =
        errorPayload?.error?.message || errorPayload?.message || errorText || 'Unknown error';
      const error = new Error(`Proofread request failed: ${response.status} ${errorMessage}`);
      error.status = response.status;
      error.retryAfterMs = retryAfterMs;
      error.isRateLimit = response.status === 429 || response.status === 503;
      error.isContextOverflow = isContextOverflowErrorMessage(errorMessage);
      error.debugPayload = attachRequestMeta(
        {
          phase: 'PROOFREAD',
          model,
          latencyMs: Date.now() - startedAt,
          usage: null,
          inputChars,
          outputChars: 0,
          request: requestPayload,
          response: {
            status: response.status,
            statusText: response.statusText,
            error: errorMessage
          },
          parseIssues: ['request-failed']
        },
        requestMeta,
        effectiveContext
      );
      throw error;
    }
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    const latencyMs = Date.now() - startedAt;
    const usage = normalizeUsage(data?.usage);
    const emptyDebugPayload = attachRequestMeta(
      {
        phase: 'PROOFREAD',
        model,
        latencyMs,
        usage,
        inputChars,
        outputChars: 0,
        request: requestPayload,
        response: {
          id: data?.id ?? null,
          status: response.status,
          statusText: response.statusText,
          model: data?.model ?? model,
          emptyContent: true,
          bodyPreview: buildProofreadBodyPreview(data)
        },
        parseIssues: ['no-content', 'api-empty-content']
      },
      requestMeta,
      effectiveContext
    );
    const rawProofread =
      '[no-content] Модель вернула пустой message.content. Проверь модель/response_format. См. debug.';
    return {
      itemsById: new Map(),
      rawProofread,
      parseError: 'no-content',
      debug: [emptyDebugPayload]
    };
  }
  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const debugPayload = attachRequestMeta(
    {
      phase: 'PROOFREAD',
      model,
      latencyMs,
      usage,
      inputChars,
      outputChars: content?.length || 0,
      request: requestPayload,
      response: content,
      parseIssues: []
    },
    requestMeta,
    effectiveContext
  );
  const debugPayloads = [debugPayload];

  let parsed = null;
  let parseError = null;
  try {
    parsed = parseJsonObjectFlexible(content, 'proofread');
  } catch (error) {
    parseError = error?.message || 'parse-error';
    debugPayload.parseIssues.push(parseError);
  }

  let rawProofread = content;
  if (parseError) {
    debugPayload.parseIssues.push('fallback:format-repair');
    const repaired = await requestProofreadFormatRepair(
      content,
      items,
      apiKey,
      model,
      apiBaseUrl,
      createChildRequestMeta(requestMeta, {
        purpose: 'validate',
        attempt: requestMeta.attempt + 1,
        triggerSource: 'validate'
      })
    );
    rawProofread = repaired.rawProofread;
    if (Array.isArray(repaired.debug)) {
      debugPayloads.push(...repaired.debug);
    }
    if (repaired.parsed) {
      parsed = repaired.parsed;
      parseError = repaired.parseError || null;
    }
  }

  const normalizedItems = normalizeProofreadItems(parsed?.items);
  const itemsById = new Map();
  normalizedItems.forEach((item) => {
    itemsById.set(item.id, item.text);
  });

  return { itemsById, rawProofread, parseError, debug: debugPayloads };
}

async function requestProofreadFormatRepair(rawResponse, items, apiKey, model, apiBaseUrl, requestMeta = null) {
  const normalizedRequestMeta = normalizeRequestMeta(requestMeta, { stage: 'proofread', purpose: 'validate' });
  const triggerSource = normalizedRequestMeta?.triggerSource || '';
  let resolvedShortContextText = '';
  let resolvedManualOutputs = '';
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    let matchedEntry = null;
    let matchedState = null;
    let matchedUpdatedAt = -1;
    try {
      const debugByUrl = await new Promise((resolve) => {
        try {
          chrome.storage.local.get({ translationDebugByUrl: {} }, (data) => {
            resolve(data?.translationDebugByUrl || {});
          });
        } catch (error) {
          resolve({});
        }
      });
      const states = debugByUrl && typeof debugByUrl === 'object' ? Object.values(debugByUrl) : [];
      for (const state of states) {
        const itemsList = Array.isArray(state?.items) ? state.items : [];
        let entry = null;
        if (normalizedRequestMeta.parentRequestId) {
          entry = itemsList.find((item) => {
            const list = Array.isArray(item?.proofreadDebug) ? item.proofreadDebug : [];
            return list.some((payload) => payload?.requestId === normalizedRequestMeta.parentRequestId);
          });
        }
        if (!entry && normalizedRequestMeta.blockKey) {
          entry = itemsList.find((item) => item?.blockKey === normalizedRequestMeta.blockKey);
        }
        if (!entry) continue;
        const updatedAt = Number.isFinite(state?.updatedAt) ? state.updatedAt : 0;
        if (!matchedState || updatedAt >= matchedUpdatedAt) {
          matchedState = state;
          matchedEntry = entry;
          matchedUpdatedAt = updatedAt;
        }
      }
    } catch (error) {
      // ignore lookup errors
    }
    if (matchedState) {
      resolvedShortContextText =
        (typeof matchedState?.contextShort === 'string' ? matchedState.contextShort.trim() : '') || '';
      if (!resolvedShortContextText && matchedState?.contextShortRefId && typeof getDebugRaw === 'function') {
        try {
          const rawRecord = await getDebugRaw(matchedState.contextShortRefId);
          resolvedShortContextText = rawRecord?.value?.text || rawRecord?.value?.response || '';
        } catch (error) {
          resolvedShortContextText = '';
        }
      }
    }
    if (matchedEntry) {
      const debugList = Array.isArray(matchedEntry.proofreadDebug) ? matchedEntry.proofreadDebug : [];
      const manualPayloads = debugList.filter((payload) => payload?.triggerSource === 'manual');
      const manualParts = manualPayloads.map((payload, index) => {
        let responseText = '';
        if (payload?.response != null) {
          try {
            responseText = typeof payload.response === 'string' ? payload.response : JSON.stringify(payload.response);
          } catch (error) {
            responseText = String(payload.response);
          }
        }
        const parseIssues = Array.isArray(payload?.parseIssues) ? payload.parseIssues.join(', ') : '';
        const header = `Manual attempt ${index + 1}${payload?.phase ? ` (${payload.phase})` : ''}`;
        return [
          header,
          responseText ? `Response: ${responseText}` : 'Response: (empty)',
          parseIssues ? `Parse issues: ${parseIssues}` : ''
        ]
          .filter(Boolean)
          .join('\n');
      });
      resolvedManualOutputs = manualParts.join('\n\n');
    }
    if (!resolvedManualOutputs) {
      resolvedManualOutputs = '(no manual outputs found)';
    }
    if (!resolvedShortContextText) {
      resolvedShortContextText = '(short context missing: bundle not found)';
      console.warn('Retry/validate short context missing; using placeholder.', {
        triggerSource,
        requestId: normalizedRequestMeta.requestId,
        parentRequestId: normalizedRequestMeta.parentRequestId,
        blockKey: normalizedRequestMeta.blockKey
      });
    }
  }
  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: [
        'You are a formatter.',
        'Convert the provided text into valid JSON that matches the required schema.',
        'Do not change meaning or wording.',
        'Return only JSON.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Return JSON with an "items" array of ${items.length} objects.`,
        'Each object must contain "id" and "text". Keep ids unchanged.',
        'Schema example: {"items":[{"id":"0","text":"..."}]}',
        'Original response:',
        rawResponse
      ].join('\n')
    }
  ], apiBaseUrl);
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    const manualOutputsText = resolvedManualOutputs || '(no manual outputs found)';
    const envelope = [
      '-----BEGIN RETRY/VALIDATE CONTEXT ENVELOPE-----',
      '[SHORT CONTEXT (GLOBAL)]',
      resolvedShortContextText || '(short context missing: bundle not found)',
      '',
      '[PREVIOUS MANUAL ATTEMPTS (OUTPUTS ONLY; NO FULL CONTEXT)]',
      manualOutputsText,
      '-----END RETRY/VALIDATE CONTEXT ENVELOPE-----'
    ].join('\n');
    if (Array.isArray(prompt)) {
      const firstUserIndex = prompt.findIndex((message) => message?.role === 'user');
      if (firstUserIndex >= 0) {
        prompt.splice(firstUserIndex, 0, { role: 'user', content: envelope });
      } else {
        prompt.push({ role: 'user', content: envelope });
      }
    }
  }

  const requestPayload = {
    model,
    messages: prompt,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: `${PROOFREAD_SCHEMA_NAME}_repair`,
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: items.length,
              maxItems: items.length,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['id', 'text'],
                additionalProperties: false
              }
            }
          },
          required: ['items'],
          additionalProperties: false
        }
      }
    }
  };
  const startedAt = Date.now();
  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload)
  });

  if (!response.ok) {
    return { parsed: null, rawProofread: rawResponse, parseError: 'format-repair-failed', debug: [] };
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const effectiveContext = buildEffectiveContext(
    {
      text: resolvedShortContextText || '',
      mode: resolvedShortContextText ? 'SHORT' : '',
      baseAnswer: '',
      baseAnswerIncluded: false
    },
    normalizedRequestMeta
  );
  const debugPayload = attachRequestMeta(
    {
      phase: 'PROOFREAD_FORMAT_REPAIR',
      model,
      latencyMs,
      usage,
      inputChars: rawResponse?.length || 0,
      outputChars: content?.length || 0,
      request: requestPayload,
      response: content,
      parseIssues: []
    },
    normalizedRequestMeta,
    effectiveContext
  );

  let parsed = null;
  let parseError = null;
  try {
    parsed = parseJsonObjectFlexible(content, 'proofread-format-repair');
  } catch (error) {
    parseError = error?.message || 'parse-error';
    debugPayload.parseIssues.push(parseError);
  }

  return {
    parsed,
    rawProofread: [rawResponse, content].filter(Boolean).join('\n\n---\n\n'),
    parseError,
    debug: [debugPayload]
  };
}

async function repairProofreadSegments(
  items,
  translations,
  originalById,
  apiKey,
  model,
  apiBaseUrl,
  language,
  debugPayloads,
  requestMeta
) {
  const repairItems = [];
  const repairIndices = [];
  translations.forEach((text, index) => {
    const item = items[index];
    const original = originalById.get(String(item?.id)) || '';
    if (needsLanguageRepair(original, text, language)) {
      repairItems.push({ id: String(item.id), source: original, draft: text });
      repairIndices.push(index);
    }
  });

  if (!repairItems.length) {
    return translations;
  }

  if (Array.isArray(debugPayloads)) {
    const last = debugPayloads[debugPayloads.length - 1];
    if (last) {
      if (!Array.isArray(last.parseIssues)) {
        last.parseIssues = [];
      }
      last.parseIssues.push('fallback:language-repair');
    } else {
      const validateRequestMeta = normalizeRequestMeta(requestMeta, { stage: 'proofread', purpose: 'validate' });
      debugPayloads.push(
        attachRequestMeta(
          {
            phase: 'PROOFREAD',
            model,
            latencyMs: null,
            usage: null,
            inputChars: null,
            outputChars: null,
            request: null,
            response: null,
            parseIssues: ['fallback:language-repair']
          },
          validateRequestMeta,
          buildEffectiveContext(
            { text: '', mode: '', baseAnswer: '', baseAnswerIncluded: false },
            validateRequestMeta
          )
        )
      );
    }
  }

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: [
        'You are a translation proofreader.',
        'Fix the draft so the result is fully in the target language, without any source-language fragments.',
        'Do not change meaning. Preserve placeholders, markup, code, numbers, units, and punctuation tokens.',
        PUNCTUATION_TOKEN_HINT,
        'Return only JSON.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        language ? `Target language: ${language}` : '',
        'Return JSON with an "items" array of {id, text}.',
        'Use the same ids as input and keep the order.',
        'Items (JSON array of {id, source, draft}):',
        JSON.stringify(repairItems)
      ]
        .filter(Boolean)
        .join('\n')
    }
  ], apiBaseUrl);

  const requestPayload = {
    model,
    messages: prompt,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: `${PROOFREAD_SCHEMA_NAME}_language_repair`,
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              minItems: repairItems.length,
              maxItems: repairItems.length,
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' }
                },
                required: ['id', 'text'],
                additionalProperties: false
              }
            }
          },
          required: ['items'],
          additionalProperties: false
        }
      }
    }
  };
  const startedAt = Date.now();
  try {
    const response = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestPayload)
    });
    if (!response.ok) {
      return translations;
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';
    const latencyMs = Date.now() - startedAt;
    const usage = normalizeUsage(data?.usage);
    const repairRequestMeta = createChildRequestMeta(requestMeta || {}, {
      purpose: 'validate',
      attempt: Number.isFinite(requestMeta?.attempt) ? requestMeta.attempt + 1 : 1,
      triggerSource: 'validate'
    });
    const debugPayload = attachRequestMeta(
      {
        phase: 'PROOFREAD_REPAIR',
        model,
        latencyMs,
        usage,
        inputChars: repairItems.reduce((sum, item) => sum + (item?.draft?.length || 0), 0),
        outputChars: content?.length || 0,
        request: requestPayload,
        response: content,
        parseIssues: ['fallback:language-repair']
      },
      repairRequestMeta,
      buildEffectiveContext(
        { text: '', mode: '', baseAnswer: '', baseAnswerIncluded: false },
        repairRequestMeta
      )
    );
    if (Array.isArray(debugPayloads)) {
      debugPayloads.push(debugPayload);
    }
    const parsed = parseJsonObjectFlexible(content, 'proofread-repair');
    const normalizedItems = normalizeProofreadItems(parsed?.items);
    const itemsById = new Map();
    normalizedItems.forEach((item) => {
      itemsById.set(item.id, item.text);
    });
    repairIndices.forEach((index) => {
      const id = String(items[index]?.id);
      const candidate = itemsById.get(id);
      if (typeof candidate === 'string' && candidate.trim()) {
        translations[index] = candidate;
      }
    });
  } catch (error) {
    console.warn('Proofread language repair failed; keeping original revisions.', error);
  }

  return translations;
}
