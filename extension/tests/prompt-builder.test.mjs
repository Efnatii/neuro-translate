import { describe, it, expect } from 'vitest';
import '../core/prompt-tags.js';
import '../core/prompt-builder.js';

describe('prompt-builder', () => {
  it('buildTranslationUserPrompt contains required tags and segment ids', () => {
    const builder = new globalThis.PromptBuilder();
    const prompt = builder.buildTranslationUserPrompt({
      segments: ['Hello', 'World'],
      targetLanguage: 'Spanish',
      contextMode: 'FULL',
      contextText: 'Context'
    });
    expect(prompt).toContain('<<<TASK_START>>>');
    expect(prompt).toContain('<<<RULES_START>>>');
    expect(prompt).toContain('<<<SEGMENTS_START>>>');
    expect(prompt).toContain('<<<OUTPUT_CONTRACT_START>>>');
    expect(prompt).toContain('0: Hello');
    expect(prompt).toContain('1: World');
  });

  it('buildTranslationUserPrompt enforces JSON-only contract', () => {
    const builder = new globalThis.PromptBuilder();
    const prompt = builder.buildTranslationUserPrompt({
      segments: ['Hello'],
      targetLanguage: 'Spanish'
    });
    expect(prompt).toContain('Return JSON');
    expect(prompt).toContain('No extra keys or commentary');
  });
});
