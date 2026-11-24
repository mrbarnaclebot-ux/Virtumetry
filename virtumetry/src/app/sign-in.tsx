import React, { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
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

export default function SignInScreen() {
  const theme = useTheme();
  const [notice] = useState(consumeSessionEndedNotice);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState<'email' | 'password' | null>(null);
  const passwordRef = useRef<React.ComponentRef<typeof TextInput>>(null);

  const canSubmit = email.trim() !== '' && password.trim() !== '' && !submitting;

  useEffect(() => {
    if (error && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(error);
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

  const inputProps = (field: 'email' | 'password'): TextInputProps => ({
    editable: !submitting,
    placeholderTextColor: theme.textSecondary,
    onFocus: () => setFocused(field),
    onBlur: () => setFocused(null),
    style: [
      styles.input,
      { backgroundColor: theme.backgroundElement, color: theme.text },
      focused === field && { borderColor: theme.accent },
    ],
  });

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}>
            <ThemedText type="title" accessibilityRole="header">
              Virtumetry
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" style={styles.tagline}>
              Walk a room. Get it back in 3D.
            </ThemedText>

            {notice && (
              <ThemedText type="small" themeColor="textSecondary" style={styles.notice}>
                You were logged out. Log in again to continue.
              </ThemedText>
            )}

            <ThemedText type="small" style={styles.label}>
              Email
            </ThemedText>
            <TextInput
              {...inputProps('email')}
              accessibilityLabel="Email"
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

            <ThemedText type="small" style={[styles.label, styles.fieldGap]}>
              Password
            </ThemedText>
            <TextInput
              {...inputProps('password')}
              ref={passwordRef}
              accessibilityLabel="Password"
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

            {error && (
              <ThemedText
                type="small"
                themeColor="destructive"
                accessibilityLiveRegion="polite"
                style={styles.fieldGap}>
                {error}
              </ThemedText>
            )}

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log in"
              accessibilityState={{ disabled: !canSubmit, busy: submitting }}
              disabled={!canSubmit}
              onPress={submit}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: theme.accent },
                !canSubmit && !submitting && styles.disabled,
                pressed && styles.pressed,
              ]}>
              <View style={styles.buttonRow}>
                {submitting && <ActivityIndicator color={theme.onAccent} />}
                <ThemedText type="smallBold" themeColor="onAccent" maxFontSizeMultiplier={1.6}>
                  {submitting ? 'Logging in…' : 'Log in'}
                </ThemedText>
              </View>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.three,
    paddingTop: Spacing.six,
    paddingBottom: Spacing.four,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  tagline: { marginTop: Spacing.two, marginBottom: Spacing.five },
  notice: { marginBottom: Spacing.three },
  label: { marginBottom: Spacing.two },
  fieldGap: { marginTop: Spacing.three },
  input: {
    height: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  button: {
    marginTop: Spacing.three,
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
