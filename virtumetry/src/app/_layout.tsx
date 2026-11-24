import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState, Platform, useColorScheme } from 'react-native';

import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';
import { startUploadManager, stopUploadManager } from '@/upload/manager';

SplashScreen.preventAutoHideAsync();

// Pause React Query polling while the app is in the background (D-20).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
}

/** Pattern 10: the public web share page never mounts the session hook or the upload manager (D-19, T-05-30). */
export default function RootLayout() {
  const segments = useSegments();
  if (Platform.OS === 'web' && segments[0] === 'r') return <PublicLayout />;
  return <AuthedLayout />;
}

function PublicLayout() {
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);
  return (
    <ThemeProvider value={DarkTheme}>
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="r/[slug]" />
        </Stack>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

function AuthedLayout() {
  const colorScheme = useColorScheme();
  const { data, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending) SplashScreen.hideAsync();
  }, [isPending]);

  // D-21: app-scoped uploads while signed in, not tied to a screen.
  const signedIn = !!data;
  useEffect(() => {
    if (!signedIn) return;
    startUploadManager();
    return stopUploadManager;
  }, [signedIn]);

  // Splash stays up while the stored session is read (UI-SPEC §1).
  if (isPending) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={!!data}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="capture" options={{ presentation: 'fullScreenModal' }} />
            <Stack.Screen name="world" />
          </Stack.Protected>
          <Stack.Protected guard={!data}>
            <Stack.Screen name="sign-in" />
          </Stack.Protected>
          <Stack.Screen name="r/[slug]" />
        </Stack>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
