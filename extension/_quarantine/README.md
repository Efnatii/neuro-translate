# Quarantine

This folder holds files that were detected as unreachable by `tools/reachability-report.js` and moved here
instead of being deleted. It is a safety net while verifying extension behavior in Edge.

## How this quarantine was created
- Source report: `tools/reachability-report.json`
- Commit: 053e553
- Date: 2025-09-27

## Retention policy
Quarantine is removed only after **two** successful releases/commits **and** a confirmed smoke test.
Record the confirmation commit/date below when verified:

- Smoke verified: 2025-09-27 (commit: ed97a21)

## Moved files
- `extension/package.json`
- `extension/tests/README.md`
- `extension/tests/guardrails.test.js`

## How to restore
Move a file back to its original location, preserving the relative path. Example:

```bash
git mv extension/_quarantine/package.json extension/package.json
```

Then re-run:

```bash
node tools/reachability-report.js
```

If the file is required, the report will mark it reachable again.
