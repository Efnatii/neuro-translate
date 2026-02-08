(() => {
  const TAGS = {
    TASK: 'TASK',
    RULES: 'RULES',
    TARGET_LANGUAGE: 'TARGET_LANGUAGE',
    CONTEXT_MODE: 'CONTEXT_MODE',
    CONTEXT: 'CONTEXT',
    SOURCE_BLOCK: 'SOURCE_BLOCK',
    TRANSLATED_BLOCK: 'TRANSLATED_BLOCK',
    SEGMENTS: 'SEGMENTS',
    OUTPUT_CONTRACT: 'OUTPUT_CONTRACT',
    DEBUG_HINTS: 'DEBUG_HINTS'
  };

  /**
   * @param {any} content
   * @returns {string}
   */
  function ntSafeText(content) {
    if (content == null) return '';
    const text = typeof content === 'string' ? content : String(content);
    return text.replace(/\0/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /**
   * @param {string} tagName
   * @param {any} content
   * @returns {string}
   */
  function ntWrapTag(tagName, content) {
    const safeTag = String(tagName || '').trim();
    const safeContent = ntSafeText(content);
    return `<<<${safeTag}_START>>>\n${safeContent}\n<<<${safeTag}_END>>>`;
  }

  /**
   * @param {{tag: string, content: any}[]} blocks
   * @returns {string}
   */
  function ntJoinTaggedBlocks(blocks) {
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((block) => block && typeof block.tag === 'string')
      .map((block) => ntWrapTag(block.tag, block.content))
      .join('\n\n');
  }

  globalThis.NT_PROMPT_TAGS = TAGS;
  globalThis.ntSafeText = ntSafeText;
  globalThis.ntWrapTag = ntWrapTag;
  globalThis.ntJoinTaggedBlocks = ntJoinTaggedBlocks;
})();
