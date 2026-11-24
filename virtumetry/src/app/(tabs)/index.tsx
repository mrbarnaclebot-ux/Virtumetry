import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { LibraryRow, type RowItem } from '@/components/library-row';
import { RenameModal } from '@/components/rename-modal';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { DisplayState } from '@/library/display-state';
import { useLocalScans } from '@/library/local-scans';
import { useWorlds } from '@/lib/api';

export default function LibraryScreen() {
  const theme = useTheme();
  const { data, error, isPending, refetch } = useWorlds();
  const { scans } = useLocalScans();
  const [refreshing, setRefreshing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);

  // Row action menu (D-21). Local scans have no server id, so they get Delete only.
  const openRowMenu = (item: RowItem, state: DisplayState) => {
    const title = state.displayTitle;
    Alert.alert(title, undefined, [
      ...('local' in item ? [] : [{ text: 'Rename', onPress: () => setRenaming({ id: item.id, title }) }]),
      { text: 'Delete', style: 'destructive' as const },
      { text: 'Cancel', style: 'cancel' as const },
    ]);
  };

  // Only a user-started refresh shows the spinner; background polling never does.
  const onRefresh = async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  };

  const items: RowItem[] = [
    ...scans.map((s) => ({ ...s, local: true as const })),
    ...(data?.worlds ?? []),
  ];
  const noCache = !data && scans.length === 0;

  const header = (
    <>
      <ThemedText type="title" accessibilityRole="header" style={styles.title}>
        Library
      </ThemedText>
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
          Scans you capture show up here, with their progress and status. Pull down to refresh.
        </ThemedText>
      </View>
    );
  }

  return (
    <ThemedView style={styles.flex}>
      <FlatList
        data={items}
        keyExtractor={(i) => ('local' in i ? `local-${i.id}` : i.id)}
        renderItem={({ item }) => <LibraryRow item={item} onMore={openRowMenu} />}
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
  title: { marginTop: Spacing.three, marginBottom: Spacing.four },
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
