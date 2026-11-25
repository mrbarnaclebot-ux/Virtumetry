---
phase: 06-live-echo-3-provider
plan: 01
subsystem: backend/provider
tags: [echo3, provider, money-guard, config, testing]
requires: []
provides:
  - createEcho3Provider / parseRetryAfter / T_SUBMIT_MS (backend/src/provider/echo3.ts)
  - startFakeEcho3 (backend/test/helpers/fake-echo3.ts)
  - vitest-wide *.spaitial.ai fetch block (backend/test/setup-no-spaitial.ts)
  - config SPAITIAL_BASE_URL, BUDGET_ALERT_SHARE, extended live boot guard
affects: [06-02 pipeline/retry, 06-04+ exactly-once tests using the fake]
tech-stack:
  added: []
  patterns: [manual-redirect bare second fetch, closure-cached limits, scripted node:http fake]
key-files:
  created:
    - backend/src/provider/echo3.ts
    - backend/test/helpers/fake-echo3.ts
    - backend/test/setup-no-spaitial.ts
    - backend/test/echo3.client.test.ts
  modified:
    - backend/src/config.ts
    - backend/src/provider/index.ts
    - backend/vitest.config.ts
    - backend/test/config.test.ts
    - backend/test/provider/mock.test.ts
    - backend/.env.example
decisions:
  - "open() accepts a thumbnail URL only when artifact.kind is 'thumbnail' and the URL is https *.spaitial.ai; API refs containing '..' are refused"
  - "Fake POST /exports/<kind> answers 200 when the next scripted state is READY, else 202"
metrics:
  duration: ~25 min
  completed: 2026-11-25
---

# Phase 6 Plan 01: Live Echo-3 client + money guards Summary

Hermetic live Echo-3 client (`echo3.ts`, stdlib fetch, no retries, exact-bytes submit, auth-free manual 302 downloads, SSRF allowlist) behind a boot guard that needs ALLOW_PAID_PROVIDER=1, both secrets, an https base and a ZIP URL TTL of at least 9000 s. A vitest setup file makes any `*.spaitial.ai` fetch throw.

## Tasks

| # | Name | Commit |
|---|------|--------|
| 1 | Money guards: fetch block for tests, live boot guard, new env | c6b1ebc |
| 2 | Fake Echo-3 server, echo3.ts live client, createProvider live branch | 025df97 |

## Verification

- `npx tsc --noEmit`: clean
- `npx vitest run test/echo3.client.test.ts test/config.test.ts test/provider/mock.test.ts`: 131/131 pass
- Full `npx vitest run`: 468 pass, 1 fail. The failure is `test/migrate-folder.test.ts`, caused by parallel executor 06-02's in-progress drizzle migration (outside this plan's files)
- No pg suites are named in this plan
- Zero network calls to SpAItial. No file sets PROVIDER_MODE=live or ALLOW_PAID_PROVIDER

## Deviations from Plan

**1. [Rule 1 - Bug] Updated obsolete live-branch assertion in test/provider/mock.test.ts**
- **Found during:** Task 2
- **Issue:** The test expected `createProvider` live to throw 'no live provider in this build', and replacing the throw breaks it.
- **Fix:** It now asserts that the live branch builds a `mode: 'live'` client with a 127.0.0.1 base. Building the client makes no request.
- **Commit:** 025df97

**2. [Rule 2] Fake gained a `retryAfter` option** so the HTTP-date Retry-After case can be scripted (default `'7'`).

**3. [Rule 1] Existing config test "boots live with ALLOW_PAID_PROVIDER=1"** now also supplies the two fake secrets, as the new guard requires.

## Known Stubs

None.

## Self-Check: PASSED
- All created files exist; commits c6b1ebc and 025df97 present in `git log`.
