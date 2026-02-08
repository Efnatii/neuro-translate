(() => {
  class PortHub {
    constructor() {
      /** @type {Map<chrome.runtime.Port, {name: string, createdAt: number, senderTabId?: number, senderUrl?: string}>} */
      this.portInfoByPort = new Map();
      /** @type {Map<string, Set<chrome.runtime.Port>>} */
      this.portsByGroup = new Map();
    }

    /**
     * @param {chrome.runtime.Port} port
     * @returns {void}
     */
    registerPort(port) {
      if (!port || typeof port !== 'object') return;
      const name = String(port.name || '');
      const senderTabId = port.sender?.tab?.id;
      const senderUrl = port.sender?.url;
      const info = {
        name,
        createdAt: Date.now(),
        ...(typeof senderTabId === 'number' ? { senderTabId } : {}),
        ...(typeof senderUrl === 'string' ? { senderUrl } : {})
      };

      this.portInfoByPort.set(port, info);
      this.addToGroup(name, port);

      if (name === 'popup' || name === 'debug') {
        this.sendUiHandshake(port);
      }

      port.onDisconnect.addListener(() => {
        this.unregisterPort(port);
      });
    }

    /**
     * @param {chrome.runtime.Port} port
     * @returns {void}
     */
    sendUiHandshake(port) {
      const protocolVersion = typeof globalThis.NT_PROTOCOL_VERSION === 'number' ? globalThis.NT_PROTOCOL_VERSION : 1;
      const capabilities = {
        supportsHeartbeat: true,
        supportsSnapshot: true,
        supportsPatch: true
      };
      const helloPayload = {
        protocolVersion,
        capabilities,
        nowTs: Date.now()
      };
      const helloEnvelope = globalThis.ntCreateMessage
        ? globalThis.ntCreateMessage('HELLO', helloPayload)
        : { type: 'HELLO', payload: helloPayload };
      this.sendToPort(port, helloEnvelope);

      const sendSnapshot = async () => {
        const stateStore = globalThis.ntStateStore;
        if (!stateStore) return;
        if (typeof stateStore.isReady === 'function' && !stateStore.isReady()) {
          if (globalThis.ntStateStoreReadyPromise) {
            await globalThis.ntStateStoreReadyPromise;
          }
        }
        const snapshot = typeof stateStore.snapshot === 'function' ? stateStore.snapshot() : { state: stateStore.get(), ts: Date.now() };
        const snapshotEnvelope = globalThis.ntCreateMessage
          ? globalThis.ntCreateMessage('STATE_SNAPSHOT', snapshot)
          : { type: 'STATE_SNAPSHOT', payload: snapshot };
        this.sendToPort(port, snapshotEnvelope);
      };

      if (globalThis.queueMicrotask) {
        queueMicrotask(() => {
          void sendSnapshot();
        });
        return;
      }
      Promise.resolve().then(() => sendSnapshot());
    }

    /**
     * @param {string} group
     * @param {any} envelope
     * @returns {boolean}
     */
    broadcast(group, envelope) {
      const ports = this.portsByGroup.get(group);
      if (!ports || !ports.size) return false;
      let delivered = false;
      for (const port of [...ports]) {
        if (this.sendToPort(port, envelope)) {
          delivered = true;
        }
      }
      return delivered;
    }

    /**
     * @param {any} envelope
     * @returns {boolean}
     */
    broadcastUi(envelope) {
      const deliveredPopup = this.broadcast('popup', envelope);
      const deliveredDebug = this.broadcast('debug', envelope);
      return deliveredPopup || deliveredDebug;
    }

    /**
     * @param {chrome.runtime.Port} port
     * @param {any} envelope
     * @returns {boolean}
     */
    sendToPort(port, envelope) {
      try {
        port.postMessage(envelope);
        return true;
      } catch (error) {
        console.warn('[PortHub] Failed to post message to port.', error);
        this.unregisterPort(port);
        return false;
      }
    }

    /**
     * @param {number} tabId
     * @param {any} envelope
     * @returns {boolean}
     */
    sendToTab(tabId, envelope) {
      if (!Number.isFinite(tabId)) return false;
      try {
        chrome.tabs.sendMessage(tabId, envelope, () => {
          if (chrome.runtime.lastError) {
            // Ignore missing listeners.
          }
        });
        return true;
      } catch (error) {
        // Ignore missing listeners.
        return false;
      }
    }

    /**
     * @param {chrome.runtime.Port} port
     * @returns {void}
     */
    unregisterPort(port) {
      const info = this.portInfoByPort.get(port);
      if (info) {
        this.removeFromGroup(info.name, port);
      }
      this.portInfoByPort.delete(port);
    }

    /**
     * @param {string} group
     * @param {chrome.runtime.Port} port
     */
    addToGroup(group, port) {
      if (!group) return;
      if (!this.portsByGroup.has(group)) {
        this.portsByGroup.set(group, new Set());
      }
      this.portsByGroup.get(group).add(port);
    }

    /**
     * @param {string} group
     * @param {chrome.runtime.Port} port
     */
    removeFromGroup(group, port) {
      const set = this.portsByGroup.get(group);
      if (!set) return;
      set.delete(port);
      if (!set.size) this.portsByGroup.delete(group);
    }
  }

  globalThis.PortHub = PortHub;
  globalThis.ntPortHub = globalThis.ntPortHub || new PortHub();
})();
