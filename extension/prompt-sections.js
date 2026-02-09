(() => {
  const SECTION_TAGS = {
    INSTRUCTIONS: 'INSTRUCTIONS',
    CONTEXT: 'CONTEXT',
    SEGMENTS_JSON: 'SEGMENTS_JSON',
    OUTPUT_FORMAT: 'OUTPUT_FORMAT',
    OUTPUT_JSON: 'OUTPUT_JSON'
  };

  function buildSection(tagName, content) {
    const safeTag = String(tagName || '').trim();
    const safeContent = content == null ? '' : String(content);
    return `<<<${safeTag}_START>>>\n${safeContent}\n<<<${safeTag}_END>>>`;
  }

  function joinSections(sections = []) {
    return sections.filter(Boolean).join('\n\n');
  }

  function extractSectionContent(source = '', tagName) {
    const safeTag = String(tagName || '').trim();
    if (!safeTag) return '';
    const pattern = new RegExp(`<<<${safeTag}_START>>>\\n([\\s\\S]*?)\\n<<<${safeTag}_END>>>`);
    const match = String(source).match(pattern);
    return match ? match[1] : '';
  }

  globalThis.PROMPT_SECTION_TAGS = SECTION_TAGS;
  globalThis.buildPromptSection = buildSection;
  globalThis.joinPromptSections = joinSections;
  globalThis.extractPromptSection = extractSectionContent;
})();
