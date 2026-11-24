# Phase 6: Live Echo-3 Provider - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-25
**Phase:** 06-live-echo-3-provider
**Areas discussed:** Live client shape, Exactly-once proof, Retry eligibility, Retry flow, Budget alert channel, Live run input
**Mode:** --auto (all areas auto-selected; recommended option chosen each time)

---

## Live client shape
| Option | Description | Selected |
|--------|-------------|----------|
| Thin fetch client behind ReconProvider, injectable fetch, no internal retries | Reuses Phase 2 pipeline policy | ✓ |
| Generated OpenAPI client | New dep, drift risk | |
**User's choice:** [auto] recommended default

## Exactly-once proof
| Option | Description | Selected |
|--------|-------------|----------|
| Local fake Echo-3 HTTP server with documented idempotency semantics, real handleSubmit | Proves the contract with zero spend | ✓ |
| Mock provider only | Doesn't exercise the HTTP client | |
**User's choice:** [auto] recommended default

## Retry eligibility
| Option | Description | Selected |
|--------|-------------|----------|
| Server-side allowlist of retryable codes; unknown = not retryable | Fail safe on money | ✓ |
| Any failure retryable | Wastes money on bad captures / risks double charge | |
**User's choice:** [auto] recommended default

## Retry flow
| Option | Description | Selected |
|--------|-------------|----------|
| POST /v1/worlds/:id/retry with fresh approval, new key minted only there, attempts archived | Exactly one new key per explicit approval | ✓ |
| Create a new world for the retry | Loses history, re-upload | |
**User's choice:** [auto] recommended default

## Budget alert channel
| Option | Description | Selected |
|--------|-------------|----------|
| Once-per-window alert row → log + push stub + in-app Library banner | Testable in Expo Go now, real push in Phase 7 | ✓ |
| Email | No email infra | |
**User's choice:** [auto] recommended default

## Live run input
| Option | Description | Selected |
|--------|-------------|----------|
| Runbook only; owner chooses; recommend real public posed capture at min frames or wait for Phase 8 | Hard money rule | ✓ |
| Agents run synthetic fixture room live | Forbidden + likely wasted money | |
**User's choice:** [auto] recommended default

## Claude's Discretion
- Fake-server implementation, echo3.ts module split, failure wording, retryable mock scenario name, banner dismissal storage.

## Deferred Ideas
- Ledger vs available_credits reconciliation, openapi drift CI, free re-import retry, real push (Phase 7), .RAD LoD.
