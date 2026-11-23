---
phase: 1
slug: isolated-backend-fork
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-11-23
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 2.1.9 (backend); `expo lint` + tsc (app) |
| **Config file** | `backend/vitest.config.ts` |
| **Quick run command** | `cd backend && npx vitest run test/config.test.ts` |
| **Full suite command** | `cd backend && npx tsc --noEmit && npx vitest run` ; `cd virtumetry && npx expo lint && npx tsc --noEmit` |
| **Estimated runtime** | ~10 seconds |

---

## Sampling Rate

- **After every task commit:** `cd backend && npx tsc --noEmit && npx vitest run`
- **After every plan wave:** full suite (backend + app)
- **Before `/gsd:verify-work`:** CI green on `main` for both workflows + `/readyz` 200 on the Railway domain + `[migrate] up to date` in api logs
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

Filled by the planner/executor per task. Requirement → test map from research:

| Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|-----------------|-----------|-------------------|-------------|--------|
| FND-01 | Stripped backend typechecks; all suites pass; no stitcher/worldlabs/depth/python left | unit + grep | `npx tsc --noEmit && npx vitest run` ; `! grep -rniE "worldlabs\|stitch\|depth\.js\|python" backend/src backend/test Dockerfile .github` | ✅ (modified) | ⬜ pending |
| FND-01 | Fresh migration journal ↔ SQL consistent | unit | `npx vitest run test/migrate-folder.test.ts` | ❌ W0 | ⬜ pending |
| FND-02 | VirtSpace host/region/bucket refused; prod endpoint/bucket refused outside prod | unit | `npx vitest run test/config.test.ts -t "VirtSpace\|production branch\|bucket"` | ❌ W0 | ⬜ pending |
| FND-02 | Deployed API on new infra | CLI | `railway status --json` (id ≠ 1690518b…) ; `curl -fsS https://<api-domain>/readyz` | — | ⬜ pending |
| FND-03 | Live provider refused w/o `ALLOW_PAID_PROVIDER=1`; dev auth + `DEV_AUTH_TOKEN` refused in prod | unit | `npx vitest run test/config.test.ts -t "paid\|dev auth\|DEV_AUTH_TOKEN"` | ❌ W0 | ⬜ pending |
| FND-04 | Prod requires direct same-endpoint migrate URL | unit | `npx vitest run test/config.test.ts -t "MIGRATE_DATABASE_URL"` | ❌ W0 | ⬜ pending |
| FND-04 | Deploy ran migrations; readyz reads DB, 503 on failure | CLI + unit | `railway logs -s api` contains `[migrate] up to date` ; `npx vitest run test/readyz.test.ts` | ❌ W0 | ⬜ pending |
| FND-05 | Backend + app workflows green on push; integration suites run when secret set | CI | `gh run list -R mrbarnaclebot-ux/Virtumetry --limit 4` → both `success` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `backend/test/config.test.ts` — new guard cases + `prodBase` fixture
- [ ] `backend/test/migrate-folder.test.ts` — journal ↔ SQL consistency
- [ ] `backend/test/readyz.test.ts` — Fastify inject with fake db/storage (200 / 503)
- [ ] `.github/workflows/backend.yml`, `.github/workflows/app.yml`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| New Neon/Railway/R2 resources exist and are separate from VirtSpace | FND-02 | Cloud console state | `neonctl projects list --org-id …` shows `virtumetry` (aws-us-west-2); `railway status` shows project `virtumetry`; R2 lists `virtumetry-dev`, `virtumetry-prod` |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
