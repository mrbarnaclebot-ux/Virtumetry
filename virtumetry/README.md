# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **src/app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Which backend a build talks to

| Where | `EXPO_PUBLIC_APP_ENV` | `EXPO_PUBLIC_API_URL` | Set in |
|---|---|---|---|
| Expo Go (`npx expo start`) | development | Railway dev | `.env.development` (committed, public values only) |
| EAS `development` / `preview` | development / preview | Railway dev | `eas.json` |
| EAS `production` | production | Railway production | `eas.json` |

Builds other than production refuse the production URL at startup (`src/config/api.ts`). To use a local backend instead, create `.env.development.local` (gitignored) with `EXPO_PUBLIC_API_URL=http://<your-lan-ip>:8080`. The Settings footer shows `Virtumetry <version> · <env>`, so you can always see which backend the app is using.

## Test on your iPhone (Phase 3)

Do these one-time steps from the repo root on your PC. Use your own email wherever you see `<your-email>`, and never commit it.

1. In `backend/.env` add `OWNER_EMAIL=<your-email>` and `OWNER_ALLOWLIST=<your-email>`. That file is gitignored.
2. Create your account on the dev database: `cd backend && npm run owner:create`. It asks for a password and doesn't show it as you type. Run it again any time to reset the password.
3. Open sign-in on the dev backend: `railway variable set OWNER_ALLOWLIST=<your-email> -e dev -s api`. Run it from the repo root with the project linked. It redeploys the dev api, so wait until the deploy is done (about 2 min).
4. Optional, to fill the library with sample scans: `cd backend && npm run seed:library`. This adds 5 scans: uploading, processing, ready, failed and cancelled. To remove them later, run `npm run seed:library -- --reset`.
5. On the iPhone, install **Expo Go** from the App Store.
6. Start the app: `cd virtumetry && npx expo start`, then scan the QR code with the iPhone camera. The phone and the PC must be on the same Wi-Fi. If they aren't, use `npx expo start --tunnel` (it may offer to install `@expo/ngrok`, say yes).

Then check these on the phone:

1. The sign-in screen shows "Virtumetry", Email, Password and Log in. There is no sign-up or forgot-password link.
2. A wrong password shows "That email and password don't match. Try again." An email that isn't on the allowlist shows the same message.
3. Log in with your email and password. The library shows the 5 scans: "Uploading · 40%" with a bar, "Processing" with "Usually 30 min – 2 h", "Ready" with a thumbnail, "Failed · The scan couldn't be turned into a room" with "Not charged", and a muted "Cancelled".
4. Pull down to refresh. Tap "…" on Ready, choose Rename, type a new name and tap Save Name. The row shows the new name.
5. Tap "…" on Cancelled, choose Delete and confirm. The row disappears and stays gone after you pull to refresh.
6. Force-quit Expo Go (swipe it away) and reopen the project. You land on the library, still signed in.
7. Settings shows your email and "Virtumetry 1.0.0 · development". Tap Log out and confirm, and you're back on the sign-in screen.

If a step fails, note its number and the exact text on screen.

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **example** directory and create a blank **src/app** directory where you can start developing.

### Other setup steps

- To set up ESLint for linting, run `npx expo lint`, or follow our guide on ["Using ESLint and Prettier"](https://docs.expo.dev/guides/using-eslint/)
- If you'd like to set up unit testing, follow our guide on ["Unit Testing with Jest"](https://docs.expo.dev/develop/unit-testing/)
- Learn more about the TypeScript setup in this template in our guide on ["Using TypeScript"](https://docs.expo.dev/guides/typescript/)

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
