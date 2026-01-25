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
  'Condense the provided full translation context into a short, high-signal brief.',
  'Keep it concise and factual; no fluff, no repetition.',
  'Preserve key terminology, ambiguity notes, and style guidance.',
  'Output plain text only (no JSON, no code).',
  'Use short bullet points where helpful.',
  'Target length: 5-10 bullet points maximum.'
].join('\n');

async function generateTranslationContext(
  text,
  apiKey,
  targetLanguage = 'ru',
  model,
  apiBaseUrl = OPENAI_API_URL
) {
  if (!text?.trim()) return { context: '', debug: [] };

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: CONTEXT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        `Target language: ${targetLanguage}.`,
        'Return translation context in numbered sections 1-10 as specified.',
        'Emphasize sections 1, 6, 8: include domain/genre + style + audience + format + formality in section 1;',
        'include a mini-glossary and an ambiguity watchlist in section 6;',
        'include a compact style guide (tone, pacing, calques, address preferences) in section 8.',
        'Prefer dense bullet points; avoid repetition; keep total length ~25 lines.',
        'Text:',
        text
      ].join('\n')
    }
  ], apiBaseUrl);

  const requestPayload = {
    model,
    messages: prompt
  };
  applyPromptCacheParams(requestPayload, apiBaseUrl, model, 'neuro-translate:context:v1');
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
  const debugPayload = {
    phase: 'CONTEXT',
    model,
    latencyMs,
    usage,
    inputChars: text.length,
    outputChars: trimmed.length,
    request: requestPayload,
    response: content,
    parseIssues: []
  };

  return { context: trimmed, debug: [debugPayload] };
}

async function generateShortTranslationContext(
  fullContext,
  apiKey,
  targetLanguage = 'ru',
  model,
  apiBaseUrl = OPENAI_API_URL
) {
  if (!fullContext?.trim()) return { context: '', debug: [] };

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: SHORT_CONTEXT_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        `Target language: ${targetLanguage}.`,
        'Summarize the full context into a short, actionable brief.',
        'Keep it compact and useful for translation disambiguation.',
        'Full context:',
        fullContext
      ].join('\n')
    }
  ], apiBaseUrl);

  const requestPayload = {
    model,
    messages: prompt
  };
  applyPromptCacheParams(requestPayload, apiBaseUrl, model, 'neuro-translate:context-short:v1');
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
  const debugPayload = {
    phase: 'CONTEXT_SHORT',
    model,
    latencyMs,
    usage,
    inputChars: fullContext.length,
    outputChars: trimmed.length,
    request: requestPayload,
    response: content,
    parseIssues: []
  };

  return { context: trimmed, debug: [debugPayload] };
}
