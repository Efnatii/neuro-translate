import { describe, expect, it } from 'vitest';

import { applyEdits, validateEditsAgainstText, type AnchorEdit } from './edits';

describe('applyEdits', () => {
  it('handles repeated targets with anchors and occurrence', () => {
    const text = 'Hello world. Hello world.';
    const edits: AnchorEdit[] = [
      {
        op: 'replace',
        target: 'Hello',
        replacement: 'Hi',
        occurrence: 2,
        before: 'world. ',
        after: ' world.'
      }
    ];
    const result = applyEdits(text, edits);
    expect(result.ok).toBe(true);
    expect(result.newText).toBe('Hello world. Hi world.');
  });

  it('keeps newline formatting and applies a fix', () => {
    const text = 'Line one.\r\nLine two.';
    const edits: AnchorEdit[] = [
      {
        op: 'replace',
        target: 'Line two.',
        replacement: 'Line two!',
        occurrence: 1
      }
    ];
    const result = applyEdits(text, edits);
    expect(result.newText).toBe('Line one.\nLine two!');
  });

  it('handles quotes and em dashes', () => {
    const text = 'Он сказал: «Привет» — и ушёл.';
    const edits: AnchorEdit[] = [
      {
        op: 'replace',
        target: 'ушёл',
        replacement: 'ушел',
        occurrence: 1,
        before: ' и ',
        after: '.'
      }
    ];
    const result = applyEdits(text, edits);
    expect(result.newText).toBe('Он сказал: «Привет» — и ушел.');
  });

  it('handles emoji without byte indexing', () => {
    const text = 'Great job 👍. Great job 👍.';
    const edits: AnchorEdit[] = [
      {
        op: 'replace',
        target: 'Great job 👍',
        replacement: 'Nice work 👍',
        occurrence: 2,
        before: '. ',
        after: '.'
      }
    ];
    const result = applyEdits(text, edits);
    expect(result.newText).toBe('Great job 👍. Nice work 👍.');
  });

  it('drops overlapping edits for safety', () => {
    const text = 'Fix this sentence now.';
    const edits: AnchorEdit[] = [
      {
        op: 'replace',
        target: 'Fix this sentence',
        replacement: 'Update this sentence',
        occurrence: 1
      },
      {
        op: 'replace',
        target: 'sentence now',
        replacement: 'sentence right now',
        occurrence: 1
      }
    ];
    const result = validateEditsAgainstText(edits, text);
    expect(result.applied.length + result.failed.length).toBe(2);
    expect(result.failed.length).toBe(1);
  });

  it('applies insert_before and insert_after', () => {
    const text = 'World';
    const edits: AnchorEdit[] = [
      {
        op: 'insert_before',
        target: 'World',
        replacement: 'Hello ',
        occurrence: 1
      },
      {
        op: 'insert_after',
        target: 'World',
        replacement: '!',
        occurrence: 1
      }
    ];
    const result = applyEdits(text, edits);
    expect(result.newText).toBe('Hello World!');
  });
});
