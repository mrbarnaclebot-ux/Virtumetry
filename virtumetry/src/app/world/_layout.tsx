import { Stack } from 'expo-router';

// D-14: full-screen viewer outside the tabs. No back swipe: it would steal left-edge joystick drags (UI-SPEC A).
export default function WorldLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="[id]/index" options={{ gestureEnabled: false }} />
      {/* D-18: iOS page sheet over the viewer. */}
      <Stack.Screen name="[id]/share" options={{ presentation: 'modal' }} />
    </Stack>
  );
}
