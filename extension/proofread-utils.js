(() => {
  const MAX_PROOFREAD_EDITS = 30;

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

  const api = {
    MAX_PROOFREAD_EDITS,
    buildProofreadPrompt,
    normalizeLineEndings
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (typeof globalThis !== 'undefined') {
    globalThis.ProofreadUtils = api;
  }
})();
