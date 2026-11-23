---
phase: 01-isolated-backend-fork
plan: 04
subsystem: backend
tags: [rename, migrations, neon]
requires: [01-02, 01-03]
provides:
  - "backend/drizzle: single fresh 0000_init migration"
  - "Neon dev branch migrated; bookkeeping table drizzle.__drizzle_migrations (1 row)"
  - "test/migrate-folder.test.ts journal <-> SQL check"
affects: [01-05, 01-06]
tech-stack:
  added: []
  patterns: ["migrate only via src/migrate.ts over the direct (non-pooler) host"]
key-files:
  created:
    - backend/drizzle/0000_init.sql
    - backend/test/migrate-folder.test.ts
  modified:
    - backend/package.json
    - backend/drizzle.config.ts
    - backend/README.md
    - backend/drizzle/meta/_journal.json
    - backend/drizzle/meta/0000_snapshot.json
    - backend/test/integration/queue.pg.test.ts
    - backend/test/integration/quota.pg.test.ts
    - backend/test/upload-size.test.ts
    - backend/test/jose-contract.test.ts
    - backend/test/rate-limit.test.ts
    - backend/test/storage.local.test.ts
  deleted:
    - backend/drizzle/0001..0004 VirtSpace migrations + snapshots
decisions:
  - "Migrator bookkeeping table confirmed as drizzle.__drizzle_migrations (research A2 holds); /readyz in 01-05 can query it"
  - "No connection-string changes needed: channel_binding=require works with pg as-is"
  - "README rewritten as a short Virtumetry doc instead of section-by-section pruning (the old one was mostly stitcher/World Labs material)"
metrics:
  duration: ~10min
  completed: 2026-11-23
  tasks: 2
  files: 13
---

# Phase 1 Plan 04: Virtumetry rename + fresh migration Summary

VirtSpace identifiers are gone from the backend package, config, tests and README, and no dependency versions changed. The migration history is now one `0000_init.sql`, generated from the stripped schema. `src/migrate.ts` applied it to the Neon dev branch over the direct host and logged `[migrate] up to date`.

## Commits

| Task | Commit | Message |
|------|--------|---------|
| 1 | 942b5a8 | chore(backend): rename VirtSpace identifiers to Virtumetry |
| 2 (RED) | 9c41b71 | test(backend): add failing migrate-folder journal check |
| 2 (GREEN) | ae88cf0 | feat(backend): fresh Virtumetry migration history |

## For plan 01-05 (/readyz)

- Migrations table: **`drizzle.__drizzle_migrations`**. A read-only count on dev returns 1. The `public` schema holds 7 tables.
- Connection-string params on the dev URLs: `sslmode`, `channel_binding`. No adjustment was needed. Ad-hoc `pg` scripts print pg's sslmode deprecation warning; `migrate.ts` avoids it through `withVerifyFullSslMode`.

## Verification

- `npx tsc --noEmit` is clean. `npx vitest run`: 203 passed / 12 skipped (26 files, plus 2 skipped integration files).
- `grep -rni virtspace src test package.json drizzle.config.ts README.md` finds nothing.
- `git diff aeafbf0 -- backend/package.json` shows no version change for vitest, typescript, zod, drizzle-orm or fastify.
- `ls drizzle/*.sql` lists only `drizzle/0000_init.sql`.
- Before the migrate run, a check confirmed that the MIGRATE_DATABASE_URL host contains `ep-mute-fog-arwonnkz` and not `-pooler`. Production and VirtSpace resources were not touched, and `drizzle-kit push` was not used.

## Deviations from Plan

- The TDD RED test went in as its own `test(...)` commit, before the plan's single `feat(...)` commit.
- The integration quota suite prefix `virtspace_q_` became `virtumetry_q_`. The plan only named `virtspace_it_`, but the grep gate required it.
- Not in the plan: the README was rewritten instead of pruned (see decisions).

## TDD Gate Compliance

The RED commit 9c41b71 (the 0000_init test failed against the 5-entry journal) comes before the GREEN commit ae88cf0.

## Self-Check: PASSED

- FOUND: backend/drizzle/0000_init.sql, backend/test/migrate-folder.test.ts
- FOUND commits: 942b5a8, 9c41b71, ae88cf0
