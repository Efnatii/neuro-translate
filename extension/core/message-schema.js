(() => {
  const NT_PROTOCOL_VERSION = 1;

  /**
   * @typedef {Object} NtMeta
   * @property {number=} tabId
   * @property {string=} url
   * @property {string=} requestId
   * @property {string=} parentRequestId
   * @property {string=} stage
   * @property {string=} source
   */

  /**
   * @typedef {Object} NtMessageEnvelope
   * @property {string} type
   * @property {any} payload
   * @property {NtMeta} meta
   * @property {number} ts
   * @property {string} id
   * @property {number} v
   */

  /**
   * @typedef {Object} TranslationStatus
   * @property {string} jobId
   * @property {number} tabId
   * @property {string} url
   * @property {"idle"|"context"|"translation"|"proofread"|"apply"|"done"|"cancelled"|"error"} stage
   * @property {{completed:number,total:number,inFlight:number}} progress
   * @property {number} lastUpdateTs
   * @property {{code:string,message:string}=} error
   */

  const hasCrypto = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function';

  function createId() {
    if (hasCrypto) return crypto.randomUUID();
    return `nt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  /**
   * @param {string} type
   * @param {any} payload
   * @param {NtMeta=} meta
   * @returns {NtMessageEnvelope}
   */
  function ntCreateMessage(type, payload, meta) {
    return {
      type: String(type),
      payload: payload ?? null,
      meta: meta ? { ...meta } : {},
      ts: Date.now(),
      id: createId(),
      v: NT_PROTOCOL_VERSION
    };
  }

  /**
   * @param {any} obj
   * @returns {obj is NtMessageEnvelope}
   */
  function ntIsEnvelope(obj) {
    return Boolean(
      obj &&
        typeof obj === 'object' &&
        typeof obj.type === 'string' &&
        typeof obj.ts === 'number' &&
        typeof obj.id === 'string' &&
        typeof obj.v === 'number' &&
        Object.prototype.hasOwnProperty.call(obj, 'payload') &&
        obj.meta &&
        typeof obj.meta === 'object'
    );
  }

  /**
   * @param {any} obj
   * @returns {NtMessageEnvelope | null}
   */
  function ntNormalizeEnvelope(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (typeof obj.type !== 'string') return null;
    const v = typeof obj.v === 'number' ? obj.v : NT_PROTOCOL_VERSION;
    if (v !== NT_PROTOCOL_VERSION) return null;
    const meta = obj.meta && typeof obj.meta === 'object' ? { ...obj.meta } : {};
    const ts = typeof obj.ts === 'number' ? obj.ts : Date.now();
    const id = typeof obj.id === 'string' ? obj.id : createId();
    const payload = Object.prototype.hasOwnProperty.call(obj, 'payload') ? obj.payload : null;
    return {
      type: obj.type,
      payload,
      meta,
      ts,
      id,
      v
    };
  }

  globalThis.NT_PROTOCOL_VERSION = NT_PROTOCOL_VERSION;
  globalThis.ntCreateMessage = ntCreateMessage;
  globalThis.ntIsEnvelope = ntIsEnvelope;
  globalThis.ntNormalizeEnvelope = ntNormalizeEnvelope;
})();
