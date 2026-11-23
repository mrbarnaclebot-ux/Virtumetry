---
phase: 2
slug: bundle-pipeline-mock-provider
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-11-23
---

# Phase 2 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2.1 (node env), `backend/test/**/*.test.ts` |
| **Config file** | `backend/vitest.config.ts` |
| **Quick run command** | `cd backend && npx vitest run test/bundle test/provider test/webhooks.test.ts` |
| **Full suite command** | `cd backend && npx tsc --noEmit && npx vitest run` |
| **PG integration** | `cd backend && node --env-file=.env scripts/test-pg.mjs` (sets `TEST_DATABASE_URL` from the asserted Neon dev direct URL in-process, never printed) |
| **R2 gated** | `cd backend && node --env-file=.env scripts/test-r2.mjs` (asserts `S3_BUCKET==='virtumetry-dev'`) |
| **Estimated runtime** | ~30 s unit, ~90 s with PG + R2 |

---

## Sampling Rate

- **After every task commit:** `npx tsc --noEmit && npx vitest run <touched test files>`
- **After every plan wave:** full suite + `scripts/test-pg.mjs`
- **Before `/gsd:verify-work`:** full suite + PG + gated R2 green, plus a `fixture:e2e` run log
- **Max feedback latency:** 120 seconds

---

## Per-Requirement Verification Map

| Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|----------|-----------|-------------------|-------------|--------|
| PROC-04 | `arkitToOpenCV` golden trajectory, det=+1, bottom row, round-trip | unit | `npx vitest run test/bundle/convert.test.ts` | ❌ W0 | ⬜ pending |
| PROC-04 | EXIF writer read back, strictly increasing, ≤64 KiB | unit | `npx vitest run test/bundle/exif.test.ts` | ❌ W0 | ⬜ pending |
| PROC-04 | Validator rules (each rule a failing case; fixture passes) | unit | `npx vitest run test/bundle/validate.test.ts` | ❌ W0 | ⬜ pending |
| PROC-04 | Pack fixture → store-only ZIP, exact entry names, intrinsics/trajectory shape, size exact | unit (fs) | `npx vitest run test/bundle/pack.test.ts` | ❌ W0 | ⬜ pending |
| PROC-04 | Presigned bundle on virtumetry-dev: Range 206, CD via Range, TTL 86400 | integration (gated S3) | `node --env-file=.env scripts/test-r2.mjs` | ❌ W0 | ⬜ pending |
| PROC-07 | pack→submit→track→import→ready, all artifacts in our storage, single ready UPDATE | integration (pg) | `scripts/test-pg.mjs` → `pipeline.pg.test.ts` | ❌ W0 | ⬜ pending |
| PROC-06 | Webhook valid/invalid/duplicate/missing-secret; nudge only | integration (pg + inject) | `scripts/test-pg.mjs` → `webhooks.pg.test.ts` | ❌ W0 | ⬜ pending |
| PROC-06 | Webhooks dropped → polling reaches ready | integration (pg) | `pipeline.pg.test.ts -t webhook_dropped` | ❌ W0 | ⬜ pending |
| PROC-10 | Scenarios FAILED/402/409/429/503/duplicate webhooks: final state + submit call count | integration (pg) | `pipeline.pg.test.ts -t scenario` | ❌ W0 | ⬜ pending |
| PROC-10 | Mock default; live refused without ALLOW_PAID_PROVIDER | unit | `npx vitest run test/config.test.ts` | ✅ extend | ⬜ pending |
| PROC-08 | Concurrent reservations over daily/monthly cap → exactly one; idempotent per key; release dated at reservation | integration (pg) | `scripts/test-pg.mjs` → `budget.pg.test.ts` | ❌ W0 | ⬜ pending |
| PROC-08 | Over-budget submit → failed/submit BUDGET_EXCEEDED, 0 provider submits | integration (pg) | `pipeline.pg.test.ts -t budget` | ❌ W0 | ⬜ pending |
| — | `snoozeJob` keeps attempts, claimable after delay | integration (pg) | `queue.pg.test.ts` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `test/fixtures/tiny-session/` (+ README licence) via `scripts/make-tiny-session.*`
- [ ] `test/fixtures/mock-outputs/*`
- [ ] `test/helpers/capture-exif.ts` (vendored MIT-0 reader)
- [ ] `test/helpers/pg-schema.ts` (apply real migrations into a throwaway schema) if needed
- [ ] `scripts/test-pg.mjs`, `scripts/test-r2.mjs`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full loop against dev R2 + Neon dev | PROC-04/07 | Needs real cloud creds | `cd backend && node --env-file=.env` + `npm run fixture:e2e`; capture log |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
