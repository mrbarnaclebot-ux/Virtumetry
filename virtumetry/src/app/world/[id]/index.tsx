import { useQueryClient } from '@tanstack/react-query';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { IconButton } from '@/components/ui/icon-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { isCoachSeen, markCoachSeen } from '@/design/first-run';
import { haptic } from '@/design/haptics';
import { ApiError, useWorld, WORLD_URL_FRESH_MS } from '@/lib/api';
import { initialRecovery, recoveryReducer } from '@/viewer/recovery';
import { VT } from '@/viewer/tokens';
import type { Pose } from '@/viewer/types';
import { scanTitle } from '@/library/display-state';
import WorldViewer from '@/viewer/world-viewer';

const TOP_BAR = 44;
const CHROME = 1.3; // maxFontSizeMultiplier on viewer chrome (UI-SPEC Typography)
const BAR_W = 200;

// Critique R1 #9: the first-open reveal plays once per world. SecureStore keys allow [A-Za-z0-9._-] only (T-06.1-33).
const revealKey = (id: string | undefined) => (id && /^[\w-]+$/.test(id) ? `vm.reveal.${id}` : null);
const isRevealed = (id: string | undefined) => {
  const k = revealKey(id);
  try {
    return !!k && SecureStore.getItem(k) === '1';
  } catch {
    return false;
  }
};
const markRevealed = (id: string | undefined) => {
  const k = revealKey(id);
  try {
    if (k) SecureStore.setItem(k, '1');
  } catch {}
};

function Reconnecting() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, styles.reconnect]} accessibilityLiveRegion="polite">
      <ProgressBar value={null} style={styles.bar} />
      <ThemedText type="label" maxFontSizeMultiplier={CHROME}>
        Reconnecting viewer…
      </ThemedText>
    </View>
  );
}

