---
phase: 05-viewer-floor-plan-measure-share
plan: 07
subsystem: web-share
tags: [expo-router-web, ssr, share, password, noindex]
requires: [05-04 public share API, 05-05 viewer]
provides: [public /r/[slug] page, public-share client, web:export:dev script]
affects: [05-08 deploy]
tech-stack:
  added: []
  patterns: [layout split by segment, client-only lazy viewer, pageHeaders + generateMetadata for noindex]
key-files:
  created:
    - virtumetry/src/app/r/[slug].tsx
    - virtumetry/src/lib/public-share.ts
    - virtumetry/src/viewer/load-viewer.ts
    - virtumetry/src/__tests__/share-web-route.test.tsx
  modified:
    - virtumetry/src/app/_layout.tsx
    - virtumetry/package.json
    - virtumetry/app.json
decisions:
  - "Viewer is lazy-loaded via src/viewer/load-viewer.ts (one-line dynamic import) so jest can mock it; jest-expo cannot run a bare import()"
  - "No separate mounted flag: 'opened' is reachable only from a fetch inside an effect, which never runs on the server (React Compiler lint forbids setState in effect)"
  - "SDK 58 Head tags only land after hydration, so robots meta is also emitted via generateMetadata, plus pageHeaders X-Robots-Tag"
  - "Server bundle reads EXPO_PUBLIC_API_URL at runtime (not inlined): EAS Hosting needs the env var set for 05-08"
metrics:
  duration: ~35 min
  completed: 2026-11-24
---

# Phase 5 Plan 07: Web Share Page Summary

Public `/r/<slug>` Expo Router web page. It checks the link, shows a password gate if needed, then opens the share and loads the same WorldViewer. The viewer is lazy-loaded on the client only. Every fetch uses `credentials: 'omit'` and sends no cookie. Noindex is set three ways: the X-Robots-Tag header, server metadata and Head.

## Tasks

| Task | Commit | Notes |
|------|--------|-------|
| 1 RED: failing web-route tests | 0c312b5 | 8 cases: spinner, open + no cookie/password, 404, retry, password wrong/right, 429, context_lost, 14-min re-open |
| 1 GREEN: page, client, layout split | ce5a9c1 | `PublicLayout` (no useSession / upload manager) for `/r/*` on web; `r/[slug]` declared outside both Protected groups in `AuthedLayout` |
| 2: export script + noindex headers | 67b80b2 | `web:export:dev`, `pageHeaders` for `/r/[slug]`, `generateMetadata` robots |

## Verification

- `npm run web:export:dev`: exit 0, output in `dist/`, which stays untracked (gitignored).
- Smoke test `node --env-file=.env.development node_modules/expo/bin/cli serve --port 8092`, then `GET /r/AAAAAAAAAAAAAAAAAAAAAA`:
  - **200**
  - header `x-robots-tag: noindex, nofollow`
  - HTML has `<meta name="robots" content="noindex,nofollow"/>` and the SSR spinner (`share-checking`)
  - no WebAssembly or window errors in the server log
- `npx expo lint`, `npx tsc --noEmit`, `npx jest --ci` all green (29 suites, 284 tests).
- SDK 58 docs checked first:
  - server-headers.md confirms the `pageHeaders` shape (`source` + `headers`).
  - static-rendering.md and server-rendering.md: `Head` updates after hydration, and `generateMetadata` puts tags in the initial HTML.

## Deviations from Plan

1. **[Rule 3 - Blocking] Added `src/viewer/load-viewer.ts`.**
   - Problem: jest-expo leaves a bare `import()` untransformed, so the test throws "dynamic import callback was invoked without --experimental-vm-modules".
   - Fix: the page does `lazy(loadViewer)`, and the test mocks `@/viewer/load-viewer`. The page still never imports world-viewer statically.
2. **[Rule 1] Dropped the `mounted` effect flag.**
   - Problem: `react-hooks/set-state-in-effect` errors on `useEffect(() => setMounted(true))`.
   - Why it is safe: the opened state is only reachable after a client-side effect fetch, so the viewer still never renders during SSR. The smoke test confirms this.
3. **[Rule 2] Added `generateMetadata` with robots `noindex,nofollow`.** In SDK 58, Head tags are not in the initial server HTML. Without this, crawlers that ignore headers would see no robots meta.
4. **Smoke test env.** Plain `npx expo serve` returned 500 `EXPO_PUBLIC_API_URL is required`. The server bundle reads `process.env` at runtime, while the client bundle has the value inlined. The serve was re-run with `node --env-file=.env.development`. A first attempt on port 8090 collided with my own still-running serve, so I moved to ports 8091 and 8092. All serve processes ended on their own via `timeout`.

## Notes for 05-08 (deploy)

- EAS Hosting must provide `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_APP_ENV` at server runtime. Without them, every SSR render returns 500. Set them as EAS environment variables for the deploy, or pass `--environment`.
- `__common` (4.3 MB) includes Spark, because `world/[id]` imports the viewer statically. It loads on the client but is only evaluated after `open`.
- The backend public CORS allows `WEB_SHARE_ORIGIN` plus `http://localhost:8081` (non-prod). A local serve on another port can't call the API from a browser. That is expected, and the smoke test only checks SSR.

## Threat Surface

- T-05-30: plain fetch with `credentials:'omit'` and no Cookie (tested); PublicLayout mounts no session hook.
- T-05-31: the password lives in component state and a ref only.
- T-05-32: the title is rendered as React text and Head children. No dangerouslySetInnerHTML.
- T-05-33: noindex via header, metadata and Head.
- T-05-34: lazy viewer; the serve smoke test showed no Spark evaluation errors.
- T-05-35: slug passed through `encodeURIComponent`.

## Known Stubs

None.

## Self-Check: PASSED
