const MAX_PROOFREAD_EDITS = 30;
const PROOFREAD_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    edits: {
      type: 'array',
      maxItems: MAX_PROOFREAD_EDITS,
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['replace', 'insert_before', 'insert_after', 'delete'] },
          target: { type: 'string' },
          replacement: { type: 'string' },
          occurrence: { type: 'integer', minimum: 1 },
          before: { type: 'string' },
          after: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['op', 'target'],
        additionalProperties: false
      }
    },
    rewrite_text: { type: 'string' }
  },
  required: ['edits'],
  additionalProperties: false
};

function detectLineEnding(text = '') {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

function normalizeLineEndings(text = '') {
  const lineEnding = detectLineEnding(text);
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return { normalized, lineEnding };
}

function buildProofreadPrompt(input) {
  const blockId = input?.blockId ?? '';
  const text = input?.text ?? '';
  const language = input?.language ?? '';
  const goals = Array.isArray(input?.goals) ? input.goals.filter(Boolean) : [];
  return [
    {
      role: 'system',
      content: [
        'You are a precise proofreading engine.',
        'Return only JSON that matches the provided schema.',
        'Use anchor-based edits only; never return start/end indices.',
        'Each edit must target an exact fragment from the original block.',
        'If a target appears multiple times, include before/after anchors.',
        'Keep formatting, whitespace, Markdown, and punctuation tokens unchanged except for local fixes.',
        'Avoid over-editing; keep meaning identical.',
        `Limit to at most ${MAX_PROOFREAD_EDITS} edits per block.`,
        'If edits are unsafe or ambiguous, return rewrite_text instead.',
        'Never include any extra commentary outside the JSON object.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Block ID: ${blockId}`,
        `Language: ${language}`,
        goals.length ? `Goals:\n- ${goals.join('\n- ')}` : '',
        'Block text:',
        text
      ]
        .filter(Boolean)
        .join('\n')
    }
  ];
}

async function proofreadTranslation(blocks, apiKey, model, apiBaseUrl = OPENAI_API_URL) {
  if (!Array.isArray(blocks) || !blocks.length) return { results: [], rawProofread: [] };

  const normalizedBlocks = blocks.map((block, index) => {
    const blockId = block?.blockId ?? String(index);
    const language = block?.language ?? '';
    const goals = Array.isArray(block?.goals) ? block.goals : [];
    const text = typeof block?.text === 'string' ? block.text : '';
    const { normalized } = normalizeLineEndings(text);
    return { blockId, text: normalized, language, goals };
  });

  const results = [];
  const rawProofread = [];

  for (const block of normalizedBlocks) {
    const prompt = applyPromptCaching(buildProofreadPrompt(block), apiBaseUrl);
    if (prompt?.[0]?.content) {
      prompt[0].content = `${prompt[0].content} ${PUNCTUATION_TOKEN_HINT}`;
    }

    const maxRateLimitRetries = 3;
    let rateLimitRetries = 0;
    let lastRateLimitDelayMs = null;
    let lastError = null;

    while (true) {
      try {
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
                name: 'proofread_edits',
                schema: PROOFREAD_RESPONSE_SCHEMA
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
        const edits = Array.isArray(parsed?.edits) ? parsed.edits : [];
        const parsedRewriteText = typeof parsed?.rewrite_text === 'string' ? parsed.rewrite_text : null;
        const rewriteText =
          parsedRewriteText && parsedRewriteText.length > 0 ? parsedRewriteText : block.text;

        results.push({ blockId: block.blockId, edits, rewriteText });
        rawProofread.push({ blockId: block.blockId, raw: content });
        break;
      } catch (error) {
        lastError = error;
        const isRateLimit = error?.status === 429 || error?.status === 503 || error?.isRateLimit;
        if (isRateLimit && rateLimitRetries < maxRateLimitRetries) {
          rateLimitRetries += 1;
          const retryDelayMs = calculateRetryDelayMs(rateLimitRetries, error?.retryAfterMs);
          lastRateLimitDelayMs = retryDelayMs;
          console.warn(`Proofreading rate-limited, retrying after ${retryDelayMs}ms...`);
          await sleep(retryDelayMs);
          continue;
        }

        if (isRateLimit) {
          const waitSeconds = Math.max(
            1,
            Math.ceil((lastRateLimitDelayMs || error?.retryAfterMs || 30000) / 1000)
          );
          const waitMs = waitSeconds * 1000;
          console.warn(`Proofreading rate limit reached—waiting ${waitSeconds}s before retrying.`);
          await sleep(waitMs);
          continue;
        }

        throw lastError;
      }
    }
  }

  return { results, rawProofread };
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
