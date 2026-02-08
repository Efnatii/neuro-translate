# Neuro Translate

Edge/Chromium extension that automatically translates webpages with the `gpt-5-nano` model. The popup lets you enter your API key, cancel translation on the current page, block the active domain, or disable the translator entirely.

## Installation
1. In Edge, open `edge://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select the `extension` folder from this repository.
3. Open the popup, paste your API key, and ensure translation is enabled.

When loading an unpacked extension, Chrome/Edge rejects folders or files that start with `_` or `__` because those prefixes are reserved by the browser. Tests now live in `extension/tests` (outside any reserved prefix) so the extension loads cleanly while Jest still discovers them.

## Usage
- Pages are translated automatically when enabled and not blocked.
- Use the popup to cancel an in-progress translation on the current page.
- Block or allow the active domain via the popup buttons.
- Disable the translator globally with the toggle in the popup.

## Reachability report (extension/)
Generate a report of reachable/unused extension files:

```bash
node tools/reachability-report.js
```

Outputs:
- `tools/reachability-report.json`
- `tools/reachability-report.md`

By default the script exits non-zero if unused candidates are detected. To allow unused files:

```bash
node tools/reachability-report.js --allow-unused
```

```bash
node tools/smoke-check.js
```
