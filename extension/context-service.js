const CONTEXT_SYSTEM_PROMPT = [
  'You are a translator assistant. Produce context that improves translation quality.',
  'Do not paraphrase the text, do not evaluate it, and do not add facts not present in the source.',
  'If information is missing, write "not specified".',
  'Focus on details that affect accuracy, terminology consistency, style, and meaning.',
  'Provide actionable context: preferred term translations, caution on ambiguous pronouns/references, consistent style guidance, and key constraints.',
  'If a term is ambiguous, list 2-3 possible interpretations and what in the text suggests each choice.',
  'Do not suggest leaving names/titles/terms untranslated unless explicitly stated in the text.',
  'Your response must be structured and concise.',
  'Format strictly by the sections below when MODE=FULL (brief, bullet points).',
  'If MODE=SHORT, ignore numbered sections and output 5-10 concise bullet points instead.',
  'Prefer dense bullet points; avoid repetition; max ~25 lines total (prioritize sections 1, 6, 8).',
  '',
  '1) Text type and purpose:',
  '- genre/domain (fiction, tech docs, marketing, UI, news, etc.)',
  '- style and format (UI/article/doc/chat) + degree of formality',
  '- goal (inform, persuade, instruct, describe, sell, etc.)',
  '- intended audience (if explicitly clear)',
  '',
  '2) Setting:',
  '- place, geography, organizations/locations (if stated)',
  '- time/era/period (if stated)',
  '',
  '3) Participants/characters:',
  '- names/roles/titles',
  '- gender/pronouns (if explicitly stated)',
  '- speakers/addressees (who speaks to whom)',
  '',
  '4) Relationships and social ties:',
  '- relationships between characters (if explicit)',
  '- status/hierarchy (manager-subordinate, customer-support, etc.)',
  '',
  '5) Plot/factual anchor points:',
  '- key events/facts that must not be distorted',
  '',
  '6) Terminology and consistency:',
  '- terms/concepts/abbreviations that must be translated consistently',
  '- mini-glossary: term → recommended translation → brief rationale (only if high confidence; otherwise mark "ambiguous")',
  '- Ambiguity watchlist: ambiguous terms + 2-3 possible interpretations with textual cues',
  '- what must not be translated or must be left as-is (only if explicitly stated)',
  '',
  '7) Proper names and onomastics:',
  '- names, brands, products, organizations, toponyms',
  '- how to render: translate/transliterate/leave as-is (leave as-is only with explicit instruction)',
  '',
  '8) Tone and style:',
  '- tone and pacing (formal/informal/neutral/literary/ironic, etc.)',
  '- style guide: acceptable calques/bureaucratese, address preferences (ты/вы), politeness/honorifics',
  '',
  '9) Linguistic features:',
  '- slang, jargon, dialect, archaisms',
  '- wordplay/idioms (if any)',
  '- quotes/quoted speech',
  '',
  '10) Format and technical requirements:',
  '- units, currencies, dates, formats',
  '- brevity/structure requirements',
  '- recurring templates/placeholders (if any)',
  '',
  'If MODE=FULL, output only the sections with brief bullet points.',
  'If MODE=FULL and a section is empty, write "not specified".',
  'If MODE=SHORT, output only concise bullet points.'
].join('\n');
const SHORT_CONTEXT_SYSTEM_PROMPT = [
  'You are a translation context summarizer.',
  'Generate a short, high-signal translation context from the provided text.',
  'Keep it concise and factual; no fluff, no repetition.',
  'Preserve key terminology, ambiguity notes, and style guidance.',
  'Output plain text only (no JSON, no code).',
  'Use short bullet points where helpful.',
  'Target length: 5-10 bullet points maximum.'
].join('\n');

function shouldLogJson() {
  return typeof globalThis.ntJsonLogEnabled === 'function' && globalThis.ntJsonLogEnabled();
}

function emitJsonLog(eventObject) {
  if (!shouldLogJson()) return;
  if (typeof globalThis.ntJsonLog === 'function') {
    globalThis.ntJsonLog(eventObject);
  }
}

function maskApiKey(apiKey) {
  if (!apiKey) return '';
  const text = String(apiKey);
  const tail = text.slice(-4);
  return `****${tail}`;
}

