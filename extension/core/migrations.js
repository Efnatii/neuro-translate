(() => {
  const LATEST_STATE_VERSION = 2;
  const OBSOLETE_STORAGE_KEYS = [
    'openAi' + 'Organization',
    'openAi' + 'Project',
    'single' + 'Block' + 'Concurrency'
  ];

  /**
   * @param {Record<string, any>} state
   * @returns {{migratedState: Record<string, any>, changed: boolean, fromVersion: number, toVersion: number}}
   */
  function migrateState(state) {
    const baseState = state && typeof state === 'object' ? { ...state } : {};
    const initialVersion = Number.isFinite(baseState.stateVersion) ? Number(baseState.stateVersion) : 1;
    let version = initialVersion;
    let current = { ...baseState };
    let changed = false;

    while (version < LATEST_STATE_VERSION) {
      if (version === 1) {
        const next = { ...current };
        OBSOLETE_STORAGE_KEYS.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(next, key)) {
            delete next[key];
            changed = true;
          }
        });
        if (!Object.prototype.hasOwnProperty.call(next, 'notificationsEnabled')) {
          next.notificationsEnabled = false;
          changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(next, 'translationStatusByTab')) {
          next.translationStatusByTab = {};
          changed = true;
        }
        if (!Object.prototype.hasOwnProperty.call(next, 'translationJobById')) {
          next.translationJobById = {};
          changed = true;
        }
        if (next.stateVersion !== 2) {
          next.stateVersion = 2;
          changed = true;
        }
        current = next;
        version = 2;
        continue;
      }
      break;
    }

    const toVersion = version;
    return {
      migratedState: current,
      changed,
      fromVersion: initialVersion,
      toVersion
    };
  }

  globalThis.migrateState = migrateState;
})();
