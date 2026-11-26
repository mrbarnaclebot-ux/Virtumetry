import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, useSegments, type Theme } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { ToastProvider } from '@/components/ui/toast';
import { useOnboarded } from '@/design/first-run';
import { FONT_MAP } from '@/design/fonts';
import { color } from '@/design/tokens';
import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';
import { startUploadManager, stopUploadManager } from '@/upload/manager';

SplashScreen.preventAutoHideAsync();

// UI-SPEC §2: one dark navigation theme from tokens for both layouts.
const navTheme: Theme = {
  dark: true,
  colors: {
    primary: color.primary,
    background: color.bg,
    card: color.bg,
    text: color.text,
    border: color.hairline,
    notification: color.danger,
  },
  fonts: DarkTheme.fonts,
};

// Splash is released after this even if fonts never load (T-06.1-04).
const FONT_TIMEOUT_MS = 2500;

// Pause React Query polling while the app is in the background (D-20).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
}

/** Pattern 10: the public web share page never mounts the session hook or the upload manager (D-19, T-05-30). */
export default function RootLayout() {
  const segments = useSegments();
  const [fontsLoaded, fontError] = useFonts(FONT_MAP);
  if (Platform.OS === 'web' && segments[0] === 'r') return <PublicLayout />;
  return <AuthedLayout fontsReady={fontsLoaded || !!fontError} />;
}

/** Renders immediately: fonts swap in on the web page, a visitor never waits (UI-SPEC §3). */
function PublicLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style="light" />
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="r/[slug]" />
        </Stack>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function AuthedLayout({ fontsReady }: { fontsReady: boolean }) {
  const { data, isPending } = authClient.useSession();
  const onboarded = useOnboarded();
  const [fontTimedOut, setFontTimedOut] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setFontTimedOut(true), FONT_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []);

  // Splash holds until fonts are loaded/errored/timed out and the stored session is read (UI-SPEC §3).
  const ready = (fontsReady || fontTimedOut) && !isPending;
  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  // D-21: app-scoped uploads while signed in, not tied to a screen.
  const signedIn = !!data;
  useEffect(() => {
    if (!signedIn) return;
    startUploadManager();
    return stopUploadManager;
  }, [signedIn]);

  if (!ready) return null;

  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style="light" />
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Protected guard={signedIn && onboarded}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="capture" options={{ presentation: 'fullScreenModal' }} />
              <Stack.Screen name="world" />
            </Stack.Protected>
            {/* UI-SPEC §8.1: first sign-in without the flag lands here; a screen lives in one group only. */}
            <Stack.Protected guard={signedIn}>
              <Stack.Screen name="onboarding" options={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'fade' }} />
            </Stack.Protected>
            <Stack.Protected guard={!signedIn}>
              <Stack.Screen name="sign-in" />
            </Stack.Protected>
            <Stack.Screen name="r/[slug]" />
          </Stack>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
