---
phase: 06-live-echo-3-provider
source: 06-08-PLAN.md Task 2
status: pending
device: iPhone 17 Pro, Expo Go
backend: Railway dev
---

# Phase 6 Human UAT

Two parts:
- **$0 checks in Expo Go**: the retry flow and the budget banner, using the mock provider. Run these in the morning.
- **Paid run runbook**: only when you decide to spend real money. No agent has run it or ever will.

## Setup done by the executor

| What | Value |
|------|-------|
| Deployed commit | `d781fba` (`railway up --ci`, from a clean tree) |
| Railway | project `162ef8a1-afac-4a01-8253-4e3f75d8b3b3`, environment `dev`, services `api` + `worker` |
| Dev API | `https://api-dev-d164ec0a.up.railway.app` |
| Schema | migration 0005 (`submit_attempt`, `world_attempts`, `budget_alerts`) is on the Neon dev branch |
| Provider | `PROVIDER_MODE=mock` on both services (set in an earlier phase). No `ALLOW_PAID_PROVIDER` or `SPAITIAL_*` variable on either. `MOCK_SCENARIO` defaults to `happy` |
| New env defaults | `BUDGET_ALERT_SHARE` 0.8, `SPAITIAL_BASE_URL` `https://api.spaitial.ai` (only read in live mode) |

Production: unchanged. Paid provider: off everywhere. No Railway variables were changed by the executor.

Live checks already passed on dev: `/healthz` ok, unauthenticated `GET /v1/worlds` returns 401, and a fixture run through the deployed worker reached ready (`fixture:e2e -- --remote`, $0).

Notes:
- Run every `railway` and `npm` command below from `backend/` in Git Bash. Each `railway variable set` without `--skip-deploys` redeploys that service, which takes about 1–2 min. Wait until it shows "Active" in the Railway dashboard before you scan.
- Don't change a worker variable while a scan is processing. The redeploy wipes the mock's in-memory request state, and the scan gets stuck in Processing.
- Fixture scans cost 930 **mock** credits each. Mock spend is a separate ledger from live spend, and `npm run budget:reset-dev` clears today's mock spend.

## $0 checks in Expo Go

Start the app as in `virtumetry/README.md` ("Test on your iPhone", Phase 3 steps 1, 2, 5 and 6), sign in, and reload the project so Expo Go picks up the Phase 6 code. A "fixture scan" means the Phase 4 "Good" fixture scan, approved.

| # | Check | Expected | Status | Observed |
|---|-------|----------|--------|----------|
| R1 | Retryable failure | Run `railway variable set MOCK_SCENARIO=failed -s worker -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3` and wait for the redeploy. Run a fixture scan | The Library row ends as "Failed · …" with "Something went wrong while processing" and "Not charged" | pending | |
| R2 | Retry sheet | Tap the failed row | The "Retry processing" sheet opens. After "Getting quote…" it shows "This retry will use ~930 credits ≈ $9.30", the credits left today/this month, the footnote "This is a new paid run. Nothing is charged until you approve." and the "Approve and retry" button | pending | |
| R3 | Cancel | Tap Cancel | The sheet closes. The row is unchanged (still Failed) | pending | |
| R4 | Approve and retry | Run `railway variable set MOCK_SCENARIO=happy -s worker -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3` and wait for the redeploy. Reopen the failed row and tap "Approve and retry" | "Retry started" is announced and the sheet closes. The row goes Processing → Ready, and tapping it opens the room in the viewer | pending | |
| R5 | Row menu | With another retryable failure (repeat R1, then switch back to `happy` as in R4 afterwards), open the row's "•••" menu | "Retry…" is the first item, followed by Rename, Delete, Cancel. "Retry…" opens the same sheet as R2 | pending | |
| R6 | Non-retryable failure | Run `railway variable set MOCK_SCENARIO=409 -s worker -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3`, wait, run a fixture scan, then tap the failed row | The "Scan failed" sheet with "We can't tell if this run was charged, so it can't be retried from the app. Scan the room again to get a new one." and a "Scan again" button. No quote and no retry button. The row menu has no "Retry…". Then restore: `railway variable set MOCK_SCENARIO=happy -s worker -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3` | pending | |
| B1 | Budget banner | Run `npm run budget:reset-dev`. In the Railway dashboard (dev), note the current `DAILY_CREDIT_BUDGET` on api and worker (blank means the default 2000). Run `railway variable set DAILY_CREDIT_BUDGET=1100 -s api -e dev -p 162ef8a1-afac-4a01-8253-4e3f75d8b3b3` and the same with `-s worker`, wait for both redeploys, then run one fixture scan | When the scan starts processing, the Library shows "You've used 84% of today's processing budget." and "New scans may wait until tomorrow." (930 / 1100). The worker log (Railway dashboard → worker → Deployments → logs) shows one `[budget-alert]` line with `"window":"daily"` and one `[push:stub]` line | pending | |
| B2 | Dismiss | Tap the dismiss button ("Dismiss budget alert") | The banner hides and stays hidden while the app runs. It comes back after you force-quit and reopen Expo Go | pending | |
| B3 | Restore budget | Run `npm run budget:reset-dev`. Set `DAILY_CREDIT_BUDGET` back to the value from B1 on **both** services (if it was blank, delete the variable in the dashboard on both) | After the redeploys and a pull-to-refresh the banner is gone | pending | |
| Z | Back to normal | In the Railway dashboard (dev) check both services | `MOCK_SCENARIO` is `happy` or deleted, `DAILY_CREDIT_BUDGET` is back to its original value on both, and there is no `PROVIDER_MODE` or `ALLOW_PAID_PROVIDER` anywhere | pending | |

