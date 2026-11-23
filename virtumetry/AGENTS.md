This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## EAS free plan — conserve quota

We are on the Expo free plan: **15 Android + 15 iOS builds/month**, low-priority build queue (slow), **60 min/month of EAS Workflows (CI/CD)**, store submissions allowed, EAS Update to **1K monthly active users**.

- **Never run `eas build` without asking first.** State the platform, profile, and why; one platform at a time, never `--platform all` unless asked.
- Exhaust free options before any cloud build: Expo Go, `npx expo start`, `npx tsc --noEmit`, `npx expo lint`, `npx expo-doctor`. Builds must only be started from a state that passes all four.
- Only native changes (new native module, `app.json`/config plugin change, SDK upgrade) need a new build. JS/asset-only changes ship with `eas update`, not a rebuild.
- Prefer one reusable `development` build per platform; avoid rebuilding it. Local builds (`npx expo run:android`, `eas build --local`) don't use quota — prefer them when the toolchain exists.
- Don't add EAS Workflows or CI that triggers builds automatically (60 min cap). Don't auto-trigger builds on push.
- Before building, check usage remaining: `npx eas-cli@latest build:list` / expo.dev billing page, and tell the user how many builds are left.
- `eas update` is fine to use, but keep the 1K MAU cap in mind before wider releases.
