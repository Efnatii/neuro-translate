const PROOFREAD_SCHEMA_NAME = 'proofread_translations';
const PROOFREAD_MAX_CHARS_PER_CHUNK = 4000;
const PROOFREAD_MAX_ITEMS_PER_CHUNK = 30;
const PROOFREAD_MISSING_RATIO_THRESHOLD = 0.2;

function buildProofreadPrompt(input, strict = false) {
  const items = Array.isArray(input?.items) ? input.items : [];
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
        'Return a JSON object with an "items" array.',
        'Each item must include the original "id" and the corrected "text" string.',
        'Do not add, remove, or reorder items. Keep ids unchanged.',
        'If a segment does not need edits, return an empty string for its text.',
        strict
          ? 'Strict mode: return every input id exactly once in the output items array.'
          : '',
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
        `Return only JSON. Expected items count: ${items.length}.`,
        'Segments to proofread (translated) as JSON array of {id, text}:',
        JSON.stringify(items)
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
  const items = normalizedSegments.map((text, index) => ({ id: String(index), text }));
  const chunks = chunkProofreadItems(items);
  const revisionsById = new Map();
  const rawProofreadParts = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    let result = await requestProofreadChunk(
      chunk,
      { sourceBlock, translatedBlock, context, language },
      apiKey,
      model,
      apiBaseUrl,
      false
    );
    rawProofreadParts.push(result.rawProofread);
    let quality = evaluateProofreadResult(chunk, result.itemsById, result.parseError);
    logProofreadChunk('proofread', index, chunks.length, chunk.length, quality, result.parseError);
    if (quality.isPoor) {
      console.warn('Proofread chunk incomplete, retrying with strict instructions.', {
        chunkIndex: index + 1,
        missing: quality.missingCount,
        received: quality.receivedCount
      });
      result = await requestProofreadChunk(
        chunk,
        { sourceBlock, translatedBlock, context, language },
        apiKey,
        model,
        apiBaseUrl,
        true
      );
      rawProofreadParts.push(result.rawProofread);
      quality = evaluateProofreadResult(chunk, result.itemsById, result.parseError);
      logProofreadChunk('proofread-retry', index, chunks.length, chunk.length, quality, result.parseError);
    }

    if (quality.isPoor && chunk.length > 1) {
      console.warn('Proofread chunk still incomplete, falling back to per-item requests.', {
        chunkIndex: index + 1,
        missing: quality.missingCount,
        received: quality.receivedCount
      });
      for (const item of chunk) {
        const singleResult = await requestProofreadChunk(
          [item],
          { sourceBlock, translatedBlock, context, language },
          apiKey,
          model,
          apiBaseUrl,
          true
        );
        rawProofreadParts.push(singleResult.rawProofread);
        const singleQuality = evaluateProofreadResult([item], singleResult.itemsById, singleResult.parseError);
        logProofreadChunk('proofread-single', index, chunks.length, 1, singleQuality, singleResult.parseError);
        const revision = singleResult.itemsById.get(item.id);
        if (revision !== undefined) {
          revisionsById.set(item.id, revision);
        }
      }
      continue;
    }

    for (const item of chunk) {
      if (result.itemsById.has(item.id)) {
        revisionsById.set(item.id, result.itemsById.get(item.id));
      }
    }
  }

  const translations = normalizedSegments.map((_, index) => {
    const revision = revisionsById.get(String(index));
    return typeof revision === 'string' ? revision : '';
  });

  const rawProofread = rawProofreadParts.filter(Boolean).join('\n\n---\n\n');
  return { translations, rawProofread };
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

async function requestProofreadChunk(items, metadata, apiKey, model, apiBaseUrl, strict) {
  const prompt = applyPromptCaching(
    buildProofreadPrompt(
      {
        items,
        sourceBlock: metadata?.sourceBlock,
        translatedBlock: metadata?.translatedBlock,
        context: metadata?.context,
        language: metadata?.language
      },
      strict
    ),
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
    return { itemsById: new Map(), rawProofread: '', parseError: 'no-content' };
  }

  let parsed = null;
  let parseError = null;
  try {
    parsed = parseJsonObjectFlexible(content, 'proofread');
  } catch (error) {
    parseError = error?.message || 'parse-error';
  }

  const normalizedItems = normalizeProofreadItems(parsed?.items);
  const itemsById = new Map();
  normalizedItems.forEach((item) => {
    itemsById.set(item.id, item.text);
  });

  return { itemsById, rawProofread: content, parseError };
}
