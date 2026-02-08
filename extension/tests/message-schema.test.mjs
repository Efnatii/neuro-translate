import { describe, it, expect } from 'vitest';
import '../core/message-schema.js';

describe('message-schema', () => {
  it('ntCreateMessage creates a stable envelope', () => {
    const envelope = globalThis.ntCreateMessage('PING', { ok: true }, { tabId: 7 });
    expect(envelope).toBeTruthy();
    expect(envelope.type).toBe('PING');
    expect(envelope.payload).toEqual({ ok: true });
    expect(envelope.meta).toEqual({ tabId: 7 });
    expect(typeof envelope.ts).toBe('number');
    expect(typeof envelope.id).toBe('string');
    expect(envelope.v).toBe(1);
  });

  it('ntNormalizeEnvelope rejects invalid payloads', () => {
    expect(globalThis.ntNormalizeEnvelope(null)).toBeNull();
    expect(globalThis.ntNormalizeEnvelope({})).toBeNull();
    expect(globalThis.ntNormalizeEnvelope({ type: 'PING', v: 999 })).toBeNull();
  });

  it('JSON.stringify(envelope) is safe and keeps required fields', () => {
    const envelope = globalThis.ntCreateMessage('PONG', { ok: true }, { tabId: 3 });
    const json = JSON.stringify(envelope);
    expect(typeof json).toBe('string');
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('PONG');
    expect(parsed.payload).toEqual({ ok: true });
    expect(parsed.meta).toEqual({ tabId: 3 });
    expect(typeof parsed.ts).toBe('number');
    expect(typeof parsed.id).toBe('string');
    expect(parsed.v).toBe(1);
  });
});
