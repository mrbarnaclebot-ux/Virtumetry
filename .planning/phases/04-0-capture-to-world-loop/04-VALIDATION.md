---
phase: 4
slug: 0-capture-to-world-loop
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-11-24
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 04-RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | App: jest 30 + jest-expo ~58 + RNTL 14. Backend: vitest ^2.1 |
| **Config file** | `virtumetry/package.json` "jest"; `backend/vitest.config.ts` |
| **Quick run command** | `cd virtumetry && npx jest --ci src/__tests__/<file>` / `cd backend && npx vitest run test/<file>` |
| **Full suite command** | `cd virtumetry && npx expo lint && npx tsc --noEmit && npx jest --ci` ; `cd backend && npx tsc --noEmit && npx vitest run && npm run test:pg` |
| **Estimated runtime** | ~60–180 seconds per side |

---

## Sampling Rate

- **After every task commit:** quick-run command for touched files
- **After every plan wave:** full suite of the affected side(s)
- **Before `/gsd:verify-work`:** both full suites green
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

| Req | Behavior | Test Type | Automated Command | File Exists | Status |
|-----|----------|-----------|-------------------|-------------|--------|
| CAP-01 | prep first-run vs compact, permission granted/denied | RNTL | `npx jest --ci src/__tests__/capture-prep.test.tsx` | ❌ W0 | ⬜ |
| CAP-05 | readiness worst-of + reason; config merge | unit | `npx jest --ci src/__tests__/capture-readiness.test.ts` ; `npx vitest run test/capture-config.test.ts` | ❌ W0 | ⬜ |
| CAP-06 | cost 900+frames in $ | unit | `npx jest --ci src/__tests__/capture-cost.test.ts` | ❌ W0 | ⬜ |
| CAP-07 | coverage path + sectors | unit | `npx jest --ci src/__tests__/capture-coverage.test.ts` | ❌ W0 | ⬜ |
| CAP-09 | persistent store + review screen | unit+RNTL | `npx jest --ci src/__tests__/capture-store.test.ts src/__tests__/capture-review.test.tsx` | ❌ W0 | ⬜ |
| CAP-10 | fixture source events + schema-1 dir + scenarios | unit | `npx jest --ci src/__tests__/capture-fixture-source.test.ts` | ❌ W0 | ⬜ |
| PROC-01 | device precheck; server validator rules; 0 credits on fail | unit + pg | `npx jest --ci src/__tests__/capture-precheck.test.ts` ; `npx vitest run test/bundle/validate.test.ts` ; `npm run test:pg -- test/integration/scans.pg.test.ts` | partial | ⬜ |
| PROC-02 | quote route + explicit approve | vitest+RNTL | `npx vitest run test/scans.quote.test.ts` ; `npx jest --ci src/__tests__/capture-quote.test.tsx` | ❌ W0 | ⬜ |
| PROC-02/SC4 | e2e create→upload→complete→ready via mock | pg e2e | `npm run test:pg -- test/integration/scans-e2e.pg.test.ts` | ❌ W0 | ⬜ |
| PROC-03 | scans routes + reconciler force-quit simulation | pg + unit | `npm run test:pg -- test/integration/scans.pg.test.ts` ; `npx jest --ci src/__tests__/upload-reconcile.test.ts` | ❌ W0 | ⬜ |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] New app test files listed above
- [ ] New backend tests: `capture-config.test.ts`, `scans.quote.test.ts`, `integration/scans.pg.test.ts`, `integration/scans-e2e.pg.test.ts`
- [ ] `test/helpers/pipeline.ts` passes dev `CAPTURE_CONFIG_JSON`; scans-route app helper
- [ ] Migrate/delete the six old-route test files
- No framework installs needed

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Full loop on iPhone in Expo Go | all | real device + Railway dev | prep → scan good → review → quote → approve → library "Ready" |
| Device check blocks | PROC-01 | UI on device | scan `too-few` → Upload disabled with reason |
| Server check blocks, not charged | PROC-01 | UI on device | scan `pose-jump` → upload → "Failed · Didn't pass checks · Not charged" |
| Force-quit resume | PROC-03 | OS behaviour | force-quit mid-upload → relaunch → upload completes, reaches Ready |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
