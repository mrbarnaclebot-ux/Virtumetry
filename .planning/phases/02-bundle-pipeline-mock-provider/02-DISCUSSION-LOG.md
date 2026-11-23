# Phase 2: Bundle Pipeline & Mock Provider - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-23
**Phase:** 2-bundle-pipeline-mock-provider
**Areas discussed:** Session format, Bundle building & EXIF, Fixture source, Provider interface & mock scenarios, State machine & budget, Webhooks, Test evidence
**Mode:** `--auto` — every question resolved with the recommended option, no owner prompts.

---

## Session format
| Option | Description | Selected |
|---|---|---|
| ARCHITECTURE.md contract (raw ARKit values, schema 1) | Phone stores raw values; backend converts | ✓ |
| Phone writes Echo-3 bundle layout directly | Conversion in Swift | |
[auto] Session format — Q: "Where do poses/EXIF get converted?" → Selected: "Backend (raw ARKit on disk)" (recommended default)

## Bundle building & EXIF
| Option | Description | Selected |
|---|---|---|
| Hand-written minimal EXIF APP1 writer | 3 tags, no dependency | ✓ |
| piexifjs / exiftool | Extra dependency | |
[auto] EXIF — Q: "EXIF writer?" → Selected: "Hand-written minimal writer" (recommended default)
[auto] ZIP — Q: "ZIP streaming?" → Selected: "yazl store-only + lib-storage multipart" (recommended default, per STACK.md)
[auto] Presign TTL — Q: "Bundle presign TTL?" → Selected: "24 h" (recommended, SUMMARY.md settlement)

## Fixture source
| Option | Description | Selected |
|---|---|---|
| Permissive public posed dataset (TUM RGB-D first) converted to ARKit convention | Legal to commit a few frames | ✓ |
| ARKitScenes | Real ARKit poses; license check needed | fallback |
| Synthetic procedural frames | No licence risk, weaker realism | |
[auto] Fixture — Q: "Fixture source?" → Selected: "Public posed dataset, researcher confirms licence" (recommended)

## Provider interface & mock scenarios
[auto] Q: "Interface?" → Selected: "ReconProvider from ARCHITECTURE.md, drop World Labs shape" (recommended)
[auto] Q: "Scenario selection?" → Selected: "Per-instance in tests + MOCK_SCENARIO env" (recommended)
[auto] Q: "Mock quote?" → Selected: "900 + frames (exercise budget)" (recommended)

## State machine & budget
[auto] Q: "Build submit state machine now or in Phase 6?" → Selected: "Now, provider-agnostic" (recommended — SC4 requires no-extra-submit proof)
[auto] Q: "Budget windows?" → Selected: "Daily + monthly, keyed on submission_key, mock/live separated" (recommended)

## Webhooks
[auto] Q: "Webhook role?" → Selected: "Nudge only; track job is sole writer" (recommended)

## Test evidence
[auto] Q: "Range preflight?" → Selected: "Against virtumetry-dev, skipped without S3 env" (recommended)

## Claude's Discretion
- Trimming existing /v1/worlds routes now vs Phase 3; backoff numbers; bundle/ module split; mock cameras.json generation; plan/wave structure.

## Deferred Ideas
- App-facing upload routes (Phase 3/4), live echo3 client (Phase 6), thumbnails, .RAD LoD (Phase 5), retention (Phase 9).
