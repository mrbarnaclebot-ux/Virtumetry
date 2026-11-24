# Phase 3 Discussion Log (--auto)

All gray areas auto-selected; recommended option taken for each. The orchestrator's phone-testing brief (Railway dev env, email+password with server allowlist, owner-run account script, seed script) was adopted as the recommended defaults.

| Area | Question | Selected |
|------|----------|----------|
| Auth library | Better Auth vs hand-rolled JWT vs Clerk | Better Auth 1.7.x + Drizzle (STACK.md) |
| Sign-up | Open, invite, disabled | Disabled + `OWNER_ALLOWLIST` env, fail closed |
| Identity link | Replace `users` with BA `user` vs map | Map BA user → `users.apple_sub = 'ba:<id>'` |
| Dev auth | Remove vs keep | Keep DEV_AUTH_TOKEN for tests/local only; refused in prod |
| Owner creation | Seed in migration vs script | Guarded owner-run `npm run owner:create` |
| Phone backend | Local tunnel vs Railway dev env | Railway `dev` environment (Neon dev + virtumetry-dev) |
| API URL per profile | app.config vs eas.json env | `eas.json` env + committed non-secret `.env`, pure `resolveApiUrl` with prod refusal |
| Library polling | Fixed vs conditional | react-query, 5 s only while non-terminal items |
| Processing estimate | None / static / progress-based | progress-based, else "Usually 30 min – 2 h" |
| Rename UX | Alert.prompt vs modal | Modal with TextInput (cross-platform) |
| Delete semantics | Soft only vs full cascade | Soft-delete now, purge job deletes provider (mock) + R2 + hard-deletes rows |
| Seed data | None vs script | Guarded `npm run seed:library` for owner's account |

Deferred: Sign in with Apple (P8), password reset, retry failed (P6), detail/viewer (P5), orgs.