Notes for B1:
- The `[budget-alert]` log line and the push fire **once per UTC day** (and once per month) for mock. If a mock alert already fired today, the banner still shows but there's no new log line. That's expected.
- If a monthly banner ("…of this month's processing budget.") shows instead, the month's mock spend is already above 80% of `MONTHLY_CREDIT_BUDGET`. The daily check is still valid when the log shows the daily window.

To record a failure, put the check number and the exact on-screen text in Observed.

## Paid run runbook (owner only — costs real money)

Nothing in this section has been run. Every step is your decision. It touches Railway **dev** only and never production.

### (a) Decide what to scan

Price: **900 + frame_count credits**, at $0.01 per credit. Failed or cancelled runs cost 0 credits. There's no sandbox and no test key.

The 900-credit base fee dominates: going from 30 to 300 frames adds only $2.70. A "minimum-frame" bundle saves almost nothing, so never pick an input just because it is small.

| Option | Cost | Verdict |
|---|---|---|
| **Your own room after Phase 8** (real ARKit capture, ~200–400 frames) | ~1,100–1,300 credits ($11–13) | **Recommended.** It tests the real capture path, there's no conversion layer to blame, and this runbook applies verbatim. |
| A converted ARKitScenes scene (real iPad ARKit room capture, ~200–300 frames at 1920×1440) | ~1,100–1,200 credits ($11–12) | The best option if you want the paid run in Phase 6. Check the dataset licence first (believed non-commercial share-alike). The converter isn't built yet: ask Claude for a quick task. |
| The committed tiny fixture (`npm run fixture:e2e -- --remote`) | 30 frames → 930 credits ($9.30) | **Money-path smoke only.** It's a flat textured floor, not a room. It proves exactly-once and the money path, not reconstruction quality. Don't expect a usable world. Note: `fixture:e2e` refuses to run unless `PROVIDER_MODE=mock` in your local `.env`, so with this option you start the scan from the app instead, or ask Claude for a one-off live variant. |
| SpAItial's 3-frame sample bundle | 903 credits | **Don't.** Its own README says it can't be reconstructed. |

The Phase 4/5 synthetic fixture room is a poor paid input: synthetic frames may fail validation or reconstruct as garbage. Use a real capture.

### (b) Preconditions

- [ ] A SpAItial plan **with API access**. Free has no API (`403 MODEL_FORBIDDEN`). Standard ($49.99/mo, 7,500 credits) outputs are **non-commercial**. Pro is needed for commercial use.
- [ ] Credit balance ≥ the expected quote.
- [ ] From the SpAItial Developer Portal: an API key, and the webhook signing secret (Webhooks page).
- [ ] Nothing else is processing on dev.

### (c) Set the live variables on BOTH services (dev only)

The api quotes and the worker submits. If only one of them is live, the app approves against the wrong budget ledger. Always set and revert **both**.

