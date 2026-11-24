import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { AppState, Platform, useColorScheme } from 'react-native';

import { authClient } from '@/lib/auth-client';
import { queryClient } from '@/lib/query-client';

SplashScreen.preventAutoHideAsync();

// Pause React Query polling while the app is in the background (D-20).
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const { data, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending) SplashScreen.hideAsync();
  }, [isPending]);

  // Splash stays up while the stored session is read (UI-SPEC §1).
  if (isPending) return null;

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={!!data}>
            <Stack.Screen name="(tabs)" />
          </Stack.Protected>
          <Stack.Protected guard={!data}>
            <Stack.Screen name="sign-in" />
          </Stack.Protected>
        </Stack>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
