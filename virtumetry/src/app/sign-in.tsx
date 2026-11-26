import { useNetworkState } from 'expo-network';
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Banner } from '@/components/ui/banner';
import { BrandMark } from '@/components/ui/brand-mark';
import { Button } from '@/components/ui/button';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { haptic } from '@/design/haptics';
import { space } from '@/design/tokens';
import { authClient } from '@/lib/auth-client';
import { consumeSessionEndedNotice } from '@/lib/session';

const COPY = {
  mismatch: "That email and password don't match. Try again.",
  rate: 'Too many attempts. Wait a minute, then try again.',
  network: "Can't reach Virtumetry. Check your connection and try again.",
  server: 'Something went wrong on our side. Try again in a moment.',
};

// One mismatch message for wrong password and non-allowlisted email (no account enumeration).
function errorCopy(status: number | undefined): string {
  if (!status) return COPY.network;
  if (status === 401) return COPY.mismatch;
  if (status === 429) return COPY.rate;
  return COPY.server;
}

/** UI-SPEC §7.1. */
export default function SignInScreen() {
  const network = useNetworkState();
  const [notice] = useState(consumeSessionEndedNotice);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const offline = network.isInternetReachable === false;
  const filled = email.trim() !== '' && password.trim() !== '';
  const canSubmit = filled && !submitting;

  useEffect(() => {
    if (!error) return;
    haptic.error();
    if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(error);
  }, [error]);

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await authClient.signIn.email({ email: email.trim(), password });
      // On success the session atom updates and Stack.Protected swaps to the tabs.
      if (res.error) setError(errorCopy(res.error.status));
    } catch {
      setError(COPY.network);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen maxWidth="form" keyboard scroll contentStyle={styles.content}>
      {/* One brand lockup (mark + wordmark); the wrapper is the screen's header. */}
      <View accessible accessibilityRole="header" accessibilityLabel="Virtumetry" style={styles.lockup}>
        <BrandMark variant="lockup" size={44} />
      </View>
      <ThemedText tone="muted" style={styles.tagline}>
        Walk a room. Get it back in 3D.
      </ThemedText>

      {(notice || offline) && (
        <View style={styles.banners}>
          {notice && <Banner tone="info" icon="info" title="You were logged out. Log in again to continue." />}
          {offline && (
            <Banner tone="neutral" icon="offline" title="You're offline. Connect to log in." />
          )}
        </View>
      )}

      <View style={[styles.fields, (notice || offline) && styles.afterBanner]}>
        <TextField
          label="Email"
          editable={!submitting}
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            setError(null);
          }}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <TextField
          ref={passwordRef}
          label="Password"
          error={error}
          editable={!submitting}
          value={password}
          onChangeText={(v) => {
            setPassword(v);
            setError(null);
          }}
          placeholder="Your password"
          secureTextEntry
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={submit}
        />
      </View>

      <Button
        label="Log in"
        busy={submitting}
        busyLabel="Logging in…"
        disabled={!filled}
        hint="Enter your email and password first."
        onPress={submit}
        style={styles.button}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: space.huge, paddingBottom: space.xl },
  lockup: { alignSelf: 'flex-start' },
  tagline: { marginTop: space.lg },
  banners: { marginTop: space.xxl, gap: space.md },
  fields: { marginTop: space.xxl, gap: space.lg },
  afterBanner: { marginTop: space.lg },
  button: { marginTop: space.xl },
});