Pick budgets just above one run: `DAILY_CREDIT_BUDGET` = quote + ~300 (e.g. 1500 for a 1,200-credit run). Then a second run is refused by the budget cap, and the 0.8 alert share is crossed by this one run, so you can observe the live budget alert. Live spend is a separate ledger from mock, so earlier mock scans don't count.

Run from `backend/`. Replace each `<paste>`; never commit or paste the real values anywhere else.

```bash
P=162ef8a1-afac-4a01-8253-4e3f75d8b3b3
for S in api worker; do
  railway variable set --skip-deploys -s $S -e dev -p $P \
    PROVIDER_MODE=live \
    ALLOW_PAID_PROVIDER=1 \
    SPAITIAL_API_KEY=<paste> \
    SPAITIAL_WEBHOOK_SECRET=<paste> \
    DAILY_CREDIT_BUDGET=<quote + 300> \
    MONTHLY_CREDIT_BUDGET=<quote + 300> \
    BUDGET_ALERT_SHARE=0.8
done
# The worker builds the webhook URL, so it needs the public https base too
# (the api already has it from Phase 5):
railway variable set --skip-deploys -s worker -e dev -p $P PUBLIC_BASE_URL=https://api-dev-d164ec0a.up.railway.app
# Redeploy both:
railway redeploy -s api -e dev -p $P --yes
railway redeploy -s worker -e dev -p $P --yes
```

Railway CLI 5.75 has `variable set`, `variable delete` and `redeploy`. If yours doesn't, use the dashboard.

Before you run the commands above, note the current `DAILY_CREDIT_BUDGET` / `MONTHLY_CREDIT_BUDGET` values in the dashboard, because you restore them in (h).

Boot guards: a service refuses to start in live mode unless `ALLOW_PAID_PROVIDER=1`, both secrets are set, the base URL is https and `BUNDLE_URL_TTL_SECONDS` ≥ 9000 (the default is 86400). A crash loop with `PROVIDER_MODE=live refused: …` in the deploy log names the missing variable. Fix it or go to (h).

Check `curl -s https://api-dev-d164ec0a.up.railway.app/healthz` → `{"status":"ok"}`, and that both deploys are Active.

### (d) Run

1. In the app, start the scan (after Phase 8: capture your room; otherwise the input you chose in (a)).
2. The review screen shows the quote. Expect **900 + frames** credits (e.g. 1,200 for 300 frames). If it differs, stop.
3. Approve once. Don't tap anything again while it processes (expect 30 min to 2 h).

### (e) Watch

- **Worker logs** (Railway dashboard → worker → logs): `[budget-alert]` with `"mode":"live"` right after the reserve; `[pipeline]` lines only on problems (snoozes, unknown status, thumbnail skip). No log line ever contains the key or a URL.
- **Library**: the row goes Submitting → Processing (with progress) → Importing → Ready.
- **Neon dev console** (SQL editor on the dev branch), read-only. Replace `<worldId>`:

```sql
-- The world: one request id, attempt 1, charged once ready
SELECT status, submit_attempt, submission_key, provider_request_id, quoted_credits, credits_spent, charged, failure_code
FROM worlds WHERE id = '<worldId>';

-- Ledger: exactly one 'reserve' row for this key, provider_mode 'live'
SELECT kind, amount, provider_mode, submission_key, created_at
FROM credit_events WHERE world_id = '<worldId>' ORDER BY created_at;

-- Webhook deliveries: one row per delivery id (duplicates are deduped by the primary key)
SELECT delivery_id, event, received_at
FROM webhook_deliveries
WHERE request_id = (SELECT provider_request_id FROM worlds WHERE id = '<worldId>')
ORDER BY received_at;

-- Alert recorded once for the live window
SELECT provider_mode, budget_window, spent, budget, share, created_at
FROM budget_alerts WHERE provider_mode = 'live' ORDER BY created_at DESC;
```

### (f) Verify exactly-once

