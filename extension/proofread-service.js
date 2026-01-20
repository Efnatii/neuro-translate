const PROOFREAD_SCHEMA_NAME = 'proofread_translations';

function buildProofreadPrompt(input) {
  const segments = Array.isArray(input?.segments) ? input.segments : [];
  const sourceBlock = input?.sourceBlock ?? '';
  const translatedBlock = input?.translatedBlock ?? '';
  const language = input?.language ?? '';
  const context = input?.context ?? '';

  return [
    {
      role: 'system',
      content: [
        'You are an expert translation proofreader and editor.',
        'Your job is to improve the translated text for clarity, fluency, and readability while preserving the original meaning.',
        'You may rewrite freely for naturalness, but do not add, omit, or distort information.',
        'Preserve modality, tense, aspect, tone, and level of certainty.',
        'Keep numbers, units, currencies, dates, and formatting intact unless they are clearly incorrect.',
        'Do not alter placeholders, markup, or code (e.g., {name}, {{count}}, <tag>, **bold**).',
        'Keep punctuation tokens unchanged and in place.',
        PUNCTUATION_TOKEN_HINT,
        'Use the source block only to verify meaning; do not translate it or copy it into the output.',
        'Use the translated block as context to maintain consistency across segments.',
        'Never include the context text in the output unless it is already part of the segments.',
        'Return a JSON object with a "translations" array that matches the input order.',
        'If a segment does not need edits, return an empty string for that segment.',
        'Do not add commentary.'
      ]
        .filter(Boolean)
        .join(' ')
    },
    {
      role: 'user',
      content: [
        language ? `Target language: ${language}` : '',
        context
          ? [
              'Use the context only for disambiguation.',
              'Do not translate, quote, or include the context in the output.',
              `Context (do not translate): <<<CONTEXT_START>>>${context}<<<CONTEXT_END>>>`
            ].join('\n')
          : '',
        sourceBlock
          ? `Source block: <<<SOURCE_BLOCK_START>>>${sourceBlock}<<<SOURCE_BLOCK_END>>>`
          : '',
        translatedBlock
          ? `Translated block: <<<TRANSLATED_BLOCK_START>>>${translatedBlock}<<<TRANSLATED_BLOCK_END>>>`
          : '',
        `Return a JSON object with a "translations" array containing exactly ${segments.length} items.`,
        'Segments to proofread (translated):',
        '<<<SEGMENTS_START>>>',
        ...segments.map((segment) => segment ?? ''),
        '<<<SEGMENTS_END>>>'
      ]
        .filter(Boolean)
        .join('\n')
    }
  ];
}

async function proofreadTranslation(
  segments,
  sourceBlock,
  translatedBlock,
  context,
  language,
  apiKey,
  model,
  apiBaseUrl = OPENAI_API_URL
) {
  if (!Array.isArray(segments) || !segments.length) {
    return { translations: [], rawProofread: '' };
  }

  const normalizedSegments = segments.map((segment) => (typeof segment === 'string' ? segment : String(segment ?? '')));
  const prompt = applyPromptCaching(
    buildProofreadPrompt({
      segments: normalizedSegments,
      sourceBlock,
      translatedBlock,
      context,
      language
    }),
    apiBaseUrl
  );

  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: prompt,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: PROOFREAD_SCHEMA_NAME,
          schema: {
            type: 'object',
            properties: {
              translations: {
                type: 'array',
                minItems: normalizedSegments.length,
                maxItems: normalizedSegments.length,
                items: { type: 'string' }
              }
            },
            required: ['translations'],
            additionalProperties: false
          }
        }
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorPayload = null;
    try {
      errorPayload = JSON.parse(errorText);
    } catch (parseError) {
      errorPayload = null;
    }
    const retryAfterMs = parseRetryAfterMs(response, errorPayload);
    const errorMessage =
      errorPayload?.error?.message || errorPayload?.message || errorText || 'Unknown error';
    const error = new Error(`Proofread request failed: ${response.status} ${errorMessage}`);
    error.status = response.status;
    error.retryAfterMs = retryAfterMs;
    error.isRateLimit = response.status === 429 || response.status === 503;
    throw error;
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No proofreading result returned');
  }

  const parsed = parseJsonObjectFlexible(content, 'proofread');
  const translations = Array.isArray(parsed?.translations)
    ? parsed.translations.map((item) => (typeof item === 'string' ? item : String(item ?? '')))
    : [];

  if (translations.length !== normalizedSegments.length) {
    throw new Error(
      `Proofread response length mismatch: expected ${normalizedSegments.length}, got ${translations.length}`
    );
  }

  return { translations, rawProofread: content };
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
