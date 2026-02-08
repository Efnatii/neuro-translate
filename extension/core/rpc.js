const NT_RPC_PROTOCOL_VERSION = 1;
const DEFAULT_RPC_TIMEOUT_MS = 30000;

function createRpcId() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isJsonSafe(value, seen = new Set()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return false;
  if (typeof value === 'bigint') return false;
  if (value === null) return true;
  if (typeof value !== 'object') return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonSafe(item, seen));
  }
  return Object.values(value).every((item) => isJsonSafe(item, seen));
}

function buildRpcError(code, message, details) {
  const error = { code: code || 'rpc_error', message: message || 'RPC error' };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

class NtRpcServer {
  constructor({ portHub, notifications, defaultTimeoutMs } = {}) {
    this.portHub = portHub || null;
    this.notifications = notifications || null;
    this.defaultTimeoutMs = Number.isFinite(defaultTimeoutMs) ? defaultTimeoutMs : DEFAULT_RPC_TIMEOUT_MS;
    this.handlers = new Map();
  }

  registerHandler(methodName, handlerFn, options = {}) {
    if (!methodName || typeof handlerFn !== 'function') return;
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : this.defaultTimeoutMs;
    this.handlers.set(methodName, { handlerFn, timeoutMs });
  }

  registerPort(port) {
    if (!port || typeof port.onMessage?.addListener !== 'function') return;
    const senderTabId = port.sender?.tab?.id ?? null;
    const senderUrl = port.sender?.url ?? '';
    const onMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.kind !== 'rpc_req') return;
      // Chrome runtime messaging serializes through JSON, so guard against functions/undefined/cycles.
      if (!isJsonSafe(message)) {
        this._postError(port, message.id, 'invalid_request', 'RPC payload must be JSON-serializable.');
        return;
      }
      const { id, method, payload, meta } = message;
      if (typeof id !== 'string' || !method || typeof method !== 'string') {
        this._postError(port, id, 'invalid_request', 'RPC request must include id and method.');
        return;
      }
      const entry = this.handlers.get(method);
      if (!entry) {
        this._postError(port, id, 'not_found', `Unknown RPC method: ${method}`);
        return;
      }
      const { handlerFn, timeoutMs } = entry;
      const normalizedMeta = meta && typeof meta === 'object' ? { ...meta } : {};
      if (normalizedMeta.tabId == null && senderTabId != null) {
        normalizedMeta.tabId = senderTabId;
      }
      if (!normalizedMeta.url && senderUrl) {
        normalizedMeta.url = senderUrl;
      }
      let settled = false;
      const resolveOnce = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this._postOk(port, id, result);
      };
      const rejectOnce = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        this._postError(port, id, error?.code || 'handler_error', error?.message || String(error), error?.details);
      };
      const timeoutId = setTimeout(() => {
        rejectOnce(buildRpcError('timeout', 'RPC handler timed out.'));
      }, timeoutMs);
      Promise.resolve()
        .then(() => handlerFn(payload, normalizedMeta, message))
        .then(resolveOnce)
        .catch(rejectOnce);
    };
    port.onMessage.addListener(onMessage);
  }

  _postOk(port, id, result) {
    this._post(port, { kind: 'rpc_res', id, ok: true, result, ts: Date.now(), v: NT_RPC_PROTOCOL_VERSION });
  }

  _postError(port, id, code, message, details) {
    this._post(port, {
      kind: 'rpc_res',
      id,
      ok: false,
      error: buildRpcError(code, message, details),
      ts: Date.now(),
      v: NT_RPC_PROTOCOL_VERSION
    });
  }

  _post(port, payload) {
    try {
      port.postMessage(payload);
    } catch (error) {
      console.warn('Failed to post RPC response.', error);
    }
  }
}

class NtRpcClient {
  constructor({ port, defaultTimeoutMs } = {}) {
    this.port = port || null;
    this.defaultTimeoutMs = Number.isFinite(defaultTimeoutMs) ? defaultTimeoutMs : DEFAULT_RPC_TIMEOUT_MS;
    this.pending = new Map();
    this._onMessage = this._onMessage.bind(this);
    this._onDisconnect = this._onDisconnect.bind(this);
    if (this.port) {
      this.port.onMessage.addListener(this._onMessage);
      this.port.onDisconnect.addListener(this._onDisconnect);
    }
  }

  call(method, payload, options = {}) {
    if (!this.port) {
      return Promise.reject(buildRpcError('rpc_disconnected', 'RPC port is not connected.'));
    }
    if (!method || typeof method !== 'string') {
      return Promise.reject(buildRpcError('invalid_request', 'RPC method must be a string.'));
    }
    const id = createRpcId();
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : this.defaultTimeoutMs;
    const meta = options.meta && typeof options.meta === 'object' ? options.meta : undefined;
    const request = {
      kind: 'rpc_req',
      id,
      method,
      payload,
      meta,
      v: NT_RPC_PROTOCOL_VERSION
    };
    // Chrome runtime messaging serializes via JSON, so validate before sending.
    if (!isJsonSafe(request)) {
      return Promise.reject(buildRpcError('invalid_request', 'RPC payload must be JSON-serializable.'));
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(buildRpcError('timeout', 'RPC request timed out.'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeoutId });
      try {
        this.port.postMessage(request);
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(buildRpcError('rpc_post_failed', 'Failed to post RPC request.', error?.message || String(error)));
      }
    });
  }

  _onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.kind !== 'rpc_res') return;
    const id = message.id;
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timeoutId);
    if (message.ok) {
      entry.resolve(message.result);
      return;
    }
    entry.reject(message.error || buildRpcError('rpc_error', 'RPC error'));
  }

  _onDisconnect() {
    for (const [id, entry] of this.pending.entries()) {
      clearTimeout(entry.timeoutId);
      entry.reject(buildRpcError('rpc_disconnected', 'RPC port disconnected.'));
      this.pending.delete(id);
    }
  }
}

globalThis.NtRpcServer = NtRpcServer;
globalThis.NtRpcClient = NtRpcClient;
globalThis.ntRpcCreateId = createRpcId;
