(() => {
  class PromptBuilder {
    /**
     * @param {{systemRulesBase?: string}=} options
     */
    constructor({ systemRulesBase } = {}) {
      this.systemRulesBase = typeof systemRulesBase === 'string' ? systemRulesBase : '';
    }

    /**
     * @param {object} params
     * @param {string[]} params.segments
     * @param {string} params.targetLanguage
     * @param {string=} params.contextMode
     * @param {string=} params.contextText
     * @param {boolean=} params.strictTargetLanguage
     * @param {string=} params.debugHints
     * @returns {string}
     */
    buildTranslationUserPrompt({ segments, targetLanguage, contextMode, contextText, strictTargetLanguage, debugHints }) {
      const rules = [
        'Translate each segment into the target language with natural, idiomatic phrasing.',
        'Do not omit, add, or generalize information.',
        'Preserve placeholders, markup, code, URLs, IDs, numbers/units, and punctuation tokens exactly.',
        'Do not copy or paraphrase CONTEXT into output unless it is required to translate the source segments.',
        'If a term should not be translated semantically, transliterate it into the target script instead of leaving it unchanged.',
        'Self-check: if output equals source (case-insensitive), ensure it is allowlisted or already in target language; otherwise translate/transliterate.'
      ];
      if (strictTargetLanguage) {
        rules.push(`Every segment must be fully in ${targetLanguage}.`);
      }

      const outputContract = [
        `Return JSON: {"translations": string[]} with exactly ${Array.isArray(segments) ? segments.length : 0} items.`,
        'Keep the same order as input. No extra keys or commentary.'
      ].join(' ');

      const segmentLines = (Array.isArray(segments) ? segments : []).map(
        (text, index) => `${index}: ${globalThis.ntSafeText(text)}`
      );

      const blocks = [
        { tag: globalThis.NT_PROMPT_TAGS.TASK, content: 'Translate the SEGMENTS into the target language.' },
        { tag: globalThis.NT_PROMPT_TAGS.TARGET_LANGUAGE, content: targetLanguage },
        { tag: globalThis.NT_PROMPT_TAGS.RULES, content: rules.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.CONTEXT_MODE, content: contextText ? (contextMode || 'FULL') : 'NONE' },
        { tag: globalThis.NT_PROMPT_TAGS.CONTEXT, content: contextText || '' },
        { tag: globalThis.NT_PROMPT_TAGS.SEGMENTS, content: segmentLines.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.OUTPUT_CONTRACT, content: outputContract }
      ];
      if (debugHints) {
        blocks.push({ tag: globalThis.NT_PROMPT_TAGS.DEBUG_HINTS, content: debugHints });
      }
      return globalThis.ntJoinTaggedBlocks(blocks);
    }

    /**
     * @param {object} params
     * @param {{id: string, source: string, draft: string}[]} params.items
     * @param {string} params.targetLanguage
     * @param {string=} params.contextText
     * @returns {string}
     */
    buildTranslationRepairUserPrompt({ items, targetLanguage, contextText }) {
      const rules = [
        'Fix the draft so the output is fully in the target language/script.',
        'Preserve meaning, formatting, punctuation tokens, placeholders, markup, code, URLs, IDs, numbers, units, and links.',
        'Do not add or remove information.',
        'Self-check: if output equals source (case-insensitive), ensure it is allowlisted or already in target language; otherwise translate/transliterate.'
      ];
      const outputContract = `Return JSON: {\"translations\": string[]} with exactly ${Array.isArray(items) ? items.length : 0} items in the same order.`;
      const itemLines = (Array.isArray(items) ? items : []).map(
        (item) =>
          `${globalThis.ntSafeText(item?.id)} | source: ${globalThis.ntSafeText(item?.source)} | draft: ${globalThis.ntSafeText(item?.draft)}`
      );
      return globalThis.ntJoinTaggedBlocks([
        { tag: globalThis.NT_PROMPT_TAGS.TASK, content: `Repair translations into ${targetLanguage}.` },
        { tag: globalThis.NT_PROMPT_TAGS.TARGET_LANGUAGE, content: targetLanguage },
        { tag: globalThis.NT_PROMPT_TAGS.RULES, content: rules.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.CONTEXT_MODE, content: contextText ? 'FULL' : 'NONE' },
        { tag: globalThis.NT_PROMPT_TAGS.CONTEXT, content: contextText || '' },
        { tag: globalThis.NT_PROMPT_TAGS.SEGMENTS, content: itemLines.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.OUTPUT_CONTRACT, content: outputContract }
      ]);
    }

    /**
     * @param {object} params
     * @param {string} params.text
     * @param {string} params.targetLanguage
     * @param {string=} params.mode
     * @returns {string}
     */
    buildContextUserPrompt({ text, targetLanguage, mode }) {
      const rules = [
        'Produce translation context that improves accuracy, terminology, and style.',
        'Do not add facts not present in the source; if unknown, write "not specified".',
        'Focus on ambiguity, terminology consistency, and tone/style guidance.',
        'Self-check: do not copy long passages verbatim; summarize instead.'
      ];
      if (mode === 'SHORT') {
        rules.push('Keep it very short and high-signal (5-10 bullet points).');
      }
      const outputContract = mode === 'SHORT'
        ? 'Output plain text only; short bullet points allowed.'
        : 'Return numbered sections 1-10 with brief bullet points only.';

      return globalThis.ntJoinTaggedBlocks([
        { tag: globalThis.NT_PROMPT_TAGS.TASK, content: 'Generate translation context for the SOURCE_BLOCK.' },
        { tag: globalThis.NT_PROMPT_TAGS.TARGET_LANGUAGE, content: targetLanguage },
        { tag: globalThis.NT_PROMPT_TAGS.RULES, content: rules.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.SOURCE_BLOCK, content: text || '' },
        { tag: globalThis.NT_PROMPT_TAGS.OUTPUT_CONTRACT, content: outputContract }
      ]);
    }

    /**
     * @param {object} params
     * @param {{id: string, text: string}[]} params.items
     * @param {string=} params.sourceBlock
     * @param {string=} params.translatedBlock
     * @param {string=} params.contextText
     * @param {string=} params.contextMode
     * @param {string=} params.language
     * @param {string=} params.proofreadMode
     * @param {boolean=} params.strict
     * @param {string=} params.extraReminder
     * @param {string=} params.debugHints
     * @returns {string}
     */
    buildProofreadUserPrompt({
      items,
      sourceBlock,
      translatedBlock,
      contextText,
      contextMode,
      language,
      proofreadMode,
      strict,
      extraReminder,
      debugHints
    }) {
      const rules = [
        'Fix grammar, style, and errors without changing meaning.',
        'Preserve placeholders, markup, code, URLs, IDs, numbers/units, and punctuation tokens exactly.',
        'Do not copy CONTEXT or source block into output unless needed for correction.',
        'Self-check: ensure output is fully in the target language/script unless allowlisted.'
      ];
      if (strict) {
        rules.push('Return every input id exactly once; do not add, remove, or reorder items.');
      }
      if (extraReminder) {
        rules.push(globalThis.ntSafeText(extraReminder));
      }

      const outputContract = [
        `Return JSON: {"items": [{"id":"...","text":"..."}]} with exactly ${Array.isArray(items) ? items.length : 0} items.`,
        'Keep ids unchanged and preserve order. No extra keys or commentary.'
      ].join(' ');

      const itemLines = (Array.isArray(items) ? items : []).map(
        (item) => `${globalThis.ntSafeText(item?.id)}: ${globalThis.ntSafeText(item?.text)}`
      );

      const blocks = [
        { tag: globalThis.NT_PROMPT_TAGS.TASK, content: `Proofread mode: ${proofreadMode || 'READABILITY_REWRITE'}.` },
        { tag: globalThis.NT_PROMPT_TAGS.TARGET_LANGUAGE, content: language || '' },
        { tag: globalThis.NT_PROMPT_TAGS.RULES, content: rules.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.CONTEXT_MODE, content: contextText ? (contextMode || 'FULL') : 'NONE' },
        { tag: globalThis.NT_PROMPT_TAGS.CONTEXT, content: contextText || '' },
        { tag: globalThis.NT_PROMPT_TAGS.SOURCE_BLOCK, content: sourceBlock || '' },
        { tag: globalThis.NT_PROMPT_TAGS.TRANSLATED_BLOCK, content: translatedBlock || '' },
        { tag: globalThis.NT_PROMPT_TAGS.SEGMENTS, content: itemLines.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.OUTPUT_CONTRACT, content: outputContract }
      ];
      if (debugHints) {
        blocks.push({ tag: globalThis.NT_PROMPT_TAGS.DEBUG_HINTS, content: debugHints });
      }
      return globalThis.ntJoinTaggedBlocks(blocks);
    }

    /**
     * @param {object} params
     * @param {string} params.rawResponse
     * @param {number} params.itemCount
     * @returns {string}
     */
    buildProofreadFormatRepairUserPrompt({ rawResponse, itemCount }) {
      const rules = [
        'Convert the provided text into valid JSON that matches the required schema.',
        'Do not change meaning or wording.',
        'Return only JSON.'
      ];
      const outputContract = `Return JSON: {"items": [{"id":"...","text":"..."}]} with exactly ${itemCount} items.`;
      return globalThis.ntJoinTaggedBlocks([
        { tag: globalThis.NT_PROMPT_TAGS.TASK, content: 'Repair the output format.' },
        { tag: globalThis.NT_PROMPT_TAGS.RULES, content: rules.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.DEBUG_HINTS, content: rawResponse || '' },
        { tag: globalThis.NT_PROMPT_TAGS.OUTPUT_CONTRACT, content: outputContract }
      ]);
    }

    /**
     * @param {object} params
     * @param {{id: string, source: string, draft: string}[]} params.items
     * @param {string=} params.language
     * @returns {string}
     */
    buildProofreadLanguageRepairUserPrompt({ items, language }) {
      const rules = [
        'Fix the draft so the result is fully in the target language.',
        'Do not change meaning; keep placeholders, markup, code, URLs, numbers/units, and punctuation tokens unchanged.',
        'Return only JSON.'
      ];
      const outputContract = `Return JSON: {"items": [{"id":"...","text":"..."}]} with exactly ${Array.isArray(items) ? items.length : 0} items.`;
      const itemLines = (Array.isArray(items) ? items : []).map(
        (item) => `${globalThis.ntSafeText(item?.id)} | source: ${globalThis.ntSafeText(item?.source)} | draft: ${globalThis.ntSafeText(item?.draft)}`
      );
      return globalThis.ntJoinTaggedBlocks([
        { tag: globalThis.NT_PROMPT_TAGS.TASK, content: 'Repair non-target-language fragments.' },
        { tag: globalThis.NT_PROMPT_TAGS.TARGET_LANGUAGE, content: language || '' },
        { tag: globalThis.NT_PROMPT_TAGS.RULES, content: rules.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.SEGMENTS, content: itemLines.join('\n') },
        { tag: globalThis.NT_PROMPT_TAGS.OUTPUT_CONTRACT, content: outputContract }
      ]);
    }
  }

  globalThis.PromptBuilder = PromptBuilder;
})();
