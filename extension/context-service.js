async function generateTranslationContext(
  text,
  apiKey,
  targetLanguage = 'ru',
  model,
  apiBaseUrl = OPENAI_API_URL
) {
  if (!text?.trim()) return '';

  const prompt = applyPromptCaching([
    {
      role: 'system',
      content: [
        'You are a translator assistant. Produce context that improves translation quality.',
        'Do not paraphrase the text, do not evaluate it, and do not add facts not present in the source.',
        'If information is missing, write "not specified".',
        'Focus on details that affect accuracy, terminology consistency, style, and meaning.',
        'Do not suggest leaving names/titles/terms untranslated unless explicitly stated in the text.',
        'Your response must be structured and concise.'
      ].join(' ')
    },
    {
      role: 'user',
      content: [
        `Analyze the source text and produce translation context for ${targetLanguage}.`,
        'Provide the most useful details for the translator.',
        'Format strictly by the sections below (brief, bullet points).',
        '',
        '1) Text type and purpose:',
        '- genre/domain (fiction, tech docs, marketing, UI, news, etc.)',
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
        '- recommended translations if clearly implied by context',
        '- what must not be translated or must be left as-is (only if explicitly stated)',
        '',
        '7) Proper names and onomastics:',
        '- names, brands, products, organizations, toponyms',
        '- how to render: translate/transliterate/leave as-is (leave as-is only with explicit instruction)',
        '',
        '8) Tone and style:',
        '- formal/informal/neutral/literary/ironic, etc.',
        '- level of formality and politeness (tu/vous, honorifics)',
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
        'Text:',
        text,
        '',
        'Output only the sections with brief bullet points.',
        'If a section is empty, write "not specified".'
      ].join('\n')
    }
  ], apiBaseUrl);

  const response = await fetch(apiBaseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: prompt
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Context request failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No context returned');
  }

  return typeof content === 'string' ? content.trim() : '';
}
