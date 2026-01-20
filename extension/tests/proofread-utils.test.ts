import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ProofreadUtils = require('../proofread-utils.js');

describe('ProofreadUtils.applyEdits', () => {
  it('applies edits with quotes and emoji correctly', () => {
    const text = 'He said "hi" 😊';
    const edits = [
      { op: 'replace', target: '"hi"', replacement: '«hi»' }
    ];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe('He said «hi» 😊');
    expect(result.failed).toHaveLength(0);
  });

  it('flags repeated target without context as model violation', () => {
    const text = 'foo bar foo';
    const edits = [{ op: 'replace', target: 'foo', replacement: 'baz' }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe(text);
    expect(result.failed[0]?.reason).toBe('model_violation');
  });

  it('rejects overlapping edits', () => {
    const text = 'abcdef';
    const edits = [
      { op: 'replace', target: 'bcd', replacement: 'XXX', before: 'a', after: 'e' },
      { op: 'replace', target: 'cd', replacement: 'YY', before: 'b', after: 'e' }
    ];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe('aXXXef');
    expect(result.failed.some((item: { reason: string }) => item.reason === 'overlap')).toBe(true);
  });

  it('removes no-op edits', () => {
    const text = 'Same text';
    const edits = [{ op: 'replace', target: 'Same', replacement: 'Same' }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe(text);
    expect(result.failed[0]?.reason).toBe('no_op');
  });

  it('falls back to rewrite text on model violation', () => {
    const text = 'Hello world';
    const edits = [{ op: 'replace', target: 'missing', replacement: 'found' }];

    const result = ProofreadUtils.applyEdits(text, edits, 'Hello there');

    expect(result.newText).toBe('Hello there');
    expect(result.usedRewrite).toBe(true);
  });

  it('treats concatenated runs as a single block', () => {
    const text = 'Hello' + 'World';
    const edits = [{ op: 'replace', target: 'HelloWorld', replacement: 'Hello World' }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe('Hello World');
    expect(result.failed).toHaveLength(0);
  });
});

describe('ProofreadUtils.debugTargetNotFound', () => {
  it('highlights NBSP and angle quotes in context', () => {
    const text = '«Привет»\u00A0мир';
    const target = '"Привет" мир';

    const matches = ProofreadUtils.debugTargetNotFound(text, target);

    expect(matches.length).toBeGreaterThan(0);
    const codePoints = matches[0].codePoints.join(' ');
    expect(codePoints).toContain('LEFT ANGLE QUOTE');
    expect(codePoints).toContain('NBSP');
  });
});
