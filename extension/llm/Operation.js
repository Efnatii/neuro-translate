(function initOperationTypes() {
  if (globalThis.ntLlmOperationTypes) return;
  globalThis.ntLlmOperationTypes = {
    TRANSLATE: 'translate',
    PROOFREAD: 'proofread',
    REPAIR: 'repair',
    VALIDATE: 'validate',
    UI: 'ui'
  };
}());
