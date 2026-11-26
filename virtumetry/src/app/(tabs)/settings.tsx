import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Alert, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { BrandMark } from '@/components/ui/brand-mark';
import { Group, ListRow } from '@/components/ui/list-row';
import { Screen } from '@/components/ui/screen';
import { APP_ENV } from '@/config/api';
import { resetCoachMarks } from '@/design/first-run';
import { minTarget, space } from '@/design/tokens';
import { authClient } from '@/lib/auth-client';
import { endSession } from '@/lib/session';

/** UI-SPEC §7.3: Account and Help groups, brand footer. */
export default function SettingsScreen() {
  const { data } = authClient.useSession();

  // On success or failure endSession drops the session; Stack.Protected then shows sign-in.
  const confirmLogOut = () =>
    Alert.alert('Log out?', "You'll need your email and password to log back in.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Log out', style: 'destructive', onPress: () => endSession({ notice: false }) },
    ]);

  const replayIntro = () => {
    resetCoachMarks();
    router.push({ pathname: '/onboarding', params: { replay: '1' } });
  };

  return (
    <Screen scroll>
      <ThemedText type="title" accessibilityRole="header" style={styles.title}>
        Settings
      </ThemedText>

      <View style={styles.groups}>
        <Group title="Account">
          <View style={styles.account}>
            <ThemedText type="caption" tone="muted">
              Signed in as
            </ThemedText>
            <ThemedText selectable>{data?.user.email}</ThemedText>
          </View>
          <ListRow leading="logout" tone="danger" title="Log out" onPress={confirmLogOut} />
        </Group>

        <Group title="Help">
          <ListRow leading="replay" title="Replay intro" subtitle="Shows the intro and tips again." trailing="chevron" onPress={replayIntro} />
        </Group>
      </View>

      <View style={styles.footer}>
        <BrandMark size={20} mono />
        <ThemedText type="caption" tone="muted">
          {`Virtumetry ${Constants.expoConfig?.version ?? ''} · ${APP_ENV}`}
        </ThemedText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: space.lg, marginBottom: space.xl },
  groups: { gap: space.xl },
  account: { minHeight: minTarget, paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs },
  footer: { marginTop: space.xxl, marginBottom: space.xl, alignItems: 'center', gap: space.sm },
});
