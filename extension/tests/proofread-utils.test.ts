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
    expect(result.failed[0]?.reason).toBe('ambiguous');
  });

  it('rejects overlapping edits', () => {
    const text = 'abcdef';
    const edits = [
      { op: 'replace', target: 'bcd', replacement: 'XXX', before: 'a', after: 'e' },
      { op: 'replace', target: 'cd', replacement: 'YY', before: 'b', after: 'e' }
    ];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe(text);
    expect(result.failed.some((item: { reason: string }) => item.reason === 'overlap')).toBe(true);
  });

  it('removes no-op edits', () => {
    const text = 'Same text';
    const edits = [{ op: 'replace', target: 'Same', replacement: 'Same' }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe(text);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('no_op');
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

  it('matches targets split across runs with optional whitespace', () => {
    const runs = ['Скачать', '.html'];
    const edits = [{ op: 'replace', target: 'Скачать .html', replacement: 'Скачать .html-файл' }];

    const result = ProofreadUtils.applyEdits(runs, edits);

    expect(result.newText).toBe('Скачать .html-файл');
    expect(result.failed).toHaveLength(0);
  });

  it('matches targets with NBSP using whitespace-optional search', () => {
    const text = `Жанры\u00A0`;
    const edits = [{ op: 'replace', target: 'Жанры', replacement: 'Жанры:' }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe(`Жанры:\u00A0`);
    expect(result.failed).toHaveLength(0);
  });

  it('matches targets with ZWSP using whitespace-optional search', () => {
    const text = `Пи\u200Bпп`;
    const edits = [{ op: 'replace', target: 'Пипп', replacement: 'Пипп!' }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe('Пипп!');
    expect(result.failed).toHaveLength(0);
  });

  it('treats occurrence 0 as first match', () => {
    const text = 'foo bar';
    const edits = [{ op: 'replace', target: 'foo', replacement: 'baz', occurrence: 0 }];

    const result = ProofreadUtils.applyEdits(text, edits);

    expect(result.newText).toBe('baz bar');
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
