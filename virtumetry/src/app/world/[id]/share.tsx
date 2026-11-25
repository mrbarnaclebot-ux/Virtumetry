import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share as RNShare,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { openCountLabel, useCreateShare, useRevokeShare, useShares, type Share } from '@/lib/shares';

const MIN = 6; // matches the backend's SHARE_PASSWORD_MIN (WR-04)
// URL only, never the password (T-05-27). iOS joins url + message on Copy/Messages ("url url"), so send one field.
const shareUrl = (url: string) => RNShare.share(Platform.OS === 'ios' ? { url } : { message: url });
const createdOn = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** D-18 share sheet (UI-SPEC §D): create, list, count and revoke a ready room's links. */
export default function ShareSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const shares = useShares(id);
  const create = useCreateShare(id);
  const revoke = useRevokeShare(id);
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  const [focused, setFocused] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const creating = create.isPending;
  const disabled = creating || (protect && password.length < MIN);

  const submit = () => {
    if (protect && password.length < MIN) return setTooShort(true);
    if (disabled) return;
    revoke.reset();
    create.mutate(protect ? password : undefined, {
      onSuccess: (share) => {
        setPassword('');
        setProtect(false);
        create.reset();
        shareUrl(share.url).catch(() => {});
      },
    });
  };

  const confirmRevoke = (share: Share) =>
    Alert.alert(
      'Turn off this link?',
      "Anyone with it won't be able to open the room anymore. People who already have it open keep what's loaded. You can't undo this.",
      [
        { text: 'Keep link', style: 'cancel' },
        { text: 'Revoke link', style: 'destructive', onPress: () => revoke.mutate(share.id) },
      ],
    );

  const onRefresh = async () => {
    setRefreshing(true);
    await shares.refetch();
    setRefreshing(false);
  };

  let helper: string | null = null;
  let helperError = false;
  if (create.isError) {
    helper = "Couldn't create the link. Check your connection and try again.";
    helperError = true;
  } else if (protect && tooShort) {
    helper = 'Use at least 6 characters.';
    helperError = true;
  } else if (protect) {
    helper = "Send the password separately. You can't see it again after you create the link.";
  }

  let list;
  if (shares.isPending) {
    list = <ActivityIndicator size="small" color={theme.accent} style={styles.listSpinner} />;
  } else if (shares.isError && !shares.data) {
    list = (
      <View style={styles.listError}>
        <ThemedText type="small" themeColor="destructive">
          {"Couldn't load your links."}
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={() => shares.refetch()}
          style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
          <ThemedText type="smallBold">Try again</ThemedText>
        </Pressable>
      </View>
    );
  } else if (shares.data.length === 0) {
    list = (
      <View style={styles.empty}>
        <ThemedText type="smallBold">No links yet</ThemedText>
        <ThemedText themeColor="textSecondary">
          Create a link to let anyone who has it walk through this room in a browser.
        </ThemedText>
      </View>
    );
  } else {
    list = shares.data.map((s, i) => {
      const count = openCountLabel(s.open_count);
      const date = createdOn(s.created_at);
      return (
        <View key={s.id}>
          {i > 0 && <View style={[styles.separator, { backgroundColor: theme.backgroundSelected }]} />}
          <View style={styles.row}>
            <View
              accessible
              accessibilityLabel={[s.url, s.has_password && 'password protected', count, `created ${date}`]
                .filter(Boolean)
                .join(', ')}
              style={styles.rowText}>
              <View style={styles.urlLine}>
                {s.has_password && (
                  <SymbolView testID="share-lock" name="lock.fill" size={14} tintColor={theme.textSecondary} />
                )}
                <ThemedText numberOfLines={1} ellipsizeMode="middle" style={styles.url}>
                  {s.url}
                </ThemedText>
              </View>
              <ThemedText type="small" themeColor="textSecondary">{`${count} · Created ${date}`}</ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share link"
              onPress={() => shareUrl(s.url).catch(() => {})}
              style={({ pressed }) => [styles.icon, pressed && styles.pressed]}>
              <SymbolView name="square.and.arrow.up" size={20} tintColor={theme.text} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Revoke link"
              accessibilityHint="Turns this link off"
              onPress={() => confirmRevoke(s)}
              style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
              <ThemedText type="small" themeColor="destructive" style={styles.bold}>
                Revoke
              </ThemedText>
            </Pressable>
          </View>
        </View>
      );
    });
  }

  return (
    <ThemedView style={styles.fill}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}>
        <View style={styles.header}>
          <ThemedText type="title" accessibilityRole="header">
            Share
          </ThemedText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={() => router.back()}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
            <ThemedText type="smallBold">Done</ThemedText>
          </Pressable>
        </View>

        <View style={[styles.card, { backgroundColor: theme.backgroundElement }]}>
          <View style={styles.switchRow}>
            <ThemedText style={styles.fill}>Protect with a password</ThemedText>
            <Switch
              accessibilityLabel="Protect with a password"
              value={protect}
              disabled={creating}
              onValueChange={(on) => {
                setProtect(on);
                setPassword('');
                setTooShort(false);
              }}
              trackColor={{ true: theme.accent }}
            />
          </View>
          {protect && (
            <View style={styles.passwordBlock}>
              <ThemedText type="small" themeColor="textSecondary">
                Password
              </ThemedText>
              <TextInput
                value={password}
                onChangeText={(t) => {
                  setPassword(t);
                  setTooShort(false);
                  create.reset();
                }}
                onSubmitEditing={submit}
                editable={!creating}
                secureTextEntry
                autoComplete="new-password"
                textContentType="newPassword"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={64}
                returnKeyType="done"
                placeholder="At least 6 characters"
                accessibilityLabel="Password"
                placeholderTextColor={theme.textSecondary}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                style={[
                  styles.input,
                  { backgroundColor: theme.background, color: theme.text },
                  focused && { borderColor: theme.accent },
                ]}
              />
            </View>
          )}
          {helper && (
            <ThemedText
              type="small"
              themeColor={helperError ? 'destructive' : 'textSecondary'}
              style={styles.helper}>
              {helper}
            </ThemedText>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create link"
            accessibilityState={{ disabled, busy: creating }}
            disabled={disabled}
            onPress={submit}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.accent },
              disabled && !creating && styles.disabled,
              pressed && styles.pressed,
            ]}>
            {creating && <ActivityIndicator size="small" color={theme.onAccent} />}
            <ThemedText type="smallBold" themeColor="onAccent">
              {creating ? 'Creating link…' : 'Create link'}
            </ThemedText>
          </Pressable>
        </View>

        <ThemedText type="subtitle" accessibilityRole="header" style={styles.section}>
          Links
        </ThemedText>
        {revoke.isError && (
          <ThemedText type="small" themeColor="destructive">
            {"Couldn't turn off the link. It still works. Try again."}
          </ThemedText>
        )}
        {list}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: Spacing.three, paddingTop: Spacing.three, paddingBottom: Spacing.five },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  card: { marginTop: Spacing.four, borderRadius: 12, padding: Spacing.three },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, minHeight: 44 },
  passwordBlock: { marginTop: Spacing.three, gap: Spacing.two },
  input: {
    height: 48,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  helper: { marginTop: Spacing.two },
  button: {
    marginTop: Spacing.three,
    height: 52,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
  },
  section: { marginTop: Spacing.four, marginBottom: Spacing.two },
  listSpinner: { alignSelf: 'flex-start', marginTop: Spacing.two },
  listError: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, flexWrap: 'wrap' },
  empty: { gap: Spacing.two, marginTop: Spacing.two },
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  rowText: { flex: 1, gap: Spacing.half },
  urlLine: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one },
  url: { flexShrink: 1 },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  textButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  bold: { fontWeight: '600' },
  separator: { height: StyleSheet.hairlineWidth },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
