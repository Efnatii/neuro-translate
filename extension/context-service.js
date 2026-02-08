const CONTEXT_SYSTEM_PROMPT = [
  'You are a translator assistant. Produce context that improves translation quality.',
  'Do not paraphrase the text, do not evaluate it, and do not add facts not present in the source.',
  'If information is missing, write "not specified".',
  'Focus on details that affect accuracy, terminology consistency, style, and meaning.',
  'Provide actionable context: preferred term translations, caution on ambiguous pronouns/references, consistent style guidance, and key constraints.',
  'If a term is ambiguous, list 2-3 possible interpretations and what in the text suggests each choice.',
  'Do not suggest leaving names/titles/terms untranslated unless explicitly stated in the text.',
  'Your response must be structured and concise.',
  'Format strictly by the sections below (brief, bullet points).',
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
  'Output only the sections with brief bullet points.',
  'If a section is empty, write "not specified".'
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
const CONTEXT_PROMPT_BUILDER = new PromptBuilder({ systemRulesBase: CONTEXT_SYSTEM_PROMPT });
const SHORT_CONTEXT_PROMPT_BUILDER = new PromptBuilder({ systemRulesBase: SHORT_CONTEXT_SYSTEM_PROMPT });

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
  requestOptions = null,
  requestSignal = null
) {
  if (!text?.trim()) return { context: '', debug: [] };
  const controller = new AbortController();
  let removeAbortListener = () => {};
  if (requestSignal) {
    if (requestSignal.aborted) {
      controller.abort(requestSignal.reason || 'cancelled');
    } else {
      const onAbort = () => controller.abort(requestSignal.reason || 'cancelled');
      requestSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => requestSignal.removeEventListener('abort', onAbort);
    }
  }

  try {
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

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: CONTEXT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: CONTEXT_PROMPT_BUILDER.buildContextUserPrompt({
        text,
        targetLanguage,
        mode: 'FULL'
      })
    }
  ], apiBaseUrl);

  const requestPayload = {
    model: selectedModelId,
    messages: prompt
  };
  applyPromptCacheParams(requestPayload, apiBaseUrl, selectedModelId, 'neuro-translate:context:v1');
  applyModelRequestParams(requestPayload, selectedModelId, effectiveRequestOptions);
  const startedAt = Date.now();
  let response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload),
    signal: controller.signal
  });

  if (!response.ok) {
    let errorText = await response.text();
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
      errorText
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
      response = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });
      if (!response.ok) {
        errorText = await response.text();
      }
    }
    if (!response.ok) {
      throw new Error(`Context request failed: ${response.status} ${errorText}`);
    }
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No context returned');
  }

  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const trimmed = typeof content === 'string' ? content.trim() : '';
  const debugPayload = attachContextRequestMeta(
    {
      phase: 'CONTEXT',
      model: selectedModelId,
      latencyMs,
      usage,
      inputChars: text.length,
      outputChars: trimmed.length,
      request: requestPayload,
      response: content
    },
    requestMeta
  );

  return { context: trimmed, debug: [debugPayload] };
  } finally {
    removeAbortListener();
  }
}

async function generateShortTranslationContext(
  text,
  apiKey,
  targetLanguage = 'ru',
  model,
  apiBaseUrl = OPENAI_API_URL,
  requestMeta = null,
  requestOptions = null,
  requestSignal = null
) {
  if (!text?.trim()) return { context: '', debug: [] };
  const controller = new AbortController();
  let removeAbortListener = () => {};
  if (requestSignal) {
    if (requestSignal.aborted) {
      controller.abort(requestSignal.reason || 'cancelled');
    } else {
      const onAbort = () => controller.abort(requestSignal.reason || 'cancelled');
      requestSignal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => requestSignal.removeEventListener('abort', onAbort);
    }
  }

  try {
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

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: SHORT_CONTEXT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: SHORT_CONTEXT_PROMPT_BUILDER.buildContextUserPrompt({
        text,
        targetLanguage,
        mode: 'SHORT'
      })
    }
  ], apiBaseUrl);

  const requestPayload = {
    model: selectedModelId,
    messages: prompt
  };
  applyPromptCacheParams(requestPayload, apiBaseUrl, selectedModelId, 'neuro-translate:context-short:v1');
  applyModelRequestParams(requestPayload, selectedModelId, effectiveRequestOptions);
  const startedAt = Date.now();
  let response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestPayload),
    signal: controller.signal
  });

  if (!response.ok) {
    let errorText = await response.text();
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
      errorText
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
      response = await fetch(apiBaseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });
      if (!response.ok) {
        errorText = await response.text();
      }
    }
    if (!response.ok) {
      throw new Error(`Short context request failed: ${response.status} ${errorText}`);
    }
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No short context returned');
  }

  const latencyMs = Date.now() - startedAt;
  const usage = normalizeUsage(data?.usage);
  const trimmed = typeof content === 'string' ? content.trim() : '';
  const debugPayload = attachContextRequestMeta(
    {
      phase: 'CONTEXT_SHORT',
      model: selectedModelId,
      latencyMs,
      usage,
      inputChars: text.length,
      outputChars: trimmed.length,
      request: requestPayload,
      response: content
    },
    requestMeta
  );

  return { context: trimmed, debug: [debugPayload] };
  } finally {
    removeAbortListener();
  }
}
