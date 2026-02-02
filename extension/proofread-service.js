const PROOFREAD_SCHEMA_NAME = 'proofread_translations';
const PROOFREAD_MAX_CHARS_PER_CHUNK = 4000;
const PROOFREAD_MAX_ITEMS_PER_CHUNK = 30;
const PROOFREAD_MISSING_RATIO_THRESHOLD = 0.2;
const PROOFREAD_MAX_OUTPUT_TOKENS = 4096;
const PROOFREAD_SYSTEM_PROMPT = [
  'Neuro-Translate Proofread System Prompt v1.',
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
  'If a segment does not need edits, return the original text unchanged.',
  'Return only JSON, without commentary.'
].join(' ');

function shouldLogJson() {
  return typeof globalThis.ntJsonLogEnabled === 'function' && globalThis.ntJsonLogEnabled();
}

function emitJsonLog(eventObject) {
  if (!shouldLogJson()) return;
  if (typeof globalThis.ntJsonLog === 'function') {
    globalThis.ntJsonLog(eventObject);
  }
}

function emitProofreadLog(kind, level, message, data) {
  if (!shouldLogJson()) return;
  if (typeof globalThis.ntJsonLog === 'function') {
    const event = {
      kind,
      level,
      message,
      ts: Date.now()
    };
    if (data !== undefined) {
      event.data = data;
    }
    globalThis.ntJsonLog(JSON.stringify(event));
  }
}

function maskApiKey(apiKey) {
  if (!apiKey) return '';
  const text = String(apiKey);
  const tail = text.slice(-4);
  return `****${tail}`;
}

function logLlmFetchRequest({ ts, role, requestId, url, method, headers, body, model, temperature, responseFormat }) {
  const event = {
    kind: 'llm.fetch.request',
    ts,
    role,
    requestId,
    url,
    method,
    headers,
    body,
    model
  };
  if (temperature != null) {
    event.temperature = temperature;
  }
  if (responseFormat != null) {
    event.response_format = responseFormat;
  }
  emitJsonLog(event);
}

function logLlmFetchResponse({ ts, requestId, status, ok, responseHeaders, responseText, durationMs }) {
  emitJsonLog({
    kind: 'llm.fetch.response',
    ts,
    requestId,
    status,
    ok,
    responseHeaders,
    responseText,
    durationMs
  });
}

function logLlmRawResponse({ ts, stage, requestId, status, ok, responseText }) {
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch (error) {
    responseJson = null;
  }
  const resolvedRequestId = requestId || createRequestId();
  const event = {
    kind: 'llm.raw_response',
    ts: ts || Date.now(),
    stage,
    requestId: resolvedRequestId,
    http: {
      status,
      ok
    }
  };
  if (responseJson !== null) {
    event.response_json = responseJson;
  } else {
    event.response_text = responseText;
  }
  emitJsonLog(event);
}

function logLlmFetchError({ ts, requestId, error }) {
  emitJsonLog({
    kind: 'llm.fetch.error',
    ts,
    requestId,
    error: error && typeof error === 'object'
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: 'Error', message: String(error ?? ''), stack: '' }
  });
}

function logLlmParseExtract({ requestId, extractedText, source }) {
  emitJsonLog({
    kind: 'llm.parse.extract',
    requestId,
    extractedTextLength: extractedText?.length || 0,
    extractedText: extractedText || '',
    source: source || 'empty'
  });
}

function logLlmParseOk({ requestId, parsed, ts }) {
  emitJsonLog({
    kind: 'llm.parse.ok',
    requestId,
    parsed,
    ts
  });
}

function logLlmParseFail({ requestId, error, rawText, ts }) {
  emitJsonLog({
    kind: 'llm.parse.fail',
    requestId,
    error: error && typeof error === 'object'
      ? { name: error.name, message: error.message, stack: error.stack }
      : error,
    rawText,
    ts
  });
}

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
    ...merged,
    requestId: merged.requestId || createRequestId(),
    parentRequestId: merged.parentRequestId || '',
    blockKey: merged.blockKey || '',
    url: merged.url || '',
    contextCacheKey: merged.contextCacheKey || '',
    stage: merged.stage || '',
    purpose: merged.purpose || 'main',
    attempt: Number.isFinite(merged.attempt) ? merged.attempt : 0,
    triggerSource: merged.triggerSource || '',
    forceFullContextOnRetry: Boolean(merged.forceFullContextOnRetry),
    candidateStrategy: merged.candidateStrategy || '',
    candidateOrderedList: Array.isArray(merged.candidateOrderedList) ? merged.candidateOrderedList : [],
    originalRequestedModelList:
      Array.isArray(merged.originalRequestedModelList) ? merged.originalRequestedModelList : [],
    selectedModel: merged.selectedModel || '',
    selectedTier: merged.selectedTier || '',
    selectedModelSpec: merged.selectedModelSpec || '',
    attemptIndex: Number.isFinite(merged.attemptIndex) ? merged.attemptIndex : 0,
    fallbackReason: merged.fallbackReason || ''
  };
}

function resolveProofreadCandidateSelection(requestMeta, fallbackModelSpec, overrides = {}) {
  const purpose = overrides.purpose || requestMeta?.purpose || '';
  const triggerSource = overrides.triggerSource || requestMeta?.triggerSource || '';
  const normalizedTrigger = typeof triggerSource === 'string' ? triggerSource.toLowerCase() : '';
  let effectivePurpose = typeof purpose === 'string' ? purpose : '';
  if (normalizedTrigger.includes('validate')) {
    effectivePurpose = 'validate';
  } else if (normalizedTrigger.includes('retry')) {
    effectivePurpose = 'retry';
  } else if (!effectivePurpose) {
    effectivePurpose = 'main';
  }
  const isManualTrigger =
    (Boolean(requestMeta?.isManual) ||
      normalizedTrigger.includes('manual') ||
      effectivePurpose === 'manual') &&
    !normalizedTrigger.includes('retry') &&
    !normalizedTrigger.includes('validate');
  let candidateStrategy = 'default_preserve_order';
  if (effectivePurpose === 'retry') {
    candidateStrategy = 'retry_cheapest';
  } else if (effectivePurpose === 'validate') {
    candidateStrategy = 'validate_cheapest';
  } else if (isManualTrigger) {
    candidateStrategy = 'manual_smartest';
  }

  let originalRequestedModelList = Array.isArray(requestMeta?.originalRequestedModelList)
    ? requestMeta.originalRequestedModelList
    : [];
  if (!originalRequestedModelList.length && fallbackModelSpec) {
    originalRequestedModelList = [fallbackModelSpec];
  }
  const parsedEntries = originalRequestedModelList.map((spec, index) => {
    const parsed = parseModelSpec(spec);
    const tierPref = parsed.tier === 'flex' ? 1 : 0;
    const capabilityRank = getModelCapabilityRank(parsed.id);
    const costSum = getModelEntry(parsed.id, parsed.tier)?.sum_1M ?? Infinity;
    return {
      spec,
      index,
      parsed,
      tierPref,
      capabilityRank,
      costSum
    };
  });
  const compareManual = (left, right) => {
    if (left.capabilityRank !== right.capabilityRank) {
      return right.capabilityRank - left.capabilityRank;
    }
    if (left.tierPref !== right.tierPref) {
      return right.tierPref - left.tierPref;
    }
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return 0;
  };
  const compareCheapest = (left, right) => {
    if (left.costSum !== right.costSum) {
      return left.costSum - right.costSum;
    }
    if (left.capabilityRank !== right.capabilityRank) {
      return right.capabilityRank - left.capabilityRank;
    }
    if (left.tierPref !== right.tierPref) {
      return right.tierPref - left.tierPref;
    }
    if (left.index !== right.index) {
      return left.index - right.index;
    }
    return 0;
  };
  const orderedEntries = [...parsedEntries];
  if (candidateStrategy === 'manual_smartest') {
    orderedEntries.sort(compareManual);
  } else if (candidateStrategy === 'retry_cheapest' || candidateStrategy === 'validate_cheapest') {
    orderedEntries.sort(compareCheapest);
  }
  const orderedList = orderedEntries.map((entry) => entry.spec);
  const selectedModelSpec = orderedList[0] || '';
  return { candidateStrategy, orderedList, originalRequestedModelList, selectedModelSpec };
}

