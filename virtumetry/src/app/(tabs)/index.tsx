import { useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { LibraryRow, type RowItem } from '@/components/library-row';
import { RenameModal } from '@/components/rename-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { getPrepFlags } from '@/capture/prep-flags';
import { getCaptureSource, isFixtureSource } from '@/capture/source';
import { useLocalScans } from '@/capture/store';
import type { DisplayState, LocalScan } from '@/library/display-state';
import { useDeleteWorld, useWorlds } from '@/lib/api';

export default function LibraryScreen() {
  const theme = useTheme();
  const { scans, remove: removeLocal } = useLocalScans();
  const forcePoll = scans.some((s) => s.uploadState === 'approved' || s.uploadState === 'uploading' || s.uploadState === 'paused');
  const { data, error, isPending, refetch } = useWorlds({ forcePoll });
  const deleteWorld = useDeleteWorld();
  const [refreshing, setRefreshing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [camera] = useCameraPermissions();

  // D-11: skip prep when "Don't show again" is set and the camera is ready (or the fixture needs none).
  const newScan = () => {
    const { skip, askedOnce } = getPrepFlags();
    const ready = camera?.granted || (isFixtureSource(getCaptureSource()) && askedOnce);
    router.push(skip && ready ? '/capture/scan' : '/capture/prep');
  };

  const newScanButton = (style: 'pill' | 'button') => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New scan"
      onPress={newScan}
      style={({ pressed }) => [styles[style], { backgroundColor: theme.accent }, pressed && styles.pressed]}>
      {style === 'pill' && <SymbolView name="plus" size={16} tintColor={theme.onAccent} />}
      <ThemedText type="smallBold" themeColor="onAccent" maxFontSizeMultiplier={1.6}>
        New scan
      </ThemedText>
    </Pressable>
  );

  const openScan = (scan: LocalScan) =>
    router.push({
      pathname: '/capture/[id]',
      params: { id: scan.id, step: scan.uploadState === 'saved' ? 'review' : 'upload' },
    });

  // Row action menu (D-21). Local scans have no server id: Discard only (UI-SPEC §2).
  const openRowMenu = (item: RowItem, state: DisplayState) => {
    const title = state.displayTitle;
    if ('local' in item) {
      Alert.alert(title, undefined, [
        { text: 'Discard', style: 'destructive', onPress: () => confirmDiscard(item.id, item.frameCount) },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    }
    Alert.alert(title, undefined, [
      { text: 'Rename', onPress: () => setRenaming({ id: item.id, title }) },
      { text: 'Delete', style: 'destructive', onPress: () => confirmDelete(item.id, title) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const confirmDiscard = (id: string, n: number) => {
    Alert.alert('Discard this scan?', `This deletes its ${n} photos from your phone. You can't undo this.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          try {
            removeLocal(id);
          } catch {
            Alert.alert("Couldn't discard", 'Try again. If it keeps failing, restart the app.', [
              { text: 'Back to Review' },
            ]);
          }
        },
      },
    ]);
  };

  const confirmDelete = (id: string, title: string) => {
    Alert.alert(`Delete "${title}"?`, "This removes it from your phone, our servers and SpAItial. You can't undo this.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteWorld.mutate(id) },
    ]);
  };

  // Only a user-started refresh shows the spinner; background polling never does.
  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  // Once the server row is past uploading it replaces the local row (Pitfall 10).
  const serverStatus = new Map((data?.worlds ?? []).map((w) => [w.id, w.status]));
  const shownScans = scans.filter((s) => {
    const status = s.serverWorldId ? serverStatus.get(s.serverWorldId) : undefined;
    return status === undefined || status === 'uploading';
  });
  const items: RowItem[] = [
    ...shownScans.map((s) => ({ ...s, local: true as const })),
    ...(data?.worlds ?? []),
  ];
  const noCache = !data && shownScans.length === 0;

  const header = (
    <>
      <View style={styles.headerRow}>
        <ThemedText type="title" accessibilityRole="header">
          Library
        </ThemedText>
        {newScanButton('pill')}
      </View>
      {error && data && (
        <ThemedText type="small" themeColor="destructive" style={styles.refreshError}>
          {"Couldn't refresh. Showing your last saved list."}
        </ThemedText>
      )}
    </>
  );

  let empty;
  if (noCache && isPending) {
    empty = (
      <View style={styles.center}>
        <ActivityIndicator testID="library-loading" size="large" color={theme.accent} />
      </View>
    );
  } else if (noCache && error) {
    empty = (
      <View style={styles.center}>
        <ThemedText type="subtitle" style={styles.heading}>
          {"Couldn't load your scans"}
        </ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.textCenter}>
          Check your connection, then try again.
        </ThemedText>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={() => refetch()}
          style={({ pressed }) => [
            styles.retry,
            { backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement },
          ]}>
          <ThemedText type="smallBold">Try again</ThemedText>
        </Pressable>
      </View>
    );
  } else {
    empty = (
      <View style={styles.center}>
        <View accessible={false}>
          <SymbolView name="cube.transparent" size={48} tintColor={theme.textSecondary} />
        </View>
        <ThemedText type="subtitle" style={styles.heading}>
          No scans yet
        </ThemedText>
        <ThemedText themeColor="textSecondary" style={styles.textCenter}>
          Walk slowly around a room with your phone, and it comes back here in 3D.
        </ThemedText>
        {newScanButton('button')}
      </View>
    );
  }

  return (
    <ThemedView style={styles.flex}>
      <FlatList
        data={items}
        keyExtractor={(i) => ('local' in i ? `local-${i.id}` : i.id)}
        renderItem={({ item }) => <LibraryRow item={item} onMore={openRowMenu} onOpen={openScan} />}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: theme.backgroundSelected }]} />
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />
        }
      />
      {renaming && <RenameModal key={renaming.id} {...renaming} onClose={() => setRenaming(null)} />}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    flexGrow: 1,
    paddingHorizontal: Spacing.three,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  headerRow: {
    marginTop: Spacing.three,
    marginBottom: Spacing.four,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pill: {
    height: 44,
    borderRadius: 22,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  button: {
    marginTop: Spacing.four,
    height: 52,
    borderRadius: 12,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.8 },
  refreshError: { marginBottom: Spacing.three },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: Spacing.six },
  heading: { marginTop: Spacing.three, marginBottom: Spacing.two, textAlign: 'center' },
  textCenter: { textAlign: 'center' },
  retry: {
    marginTop: Spacing.four,
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: 12,
    justifyContent: 'center',
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 96 - Spacing.three },
});
