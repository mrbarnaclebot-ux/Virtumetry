import { useNetworkState } from 'expo-network';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, Pressable, RefreshControl, ScrollView, Share as RNShare, StyleSheet, Switch, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Glyph } from '@/components/ui/glyph';
import { Icon } from '@/components/ui/icon';
import { IconButton } from '@/components/ui/icon-button';
import { SheetHeader } from '@/components/ui/sheet-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Surface } from '@/components/ui/surface';
import { TextField } from '@/components/ui/text-field';
import { toast } from '@/components/ui/toast';
import { haptic } from '@/design/haptics';
import { color, radius, space } from '@/design/tokens';
import { openCountLabel, useCreateShare, useRevokeShare, useShares, type Share } from '@/lib/shares';

const MIN = 6; // matches the backend's SHARE_PASSWORD_MIN (WR-04)
const OFFLINE = "You're offline. Connect to create or turn off links.";
// URL only, never the password (T-05-27). iOS joins url + message on Copy/Messages ("url url"), so send one field.
const shareUrl = (url: string) => RNShare.share(Platform.OS === 'ios' ? { url } : { message: url });
const createdOn = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** D-18 share sheet (UI-SPEC §7.11): create, list, count and revoke a ready room's links. */
export default function ShareSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const shares = useShares(id);
  const create = useCreateShare(id);
  const revoke = useRevokeShare(id);
  const offline = useNetworkState().isInternetReachable === false;
  const [protect, setProtect] = useState(false);
  const [password, setPassword] = useState('');
  const [tooShort, setTooShort] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const creating = create.isPending;
  const disabled = offline || creating || (protect && password.length < MIN);

  const submit = () => {
    if (protect && password.length < MIN) return setTooShort(true);
    if (disabled) return;
    create.mutate(protect ? password : undefined, {
      onSuccess: (share) => {
        setPassword('');
        setProtect(false);
        create.reset();
        toast.success('Link created');
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
        {
          text: 'Revoke link',
          style: 'destructive',
          onPress: () =>
            revoke.mutate(share.id, {
              onSuccess: () => toast.success('Link turned off'),
              onError: () => toast.error("Couldn't turn off the link. It still works. Try again."),
            }),
        },
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
    list = (
      <View accessible accessibilityLabel="Loading links" accessibilityState={{ busy: true }}>
        {[0, 1].map((k) => (
          <View key={k} style={styles.skeletonRow}>
            <Skeleton width="70%" height={16} />
            <Skeleton width="40%" height={14} />
          </View>
        ))}
      </View>
    );
  } else if (shares.isError && !shares.data) {
    list = (
      <View style={styles.listError}>
        <Glyph id="alert" size={16} color={color.danger} />
        <ThemedText type="label" tone="danger">
          {"Couldn't load your links."}
        </ThemedText>
        <Button variant="ghost" size="md" label="Try again" onPress={() => void shares.refetch()} />
      </View>
    );
  } else if (shares.data.length === 0) {
    list = (
      <EmptyState
        compact
        icon="link"
        title="No links yet"
        body="Create a link to let anyone who has it walk through this room in a browser."
      />
    );
  } else {
    list = shares.data.map((s, i) => {
      const count = openCountLabel(s.open_count);
      const date = createdOn(s.created_at);
      return (
        <View key={s.id} style={[styles.row, i > 0 && styles.separator]}>
          <View
            accessible
            accessibilityLabel={[s.url, s.has_password && 'password protected', count, `created ${date}`]
              .filter(Boolean)
              .join(', ')}
            style={styles.rowText}>
            <View style={styles.urlLine}>
              {s.has_password && (
                <View testID="share-lock">
                  <Icon name="lock" size={16} color={color.textMuted} />
                </View>
              )}
              <ThemedText type="label" numberOfLines={1} ellipsizeMode="middle" style={styles.url}>
                {s.url}
              </ThemedText>
            </View>
            <ThemedText type="caption" tone="muted">{`${count} · Created ${date}`}</ThemedText>
          </View>
          <IconButton icon="share" accessibilityLabel="Share link" onPress={() => shareUrl(s.url).catch(() => {})} />
          {/* Ghost destructive md; Button can't carry a distinct a11y name ("Revoke link" vs visible "Revoke"). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Revoke link"
            accessibilityHint="Turns this link off"
            onPress={() => confirmRevoke(s)}
            style={({ pressed }) => [styles.revoke, pressed && styles.pressed]}>
            <ThemedText type="bodyStrong" tone="danger">
              Revoke
            </ThemedText>
          </Pressable>
        </View>
      );
    });
  }

  return (
    <View style={styles.fill}>
      <SheetHeader title="Share" trailing={{ label: 'Done', onPress: () => router.back() }} />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.primary} />}>
        {offline && <Banner tone="neutral" icon="offline" title={OFFLINE} />}

        <Surface padded style={styles.group}>
          <View style={styles.switchRow}>
            <ThemedText style={styles.fill}>Protect with a password</ThemedText>
            <Switch
              accessibilityRole="switch"
              accessibilityLabel="Protect with a password"
              accessibilityState={{ checked: protect }}
              value={protect}
              disabled={creating}
              onValueChange={(on) => {
                haptic.selection();
                setProtect(on);
                setPassword('');
                setTooShort(false);
              }}
              trackColor={{ true: color.primary, false: color.surface.pressed }}
              ios_backgroundColor={color.surface.pressed}
            />
          </View>
          {protect ? (
            <TextField
              label="Password"
              inGroup
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
              error={helperError ? helper : null}
              helper={helperError ? undefined : (helper ?? undefined)}
            />
          ) : (
            helper && (
              <ThemedText type="label" tone="danger" accessibilityLiveRegion="polite">
                {helper}
              </ThemedText>
            )
          )}
          <Button
            label="Create link"
            busy={creating}
            busyLabel="Creating link…"
            disabled={disabled}
            hint={offline ? OFFLINE : undefined}
            onPress={submit}
          />
        </Surface>

        <ThemedText type="heading" accessibilityRole="header" style={styles.section}>
          Links
        </ThemedText>
        {list}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: space.lg, paddingBottom: space.xxxl, gap: space.lg },
  group: { gap: space.lg },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.lg, minHeight: 44 },
  section: { marginTop: space.lg }, // + content gap = 32 above
  skeletonRow: { minHeight: 72, justifyContent: 'center', gap: space.sm },
  listError: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  separator: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.hairline },
  rowText: { flex: 1, gap: space.xs },
  urlLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  url: { flexShrink: 1 },
  revoke: { height: 44, paddingHorizontal: space.lg, borderRadius: radius.md, justifyContent: 'center' },
  pressed: { backgroundColor: color.surface.pressed },
});
