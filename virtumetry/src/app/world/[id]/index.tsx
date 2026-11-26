import { useQueryClient } from '@tanstack/react-query';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, useWorld, WORLD_URL_FRESH_MS } from '@/lib/api';
import { initialRecovery, recoveryReducer } from '@/viewer/recovery';
import { VT } from '@/viewer/tokens';
import type { Pose } from '@/viewer/types';
import WorldViewer from '@/viewer/world-viewer';

const TOP_BAR = 44;
const CHROME = 1.3; // maxFontSizeMultiplier on viewer chrome (UI-SPEC Typography)
function Message({
  heading,
  body,
  onRetry,
  retryLabel = 'Try again',
}: {
  heading: string;
  body: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <View style={styles.center}>
      <Text style={styles.heading} maxFontSizeMultiplier={CHROME}>
        {heading}
      </Text>
      <Text style={styles.body} maxFontSizeMultiplier={CHROME}>
        {body}
      </Text>
      {onRetry && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
          onPress={onRetry}
          style={({ pressed }) => [styles.retry, { backgroundColor: pressed ? VT.color.surface.pressed : VT.color.surface.raised }]}>
          <Text style={styles.retryLabel} maxFontSizeMultiplier={CHROME}>
            {retryLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Reconnecting() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.center, styles.reconnect]} accessibilityLiveRegion="polite">
      <ActivityIndicator size="large" color={VT.color.primary} />
      <Text style={styles.reconnectLabel} maxFontSizeMultiplier={CHROME}>
        Reconnecting viewer…
      </Text>
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
  const title = world?.title?.trim() || 'Untitled scan';
  const splatUrl = data?.assets.splat_url;
  // D-18: sharing only exists for a ready room.
  const ready = world?.status === 'ready';

  let content;
  if (isPending) {
    content = <ActivityIndicator testID="world-loading" size="large" color={VT.color.primary} style={styles.fill} />;
  } else if (error) {
    content =
      error instanceof ApiError && error.status === 404 ? (
        <Message heading="This scan isn't available" body="It may have been deleted." />
      ) : (
        <Message
          heading="Couldn't open this scan"
          body="Check your connection, then try again."
          onRetry={() => refetch()}
        />
      );
  } else if (world?.status !== 'ready' || !splatUrl) {
    content = (
      <Message
        heading="This scan isn't ready yet"
        body="Open it again from your Library when it says Ready."
      />
    );
  } else if (rec.capped && refreshing) {
    content = <Reconnecting />;
  } else if (rec.capped) {
    content = (
      <Message
        heading="The viewer stopped working"
        body="This can happen when the phone is low on memory. Reload to try again."
        retryLabel="Reload viewer"
        onRetry={() => {
          if (reloading.current) return; // IN-03: a double tap queues one reload
          reloading.current = true;
          void freshen().then(() => {
            reloading.current = false;
            dispatch({ type: 'reload' });
          });
        }}
      />
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
          dom={dom}
        />
        {rec.reconnecting || refreshing ? (
          <Reconnecting />
        ) : (
          !domUp && (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
              <ActivityIndicator size="large" color={VT.color.primary} />
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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: VT.color.surface.pressed }]}>
          <SymbolView name="chevron.left" size={20} tintColor={VT.color.text} />
          <Text style={styles.backLabel} maxFontSizeMultiplier={CHROME}>
            Back
          </Text>
        </Pressable>
        {world && (
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            ellipsizeMode="tail"
            maxFontSizeMultiplier={CHROME}
            style={[styles.title, !ready && styles.titlePad]}>
            {title}
          </Text>
        )}
        {ready && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share this room"
            onPress={() => router.push({ pathname: '/world/[id]/share', params: { id } })}
            style={({ pressed }) => [styles.share, pressed && { backgroundColor: VT.color.surface.pressed }]}>
            <SymbolView name="square.and.arrow.up" size={20} tintColor={VT.color.text} />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: VT.color.bg },
  fill: { flex: 1 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: VT.space.sm,
    paddingHorizontal: VT.space.sm,
    backgroundColor: VT.color.scrim.hud,
  },
  back: {
    height: TOP_BAR,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: VT.space.xs,
    paddingHorizontal: VT.space.xs,
    borderRadius: VT.radius.sm,
  },
  backLabel: { color: VT.color.text, fontSize: VT.type.body.fontSize },
  title: { flex: 1, color: VT.color.text, fontSize: VT.type.body.fontSize, fontWeight: '600' },
  titlePad: { marginRight: 44 }, // balances Back when Share is hidden
  share: { width: 44, height: TOP_BAR, alignItems: 'center', justifyContent: 'center', borderRadius: VT.radius.sm },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: VT.space.xl },
  heading: { color: VT.color.text, fontSize: VT.type.heading.fontSize, lineHeight: 28, fontWeight: '600', textAlign: 'center' },
  body: {
    color: VT.color.textMuted,
    fontSize: VT.type.body.fontSize,
    lineHeight: 24,
    textAlign: 'center',
    marginTop: VT.space.sm,
  },
  retry: {
    marginTop: VT.space.xl,
    height: 44,
    paddingHorizontal: VT.space.xl,
    borderRadius: VT.radius.md,
    justifyContent: 'center',
  },
  retryLabel: { color: VT.color.text, fontSize: VT.type.body.fontSize, fontWeight: '600' },
  reconnect: { backgroundColor: VT.color.bg, gap: VT.space.sm },
  reconnectLabel: { color: VT.color.text, fontSize: VT.type.label.fontSize, lineHeight: 20 },
});
