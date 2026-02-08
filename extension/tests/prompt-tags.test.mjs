import { describe, it, expect } from 'vitest';
import '../core/prompt-tags.js';

describe('prompt-tags', () => {
  it('ntWrapTag wraps content with START/END tags', () => {
    const wrapped = globalThis.ntWrapTag('TASK', 'Hello');
    expect(wrapped).toContain('<<<TASK_START>>>');
    expect(wrapped).toContain('Hello');
    expect(wrapped).toContain('<<<TASK_END>>>');
  });

  it('ntJoinTaggedBlocks preserves order', () => {
    const joined = globalThis.ntJoinTaggedBlocks([
      { tag: 'FIRST', content: 'one' },
      { tag: 'SECOND', content: 'two' }
    ]);
    expect(joined.indexOf('<<<FIRST_START>>>')).toBeLessThan(joined.indexOf('<<<SECOND_START>>>'));
  });

  it('ntSafeText normalizes line breaks', () => {
    const text = globalThis.ntSafeText('a\r\nb\rc');
    expect(text).toBe('a\nb\nc');
  });
});
