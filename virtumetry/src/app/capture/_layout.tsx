import { Stack } from 'expo-router';

// D-12: capture flow, presented as one full-screen modal from the root stack.
export default function CaptureLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
