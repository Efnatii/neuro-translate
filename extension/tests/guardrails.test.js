const guardrails = require('../guardrails');

describe('guardrails', () => {
  beforeEach(() => {
    globalThis.ntJsonLogEnabled = () => false;
    globalThis.ntJsonLog = jest.fn();
  });

  afterEach(() => {
    delete globalThis.ntJsonLogEnabled;
    delete globalThis.ntJsonLog;
  });

  test('assertCountMatch returns ok when counts align', () => {
    const result = guardrails.assertCountMatch('translate', 2, 2, { requestId: 'req-1' });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test('assertCountMatch returns an error when counts differ', () => {
    const result = guardrails.assertCountMatch('translate', 2, 3, { requestId: 'req-2' });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(guardrails.InvariantError);
    expect(result.error.guardrailKind).toBe('count_mismatch');
  });

  test('assertIdsSubset returns ok when ids are expected', () => {
    const expectedIds = new Set(['a', 'b']);
    const result = guardrails.assertIdsSubset('proofread', expectedIds, ['a'], { requestId: 'req-3' });

    expect(result.ok).toBe(true);
  });

  test('assertIdsSubset returns an error with extras', () => {
    const expectedIds = new Set(['a']);
    const result = guardrails.assertIdsSubset('proofread', expectedIds, ['a', 'b'], { requestId: 'req-4' });

    expect(result.ok).toBe(false);
    expect(result.error.guardrailKind).toBe('ids_subset');
    expect(result.error.details.extras).toEqual(['b']);
  });

  test('assertPlaceholdersMatch detects mismatches', () => {
    const result = guardrails.assertPlaceholdersMatch(
      'Hello {{name}}',
      'Bonjour {{prenom}}',
      { stage: 'translate', requestId: 'req-5' }
    );

    expect(result.ok).toBe(false);
    expect(result.error.guardrailKind).toBe('placeholders');
  });

  test('classifyInvariantViolation returns guardrail kind when present', () => {
    const error = new guardrails.InvariantError('nope', { kind: 'ids_subset', details: { extras: ['x'] } });
    const classification = guardrails.classifyInvariantViolation(error);

    expect(classification).toEqual({ kind: 'ids_subset', details: { extras: ['x'] } });
  });
});
