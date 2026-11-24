import Constants from 'expo-constants';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { APP_ENV } from '@/config/api';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { authClient } from '@/lib/auth-client';
import { endSession } from '@/lib/session';

export default function SettingsScreen() {
  const theme = useTheme();
  const { data } = authClient.useSession();

  // On success or failure endSession drops the session; Stack.Protected then shows sign-in.
  const confirmLogOut = () =>
    Alert.alert('Log out?', "You'll need your email and password to log back in.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => endSession({ notice: false }) },
    ]);

  return (
    <ThemedView style={styles.flex}>
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <ThemedText type="title" accessibilityRole="header" style={styles.title}>
          Settings
        </ThemedText>

        <ThemedText type="subtitle" style={styles.section}>
          Account
        </ThemedText>
        <ThemedView type="backgroundElement" style={styles.card}>
          <View style={styles.row}>
            <ThemedText type="small" themeColor="textSecondary">
              Signed in as
            </ThemedText>
            <ThemedText selectable>{data?.user.email}</ThemedText>
          </View>
          <View style={[styles.hairline, { backgroundColor: theme.backgroundSelected }]} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log out"
            onPress={confirmLogOut}
            style={({ pressed }) => [
              styles.logOut,
              pressed && { backgroundColor: theme.backgroundSelected },
            ]}>
            <ThemedText type="smallBold" themeColor="destructive" maxFontSizeMultiplier={1.6}>
              Log out
            </ThemedText>
          </Pressable>
        </ThemedView>

        <ThemedText type="small" themeColor="textSecondary" style={styles.footer}>
          {`Virtumetry ${Constants.expoConfig?.version ?? ''} · ${APP_ENV}`}
        </ThemedText>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.three,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  title: { marginTop: Spacing.three, marginBottom: Spacing.four },
  section: { marginBottom: Spacing.two },
  card: { borderRadius: 12, overflow: 'hidden' },
  row: { minHeight: 44, padding: Spacing.three },
  hairline: { height: StyleSheet.hairlineWidth },
  logOut: { minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  footer: { marginTop: Spacing.four, textAlign: 'center' },
});