function createRequestId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function resolveContextModelSpec(requestMeta, fallbackModelSpec) {
  const triggerSource =
    requestMeta && typeof requestMeta.triggerSource === 'string'
      ? requestMeta.triggerSource.toLowerCase()
      : '';
  const purpose = requestMeta?.purpose || '';
  let effectivePurpose = purpose || 'main';
  if (triggerSource.includes('validate')) {
    effectivePurpose = 'validate';
  } else if (triggerSource.includes('retry')) {
    effectivePurpose = 'retry';
  }
  const isManualTrigger =
    (Boolean(requestMeta?.isManual) || triggerSource.includes('manual') || effectivePurpose === 'manual') &&
    !triggerSource.includes('retry') &&
    !triggerSource.includes('validate');
  let candidateStrategyUsed = 'default_preserve_order';
  if (effectivePurpose === 'validate') {
    candidateStrategyUsed = 'validate_cheapest';
  } else if (effectivePurpose === 'retry') {
    candidateStrategyUsed = 'retry_cheapest';
  } else if (isManualTrigger) {
    candidateStrategyUsed = 'manual_smartest';
  }
  const candidateList = Array.isArray(requestMeta?.originalRequestedModelList) && requestMeta.originalRequestedModelList.length
    ? requestMeta.originalRequestedModelList
    : Array.isArray(requestMeta?.candidateOrderedList) && requestMeta.candidateOrderedList.length
      ? requestMeta.candidateOrderedList
      : [];
  const fallbackSpec = typeof fallbackModelSpec === 'string' ? fallbackModelSpec : '';
  const normalizedList = candidateList.length ? candidateList : fallbackSpec ? [fallbackSpec] : [];
  const parsedEntries = normalizedList.map((spec, index) => {
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
  if (candidateStrategyUsed === 'manual_smartest') {
    orderedEntries.sort(compareManual);
  } else if (candidateStrategyUsed === 'retry_cheapest' || candidateStrategyUsed === 'validate_cheapest') {
    orderedEntries.sort(compareCheapest);
  }
  const selected = orderedEntries[0];
  if (!selected) {
    return {
      modelId: '',
      tier: 'standard',
      spec: '',
      candidateStrategyUsed
    };
  }
  return {
    modelId: selected.parsed.id,
    tier: selected.parsed.tier,
    spec: selected.spec,
    candidateStrategyUsed
  };
}

function attachContextRequestMeta(payload, requestMeta) {
  if (!payload || typeof payload !== 'object' || !requestMeta || typeof requestMeta !== 'object') {
    return payload;
  }
  return {
    ...payload,
    requestId: payload.requestId || requestMeta.requestId || '',
    parentRequestId: payload.parentRequestId || requestMeta.parentRequestId || '',
    stage: payload.stage || requestMeta.stage || '',
    purpose: requestMeta.purpose || payload.purpose || '',
    attempt: Number.isFinite(payload.attempt) ? payload.attempt : requestMeta.attempt,
    triggerSource: requestMeta.triggerSource || payload.triggerSource || '',
    selectedModel: requestMeta.selectedModel || payload.selectedModel || payload.model || '',
    selectedTier: requestMeta.selectedTier || payload.selectedTier || '',
    selectedModelSpec: requestMeta.selectedModelSpec || payload.selectedModelSpec || '',
    candidateStrategy: requestMeta.candidateStrategy || payload.candidateStrategy || '',
    candidateOrderedList:
      Array.isArray(requestMeta.candidateOrderedList)
        ? requestMeta.candidateOrderedList
        : Array.isArray(payload.candidateOrderedList)
          ? payload.candidateOrderedList
          : [],
    attemptIndex:
      Number.isFinite(payload.attemptIndex) || payload.attemptIndex === 0
        ? payload.attemptIndex
        : Number.isFinite(requestMeta.attemptIndex)
          ? requestMeta.attemptIndex
          : 0,
    fallbackReason: payload.fallbackReason || requestMeta.fallbackReason || '',
    originalRequestedModelList:
      Array.isArray(requestMeta.originalRequestedModelList)
        ? requestMeta.originalRequestedModelList
        : Array.isArray(payload.originalRequestedModelList)
          ? payload.originalRequestedModelList
          : []
  };
}

async function generateTranslationContext(
  text,
  apiKey,
  targetLanguage = 'ru',
  model,
  apiBaseUrl = OPENAI_API_URL,
  requestMeta = null,
  requestOptions = null
) {
  if (!text?.trim()) return { context: '', debug: [] };

  const fallbackSpec =
    requestMeta?.selectedModelSpec ||
    formatModelSpec(model, requestMeta?.selectedTier || requestOptions?.tier || 'standard');
  const selection = resolveContextModelSpec(requestMeta, fallbackSpec);
  const selectedModelId = selection.modelId || model;
  const selectedTier = selection.tier || requestMeta?.selectedTier || requestOptions?.tier || 'standard';
  const selectedModelSpec = selection.spec || formatModelSpec(selectedModelId, selectedTier);
  if (requestMeta && typeof requestMeta === 'object') {
    requestMeta.selectedModel = selectedModelId;
    requestMeta.selectedTier = selectedTier;
    requestMeta.selectedModelSpec = selectedModelSpec;
    requestMeta.candidateStrategy = selection.candidateStrategyUsed || requestMeta.candidateStrategy || '';
  }
  const effectiveRequestOptions =
    requestOptions && typeof requestOptions === 'object'
      ? {
          ...requestOptions,
          tier: selectedTier,
          serviceTier: selectedTier === 'flex' ? 'flex' : null
        }
      : {
          tier: selectedTier,
          serviceTier: selectedTier === 'flex' ? 'flex' : null
        };

  const cachePrefix = [
    'NEURO-TRANSLATE CACHE PREFIX v1 (context).',
    'This block is static and identical across context requests.',
    'Purpose: stabilize the cached prefix; it does not add new requirements.',
    'Follow the system prompt rules exactly; if a line here conflicts, the system prompt wins.',
    'Output must be concise, structured, and factual.',
    'Never paraphrase the source; never invent facts.',
    'If information is missing, explicitly state "not specified".',
    'Prioritize terminology, ambiguity notes, and style guidance.',
    'Avoid repetition; keep bullet points dense.',
    'Do not quote the prompt or instructions.',
    'Do not output JSON; output plain text only.',
    'Do not include the source text verbatim unless required for ambiguity notes.',
    'Keep the output short and high-signal.',
    'Repeat: no commentary beyond the requested context.',
    'Repeat: do not add facts.',
    'Repeat: follow the requested format.',
    'Repeat: be concise.',
    'Repeat: prioritize actionable translation context.',
    'Repeat: do not translate the text.',
    'Repeat: do not output markdown fences.',
    'Repeat: no extra sections beyond requested format.',
    '',
    'STABLE CONTEXT CHECKLIST (static; do not emit in output):',
    '1. Identify genre/domain if explicit.',
    '2. Identify audience if explicit.',
    '3. Note tone/formality cues.',
    '4. Note key entities and roles.',
    '5. Note ambiguous pronouns/references.',
    '6. Provide consistent term recommendations.',
    '7. Flag ambiguity with possible interpretations.',
    '8. Note any explicit translation constraints.',
    '9. Note format/structure requirements.',
    '10. Keep output concise and skimmable.',
    '11. Avoid repeating the same point.',
    '12. Avoid quoting long source phrases.',
    '13. Use bullet points where helpful.',
    '14. Keep total length compact.',
    '15. Do not add stylistic opinions.'
  ].join('\n');

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: CONTEXT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: cachePrefix
    },
    {
      role: 'user',
      content: [
        `Target language: ${targetLanguage}.`,
        'Return translation context following the system prompt format rules.',
        'Emphasize sections 1, 6, 8: include domain/genre + style + audience + format + formality in section 1;',
        'include a mini-glossary and an ambiguity watchlist in section 6;',
        'include a compact style guide (tone, pacing, calques, address preferences) in section 8.',
        'Prefer dense bullet points; avoid repetition; keep total length ~25 lines.',
        'MODE: FULL (use numbered sections 1-10).',
        'Text:',
        text
      ].join('\n')
    }
  ], apiBaseUrl, effectiveRequestOptions);

  const requestPayload = {
    model: selectedModelId,
    messages: prompt
  };
  applyPromptCacheParams(
    requestPayload,
    apiBaseUrl,
    selectedModelId,
    getPromptCacheKey('context'),
    effectiveRequestOptions
  );
  applyModelRequestParams(requestPayload, selectedModelId, effectiveRequestOptions, apiBaseUrl);
  const promptCacheSupport = getPromptCacheSupport(apiBaseUrl, effectiveRequestOptions);
  const promptCacheKey = requestPayload.prompt_cache_key || '';
  const promptCacheRetention = requestPayload.prompt_cache_retention || '';
  const requestId = requestMeta?.requestId || createRequestId();
  if (requestMeta && typeof requestMeta === 'object' && !requestMeta.requestId) {
    requestMeta.requestId = requestId;
  }
  const startedAt = Date.now();
  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  const requestBody = JSON.stringify(requestPayload);
  let response;
  let responseText = '';
  let fetchStartedAt = Date.now();
  logLlmFetchRequest({
    ts: fetchStartedAt,
    role: 'context',
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
      stage: 'context',
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
      selectedModelId,
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
      console.warn('Unsupported param removed; retrying without it.', {
        model: selectedModelId,
        status: response.status,
        removedParams: stripped.removedParams
      });
      fetchStartedAt = Date.now();
      logLlmFetchRequest({
        ts: fetchStartedAt,
        role: 'context',
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
          stage: 'context',
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
      }
    }
    if (!response.ok) {
      throw new Error(`Context request failed: ${response.status} ${errorText}`);
    }
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    logLlmParseFail({ requestId, error: 'no-content', rawText: responseText, ts: Date.now() });
    throw new Error('No context returned');
  }

  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const trimmed = typeof content === 'string' ? content.trim() : '';
  logLlmParseOk({ requestId, parsed: trimmed, ts: Date.now() });
  const debugPayload = attachContextRequestMeta(
    {
      phase: 'CONTEXT',
      model: selectedModelId,
      latencyMs,
      usage,
      inputChars: text.length,
      outputChars: trimmed.length,
      request: requestPayload,
      promptCacheKey,
      promptCacheRetention,
      promptCacheSupport,
      response: content,
      parseIssues: []
    },
    requestMeta
  );

  return { context: trimmed, debug: [debugPayload] };
}