- [ ] `worlds.provider_request_id` is set and never changes. `submit_attempt` = 1 (unless you pressed Retry).
- [ ] `credit_events` has exactly **one** `reserve` row for the world's `submission_key`, `provider_mode = 'live'`, amount = the quote, and no `release` row (it was charged).
- [ ] `webhook_deliveries` has one row per delivery id. SpAItial retries up to 5 times, and redeliveries never create a second row or a second state change.
- [ ] No second submission key exists unless you pressed Retry (`SELECT * FROM world_attempts WHERE world_id = '<worldId>'` is empty).
- [ ] The SpAItial dashboard shows one request and one charge.
- [ ] The world is Ready, and the viewer opens it (orbit, Walk, Plan, Measure).
- [ ] The live budget alert: the Library banner shows and the worker logged `[budget-alert]` with `"mode":"live"` (success criterion 4, live half).
- [ ] Record the replay set while the live vars are still set locally:

```bash
cd backend
PROVIDER_MODE=live ALLOW_PAID_PROVIDER=1 SPAITIAL_API_KEY=<paste> npm run record:echo3 <worldId>
```

It makes free GETs only (status, envelope, exports), writes the scrubbed `test/fixtures/echo3-recorded/manifest.json` (it refuses to write anything that looks like a URL, signature or key) and copies the world's outputs inside R2 dev to `fixtures/echo3-run-1/`. Check `git diff` shows no key and no URL, then commit the manifest. Don't put the live variables into `backend/.env`.

### (g) Abort

- **Normal abort:** delete the scan in the app (row menu → Delete). `DELETE /v1/worlds/:id` marks it deleted, and the worker's purge cancels the provider request (and deletes the provider world). A failed or cancelled run costs 0 credits; a run that already completed is charged.
- **Something looks wrong** (a second request id, a second reserve row, a crash loop): go to (h) immediately. With the vars removed, nothing new can be sent.
- What the app shows on errors: a retry sheet quote failure shows "Couldn't start the retry…" (the server answered 503 `quote_unavailable` or 502 `quote_failed`, nothing written). A rejected API key fails the scan as `PROVIDER_AUTH`: not retryable, reservation released, 0 credits. If a submit's outcome is unknown, the world is failed as `SUBMIT_UNCERTAIN`, which is never retried from the app.

### (h) Revert to mock

```bash
P=162ef8a1-afac-4a01-8253-4e3f75d8b3b3
for S in api worker; do
  railway variable delete -s $S -e dev -p $P PROVIDER_MODE
  railway variable delete -s $S -e dev -p $P ALLOW_PAID_PROVIDER
  railway variable delete -s $S -e dev -p $P SPAITIAL_API_KEY
  railway variable delete -s $S -e dev -p $P SPAITIAL_WEBHOOK_SECRET
  railway variable delete -s $S -e dev -p $P BUDGET_ALERT_SHARE
done
```

Restore `DAILY_CREDIT_BUDGET` and `MONTHLY_CREDIT_BUDGET` to the values you noted in (c) on both services (delete them if they were blank). Keep the worker's `PUBLIC_BASE_URL` (harmless in mock). Redeploy both.

Then confirm:
- [ ] Both deploys Active, `curl -s https://api-dev-d164ec0a.up.railway.app/healthz` → `{"status":"ok"}`
- [ ] The dashboard shows no `PROVIDER_MODE`, `ALLOW_PAID_PROVIDER` or `SPAITIAL_*` on api or worker
- [ ] `cd backend && npm run fixture:e2e -- --remote` → `ready` ($0, mock)
- [ ] Optional: rotate the SpAItial API key in the Developer Portal if it was pasted anywhere outside Railway

### (i) Questions for SpAItial support

1. How long is an `Idempotency-Key` retained? (Our submit retry cap is 4 attempts within ≤ 15 min of backoff; that stays as is.)
2. Two concurrent in-flight requests with the same key: does the second replay the first, or get a 409?
3. For async validation failures, what is the top-level `error.code` (vs the per-check codes)?
4. Does `world.thumbnail_url` (on `img.spaitial.ai`) need auth? (If it does, we skip the thumbnail; the world is still Ready.)

## Pending (not claimed by the automated plans)

| Item | Status |
|------|--------|
| Success criterion 2, live half: the first paid run reaches Ready exactly once, and the recorded replay set is committed | pending (owner, runbook above) |
| Success criterion 4, live half: the budget alert observed on a live run | pending (owner, runbook (f)) |
| $0 checks R1–R6, B1–B3, Z | pending (owner, Expo Go) |
