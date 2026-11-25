---
phase: 06-live-echo-3-provider
iteration: 3
reviewed: 2026-11-25T03:34:32Z
depth: deep
diff_base: 3b8e833
files_reviewed: 8
files_reviewed_list:
  - backend/src/pipeline.ts
  - backend/src/provider/echo3.ts
  - backend/src/budget.ts
  - backend/src/retry.ts
  - backend/test/echo3.client.test.ts
  - backend/test/integration/echo3-contract.pg.test.ts
  - backend/test/integration/retry.pg.test.ts
  - backend/test/integration/scenarios.pg.test.ts
findings:
  critical: 0
  warning: 0
  info: 6
  total: 6
status: clean
---

# Phase 6: Code Review Report (iteration 3)

**Reviewed:** 2026-11-25T03:34:32Z
**Depth:** deep. The diff `3b8e833..5cdd8f9` was traced through `queue.ts` (`heartbeatJob`, `claimNextJob`, the owner-guarded finalizers), `worker.ts` (`handleJobError`'s `LeaseLostError` walk-away, the serial claim loop, purge's held-reserve check), `budget.ts` (`reserveCredits`/`releaseCredits`) and `retry.ts` (`applyRetry`'s in-tx ledger guard and job retirement).
**Files Reviewed:** 8
**Status:** clean (no BLOCKER or WARNING remains)

`npx tsc --noEmit` is clean, and `test/echo3.client.test.ts` passes 62/62 locally. The pg suites were not re-run in this review.

## Summary

### Verification of the iteration-2 findings

| ID | Verdict | Trace |
|----|---------|-------|
| WR-01 | **Fixed** | `beat()` runs at line 243, before `reserveCredits`, and again at line 289, right before `provider.submit`. `heartbeatJob` requires `phase='running' AND locked_by=workerId`. A job that `applyRetry` retired (`phase='done'`, `locked_by=NULL`) fails it, and so does a job re-claimed by another worker. The `LeaseLostError` reaches `handleJobError`, which leaves the row alone. The line-289 beat also renews the lease to a full 600 s, while the send is capped at `T_SUBMIT_MS` = 60 s. So no second owner can claim the job between the last check and the request leaving the process. **Exactly-once holds.** Any run that sends either wrote `sending:true` before a successful beat, so every later owner's claim snapshot sees it and the 4xx is sticky-uncertain, or it is the only owner. The success tx records the request id only `WHERE submission_key = key`. **A sent request cannot go untracked through the new guard.** A run that reaches the send holds a reserve on `key`, so `applyRetry`'s in-tx `NOT EXISTS(heldReserve)` blocks any re-key. That reserve can only be released by a definitive refusal of the same key, and no concurrent owner can produce one under the lease. The `!recorded` branch is therefore defensive only (IN-15). |
| WR-02 | **Fixed** | `thisAttempt` is fixed at entry and scopes the quote write (196), the body persist (232), `refuse()` (178), the 409 path (314) and the uncertain-exhausted path (331). The key mint (204-207) needs no scope, because after any retry `submission_key` is never NULL. A non-legacy stale job is caught at line 236 by `stale()`. A legacy one reads the new attempt's key, but the line-243 beat stops it, as the new pg test shows. |
| WR-03 | **Fixed** | `bareGet` checks `downloadAllowed` before **every** fetch, including each redirect target. It never passes `headers`, so the API key cannot leave `call()`. The key is only sent to `${base}${path}`, with `redirect:'manual'`. Relative `Location` values resolve against the current hop. One `AbortSignal.timeout` covers all hops and the body. Redirects stop after 3 storage hops, so a loop cannot spin. An http downgrade or an IP literal at any hop is refused before it is fetched. |
| WR-04 | **Fixed** | `refuse(code, msg, key)` runs `releaseCredits(tx, key)` in the same tx as `failWorld` and `completeJob`. Releases only happen on provably uncharged outcomes. One is a non-uncertain definitive 4xx other than 408/409/429. The other is a 429/503 after retries ran out with `!uncertain`. Both are gated by the sticky `uncertain` flag. `SUBMIT_UNCERTAIN`, 409, 5xx and timeouts never release. The release commits even if the scoped `failWorld` matches 0 rows. That is correct: whether to release depends on what the provider said about this key, not on the world row. A 0-row match with a held reserve also cannot coincide with a re-key (see WR-01). |
| IN-11 | **Fixed** | `err instanceof LeaseLostError` is checked first, so the thumbnail-skip path cannot swallow a lost lease. `handleTrack` rethrows it. A small residual remains (IN-17). |

HARD MONEY RULE: the new tests only use injected `fetch` against `api.example.com`, `*.example.com` and `amazonaws.com` names, and the mock provider. No path sets `ALLOW_PAID_PROVIDER` or `PROVIDER_MODE=live`.

No new BLOCKER or WARNING was found. The notes below are INFO only. Each one needs a multi-minute stall nested inside another stall, an infrastructure assumption, or a cosmetic error path.

## Info

### IN-14: If the line-289 beat fails after a fresh reserve, an orphaned reserve can sit on an archived key
**File:** `backend/src/pipeline.ts:243-289`
**Issue:** For this to happen, a retry must commit between the line-243 beat and the reserve insert, while this run still holds a live lease. That needs a second, older stale run of the same attempt to `refuse()` the world in that window. `applyRetry` doesn't take the budget advisory lock, so its `NOT EXISTS` and the reserve insert can both commit. The run then fails the line-289 beat and sends nothing. The K1 reserve stays held on an archived attempt and over-counts the budget. That errs on the safe side: no money is lost, and purge checks only the current key.
**Fix (optional):** Take `pg_advisory_xact_lock(BUDGET_LOCK_KEY)` inside `applyRetry`'s tx, or release the reserve when the line-289 beat fails *and* the job is `done`.

### IN-15: The `RECONCILE` branch leaves only a log line
**File:** `backend/src/pipeline.ts:360-361`
**Issue:** Per the WR-01 trace this branch is unreachable today. If it ever fires, the only record of a billed request id is a log line. The reserve on that key does stay held.
**Fix (optional):** Also write the request id to the `world_attempts` row for that `submission_key`, so purge (A-05) deletes the provider copy.

### IN-16: Every lease check assumes `hostname:pid` is unique per live process
**File:** `backend/src/worker.ts` (`makeWorkerId`), `backend/src/queue.ts` (`heartbeatJob`)
**Issue:** Within one process the claim loop is serial, so two runs there never overlap. Across containers, the hostname is normally the container id. If two live replicas ever shared a hostname, and both ran PID 1, the WR-01 lease check could not tell their runs apart.
**Fix (optional):** `makeWorkerId = () => \`${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}\``.

### IN-17: After a skipped thumbnail, `ready` is written with no lease check
**File:** `backend/src/pipeline.ts:492-494`, `509-521`
**Issue:** On the skip path, `continue` jumps past the line-497 `beat()`. The final `ready` update is guarded only on `status='importing'`. A run that lost its lease while the thumbnail failed in some other way could still finalize. The new owner would then hit a 0-row update, which is harmless.
**Fix (optional):** `await beat()` right before the `ready` update.

### IN-18: A malformed `Location` header throws `TypeError`, not `ProviderError`, and the download host check ignores ports
**File:** `backend/src/provider/echo3.ts:154`, `312`, `52-58`
**Issue:** `new URL(loc, url)` throws on garbage. `handleTrack` still snoozes, so only the error label is wrong. `downloadAllowed` also accepts any port on a public DNS name. That is within the documented `ponytail:` hostname-only ceiling.
**Fix (optional):** Use `URL.canParse(loc, url)`, and throw `ProviderError` when it fails.

### IN-12, IN-13, IN-01 … IN-10 (carried over, unchanged, out of fix scope)
- IN-12: After a 0-row quote write, the run keeps its stale `w.submitBody == null` and runs the preflight anyway (`pipeline.ts:189-217`). The failure is now attempt-scoped, but it can still fail a same-attempt world that a concurrent owner is sending.
- IN-13: `withHeartbeat` only beats when a chunk arrives (`pipeline.ts:81-92`).
- IN-01 … IN-10: as listed in iteration 2. These are: jsonb re-stringify, the retry sheet spinning on a null `frame_count`, the alert slot being spent on a refusal, the banner keyed by window name, the thumbnail allowlist, the validation-code list, the test money guard's FQDN gap, the recorder's synthetic paths, `SPAITIAL_BASE_URL` breadth, and `deleteWorld` 409 rethrow.

---

_Reviewed: 2026-11-25T03:34:32Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
_Iteration: 3_
