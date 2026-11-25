---
phase: 6
slug: live-echo-3-provider
status: complete
nyquist_compliant: true
wave_0_complete: true
created: 2026-11-25
---

# Phase 6 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution. Source: 06-RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | backend: vitest ^2.1 (+ pg suites via `scripts/test-pg.mjs` on Neon dev); app: jest-expo 58 + Jest 30 + RNTL 14 |
| **Config file** | `backend/vitest.config.ts` (add `setupFiles: ['test/setup-no-spaitial.ts']`); `virtumetry/package.json` jest block |
| **Quick run command** | `cd backend && npx vitest run test/echo3.client.test.ts test/retryable.test.ts test/config.test.ts` |
| **Full suite command** | `cd backend && npx tsc --noEmit && npx vitest run && node --env-file=.env scripts/test-pg.mjs`; `cd virtumetry && npx expo lint && npx tsc --noEmit && npx jest --ci` |
| **Estimated runtime** | ~180 seconds |

---

## Sampling Rate

- **After every task commit:** quick run for touched unit files + typecheck of the touched package
- **After every plan wave:** full backend vitest + pg suites touched + full app jest
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

| ID | Requirement | Behavior | Test Type | Automated Command | File Exists | Status |
|----|-------------|----------|-----------|-------------------|-------------|--------|
| V1 | PROC-05 | echo3 client: auth header, exact body bytes, error/Retry-After mapping, timeout, 302 w/o auth, ref allowlist | unit (fake http) | `npx vitest run test/echo3.client.test.ts` | ❌ W0 | ✅ green |
| V2 | PROC-05 | kill mid-submit → billed 1, same request id, one reserve | pg | `node --env-file=.env scripts/test-pg.mjs test/integration/echo3-contract.pg.test.ts` | ❌ | ✅ green |
| V3 | PROC-05 | concurrent double handleSubmit → billed 1 | pg | same | ❌ | ✅ green |
| V4 | PROC-05 | drop-after-accept/timeout/429/503 → billed 1; 409 parks; 401 definitive + released | pg | same | ❌ | ✅ green |
| V5 | PROC-05 | kill mid-submit against the mock | pg | `… test/integration/scenarios.pg.test.ts` | ✅ extend | ✅ green |
| V6 | SC2 (automated) | replay set submit → track → import → ready | pg | `… echo3-contract.pg.test.ts -t replay` | ❌ | ✅ green |
| V7 | LIB-02 | `isRetryable` truth table | unit | `npx vitest run test/retryable.test.ts` | ❌ | ✅ green |
| V8 | LIB-02 | retry route: ownership, not-retryable, ledger-held, below quote, success reset + new key + attempt row, idempotent replay, concurrent → one wins | pg | `… test/integration/retry.pg.test.ts` | ❌ | ✅ green |
| V9 | OPS-06 | alert once per window, push+warn after commit, push failure non-fatal, `budgetAlert` in API | pg + unit | `… test/integration/budget-alert.pg.test.ts` | ❌ | ✅ green |
| V10 | LIB-02 | Library failed row → "Retry…" only when retryable | RNTL | `npx jest src/__tests__/library-actions.test.tsx` | ✅ extend | ✅ green |
| V11 | LIB-02 | retry sheet: fresh quote, over-budget disabled, stable Idempotency-Key, 409, non-retryable "Scan again" | RNTL | `npx jest src/__tests__/world-retry.test.tsx` | ❌ | ✅ green |
| V12 | OPS-06 | banner from `budgetAlert`, dismiss per window per session | RNTL | `npx jest src/__tests__/library.test.tsx` | ✅ extend | ✅ green |
| V13 | money rule | live needs ALLOW + keys + https base; any test fetch to `*.spaitial.ai` throws | unit | `npx vitest run test/config.test.ts` | ✅ extend + W0 | ✅ green |
| V14 | LIB-03 regression | purge deletes `world_attempts` + provider-deletes archived request ids | pg | `… test/integration/purge-cascade.pg.test.ts` | ✅ extend | ✅ green |

*Status: ✅ green · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `backend/test/helpers/fake-echo3.ts` — fake Echo-3 server (idempotency, scripts, billed count, replay mode)
- [ ] `backend/test/helpers/pipeline.ts` — injectable provider option
- [ ] `backend/test/setup-no-spaitial.ts` + `setupFiles` in vitest config
- [ ] `backend/test/fixtures/echo3-recorded/manifest.json` (`synthetic: true`)
- [ ] drizzle migration for `world_attempts`, `submit_attempt`, `budget_alerts`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| First paid run: one request id, ready, viewer opens, recorded set written | PROC-05 / SC2 | Costs real money; owner's decision | 06-HUMAN-UAT.md runbook |
| Expo Go: retryable failed row → Retry → approve → processing → ready | LIB-02 | Device UI | 06-HUMAN-UAT.md |
| Alert visible in logs and banner | OPS-06 | Live/dev env | 06-HUMAN-UAT.md |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 180s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-11-25 (automated V1-V14 green; M1-M3 manual in 06-HUMAN-UAT.md)
