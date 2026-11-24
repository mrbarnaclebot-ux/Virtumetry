# Phase 4: $0 Capture-to-World Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-24
**Phase:** 04-0-capture-to-world-loop
**Areas discussed:** Fixture source, Remote threshold tuning, Coverage mini-map, Local scan persistence, Backend checks, Upload routes, Upload manager, Dev budget

Mode: `--auto` — Claude selected the recommended option for each area; no owner prompts.

## Fixture source
| Option | Selected |
|---|---|
| Bundle 30-frame TUM fixture in app assets, copy into a real session dir | ✓ |
| Download fixture from dev R2 on demand | |
| Synthetic generated frames | |

## Remote threshold tuning
| Option | Selected |
|---|---|
| `GET /v1/capture/config` from validated `CAPTURE_CONFIG_JSON` env + code defaults | ✓ |
| EAS Update constants only | |
| Remote config service | |

## Coverage mini-map
| Option | Selected |
|---|---|
| react-native-svg top-down path + 12 yaw sectors | ✓ |
| Skia canvas | |

## Local scan persistence
| Option | Selected |
|---|---|
| JSON index via expo-file-system next to session dirs | ✓ |
| AsyncStorage (new dep) | |

## Backend checks timing
| Option | Selected |
|---|---|
| Synchronous at `:complete` on manifest files + pack-time second line | ✓ |
| Only in pack job | |

## Upload routes
| Option | Selected |
|---|---|
| New `/v1/scans` routes; remove legacy `.heic` create/refresh/frames:done | ✓ |
| Reshape `/v1/worlds` create in place | |

## Upload manager
| Option | Selected |
|---|---|
| App-scoped reconciler, R2 truth via `uploads:missing`, all PUTs enqueued, manifest last | ✓ |
| Client-side ledger | |

## Dev budget
| Option | Selected |
|---|---|
| Raise caps on Railway dev only + optional guarded reset script | ✓ |
| Reset script only | |

## Claude's Discretion
File layout, HUD visuals (UI-SPEC), thresholds, batch sizes, plan split, review/quote screen split.

## Deferred Ideas
Coaching/tracking pause/heat (Phase 8), on-device threshold tuning UI, push notifications, retry (Phase 6).