function buildRequestOptionsForTier(requestOptions, tier) {
  const normalizedTier = tier === 'flex' ? 'flex' : 'standard';
  return {
    ...(requestOptions && typeof requestOptions === 'object' ? requestOptions : {}),
    tier: normalizedTier,
    serviceTier: normalizedTier === 'flex' ? 'flex' : null
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

function trimToShortContext(text, limit = 800) {
  const normalized = typeof text === 'string' ? text.trim() : String(text ?? '').trim();
  if (!normalized) return '';
  return normalized;
}

function formatManualOutputs(payloads) {
  if (!Array.isArray(payloads) || !payloads.length) return '';
  const manualPayloads = payloads.filter((payload) => payload?.triggerSource === 'manual');
  if (!manualPayloads.length) return '';
  return manualPayloads
    .map((payload, index) => {
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
    })
    .join('\n\n');
}

function buildRetryValidateEnvelope(shortText, manualOutputsText) {
  return [
    '-----BEGIN RETRY/VALIDATE CONTEXT ENVELOPE-----',
    '[USAGE RULES]',
    '- SHORT CONTEXT is minimal global context; use it only for terminology, disambiguation, style/tone consistency.',
    '- PREVIOUS MANUAL ATTEMPTS are hints only: keep good fixes, but correct any mistakes or rule violations.',
    '- Do NOT copy the envelope, context, source block, or translated block into the output.',
    '- Preserve placeholders, markup/code, numbers/units, URLs, and punctuation tokens exactly.',
    '- Output MUST be valid JSON that matches the required schema exactly.',
    '- Keep ids unchanged. Do not add/remove/reorder items.',
    '[SHORT CONTEXT (GLOBAL)]',
    shortText,
    '[PREVIOUS MANUAL ATTEMPTS (OUTPUTS ONLY; NO FULL CONTEXT)]',
    manualOutputsText,
    '-----END RETRY/VALIDATE CONTEXT ENVELOPE-----'
  ].join('\n');
}

async function resolveRetryValidateBundle({ requestMeta, debugPayloadsOptional, normalizedContext, effectiveContext }) {
  let shortText = '';
  let shortSource = '';
  let manualOutputsText = '';
  let matchedEntry = null;
  let matchedState = null;
  let matchedUpdatedAt = -1;

  if (effectiveContext?.mode === 'SHORT' && effectiveContext.text) {
    shortText = trimToShortContext(effectiveContext.text);
    shortSource = 'effective-context';
  }

  if (!shortText && normalizedContext) {
    const candidate = normalizedContext.shortText || (normalizedContext.mode === 'SHORT' ? normalizedContext.text : '') || '';
    shortText = trimToShortContext(candidate);
    if (shortText) {
      shortSource = 'normalized-context';
    }
  }

  manualOutputsText = formatManualOutputs(debugPayloadsOptional);

  if (!shortText || !manualOutputsText) {
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
        if (requestMeta?.parentRequestId) {
          entry = items.find((item) => {
            const list = Array.isArray(item?.proofreadDebug) ? item.proofreadDebug : [];
            return list.some((payload) => payload?.requestId === requestMeta.parentRequestId);
          });
        }
        if (!entry && requestMeta?.blockKey) {
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
      matchedEntry = null;
      matchedState = null;
    }
  }

  if (!shortText && matchedState) {
    if (matchedState?.contextShortRefId && typeof getDebugRaw === 'function') {
      try {
        const rawRecord = await getDebugRaw(matchedState.contextShortRefId);
        shortText = trimToShortContext(rawRecord?.value?.text || rawRecord?.value?.response || '');
      } catch (error) {
        shortText = '';
      }
    }
    if (!shortText) {
      shortText =
        trimToShortContext(typeof matchedState?.contextShort === 'string' ? matchedState.contextShort : '') || '';
    }
    if (shortText) {
      shortSource = 'debug-scan';
    }
  }

  if (!manualOutputsText && matchedEntry) {
    const debugList = Array.isArray(matchedEntry.proofreadDebug) ? matchedEntry.proofreadDebug : [];
    manualOutputsText = formatManualOutputs(debugList);
  }

  if (!shortText && normalizedContext) {
    const fallbackSource = normalizedContext.text || normalizedContext.fullText || '';
    shortText = trimToShortContext(fallbackSource);
    if (shortText) {
      shortSource = 'fallback-context';
    }
  }

  if (!manualOutputsText) {
    manualOutputsText = '(no manual outputs found)';
  }

  return { shortText, manualOutputsText, shortSource };
}

function buildEffectiveContext(contextPayload, requestMeta) {
  const normalized = normalizeContextPayload(contextPayload);
  let mode = resolveEffectiveContextMode(requestMeta, normalized);
  let text = '';
  if (mode === 'FULL') {
    text = normalized.fullText || (normalized.mode === 'FULL' ? normalized.text : '') || normalized.text || '';
  } else if (mode === 'SHORT') {
    const candidate = normalized.shortText || (normalized.mode === 'SHORT' ? normalized.text : '') || '';
    text = trimToShortContext(candidate);
    if (!text) {
      const fallbackSource = normalized.text || normalized.fullText || '';
      text = trimToShortContext(fallbackSource);
    }
    if (!text) {
      mode = 'NONE';
    }
  }
  const baseAnswer = normalized.baseAnswer || '';
  const baseAnswerIncluded = Boolean(normalized.baseAnswerIncluded);
  const contextMissing = (mode === 'FULL' || mode === 'SHORT') && !text;
  if (contextMissing) {
    emitProofreadLog(
      'proofread.context_missing',
      'warn',
      'Context mode requires text but none was provided.',
      {
        mode,
        triggerSource: requestMeta?.triggerSource,
        purpose: requestMeta?.purpose
      }
    );
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
  let shortText = trimToShortContext(normalized.shortText || (normalized.mode === 'SHORT' ? normalized.text : '') || '');
  if (!shortText) {
    shortText = trimToShortContext(normalized.text || normalized.fullText || '');
  }
  return {
    text: shortText,
    mode: 'SHORT',
    baseAnswer: normalized.baseAnswer || '',
    baseAnswerIncluded: Boolean(normalized.baseAnswerIncluded),
    fullText: '',
    shortText
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
    purpose: requestMeta.purpose || payload.purpose || '',
    attempt: Number.isFinite(payload.attempt) ? payload.attempt : requestMeta.attempt,
    triggerSource: requestMeta.triggerSource || payload.triggerSource || '',
    selectedModel: requestMeta.selectedModel || payload.selectedModel || payload.model || '',
    selectedTier: requestMeta.selectedTier || payload.selectedTier || '',
    selectedModelSpec: requestMeta.selectedModelSpec || payload.selectedModelSpec || '',
    attemptIndex:
      Number.isFinite(payload.attemptIndex) || payload.attemptIndex === 0
        ? payload.attemptIndex
        : requestMeta.attemptIndex,
    fallbackReason: payload.fallbackReason || requestMeta.fallbackReason || '',
    originalRequestedModelList:
      Array.isArray(requestMeta.originalRequestedModelList)
        ? requestMeta.originalRequestedModelList
        : Array.isArray(payload.originalRequestedModelList)
          ? payload.originalRequestedModelList
          : [],
    candidateStrategy: requestMeta.candidateStrategy || payload.candidateStrategy || '',
    candidateOrderedList:
      Array.isArray(requestMeta.candidateOrderedList)
        ? requestMeta.candidateOrderedList
        : Array.isArray(payload.candidateOrderedList)
          ? payload.candidateOrderedList
          : [],
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

  const cachePrefix = [
    'NEURO-TRANSLATE CACHE PREFIX v1 (proofread).',
    'This block is static and identical across proofread requests.',
    'Purpose: stabilize the cached prefix; it does not add new requirements.',
    'Follow the system prompt rules exactly; if a line here conflicts, the system prompt wins.',
    'Output must be strictly JSON with an "items" array; no prose, no markdown.',
    'Never invent facts; never add commentary; never quote the prompt.',
    'Preserve placeholders, markup, code, URLs, IDs, numbers/units, and punctuation tokens.',
    'Do not reorder items; keep ids unchanged; keep one output per input item.',
    'If no edits are needed, return the original text unchanged.',
    'Use source block only to verify meaning; never translate it.',
    'Use translated block for consistency; do not copy it verbatim unless unchanged.',
    'Do not insert context text into outputs.',
    'Never drop or merge items.',
    'Do not output extra keys or metadata.',
    'Return valid JSON only.',
    'Repeat: only JSON, only items array.',
    'Repeat: keep ids unchanged.',
    'Repeat: preserve placeholders/tokens.',
    'Repeat: keep the exact number of items.',
    'Repeat: do not add commentary.',
    'Repeat: no markdown fences.',
    'Repeat: no extra keys.',
    'Repeat: keep output order identical.',
    'Repeat: preserve meaning exactly.',
    'Repeat: do not invent content.',
    'Repeat: avoid paraphrase beyond requested mode.',
    'Repeat: keep punctuation tokens intact.',
    'Repeat: output must be valid JSON.',
    'Repeat: do not quote prompt text.',
    'Repeat: follow system rules.',
    'Repeat: ids must be strings.',
    'Repeat: every item must have {id,text}.',
    '',
    'STABLE EDITING GUIDE (static; do not emit in output):',
    '1. Preserve the original meaning exactly.',
    '2. Fix obvious grammar and punctuation errors.',
    '3. Keep terminology consistent with the translated block.',
    '4. Keep capitalization and casing appropriate for the language.',
    '5. Do not expand abbreviations unless clearly needed.',
    '6. Do not add or remove honorifics.',
    '7. Keep the same segment boundaries.',
    '8. Preserve UI labels and button text.',
    '9. Preserve quotations and quotation marks.',
    '10. Do not introduce new entities or facts.',
    '11. Preserve numerical formatting.',
    '12. Keep dates/times unchanged.',
    '13. Keep line breaks unless clearly erroneous.',
    '14. Avoid stylistic changes in NOISE_CLEANUP.',
    '15. In READABILITY_REWRITE, improve flow without changing meaning.',
    '16. Do not invent missing information.',
    '17. Keep placeholders and tokens unchanged.',
    '18. Avoid swapping word order across items.',
    '19. Keep tone consistent within the block.',
    '20. Do not translate source block content.',
    '21. Do not copy context text into outputs.',
    '22. Keep punctuation tokens exactly.',
    '23. Avoid adding emphasis or emojis.',
    '24. Avoid converting formal to informal or vice versa.',
    '25. Keep sentence mood (question/statement).'
  ].join('\n');

  const messages = [
    {
      role: 'system',
      content: PROOFREAD_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: cachePrefix
    },
    {
      role: 'user',
      content: [
        'Proofread instructions:',
        'Follow the system prompt rules exactly.',
        'Respond with JSON only; no commentary.',
        'Context and payload details follow in later messages.'
      ].join('\n')
    }
  ];

  messages.push({
    role: 'user',
    content: [
      `Context (${contextMode}):`,
      contextText ? `<<<CONTEXT_START>>>${contextText}<<<CONTEXT_END>>>` : '<EMPTY>'
    ].join('\n')
  });

  messages.push({
    role: 'assistant',
    content: baseAnswerText || 'PREVIOUS BASE ANSWER (FULL): <EMPTY>'
  });

  messages.push({
    role: 'user',
    content: [
      `PROOFREAD_MODE: ${proofreadMode}.`,
      language ? `Target language: ${language}` : '',
      strict ? 'Strict mode: return every input id exactly once in the output items array.' : '',
      extraReminder,
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

function estimatePromptTokensFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  const totalChars = messages.reduce((sum, message) => {
    if (!message) return sum;
    const content = message.content;
    if (typeof content === 'string') {
      return sum + content.length;
    }
    if (Array.isArray(content)) {
      return sum + content.reduce((innerSum, part) => innerSum + String(part ?? '').length, 0);
    }
    return sum + String(content ?? '').length;
  }, 0);
  return Math.max(1, Math.ceil(totalChars / 4));
}

function extractAssistantTextFromChatCompletion(responseBody, meta = {}) {
  const message = responseBody?.choices?.[0]?.message || {};
  const content = message?.content;
  const safeMeta = meta && typeof meta === 'object' ? meta : {};
  const setSource = (source) => {
    safeMeta.assistant_content_source = source;
  };
  const stringifyValue = (value) => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch (error) {
      return String(value);
    }
  };
  if (typeof content === 'string' && content) {
    setSource('content_string');
    return content;
  }
  if (Array.isArray(content) && content.length) {
    setSource('content_parts');
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return String(part.text ?? '');
        return String(part ?? '');
      })
      .join('');
  }
  if (content != null && typeof content !== 'string' && !Array.isArray(content)) {
    setSource('content_string');
    return stringifyValue(content);
  }
  const toolArguments = message?.tool_calls?.[0]?.function?.arguments;
  if (toolArguments != null) {
    setSource('tool_calls');
    return stringifyValue(toolArguments);
  }
  const functionArguments = message?.function_call?.arguments;
  if (functionArguments != null) {
    setSource('function_call');
    return stringifyValue(functionArguments);
  }
  setSource('empty');
  return '';
}

function estimatePromptTokensFromChars(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.max(1, Math.ceil(chars / 4));
}

function getPromptCacheRateLimiterState() {
  if (!globalThis.__NT_PROMPT_CACHE_RATE_LIMITER__) {
    globalThis.__NT_PROMPT_CACHE_RATE_LIMITER__ = { entriesByKey: new Map() };
  }
  return globalThis.__NT_PROMPT_CACHE_RATE_LIMITER__;
}

function buildPromptCacheRateKey(cacheKey, url) {
  const safeKey = cacheKey || 'proofread';
  const safeUrl = url || '';
  return `${safeKey}::${safeUrl}`;
}

async function enforcePromptCacheRateLimit(cacheKey, url, options = {}) {
  const limitPerMinute = Number.isFinite(options.limitPerMinute) ? options.limitPerMinute : 12;
  if (!limitPerMinute) return;
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : 60000;
  const limiter = getPromptCacheRateLimiterState();
  const key = buildPromptCacheRateKey(cacheKey, url);
  if (!limiter.entriesByKey.has(key)) {
    limiter.entriesByKey.set(key, []);
  }
  const entries = limiter.entriesByKey.get(key);
  const prune = (now) => {
    while (entries.length && entries[0] <= now - windowMs) {
      entries.shift();
    }
  };
  while (true) {
    const now = Date.now();
    prune(now);
    if (entries.length < limitPerMinute) {
      entries.push(now);
      return;
    }
    const earliest = entries[0];
    const waitMs = Math.max(50, earliest + windowMs - now + 25);
    await sleep(waitMs);
  }
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
  requestMeta = null,
  requestOptions = null
) {
  if (!Array.isArray(segments) || !segments.length) {
    return { translations: [], rawProofread: '' };
  }

  const baseRequestMeta = normalizeRequestMeta(requestMeta, { stage: 'proofread', purpose: 'main' });
  const baseModelSpec = formatModelSpec(model, baseRequestMeta.selectedTier || 'standard');
  const resolveModelSelection = (purpose, triggerSource) => {
    const selection = resolveProofreadCandidateSelection(baseRequestMeta, baseModelSpec, {
      purpose,
      triggerSource
    });
    const fallbackSpec = selection.selectedModelSpec || baseModelSpec;
    const parsed = parseModelSpec(fallbackSpec);
    return {
      ...selection,
      modelId: parsed.id || model,
      tier: parsed.tier || baseRequestMeta.selectedTier || 'standard',
      selectedModelSpec: fallbackSpec
    };
  };
  const mainSelection = resolveModelSelection('main', baseRequestMeta.triggerSource || 'auto');
  baseRequestMeta.selectedModel = mainSelection.modelId;
  baseRequestMeta.selectedTier = mainSelection.tier;
  baseRequestMeta.selectedModelSpec = mainSelection.selectedModelSpec;
  baseRequestMeta.candidateStrategy = mainSelection.candidateStrategy;
  baseRequestMeta.candidateOrderedList = mainSelection.orderedList;
  if (!baseRequestMeta.originalRequestedModelList?.length) {
    baseRequestMeta.originalRequestedModelList = mainSelection.originalRequestedModelList;
  }
  const retrySelection = resolveModelSelection('retry', 'retry');
  const validateSelection = resolveModelSelection('validate', 'validate');
  const { items, originalById } = normalizeProofreadSegments(segments);
  const normalizedContext = normalizeContextPayload(context);
  const baseContextChars =
    (normalizedContext?.text?.length || 0) +
    (normalizedContext?.baseAnswer?.length || 0) +
    (sourceBlock?.length || 0) +
    (translatedBlock?.length || 0);
  const basePromptTokens = estimatePromptTokensFromChars(baseContextChars + PROOFREAD_SYSTEM_PROMPT.length);
  const maxPromptTokens = basePromptTokens + estimatePromptTokensFromChars(PROOFREAD_MAX_CHARS_PER_CHUNK);
  const chunks = chunkProofreadItems(items, {
    basePromptTokens,
    maxPromptTokens,
    targetPromptTokens: 1200
  });
  const revisionsById = new Map();
  const rawProofreadParts = [];
  const debugPayloads = [];
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
          model: mainSelection.modelId,
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
      mainSelection.modelId,
      apiBaseUrl,
      {
        strict: false,
        requestMeta: baseRequestMeta,
        purpose: 'main',
        debugPayloads,
        requestOptions: buildRequestOptionsForTier(requestOptions, mainSelection.tier)
      }
    );
    rawProofreadParts.push(result.rawProofread);
    if (Array.isArray(result.debug)) {
      debugPayloads.push(...result.debug);
    }
    let quality = evaluateProofreadResult(chunk, result.itemsById, result.parseError);
    logProofreadChunk('proofread', index, chunks.length, chunk.length, quality, result.parseError);
    if (quality.isPoor) {
      emitProofreadLog(
        'proofread.chunk_incomplete',
        'warn',
        'Proofread chunk incomplete, retrying with strict instructions.',
        {
          chunkIndex: index + 1,
          missing: quality.missingCount,
          received: quality.receivedCount
        }
      );
      appendParseIssue('retry:retryable');
      result = await requestProofreadChunk(
        chunk,
        { sourceBlock, translatedBlock, context: retryContextPayload, language, proofreadMode },
        apiKey,
        retrySelection.modelId,
        apiBaseUrl,
        {
          strict: true,
          requestMeta: createChildRequestMeta(baseRequestMeta, {
            purpose: 'retry',
            attempt: baseRequestMeta.attempt + 1,
            triggerSource: 'retry',
            selectedModel: retrySelection.modelId,
            selectedTier: retrySelection.tier,
            selectedModelSpec: retrySelection.selectedModelSpec,
            candidateStrategy: retrySelection.candidateStrategy,
            candidateOrderedList: retrySelection.orderedList,
            originalRequestedModelList: retrySelection.originalRequestedModelList
          }),
          purpose: 'retry',
          debugPayloads,
          requestOptions: buildRequestOptionsForTier(requestOptions, retrySelection.tier)
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
      emitProofreadLog(
        'proofread.chunk_incomplete_retry_max_tokens',
        'info',
        'Proofread chunk still incomplete after strict retry, retrying with higher max tokens.',
        {
          chunkIndex: index + 1,
          missing: quality.missingCount,
          received: quality.receivedCount,
          threshold: PROOFREAD_MISSING_RATIO_THRESHOLD
        }
      );
      appendParseIssue('retry:retryable');
      result = await requestProofreadChunk(
        chunk,
        { sourceBlock, translatedBlock, context: retryContextPayload, language, proofreadMode },
        apiKey,
        retrySelection.modelId,
        apiBaseUrl,
        {
          strict: true,
          maxTokensOverride: 1.5,
          extraReminder: 'Return every input id exactly once. Do not omit any ids.',
          requestMeta: createChildRequestMeta(baseRequestMeta, {
            purpose: 'retry',
            attempt: baseRequestMeta.attempt + 2,
            triggerSource: 'retry',
            selectedModel: retrySelection.modelId,
            selectedTier: retrySelection.tier,
            selectedModelSpec: retrySelection.selectedModelSpec,
            candidateStrategy: retrySelection.candidateStrategy,
            candidateOrderedList: retrySelection.orderedList,
            originalRequestedModelList: retrySelection.originalRequestedModelList
          }),
          purpose: 'retry',
          debugPayloads,
          requestOptions: buildRequestOptionsForTier(requestOptions, retrySelection.tier)
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
      emitProofreadLog(
        'proofread.chunk_incomplete_fallback_per_item',
        'warn',
        'Proofread chunk still incomplete, falling back to per-item requests.',
        {
          chunkIndex: index + 1,
          missing: quality.missingCount,
          received: quality.receivedCount,
          threshold: PROOFREAD_MISSING_RATIO_THRESHOLD
        }
      );
      appendParseIssue('fallback:per-item');
      for (const item of chunk) {
        const singleResult = await requestProofreadChunk(
          [item],
          { sourceBlock, translatedBlock, context: retryContextPayload, language, proofreadMode },
          apiKey,
          retrySelection.modelId,
          apiBaseUrl,
          {
            strict: true,
            requestMeta: createChildRequestMeta(baseRequestMeta, {
              purpose: 'retry',
              attempt: baseRequestMeta.attempt + 3,
              triggerSource: 'retry',
              selectedModel: retrySelection.modelId,
              selectedTier: retrySelection.tier,
              selectedModelSpec: retrySelection.selectedModelSpec,
              candidateStrategy: retrySelection.candidateStrategy,
              candidateOrderedList: retrySelection.orderedList,
              originalRequestedModelList: retrySelection.originalRequestedModelList
            }),
            purpose: 'retry',
            debugPayloads,
            requestOptions: buildRequestOptionsForTier(requestOptions, retrySelection.tier)
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

  const validateRequestMeta = createChildRequestMeta(baseRequestMeta, {
    purpose: 'validate',
    triggerSource: 'validate',
    selectedModel: validateSelection.modelId,
    selectedTier: validateSelection.tier,
    selectedModelSpec: validateSelection.selectedModelSpec,
    candidateStrategy: validateSelection.candidateStrategy,
    candidateOrderedList: validateSelection.orderedList,
    originalRequestedModelList: validateSelection.originalRequestedModelList
  });
  const repairedTranslations = await repairProofreadSegments(
    items,
    translations,
    originalById,
    apiKey,
    validateSelection.modelId,
    apiBaseUrl,
    language,
    debugPayloads,
    validateRequestMeta,
    buildRequestOptionsForTier(requestOptions, validateSelection.tier)
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

function chunkProofreadItems(items, options = {}) {
  const chunks = [];
  let current = [];
  let currentSize = 0;
  const basePromptTokens = Number.isFinite(options.basePromptTokens) ? options.basePromptTokens : 0;
  const maxPromptTokens = Number.isFinite(options.maxPromptTokens) ? options.maxPromptTokens : Infinity;
  const targetPromptTokens = Number.isFinite(options.targetPromptTokens) ? options.targetPromptTokens : 0;
  let currentTokens = basePromptTokens;

  items.forEach((item, index) => {
    const textSize = typeof item.text === 'string' ? item.text.length : 0;
    const estimatedSize = textSize + 30;
    const estimatedTokens = estimatePromptTokensFromChars(estimatedSize);
    const exceedsMax =
      current.length &&
      (current.length >= PROOFREAD_MAX_ITEMS_PER_CHUNK ||
        currentSize + estimatedSize > PROOFREAD_MAX_CHARS_PER_CHUNK ||
        currentTokens + estimatedTokens > maxPromptTokens);
    if (
      exceedsMax
    ) {
      chunks.push(current);
      current = [];
      currentSize = 0;
      currentTokens = basePromptTokens;
    }
    current.push(item);
    currentSize += estimatedSize;
    currentTokens += estimatedTokens;
    const isLast = index === items.length - 1;
    if (!isLast && targetPromptTokens && currentTokens >= targetPromptTokens) {
      chunks.push(current);
      current = [];
      currentSize = 0;
      currentTokens = basePromptTokens;
    }
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
    emitProofreadLog(
      'proofread.chunk_parse_issue',
      'warn',
      `Proofread chunk parse issue (${label}).`,
      { ...summary, error: parseError }
    );
    return;
  }
  emitProofreadLog('proofread.chunk_processed', 'info', `Proofread chunk processed (${label}).`, summary);
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
  return raw;
}

async function requestProofreadChunk(items, metadata, apiKey, model, apiBaseUrl, options = {}) {
  const { strict = false, maxTokensOverride = null, extraReminder = '' } = options;
  const requestOptions = options.requestOptions || null;
  const requestMeta = normalizeRequestMeta(options.requestMeta, {
    stage: 'proofread',
    purpose: options.purpose || 'main'
  });
  const resolvedTier = requestMeta.selectedTier || (requestOptions?.tier === 'flex' ? 'flex' : 'standard');
  if (requestMeta.selectedModelSpec) {
    const parsedSelection = parseModelSpec(requestMeta.selectedModelSpec);
    if (!requestMeta.selectedModel && parsedSelection.id) {
      requestMeta.selectedModel = parsedSelection.id;
    }
    if (!requestMeta.selectedTier && parsedSelection.tier) {
      requestMeta.selectedTier = parsedSelection.tier;
    }
  }
  if (!requestMeta.selectedModel) {
    requestMeta.selectedModel = model;
  }
  if (!requestMeta.selectedTier) {
    requestMeta.selectedTier = resolvedTier;
  }
  if (!requestMeta.selectedModelSpec) {
    requestMeta.selectedModelSpec = formatModelSpec(requestMeta.selectedModel || model, requestMeta.selectedTier);
  }
  if (!requestMeta.candidateStrategy || !requestMeta.candidateOrderedList?.length) {
    const selection = resolveProofreadCandidateSelection(requestMeta, requestMeta.selectedModelSpec, {
      purpose: requestMeta.purpose,
      triggerSource: requestMeta.triggerSource
    });
    requestMeta.candidateStrategy = selection.candidateStrategy;
    requestMeta.candidateOrderedList = selection.orderedList;
    if (!requestMeta.originalRequestedModelList?.length) {
      requestMeta.originalRequestedModelList = selection.originalRequestedModelList;
    }
  }
  const normalizedContext = normalizeContextPayload(metadata?.context);
  let effectiveContext = buildEffectiveContext(normalizedContext, requestMeta);
  const triggerSource = requestMeta?.triggerSource || '';
  let resolvedShortContextText = effectiveContext.text || '';
  let resolvedManualOutputs = '';
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    const bundle = await resolveRetryValidateBundle({
      requestMeta,
      debugPayloadsOptional: options.debugPayloads,
      normalizedContext,
      effectiveContext
    });
    resolvedShortContextText = bundle.shortText || '';
    resolvedManualOutputs = bundle.manualOutputsText || '(no manual outputs found)';
    effectiveContext = buildEffectiveContext(
      {
        text: resolvedShortContextText,
        mode: resolvedShortContextText ? 'SHORT' : '',
        baseAnswer: effectiveContext.baseAnswer,
        baseAnswerIncluded: effectiveContext.baseAnswerIncluded
      },
      requestMeta
    );
  }
  const prompt = applyPromptCaching(
    buildProofreadPrompt(
      {
        items,
        sourceBlock: metadata?.sourceBlock,
        translatedBlock: metadata?.translatedBlock,
        context: {
          text: triggerSource === 'retry' || triggerSource === 'validate' ? '' : effectiveContext.text,
          mode: triggerSource === 'retry' || triggerSource === 'validate' ? '' : effectiveContext.mode,
          baseAnswer: effectiveContext.baseAnswer,
          baseAnswerIncluded: effectiveContext.baseAnswerIncluded
        },
        language: metadata?.language,
        proofreadMode: metadata?.proofreadMode
      },
      strict,
      extraReminder
    ),
    apiBaseUrl,
    requestOptions
  );
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    const manualOutputsText = resolvedManualOutputs || '(no manual outputs found)';
    if (resolvedShortContextText) {
      const envelope = buildRetryValidateEnvelope(resolvedShortContextText, manualOutputsText);
      if (Array.isArray(prompt)) {
        const firstUserIndex = prompt.findIndex((message) => message?.role === 'user');
        if (firstUserIndex >= 0) {
          prompt.splice(firstUserIndex, 0, { role: 'user', content: envelope });
        } else {
          prompt.push({ role: 'user', content: envelope });
        }
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
    max_completion_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: PROOFREAD_SCHEMA_NAME,
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
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
  applyPromptCacheParams(
    requestPayload,
    apiBaseUrl,
    model,
    getPromptCacheKey('proofread'),
    requestOptions
  );
  applyModelRequestParams(requestPayload, model, requestOptions, apiBaseUrl);
  const promptCacheSupport = getPromptCacheSupport(apiBaseUrl, requestOptions);
  const promptCacheKey = requestPayload.prompt_cache_key || '';
  const promptCacheRetention = requestPayload.prompt_cache_retention || '';
  const requestId = requestMeta?.requestId || createRequestId();
  const startedAt = Date.now();
  const estimatedPromptTokens = estimatePromptTokensFromMessages(prompt);
  const batchSize = items.length;
  if (triggerSource !== 'retry' && triggerSource !== 'validate') {
    await enforcePromptCacheRateLimit(getPromptCacheKey('proofread'), requestMeta?.url || '', {
      limitPerMinute: 12
    });
  }
  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  let requestBody = JSON.stringify(requestPayload);
  let response;
  let responseText = '';
  let fetchStartedAt = Date.now();
  logLlmFetchRequest({
    ts: fetchStartedAt,
    role: 'proofread',
    requestId,
    url: apiBaseUrl,
    method: 'POST',
    headers: { ...requestHeaders, Authorization: `Bearer ${maskApiKey(apiKey)}` },
    body: requestBody,
    model: requestPayload.model,
    temperature: requestPayload.temperature,
    responseFormat: requestPayload.response_format
  });
  try {
    response = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody
    });
    responseText = await response.clone().text();
    logLlmRawResponse({
      ts: Date.now(),
      stage: 'proofread',
      requestId,
      status: response.status,
      ok: response.ok,
      responseText
    });
    logLlmFetchResponse({
      ts: Date.now(),
      requestId,
      status: response.status,
      ok: response.ok,
      responseHeaders: Array.from(response.headers.entries()),
      responseText,
      durationMs: Date.now() - fetchStartedAt
    });
  } catch (error) {
    logLlmFetchError({ ts: Date.now(), requestId, error });
    throw error;
  }

  if (!response.ok) {
    let errorText = responseText;
    let errorPayload = null;
    try {
      errorPayload = JSON.parse(errorText);
    } catch (parseError) {
      errorPayload = null;
    }
    const stripped = stripUnsupportedRequestParams(
      requestPayload,
      model,
      response.status,
      errorPayload,
      errorText,
      apiBaseUrl
    );
    if (response.status === 400 && stripped.changed) {
      if (requestMeta && typeof requestMeta === 'object' && stripped.removedParams.length) {
        if (!requestMeta.fallbackReason) {
          requestMeta.fallbackReason = `unsupported_param:${stripped.removedParams.join(',')}`;
        }
        if (stripped.removedParams.includes('service_tier') && requestMeta.selectedTier === 'flex') {
          requestMeta.selectedTier = 'standard';
        }
      }
      if (
        stripped.removedParams.includes('max_tokens->max_completion_tokens') ||
        stripped.removedParams.includes('max_completion_tokens->max_tokens')
      ) {
        emitProofreadLog(
          'proofread.swap_token_limit_param',
          'debug',
          '[proofread] Retrying with swapped token limit parameter.',
          {
            model,
            removedParams: stripped.removedParams
          }
        );
      }
      emitProofreadLog(
        'proofread.unsupported_param_removed',
        'warn',
        'Unsupported param removed; retrying without it.',
        {
          model,
          status: response.status,
          removedParams: stripped.removedParams
        }
      );
      requestBody = JSON.stringify(requestPayload);
      fetchStartedAt = Date.now();
      logLlmFetchRequest({
        ts: fetchStartedAt,
        role: 'proofread',
        requestId,
        url: apiBaseUrl,
        method: 'POST',
        headers: { ...requestHeaders, Authorization: `Bearer ${maskApiKey(apiKey)}` },
        body: requestBody,
        model: requestPayload.model,
        temperature: requestPayload.temperature,
        responseFormat: requestPayload.response_format
      });
      try {
        response = await fetch(apiBaseUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody
        });
        responseText = await response.clone().text();
        logLlmRawResponse({
          ts: Date.now(),
          stage: 'proofread',
          requestId,
          status: response.status,
          ok: response.ok,
          responseText
        });
        logLlmFetchResponse({
          ts: Date.now(),
          requestId,
          status: response.status,
          ok: response.ok,
          responseHeaders: Array.from(response.headers.entries()),
          responseText,
          durationMs: Date.now() - fetchStartedAt
        });
      } catch (error) {
        logLlmFetchError({ ts: Date.now(), requestId, error });
        throw error;
      }
      if (!response.ok) {
        errorText = responseText;
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
      error.errorCode = errorPayload?.error?.code || errorPayload?.code;
      error.errorType = errorPayload?.error?.type || errorPayload?.type;
      error.isUnavailable =
        response.status === 503 ||
        response.status === 502 ||
        response.status === 504 ||
        String(errorMessage || '').toLowerCase().includes('unavailable');
      error.debugPayload = attachRequestMeta(
        {
          phase: 'PROOFREAD',
          model,
          latencyMs: Date.now() - startedAt,
          usage: null,
          inputChars,
          outputChars: 0,
          batchSize,
          estimatedPromptTokens,
          request: requestPayload,
          promptCacheKey,
          promptCacheRetention,
          promptCacheSupport,
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
  const assistantContentMeta = {};
  const extractedContent = extractAssistantTextFromChatCompletion(data, assistantContentMeta);
  logLlmParseExtract({
    requestId,
    extractedText: extractedContent,
    source: assistantContentMeta.assistant_content_source || 'empty'
  });
  const content = extractedContent.trim();
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
        promptCacheKey,
        promptCacheRetention,
        promptCacheSupport,
        response: {
          id: data?.id ?? null,
          status: response.status,
          statusText: response.statusText,
          model: data?.model ?? model,
          emptyContent: true,
          bodyPreview: buildProofreadBodyPreview(data)
        },
        parseIssues: ['no-content', 'api-empty-content'],
        assistant_content_source: assistantContentMeta.assistant_content_source || 'empty'
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
      batchSize,
      estimatedPromptTokens,
      request: requestPayload,
      promptCacheKey,
      promptCacheRetention,
      promptCacheSupport,
      assistant_content_source: assistantContentMeta.assistant_content_source || 'empty',
      response: content,
      parseIssues: []
    },
    requestMeta,
    effectiveContext
  );
  const debugPayloads = [debugPayload];
  const cachedTokens = debugPayload?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const promptTokens = debugPayload?.usage?.prompt_tokens ?? debugPayload?.usage?.input_tokens ?? estimatedPromptTokens;
  const cacheHitRate = promptTokens ? Math.round((cachedTokens / promptTokens) * 100) : 0;
  emitProofreadLog(
    'proofread.prompt_cache_metrics',
    'debug',
    '[proofread] Prompt cache metrics.',
    {
      batch_size: batchSize,
      estimatedPromptTokens,
      cached_tokens: cachedTokens,
      cached_percent: cacheHitRate,
      prompt_cache_key: getPromptCacheKey('proofread'),
      url: requestMeta?.url || ''
    }
  );

  let parsed = null;
  let parseError = null;
  try {
    parsed = parseJsonObjectFlexible(content, 'proofread');
  } catch (error) {
    parseError = error?.message || 'parse-error';
    debugPayload.parseIssues.push(parseError);
  }
  const expectedIds = items.map((item) => String(item.id));
  const expectedIdSet = new Set(expectedIds);
  const normalizedParsedItems = normalizeProofreadItems(parsed?.items);
  const responseIds = normalizedParsedItems.map((item) => item.id);
  const responseIdSet = new Set(responseIds);
  const hasUnknownIds = responseIds.some((id) => !expectedIdSet.has(id));
  const hasMissingIds = expectedIds.some((id) => !responseIdSet.has(id));
  const hasDuplicateIds = responseIdSet.size !== responseIds.length;
  const hasCountMismatch = normalizedParsedItems.length !== expectedIds.length;
  if (!parseError && (hasUnknownIds || hasMissingIds || hasDuplicateIds || hasCountMismatch)) {
    parseError = 'schema-mismatch:items';
    debugPayload.parseIssues.push(parseError);
  }

  if (parseError) {
    logLlmParseFail({ requestId, error: parseError, rawText: content, ts: Date.now() });
  } else {
    logLlmParseOk({ requestId, parsed, ts: Date.now() });
  }

  let rawProofread = content;
  if (parseError) {
    debugPayload.parseIssues.push('fallback:format-repair');
    const fallbackSpec =
      requestMeta?.selectedModelSpec || formatModelSpec(model, requestMeta?.selectedTier || 'standard');
    const validateSelection = resolveProofreadCandidateSelection(requestMeta, fallbackSpec, {
      purpose: 'validate',
      triggerSource: 'validate'
    });
    const validateSpec = validateSelection.selectedModelSpec || fallbackSpec;
    const parsedValidateSpec = parseModelSpec(validateSpec);
    const validateModelId = parsedValidateSpec.id || model;
    const validateTier = parsedValidateSpec.tier || requestMeta?.selectedTier || 'standard';
    const repaired = await requestProofreadFormatRepair(
      content,
      items,
      apiKey,
      validateModelId,
      apiBaseUrl,
      createChildRequestMeta(requestMeta, {
        purpose: 'validate',
        attempt: requestMeta.attempt + 1,
        triggerSource: 'validate',
        selectedModel: validateModelId,
        selectedTier: validateTier,
        selectedModelSpec: validateSpec,
        candidateStrategy: validateSelection.candidateStrategy,
        candidateOrderedList: validateSelection.orderedList,
        originalRequestedModelList: validateSelection.originalRequestedModelList
      }),
      buildRequestOptionsForTier(requestOptions, validateTier)
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

async function requestProofreadFormatRepair(
  rawResponse,
  items,
  apiKey,
  model,
  apiBaseUrl,
  requestMeta = null,
  requestOptions = null
) {
  const normalizedRequestMeta = normalizeRequestMeta(requestMeta, {
    stage: 'proofread',
    purpose: 'validate',
    triggerSource: 'validate'
  });
  const triggerSource = normalizedRequestMeta?.triggerSource || '';
  let resolvedShortContextText = '';
  let resolvedManualOutputs = '';
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    const bundle = await resolveRetryValidateBundle({
      requestMeta: normalizedRequestMeta,
      debugPayloadsOptional: null,
      normalizedContext: normalizeContextPayload(null),
      effectiveContext: null
    });
    resolvedShortContextText = bundle.shortText || '';
    resolvedManualOutputs = bundle.manualOutputsText || '(no manual outputs found)';
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
  ], apiBaseUrl, requestOptions);
  if (triggerSource === 'retry' || triggerSource === 'validate') {
    const manualOutputsText = resolvedManualOutputs || '(no manual outputs found)';
    if (resolvedShortContextText) {
      const envelope = buildRetryValidateEnvelope(resolvedShortContextText, manualOutputsText);
      if (Array.isArray(prompt)) {
        const firstUserIndex = prompt.findIndex((message) => message?.role === 'user');
        if (firstUserIndex >= 0) {
          prompt.splice(firstUserIndex, 0, { role: 'user', content: envelope });
        } else {
          prompt.push({ role: 'user', content: envelope });
        }
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
  applyPromptCacheParams(
    requestPayload,
    apiBaseUrl,
    model,
    getPromptCacheKey('proofread'),
    requestOptions
  );
  applyModelRequestParams(requestPayload, model, requestOptions, apiBaseUrl);
  const requestId = normalizedRequestMeta?.requestId || createRequestId();
  const startedAt = Date.now();
  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  let requestBody = JSON.stringify(requestPayload);
  let response;
  let responseText = '';
  let fetchStartedAt = Date.now();
  logLlmFetchRequest({
    ts: fetchStartedAt,
    role: 'proofread',
    requestId,
    url: apiBaseUrl,
    method: 'POST',
    headers: { ...requestHeaders, Authorization: `Bearer ${maskApiKey(apiKey)}` },
    body: requestBody,
    model: requestPayload.model,
    temperature: requestPayload.temperature,
    responseFormat: requestPayload.response_format
  });
  try {
    response = await fetch(apiBaseUrl, {
      method: 'POST',
      headers: requestHeaders,
      body: requestBody
    });
    responseText = await response.clone().text();
    logLlmRawResponse({
      ts: Date.now(),
      stage: 'proofread',
      requestId,
      status: response.status,
      ok: response.ok,
      responseText
    });
    logLlmFetchResponse({
      ts: Date.now(),
      requestId,
      status: response.status,
      ok: response.ok,
      responseHeaders: Array.from(response.headers.entries()),
      responseText,
      durationMs: Date.now() - fetchStartedAt
    });
  } catch (error) {
    logLlmFetchError({ ts: Date.now(), requestId, error });
    throw error;
  }

  if (!response.ok) {
    let errorText = responseText;
    let errorPayload = null;
    try {
      errorPayload = JSON.parse(errorText);
    } catch (parseError) {
      errorPayload = null;
    }
    const stripped = stripUnsupportedRequestParams(
      requestPayload,
      model,
      response.status,
      errorPayload,
      errorText,
      apiBaseUrl
    );
    if (response.status === 400 && stripped.changed) {
      if (requestMeta && typeof requestMeta === 'object' && stripped.removedParams.length) {
        if (!requestMeta.fallbackReason) {
          requestMeta.fallbackReason = `unsupported_param:${stripped.removedParams.join(',')}`;
        }
        if (stripped.removedParams.includes('service_tier') && requestMeta.selectedTier === 'flex') {
          requestMeta.selectedTier = 'standard';
        }
      }
      if (
        stripped.removedParams.includes('max_tokens->max_completion_tokens') ||
        stripped.removedParams.includes('max_completion_tokens->max_tokens')
      ) {
        emitProofreadLog(
          'proofread.swap_token_limit_param',
          'debug',
          '[proofread] Retrying format repair with swapped token limit parameter.',
          {
            model,
            removedParams: stripped.removedParams,
            stage: 'format_repair'
          }
        );
      }
      emitProofreadLog(
        'proofread.unsupported_param_removed',
        'warn',
        'Unsupported param removed; retrying format repair without it.',
        {
          model,
          status: response.status,
          removedParams: stripped.removedParams,
          stage: 'format_repair'
        }
      );
      requestBody = JSON.stringify(requestPayload);
      fetchStartedAt = Date.now();
      logLlmFetchRequest({
        ts: fetchStartedAt,
        role: 'proofread',
        requestId,
        url: apiBaseUrl,
        method: 'POST',
        headers: { ...requestHeaders, Authorization: `Bearer ${maskApiKey(apiKey)}` },
        body: requestBody,
        model: requestPayload.model,
        temperature: requestPayload.temperature,
        responseFormat: requestPayload.response_format
      });
      try {
        response = await fetch(apiBaseUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: requestBody
        });
        responseText = await response.clone().text();
        logLlmRawResponse({
          ts: Date.now(),
          stage: 'proofread',
          requestId,
          status: response.status,
          ok: response.ok,
          responseText
        });
        logLlmFetchResponse({
          ts: Date.now(),
          requestId,
          status: response.status,
          ok: response.ok,
          responseHeaders: Array.from(response.headers.entries()),
          responseText,
          durationMs: Date.now() - fetchStartedAt
        });
      } catch (error) {
        logLlmFetchError({ ts: Date.now(), requestId, error });
        throw error;
      }
      if (!response.ok) {
        return { parsed: null, rawProofread: rawResponse, parseError: 'format-repair-failed', debug: [] };
      }
    } else {
      return { parsed: null, rawProofread: rawResponse, parseError: 'format-repair-failed', debug: [] };
    }
  }
  const data = await response.json();
  const assistantContentMeta = {};
  const extractedContent = extractAssistantTextFromChatCompletion(data, assistantContentMeta);
  logLlmParseExtract({
    requestId,
    extractedText: extractedContent,
    source: assistantContentMeta.assistant_content_source || 'empty'
  });
  const content = extractedContent.trim();
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
      promptCacheKey,
      promptCacheRetention,
      promptCacheSupport,
      assistant_content_source: assistantContentMeta.assistant_content_source || 'empty',
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
  if (!parseError) {
    const expectedIds = items.map((item) => String(item.id));
    const expectedIdSet = new Set(expectedIds);
    const normalizedParsedItems = normalizeProofreadItems(parsed?.items);
    const responseIds = normalizedParsedItems.map((item) => item.id);
    const responseIdSet = new Set(responseIds);
    const hasUnknownIds = responseIds.some((id) => !expectedIdSet.has(id));
    const hasMissingIds = expectedIds.some((id) => !responseIdSet.has(id));
    const hasDuplicateIds = responseIdSet.size !== responseIds.length;
    const hasCountMismatch = normalizedParsedItems.length !== expectedIds.length;
    if (hasUnknownIds || hasMissingIds || hasDuplicateIds || hasCountMismatch) {
      parseError = 'schema-mismatch:items';
      debugPayload.parseIssues.push(parseError);
    }
  }

  if (parseError) {
    logLlmParseFail({ requestId, error: parseError, rawText: content, ts: Date.now() });
  } else {
    logLlmParseOk({ requestId, parsed, ts: Date.now() });
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
  requestMeta,
  requestOptions = null
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
      const validateRequestMeta = normalizeRequestMeta(requestMeta, {
        stage: 'proofread',
        purpose: 'validate',
        triggerSource: 'validate'
      });
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

  const repairRequestMeta = createChildRequestMeta(requestMeta || {}, {
    purpose: 'validate',
    attempt: Number.isFinite(requestMeta?.attempt) ? requestMeta.attempt + 1 : 1,
    triggerSource: 'validate'
  });
  let resolvedShortContextText = '';
  let resolvedManualOutputs = '';
  if (repairRequestMeta.triggerSource === 'retry' || repairRequestMeta.triggerSource === 'validate') {
    const bundle = await resolveRetryValidateBundle({
      requestMeta: repairRequestMeta,
      debugPayloadsOptional: debugPayloads,
      normalizedContext: normalizeContextPayload(null),
      effectiveContext: null
    });
    resolvedShortContextText = bundle.shortText || '';
    resolvedManualOutputs = bundle.manualOutputsText || '(no manual outputs found)';
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
  ], apiBaseUrl, requestOptions);
  if (repairRequestMeta.triggerSource === 'retry' || repairRequestMeta.triggerSource === 'validate') {
    const manualOutputsText = resolvedManualOutputs || '(no manual outputs found)';
    if (resolvedShortContextText) {
      const envelope = buildRetryValidateEnvelope(resolvedShortContextText, manualOutputsText);
      if (Array.isArray(prompt)) {
        const firstUserIndex = prompt.findIndex((message) => message?.role === 'user');
        if (firstUserIndex >= 0) {
          prompt.splice(firstUserIndex, 0, { role: 'user', content: envelope });
        } else {
          prompt.push({ role: 'user', content: envelope });
        }
      }
    }
  }

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
  applyPromptCacheParams(
    requestPayload,
    apiBaseUrl,
    model,
    getPromptCacheKey('proofread'),
    requestOptions
  );
  applyModelRequestParams(requestPayload, model, requestOptions, apiBaseUrl);
  const requestId = repairRequestMeta?.requestId || createRequestId();
  const startedAt = Date.now();
  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  let requestBody = JSON.stringify(requestPayload);
  try {
    let response;
    let responseText = '';
    let fetchStartedAt = Date.now();
    logLlmFetchRequest({
      ts: fetchStartedAt,
      role: 'proofread',
      requestId,
      url: apiBaseUrl,
      method: 'POST',
      headers: { ...requestHeaders, Authorization: `Bearer ${maskApiKey(apiKey)}` },
      body: requestBody,
      model: requestPayload.model,
      temperature: requestPayload.temperature,
      responseFormat: requestPayload.response_format
    });
    try {
      response = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: requestHeaders,
        body: requestBody
      });
      responseText = await response.clone().text();
      logLlmRawResponse({
        ts: Date.now(),
        stage: 'proofread',
        requestId,
        status: response.status,
        ok: response.ok,
        responseText
      });
      logLlmFetchResponse({
        ts: Date.now(),
        requestId,
        status: response.status,
        ok: response.ok,
        responseHeaders: Array.from(response.headers.entries()),
        responseText,
        durationMs: Date.now() - fetchStartedAt
      });
    } catch (error) {
      logLlmFetchError({ ts: Date.now(), requestId, error });
      throw error;
    }
    if (!response.ok) {
      let errorText = responseText;
      let errorPayload = null;
      try {
        errorPayload = JSON.parse(errorText);
      } catch (parseError) {
        errorPayload = null;
      }
      const stripped = stripUnsupportedRequestParams(
        requestPayload,
        model,
        response.status,
        errorPayload,
        errorText,
        apiBaseUrl
      );
      if (response.status === 400 && stripped.changed) {
        if (requestMeta && typeof requestMeta === 'object' && stripped.removedParams.length) {
          if (!requestMeta.fallbackReason) {
            requestMeta.fallbackReason = `unsupported_param:${stripped.removedParams.join(',')}`;
          }
          if (stripped.removedParams.includes('service_tier') && requestMeta.selectedTier === 'flex') {
            requestMeta.selectedTier = 'standard';
          }
        }
        if (
          stripped.removedParams.includes('max_tokens->max_completion_tokens') ||
          stripped.removedParams.includes('max_completion_tokens->max_tokens')
        ) {
          emitProofreadLog(
            'proofread.swap_token_limit_param',
            'debug',
            '[proofread] Retrying proofread repair with swapped token limit parameter.',
            {
              model,
              removedParams: stripped.removedParams,
              stage: 'repair'
            }
          );
        }
        emitProofreadLog(
          'proofread.unsupported_param_removed',
          'warn',
          'Unsupported param removed; retrying proofread repair without it.',
          {
            model,
            status: response.status,
            removedParams: stripped.removedParams,
            stage: 'repair'
          }
        );
        requestBody = JSON.stringify(requestPayload);
        fetchStartedAt = Date.now();
        logLlmFetchRequest({
          ts: fetchStartedAt,
          role: 'proofread',
          requestId,
          url: apiBaseUrl,
          method: 'POST',
          headers: { ...requestHeaders, Authorization: `Bearer ${maskApiKey(apiKey)}` },
          body: requestBody,
          model: requestPayload.model,
          temperature: requestPayload.temperature,
          responseFormat: requestPayload.response_format
        });
        try {
          response = await fetch(apiBaseUrl, {
            method: 'POST',
            headers: requestHeaders,
            body: requestBody
          });
          responseText = await response.clone().text();
          logLlmRawResponse({
            ts: Date.now(),
            stage: 'proofread',
            requestId,
            status: response.status,
            ok: response.ok,
            responseText
          });
          logLlmFetchResponse({
            ts: Date.now(),
            requestId,
            status: response.status,
            ok: response.ok,
            responseHeaders: Array.from(response.headers.entries()),
            responseText,
            durationMs: Date.now() - fetchStartedAt
          });
        } catch (error) {
          logLlmFetchError({ ts: Date.now(), requestId, error });
          throw error;
        }
      }
    }
    if (!response.ok) {
      return translations;
    }
    const data = await response.json();
    const assistantContentMeta = {};
    const extractedContent = extractAssistantTextFromChatCompletion(data, assistantContentMeta);
    logLlmParseExtract({
      requestId,
      extractedText: extractedContent,
      source: assistantContentMeta.assistant_content_source || 'empty'
    });
    const content = extractedContent.trim();
    const latencyMs = Date.now() - startedAt;
    const usage = normalizeUsage(data?.usage);
    const debugPayload = attachRequestMeta(
      {
        phase: 'PROOFREAD_REPAIR',
        model,
        latencyMs,
        usage,
        inputChars: repairItems.reduce((sum, item) => sum + (item?.draft?.length || 0), 0),
        outputChars: content?.length || 0,
        request: requestPayload,
        promptCacheKey,
        promptCacheRetention,
        promptCacheSupport,
        assistant_content_source: assistantContentMeta.assistant_content_source || 'empty',
        response: content,
        parseIssues: ['fallback:language-repair']
      },
      repairRequestMeta,
      buildEffectiveContext(
        {
          text: resolvedShortContextText || '',
          mode: resolvedShortContextText ? 'SHORT' : '',
          baseAnswer: '',
          baseAnswerIncluded: false
        },
        repairRequestMeta
      )
    );
    if (Array.isArray(debugPayloads)) {
      debugPayloads.push(debugPayload);
    }
    let parsed = null;
    let parseError = null;
    try {
      parsed = parseJsonObjectFlexible(content, 'proofread-repair');
    } catch (error) {
      parseError = error?.message || 'parse-error';
      debugPayload.parseIssues.push(parseError);
    }
    if (!parseError) {
      const expectedIds = repairItems.map((item) => String(item.id));
      const expectedIdSet = new Set(expectedIds);
      const normalizedParsedItems = normalizeProofreadItems(parsed?.items);
      const responseIds = normalizedParsedItems.map((item) => item.id);
      const responseIdSet = new Set(responseIds);
      const hasUnknownIds = responseIds.some((id) => !expectedIdSet.has(id));
      const hasMissingIds = expectedIds.some((id) => !responseIdSet.has(id));
      const hasDuplicateIds = responseIdSet.size !== responseIds.length;
      const hasCountMismatch = normalizedParsedItems.length !== expectedIds.length;
      if (hasUnknownIds || hasMissingIds || hasDuplicateIds || hasCountMismatch) {
        parseError = 'schema-mismatch:items';
        debugPayload.parseIssues.push(parseError);
      }
    }
    if (parseError) {
      logLlmParseFail({ requestId, error: parseError, rawText: content, ts: Date.now() });
    } else {
      logLlmParseOk({ requestId, parsed, ts: Date.now() });
    }
    if (parseError) {
      const fallbackSpec =
        repairRequestMeta?.selectedModelSpec || formatModelSpec(model, repairRequestMeta?.selectedTier || 'standard');
      const validateSelection = resolveProofreadCandidateSelection(repairRequestMeta, fallbackSpec, {
        purpose: 'validate',
        triggerSource: 'validate'
      });
      const validateSpec = validateSelection.selectedModelSpec || fallbackSpec;
      const parsedValidateSpec = parseModelSpec(validateSpec);
      const validateModelId = parsedValidateSpec.id || model;
      const validateTier = parsedValidateSpec.tier || repairRequestMeta?.selectedTier || 'standard';
      debugPayload.parseIssues.push('fallback:format-repair');
      const repaired = await requestProofreadFormatRepair(
        content,
        repairItems,
        apiKey,
        validateModelId,
        apiBaseUrl,
        createChildRequestMeta(repairRequestMeta, {
          purpose: 'validate',
          attempt: Number.isFinite(repairRequestMeta?.attempt) ? repairRequestMeta.attempt + 1 : 1,
          triggerSource: 'validate',
          selectedModel: validateModelId,
          selectedTier: validateTier,
          selectedModelSpec: validateSpec,
          candidateStrategy: validateSelection.candidateStrategy,
          candidateOrderedList: validateSelection.orderedList,
          originalRequestedModelList: validateSelection.originalRequestedModelList
        }),
        buildRequestOptionsForTier(requestOptions, validateTier)
      );
      if (Array.isArray(repaired.debug)) {
        debugPayloads.push(...repaired.debug);
      }
      if (repaired.parsed && !repaired.parseError) {
        parsed = repaired.parsed;
        parseError = null;
      }
    }
    if (parseError) {
      return translations;
    }
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
    emitProofreadLog(
      'proofread.repair_failed',
      'warn',
      'Proofread language repair failed; keeping original revisions.',
      {
        error: error && typeof error === 'object'
          ? { name: error.name, message: error.message, stack: error.stack }
          : { name: 'Error', message: String(error ?? ''), stack: '' }
      }
    );
  }

  return translations;
}
