# Phase 5: Viewer, Floor Plan, Measure & Share - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-24
**Phase:** 05-viewer-floor-plan-measure-share
**Areas discussed:** Fixture world, Viewer architecture, Walk/collision, Floor plan, Measure, Crash recovery, Share links, OG previews, Web route
**Mode:** --auto (all areas auto-selected; recommended option chosen each time)

## Fixture world
| Option | Selected |
|---|---|
| Generated synthetic demo room (splat + collider + floor plan + cameras + thumbnail), env-selected in mock | ✓ |
| Public sample splat download (licence + size risk, no matching collider) | |
| Keep 8-gaussian placeholder | |

## Viewer architecture
| Option | Selected |
|---|---|
| Spark 2.4 + three 0.187 imperative in one 'use dom' component (CLAUDE.md stack) | ✓ |
| PlayCanvas | |
| react-native-webview of hosted page | |

## Walk / collision
| Option | Selected |
|---|---|
| Capsule vs three-mesh-bvh, fixed eye height, joystick + drag look / WASD | ✓ |
| Gravity + stairs | |

## Floor plan
| Option | Selected |
|---|---|
| In-viewer panel, you-are-here dot, tap to teleport via provider affine | ✓ |
| Separate native screen | |

## Measure
| Option | Selected |
|---|---|
| Two taps raycast on collider, "≈ x.xx m (approx.)" | ✓ |
| Raycast on splat depth | |

## Crash recovery
| Option | Selected |
|---|---|
| webglcontextlost rebuild + native remount with saved pose, retry cap | ✓ |
| Show error + manual reload only | |

## Share links
| Option | Selected |
|---|---|
| Extend share_slugs (password_hash, open_count); scrypt; public open route counts; 15 min asset TTL | ✓ |
| Public bucket keys | |

## OG previews
| Option | Selected |
|---|---|
| Backend `/s/:slug` HTML landing with OG + noindex, redirect to web viewer | ✓ |
| Client-rendered meta only (scrapers don't run JS) | |
| Expo API routes (rejected by CLAUDE.md) | |

## Web route
| Option | Selected |
|---|---|
| Expo Router web `/r/[slug]`, eas deploy preview | ✓ |
| Separate Vite app | |

## Claude's Discretion
File split, joystick visuals, splat format/count, LoD constants, rate-limit numbers, wave split.

## Deferred Ideas
.RAD LoD build, custom domain, link expiry/analytics, RealityKit viewer.
