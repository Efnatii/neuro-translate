# Cleanup checklist (manual regression)

Quick regression checklist after cleanup/quarantine changes:

1. Edge: load the unpacked extension from the `extension/` folder.
2. Open the popup: confirm it renders without errors.
3. Open the debug page: click **Self-check** and confirm `ok: true`.
4. Open a test page (Fimfiction or local HTML), start translation, and verify progress advances (done/failed count increases).