/** D-14 viewer screen: always dark, RN top bar over a full-bleed DOM viewer (UI-SPEC A). */
export default function WorldScreen() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const safe = useSafeAreaInsets();
  const { data, error, isPending, refetch } = useWorld(id);
  const qc = useQueryClient();
  // CR-01: presigned URLs expire after 1 h. Refresh them only right before a viewer (re)load, never mid-walk.
  const urlsStale = useCallback(
    () => Date.now() - (qc.getQueryState(['world', id])?.dataUpdatedAt ?? 0) > WORLD_URL_FRESH_MS,
    [qc, id],
  );
  // Review-2 WR-02: "Reconnecting viewer…" shows while the refetch runs; one refetch in flight at a time (IN-03).
  const [refreshing, setRefreshing] = useState(false);
  const inflight = useRef<Promise<unknown> | null>(null);
  const freshen = useCallback(async () => {
    if (inflight.current) return void (await inflight.current);
    if (!urlsStale()) return;
    setRefreshing(true);
    inflight.current = refetch().finally(() => {
      inflight.current = null;
      setRefreshing(false);
    });
    await inflight.current;
  }, [urlsStale, refetch]);
  const reloading = useRef(false);
  // Pitfall 12: the DOM bundle takes a moment to parse; keep a native spinner until it reports in.
  const [domUp, setDomUp] = useState(false);
  // Stable identities: every prop change re-renders the whole DOM tree.
  const insets = useMemo(() => ({ top: safe.top + TOP_BAR, bottom: safe.bottom }), [safe.top, safe.bottom]);

  // D-13b: a killed WebView remounts (key bump) at the last pose; capped at 3 crashes / 60 s (T-05-22).
  const [rec, dispatch] = useReducer(recoveryReducer, initialRecovery);
  const crash = useCallback(() => {
    const at = Date.now();
    void freshen().then(() => dispatch({ type: 'crash', at }));
  }, [freshen]);
  const dom = useMemo(
    () => ({ scrollEnabled: false, onContentProcessDidTerminate: crash, onRenderProcessGone: crash }),
    [crash],
  );
  const onReady = useCallback(async () => {
    setDomUp(true);
    dispatch({ type: 'ready' });
  }, []);
  const onPose = useCallback(async (pose: Pose) => dispatch({ type: 'pose', pose }), []);
  // Pattern 9: coach state read once; the DOM keeps its own dismissed set. Ids from the WebView are allow-listed (T-06.1-33).
  // 'reveal' joins the list once played, so a crash remount never replays it.
  const [coachSeen, setCoachSeen] = useState<string[]>(() => [
    ...(['walk', 'measure'] as const).filter(isCoachSeen),
    ...(isRevealed(id) ? ['reveal'] : []),
  ]);
  const onCoachSeen = useCallback(
    async (cid: string) => {
      if (cid === 'walk' || cid === 'measure') markCoachSeen(cid);
      else if (cid === 'reveal') {
        markRevealed(id);
        setCoachSeen((s) => (s.includes('reveal') ? s : [...s, 'reveal']));
      }
    },
    [id],
  );
  const onHaptic = useCallback(async (kind: 'selection' | 'light' | 'success') => {
    if (kind === 'selection') haptic.selection();
    else if (kind === 'light') haptic.light();
    else if (kind === 'success') haptic.success();
  }, []);
  const onError = useCallback(
    async (e: { code: string }) => {
      setDomUp(true);
      if (e.code === 'context_lost') return crash();
      // WR-01: any other terminal error lifts "Reconnecting viewer…" so the viewer's own Try again shows.
      dispatch({ type: 'ready' });
      // Expired URLs: fresh ones change splatUrl, which reloads the viewer.
      if (e.code === 'load_failed' && urlsStale()) await refetch();
    },
    [crash, urlsStale, refetch],
  );
  useEffect(() => {
    if (rec.capped) AccessibilityInfo.announceForAccessibility('The viewer stopped working');
  }, [rec.capped]);

  const world = data?.world;
  const title = world ? scanTitle(world.title, world.created_at) : '';
  const splatUrl = data?.assets.splat_url;
  // D-18: sharing only exists for a ready room.
  const ready = world?.status === 'ready';

  let content;
  if (isPending) {
    content = (
      <View testID="world-loading" style={[styles.center, styles.loading]}>
        <ThemedText type="label" tone="muted" maxFontSizeMultiplier={CHROME}>
          Opening room
        </ThemedText>
        <ProgressBar value={null} testID="world-loading-bar" accessibilityLabel="Opening room" style={styles.bar} />
      </View>
    );
  } else if (error) {
    content =
      error instanceof ApiError && error.status === 404 ? (
        <View style={styles.center}>
          <ErrorState icon="warning" cap={CHROME} title="This scan isn't available" body="It may have been deleted." />
        </View>
      ) : (
        <View style={styles.center}>
          <ErrorState
            icon="offline"
            cap={CHROME}
            title="Couldn't open this scan"
            body="Check your connection, then try again."
            action={{ label: 'Try again', onPress: () => void refetch() }}
          />
        </View>
      );
  } else if (world?.status !== 'ready' || !splatUrl) {
    content = (
      <View style={styles.center}>
        <ErrorState
          icon="processing"
          cap={CHROME}
          title="This scan isn't ready yet"
          body="Open it again from your Library when it says Ready."
          action={{ label: 'Back to Library', onPress: () => router.back() }}
        />
      </View>
    );
  } else if (rec.capped && refreshing) {
    content = <Reconnecting />;
  } else if (rec.capped) {
    content = (
      <View style={styles.center}>
        <ErrorState
          icon="warning"
          cap={CHROME}
          title="The viewer stopped working"
          body="This can happen when the phone is low on memory. Reload to try again."
          action={{
            label: 'Reload viewer',
            onPress: () => {
              if (reloading.current) return; // IN-03: a double tap queues one reload
              reloading.current = true;
              void freshen().then(() => {
                reloading.current = false;
                dispatch({ type: 'reload' });
              });
            },
          }}
        />
      </View>
    );
  } else {
    content = (
      <>
        <WorldViewer
          key={rec.mountKey}
          startPose={rec.mountPose}
          splatUrl={splatUrl}
          colliderUrl={data.assets.collider_url}
          floorplanUrl={data.assets.floorplan_url}
          floorplanMeta={world.floorplan_meta ?? null}
          camerasUrl={data.assets.cameras_url}
          title={title}
          insets={insets}
          onProgress={onReady}
          onReady={onReady}
          onError={onError}
          onPose={onPose}
          coachSeen={coachSeen}
          onCoachSeen={onCoachSeen}
          onHaptic={onHaptic}
          dom={dom}
        />
        {rec.reconnecting || refreshing ? (
          <Reconnecting />
        ) : (
          !domUp && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
              <ProgressBar value={null} style={styles.bar} />
            </View>
          )
        )}
      </>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {content}
      <View style={[styles.topBar, { paddingTop: safe.top }]}>
        <Button variant="ghost" size="md" icon="back" label="Back" onPress={() => router.back()} haptic={false} />
        {world && (
          <ThemedText
            type="heading"
            accessibilityRole="header"
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={CHROME}
            style={[styles.title, !ready && styles.titlePad]}>
            {title}
          </ThemedText>
        )}
        {ready && (
          <IconButton
            icon="share"
            accessibilityLabel="Share this room"
            onPress={() => router.push({ pathname: '/world/[id]/share', params: { id } })}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: VT.color.bg },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    minHeight: TOP_BAR,
    flexDirection: 'row',
    alignItems: 'center',
    gap: VT.space.sm,
    paddingHorizontal: VT.space.sm,
    backgroundColor: VT.color.scrim.hud,
  },
  title: { flex: 1 },
  titlePad: { marginRight: 44 }, // balances Back when Share is hidden
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: VT.space.xl },
  loading: { gap: VT.space.md },
  bar: { width: BAR_W },
  reconnect: { backgroundColor: VT.color.bg, gap: VT.space.sm },
});
