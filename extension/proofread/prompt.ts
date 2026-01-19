import type { ProofreadInput } from './edits';

export const PROOFREAD_RESPONSE_SCHEMA = {
  name: 'proofread_anchor_edits',
  schema: {
    type: 'object',
    properties: {
      edits: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['replace', 'insert_before', 'insert_after', 'delete']
            },
            target: { type: 'string' },
            replacement: { type: 'string' },
            occurrence: { type: 'integer', minimum: 1 },
            before: { type: 'string' },
            after: { type: 'string' },
            rationale: { type: 'string' }
          },
          required: ['op', 'target', 'occurrence'],
          additionalProperties: false
        }
      },
      rewrite: {
        type: 'object',
        properties: {
          text: { type: 'string' }
        },
        required: ['text'],
        additionalProperties: false
      }
    },
    required: ['edits'],
    additionalProperties: false
  },
  strict: true
};

export function buildProofreadPrompt(input: ProofreadInput) {
  const goals = Array.isArray(input.goals) ? input.goals.filter(Boolean) : [];
  const goalsSection = goals.length ? `Goals:\n- ${goals.join('\n- ')}` : 'Goals: (none)';
  const baseSystem = [
    'You are a professional text proofreader.',
    'Return ONLY valid JSON matching the provided schema.',
    'Do not return start/end indices or character offsets.',
    'Edits must be anchor-based using exact text snippets from the input block.',
    'If a target appears multiple times, include before/after anchors and occurrence (1-based).',
    'Keep formatting (whitespace, line breaks, Markdown) intact except for localized fixes.',
    'Prefer minimal, precise edits. Avoid altering meaning or adding content.',
    'If safe anchor edits are impossible due to ambiguity, return rewrite.text and leave edits empty.',
    'Never include extra commentary outside JSON.'
  ].join(' ');

  const userContent = [
    `Block ID: ${input.blockId}`,
    `Language: ${input.language}`,
    goalsSection,
    'Text:',
    input.text
  ].join('\n');

  return [
    { role: 'system', content: baseSystem },
    { role: 'user', content: userContent }
  ];
}
