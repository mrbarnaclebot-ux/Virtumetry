import { useCameraPermissions } from 'expo-camera';
import { useNetworkState } from 'expo-network';
import { router, type Href } from 'expo-router';
import { useEffect, useEffectEvent, useState } from 'react';
import { AccessibilityInfo, Alert, RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { LibraryEmptyArt } from '@/components/library-empty-art';
import { LibraryRow, rowActions, type RowItem } from '@/components/library-row';
import { RenameModal } from '@/components/rename-modal';
import { ThemedText } from '@/components/themed-text';
import { Banner } from '@/components/ui/banner';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { SkeletonRow } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { getPrepFlags } from '@/capture/prep-flags';
import { getCaptureSource, isFixtureSource } from '@/capture/source';
import { useLocalScans } from '@/capture/store';
import { consumeIntent, getOnboardingSkipped } from '@/design/first-run';
import { haptic } from '@/design/haptics';
import { ease, useReduceMotion } from '@/design/motion';
import { color, motion, space } from '@/design/tokens';
import type { DisplayState, LibraryItem, LocalScan } from '@/library/display-state';
import { useDeleteWorld, useWorlds, type BudgetAlert } from '@/lib/api';

// D-13: dismissed/announced per window for this JS session only (no storage).
const dismissedAlerts = new Set<string>();
const announcedAlerts = new Set<string>();

/** Test-only: clears the per-session banner state. */
export function __resetBudgetBannerForTest() {
  dismissedAlerts.clear();
  announcedAlerts.clear();
}

function BudgetBanner({ alert }: { alert: BudgetAlert }) {
  const [, setTick] = useState(0);
  const daily = alert.window === 'daily';
  const pct = Math.min(100, Math.floor((alert.spent / alert.budget) * 100));
  const which = daily ? "today's" : "this month's";
  const line1 = `You've used ${pct >= 100 ? 'all' : `${pct}%`} of ${which} processing budget.`;
  const line2 = daily ? 'New scans may wait until tomorrow.' : 'New scans may wait until next month.';
  const hidden = dismissedAlerts.has(alert.window);

  useEffect(() => {
    if (hidden || announcedAlerts.has(alert.window)) return;
    announcedAlerts.add(alert.window);
    AccessibilityInfo.announceForAccessibility(line1);
  }, [hidden, alert.window, line1]);

  if (hidden) return null;
  return (
    <Banner
      tone="warning"
      icon="warning"
      title={line1}
      body={line2}
      dismissLabel="Dismiss budget alert"
      onDismiss={() => {
        dismissedAlerts.add(alert.window);
        setTick((t) => t + 1);
      }}
    />
  );
}

const STEPS = ['Scan the room slowly', 'Check the cost, then approve', 'Walk, measure and share'];

export default function LibraryScreen() {
  const { scans, remove: removeLocal } = useLocalScans();
  const forcePoll = scans.some((s) => s.uploadState === 'approved' || s.uploadState === 'uploading' || s.uploadState === 'paused');
  const { data, error, isPending, refetch } = useWorlds({ forcePoll });
  const deleteWorld = useDeleteWorld();
  const [refreshing, setRefreshing] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [camera] = useCameraPermissions();
  const offline = useNetworkState()?.isInternetReachable === false;
  const reduce = useReduceMotion();

  // D-11: skip prep when "Don't show again" is set and the camera is ready (or the fixture needs none).
  const newScan = () => {
    const { skip, askedOnce } = getPrepFlags();
    const ready = camera?.granted || (isFixtureSource(getCaptureSource()) && askedOnce);
    router.push(skip && ready ? '/capture/scan' : '/capture/prep');
  };

  // §8.1: the onboarding "Scan your first room" CTA leaves a one-shot intent for the Library.
  const onMountIntent = useEffectEvent(() => {
    if (consumeIntent() === 'scan') newScan();
  });
  useEffect(() => onMountIntent(), []);

  const openScan = (scan: LocalScan) =>
    router.push({
      pathname: '/capture/[id]',
      params: { id: scan.id, step: scan.uploadState === 'saved' ? 'review' : 'upload' },
    });

  // Typegen lists the folder route as '/world/[id]/index'; the URL /world/<id> is what matches it.
  const openWorld = (world: { id: string }) =>
    router.push({ pathname: '/world/[id]', params: { id: world.id } } as unknown as Href);

  // D-11: failed server rows open the retry sheet, which explains the failure or quotes a retry.
  const openRetry = (world: { id: string }) =>
    router.push({ pathname: '/world/[id]/retry', params: { id: world.id } } as unknown as Href);

  // Row action menu (D-21): the entries come from rowActions, the same list that shows or hides
  // the row's More button. A local scan's Delete targets its server world (iter-2 WR-02).
  const openRowMenu = (item: RowItem, state: DisplayState) => {
    const title = state.displayTitle;
    const worldId = 'local' in item ? item.serverWorldId : item.id;
    const buttons = rowActions(item).map((a) => {
      if (a === 'Retry') return { text: 'Retry…', onPress: () => openRetry(item) };
      if (a === 'Rename') return { text: 'Rename', onPress: () => setRenaming({ id: item.id, title: item.title?.trim() ?? '' }) }; // review IN-05: never prefill the date fallback
      if (a === 'Discard') return { text: 'Discard', style: 'destructive' as const, onPress: () => confirmDiscard(item.id, (item as LocalScan).frameCount) };
      return { text: 'Delete', style: 'destructive' as const, onPress: () => worldId && confirmDelete(worldId, title) };
    });
    Alert.alert(title, undefined, [...buttons, { text: 'Cancel', style: 'cancel' }]);
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
            toast.error("Couldn't discard. Try again.");
            return;
          }
          toast.success('Scan discarded');
        },
      },
    ]);
  };

  const confirmDelete = (id: string, title: string) => {
    Alert.alert(`Delete "${title}"?`, "This removes it from your phone and our servers, including processed files. You can't undo this."
, [
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

  // A 'done' entry (files already deleted) is dropped once the server lists its world, so it
  // can't come back as a stale "Uploaded" row after a delete or past the first page (WR-07).
  const listed = data?.worlds;
  useEffect(() => {
    const ids = new Set((listed ?? []).map((w) => w.id));
    for (const s of scans) {
      if (s.uploadState !== 'done' || !s.serverWorldId || !ids.has(s.serverWorldId)) continue;
      try {
        removeLocal(s.id);
      } catch {
        // Kept; retried on the next list refresh.
      }
    }
  }, [listed, scans, removeLocal]);

  // First ready moment: a world seen non-ready earlier on this screen that is now ready (never on first load).
  // Derived while rendering from the previous list (no effect setState); the haptic follows the count.
  const [track, setTrack] = useState<{ listed?: LibraryItem[]; prev: ReadonlyMap<string, string>; ready: ReadonlySet<string> }>(
    () => ({ prev: new Map(), ready: new Set() }),
  );
  if (listed && listed !== track.listed) {
    const prev = new Map(track.prev);
    const ready = new Set(track.ready);
    for (const w of listed) {
      const before = track.prev.get(w.id);
      if (w.status === 'ready' && before !== undefined && before !== 'ready') ready.add(w.id);
      prev.set(w.id, w.status);
    }
    setTrack({ listed, prev, ready });
  }
  const readyCount = track.ready.size;
  useEffect(() => {
    if (readyCount > 0) haptic.success();
  }, [readyCount]);

  const shownScans = scans.filter((s) => {
    const status = s.serverWorldId ? serverStatus.get(s.serverWorldId) : undefined;
    return status === undefined || status === 'uploading';
  });
  // ...and while it is shown, the local row stands in for its server row (WR-01).
  const shadowed = new Set(shownScans.map((s) => s.serverWorldId));
  const items: RowItem[] = [
    ...shownScans.map((s) => ({ ...s, local: true as const })),
    ...(data?.worlds ?? []).filter((w) => !shadowed.has(w.id)),
  ];
  const noCache = !data && shownScans.length === 0;
  const hasItems = items.length > 0;

  const header = (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <ThemedText type="title" accessibilityRole="header">
          Library
        </ThemedText>
        {/* First run: the EmptyState CTA is the single primary instead. */}
        {hasItems && <Button size="md" icon="newScan" label="New scan" onPress={newScan} />}
      </View>
      {hasItems && offline && (
        <Banner
          tone="neutral"
          icon="offline"
          title="You're offline. Showing your last saved list."
          body="Uploads resume when you're back online."
        />
      )}
      {hasItems && !offline && error && data && (
        <Banner
          tone="neutral"
          icon="refresh"
          title="Couldn't refresh. Showing your last saved list."
          action={{ label: 'Refresh', onPress: () => void refetch() }}
        />
      )}
      {/* Never in the empty/error/loading states: those have no rows to sit above. */}
      {data?.budgetAlert && hasItems && <BudgetBanner alert={data.budgetAlert} />}
    </View>
  );

  let empty;
  if (noCache && offline) {
    empty = (
      <ErrorState
        icon="offline"
        title="You're offline"
        body="Your scans show up here when you're back online."
        action={{ label: 'Try again', onPress: () => void refetch() }}
        style={styles.center}
      />
    );
  } else if (noCache && isPending) {
    empty = (
      <View testID="library-loading" accessible accessibilityLabel="Loading your scans" accessibilityState={{ busy: true }}>
        {[0, 1, 2, 3].map((i) => (
          <SkeletonRow key={i} />
        ))}
      </View>
    );
  } else if (noCache && error) {
    empty = (
      <ErrorState
        icon="warning"
        title="Couldn't load your scans"
        body="Check your connection, then try again."
        action={{ label: 'Try again', onPress: () => void refetch() }}
        style={styles.center}
      />
    );
  } else {
    empty = (
      <EmptyState
        art={<LibraryEmptyArt />}
        title="No scans yet"
        body="Walk slowly around a room with your phone, and it comes back here in 3D."
        // Critique F3: the steps repeat the intro, so only users who skipped it see them.
        steps={getOnboardingSkipped() ? STEPS : undefined}
        action={{ label: 'Scan a room', icon: 'newScan', onPress: newScan }}
        style={styles.empty}
      />
    );
  }

  return (
    <Screen edges={['top']} contentStyle={styles.column}>
      <Animated.FlatList
        data={items}
        keyExtractor={(i) => ('local' in i ? `local-${i.id}` : i.id)}
        itemLayoutAnimation={reduce ? undefined : LinearTransition.duration(motion.duration.base).easing(ease.outQuart)}
        renderItem={({ item }) => (
          // Pattern 4: layout animations on a wrapper, never on the row (its opacity is styled).
          <Animated.View
            entering={reduce ? undefined : FadeIn.duration(motion.duration.base)}
            exiting={reduce ? undefined : FadeOut.duration(motion.duration.fast)}>
            <LibraryRow
              item={item}
              onMore={openRowMenu}
              onOpen={openScan}
              onOpenWorld={openWorld}
              onOpenFailed={openRetry}
              justReady={!('local' in item) && track.ready.has(item.id)}
            />
          </Animated.View>
        )}
        ItemSeparatorComponent={Separator}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={color.primary} colors={[color.primary]} />
        }
      />
      {renaming && <RenameModal key={renaming.id} {...renaming} onClose={() => setRenaming(null)} />}
    </Screen>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  column: { paddingHorizontal: 0 },
  content: { flexGrow: 1, paddingHorizontal: space.lg, paddingBottom: space.xxl },
  header: { gap: space.lg, marginTop: space.lg, marginBottom: space.xl },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md },
  center: { flex: 1, justifyContent: 'center', paddingBottom: space.xxxl },
  empty: { paddingBottom: space.xxl },
  // Inset past the 88 thumb + 16 gap.
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 104, backgroundColor: color.hairline },
});