async function generateShortTranslationContext(
  text,
  apiKey,
  targetLanguage = 'ru',
  model,
  apiBaseUrl = OPENAI_API_URL,
  requestMeta = null,
  requestOptions = null
) {
  if (!text?.trim()) return { context: '', debug: [] };

  const fallbackSpec =
    requestMeta?.selectedModelSpec ||
    formatModelSpec(model, requestMeta?.selectedTier || requestOptions?.tier || 'standard');
  const selection = resolveContextModelSpec(requestMeta, fallbackSpec);
  const selectedModelId = selection.modelId || model;
  const selectedTier = selection.tier || requestMeta?.selectedTier || requestOptions?.tier || 'standard';
  const selectedModelSpec = selection.spec || formatModelSpec(selectedModelId, selectedTier);
  if (requestMeta && typeof requestMeta === 'object') {
    requestMeta.selectedModel = selectedModelId;
    requestMeta.selectedTier = selectedTier;
    requestMeta.selectedModelSpec = selectedModelSpec;
    requestMeta.candidateStrategy = selection.candidateStrategyUsed || requestMeta.candidateStrategy || '';
  }
  const effectiveRequestOptions =
    requestOptions && typeof requestOptions === 'object'
      ? {
          ...requestOptions,
          tier: selectedTier,
          serviceTier: selectedTier === 'flex' ? 'flex' : null
        }
      : {
          tier: selectedTier,
          serviceTier: selectedTier === 'flex' ? 'flex' : null
        };

  const cachePrefix = [
    'NEURO-TRANSLATE CACHE PREFIX v1 (context).',
    'This block is static and identical across context requests.',
    'Purpose: stabilize the cached prefix; it does not add new requirements.',
    'Follow the system prompt rules exactly; if a line here conflicts, the system prompt wins.',
    'Output must be concise, structured, and factual.',
    'Never paraphrase the source; never invent facts.',
    'If information is missing, explicitly state "not specified".',
    'Prioritize terminology, ambiguity notes, and style guidance.',
    'Avoid repetition; keep bullet points dense.',
    'Do not quote the prompt or instructions.',
    'Do not output JSON; output plain text only.',
    'Do not include the source text verbatim unless required for ambiguity notes.',
    'Keep the output short and high-signal.',
    'Repeat: no commentary beyond the requested context.',
    'Repeat: do not add facts.',
    'Repeat: follow the requested format.',
    'Repeat: be concise.',
    'Repeat: prioritize actionable translation context.',
    'Repeat: do not translate the text.',
    'Repeat: do not output markdown fences.',
    'Repeat: no extra sections beyond requested format.',
    '',
    'STABLE CONTEXT CHECKLIST (static; do not emit in output):',
    '1. Identify genre/domain if explicit.',
    '2. Identify audience if explicit.',
    '3. Note tone/formality cues.',
    '4. Note key entities and roles.',
    '5. Note ambiguous pronouns/references.',
    '6. Provide consistent term recommendations.',
    '7. Flag ambiguity with possible interpretations.',
    '8. Note any explicit translation constraints.',
    '9. Note format/structure requirements.',
    '10. Keep output concise and skimmable.',
    '11. Avoid repeating the same point.',
    '12. Avoid quoting long source phrases.',
    '13. Use bullet points where helpful.',
    '14. Keep total length compact.',
    '15. Do not add stylistic opinions.'
  ].join('\n');

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: CONTEXT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: cachePrefix
    },
    {
      role: 'user',
      content: [
        `Target language: ${targetLanguage}.`,
        'Return translation context following the system prompt format rules.',
        'Emphasize sections 1, 6, 8: include domain/genre + style + audience + format + formality in section 1;',
        'include a mini-glossary and an ambiguity watchlist in section 6;',
        'include a compact style guide (tone, pacing, calques, address preferences) in section 8.',
        'Prefer dense bullet points; avoid repetition; keep total length ~25 lines.',
        'MODE: SHORT (ignore numbered sections; output 5-10 bullet points).',
        'Text:',
        text
      ].join('\n')
    }
  ], apiBaseUrl, effectiveRequestOptions);

  const requestPayload = {
    model: selectedModelId,
    messages: prompt
  };
  applyPromptCacheParams(
    requestPayload,
    apiBaseUrl,
    selectedModelId,
    getPromptCacheKey('context', 'short'),
    effectiveRequestOptions
  );
  applyModelRequestParams(requestPayload, selectedModelId, effectiveRequestOptions, apiBaseUrl);
  const promptCacheSupport = getPromptCacheSupport(apiBaseUrl, effectiveRequestOptions);
  const promptCacheKey = requestPayload.prompt_cache_key || '';
  const promptCacheRetention = requestPayload.prompt_cache_retention || '';
  const requestId = requestMeta?.requestId || createRequestId();
  if (requestMeta && typeof requestMeta === 'object' && !requestMeta.requestId) {
    requestMeta.requestId = requestId;
  }
  const startedAt = Date.now();
  const requestHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
  const requestBody = JSON.stringify(requestPayload);
  let response;
  let responseText = '';
  let fetchStartedAt = Date.now();
  logLlmFetchRequest({
    ts: fetchStartedAt,
    role: 'context',
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
      stage: 'context',
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
      selectedModelId,
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
      console.warn('Unsupported param removed; retrying without it.', {
        model: selectedModelId,
        status: response.status,
        removedParams: stripped.removedParams
      });
      fetchStartedAt = Date.now();
      logLlmFetchRequest({
        ts: fetchStartedAt,
        role: 'context',
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
          stage: 'context',
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
      }
    }
    if (!response.ok) {
      throw new Error(`Short context request failed: ${response.status} ${errorText}`);
    }
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    logLlmParseFail({ requestId, error: 'no-content', rawText: responseText, ts: Date.now() });
    throw new Error('No short context returned');
  }

  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const trimmed = typeof content === 'string' ? content.trim() : '';
  logLlmParseOk({ requestId, parsed: trimmed, ts: Date.now() });
  const debugPayload = attachContextRequestMeta(
    {
      phase: 'CONTEXT_SHORT',
      model: selectedModelId,
      latencyMs,
      usage,
      inputChars: text.length,
      outputChars: trimmed.length,
      request: requestPayload,
      promptCacheKey,
      promptCacheRetention,
      promptCacheSupport,
      response: content,
      parseIssues: []
    },
    requestMeta
  );

  return { context: trimmed, debug: [debugPayload] };
}
