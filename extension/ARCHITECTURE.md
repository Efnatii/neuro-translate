# Extension Architecture

## Contexts
- **Background service worker (background.js)**: source of truth for state and message routing.
- **Content script (content-script.js)**: runs in page context and relays data to/from background.
- **Popup UI (popup.html + popup.js)**: user-facing controls and state display.
- **Debug UI (debug.html + debug.js)**: developer diagnostics and logs.

## Communication Channels
- **chrome.runtime.sendMessage / onMessage**: request-response or one-off notifications.
- **chrome.runtime.connect / Port**: long-lived channels (e.g., popup/debug to background).

## State & Event Flow
- **State lives in the background service worker.**
- UI contexts subscribe to updates and receive broadcasts (patches) from background.
- Shared message envelopes standardize event metadata and payloads.
