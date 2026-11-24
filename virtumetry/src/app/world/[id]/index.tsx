import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SymbolView } from 'expo-symbols';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, useWorld } from '@/lib/api';
import { VT } from '@/viewer/tokens';
import WorldViewer from '@/viewer/world-viewer';

const TOP_BAR = 44;
const CHROME = 1.3; // maxFontSizeMultiplier on viewer chrome (UI-SPEC Typography)
const DOM = { scrollEnabled: false };

function Message({ heading, body, onRetry }: { heading: string; body: string; onRetry?: () => void }) {
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
          accessibilityLabel="Try again"
          onPress={onRetry}
          style={({ pressed }) => [styles.retry, { backgroundColor: pressed ? VT.surfaceSelected : VT.surface }]}>
          <Text style={styles.retryLabel} maxFontSizeMultiplier={CHROME}>
            Try again
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** D-14 viewer screen: always dark, RN top bar over a full-bleed DOM viewer (UI-SPEC A). */
export default function WorldScreen() {
  useKeepAwake();
  const { id } = useLocalSearchParams<{ id: string }>();
  const safe = useSafeAreaInsets();
  const { data, error, isPending, refetch } = useWorld(id);
  // Pitfall 12: the DOM bundle takes a moment to parse; keep a native spinner until it reports in.
  const [domUp, setDomUp] = useState(false);
  const up = useCallback(async () => setDomUp(true), []);
  // Stable identities: every prop change re-renders the whole DOM tree.
  const insets = useMemo(() => ({ top: safe.top + TOP_BAR, bottom: safe.bottom }), [safe.top, safe.bottom]);

  const world = data?.world;
  const title = world?.title?.trim() || 'Untitled scan';
  const splatUrl = data?.assets.splat_url;

  let content;
  if (isPending) {
    content = <ActivityIndicator testID="world-loading" size="large" color={VT.accent} style={styles.fill} />;
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
  } else {
    content = (
      <>
        <WorldViewer
          splatUrl={splatUrl}
          colliderUrl={data.assets.collider_url}
          floorplanUrl={data.assets.floorplan_url}
          floorplanMeta={world.floorplan_meta ?? null}
          camerasUrl={data.assets.cameras_url}
          title={title}
          insets={insets}
          onProgress={up}
          onReady={up}
          onError={up}
          dom={DOM}
        />
        {!domUp && (
          <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
            <ActivityIndicator size="large" color={VT.accent} />
          </View>
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
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: VT.surfaceSelected }]}>
          <SymbolView name="chevron.left" size={20} tintColor={VT.text} />
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
            style={styles.title}>
            {title}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: VT.bg },
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
    backgroundColor: VT.scrim,
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
  backLabel: { color: VT.text, fontSize: VT.font.body },
  title: { flex: 1, color: VT.text, fontSize: VT.font.body, fontWeight: '600', marginRight: 44 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: VT.space.lg },
  heading: { color: VT.text, fontSize: VT.font.heading, lineHeight: 28, fontWeight: '600', textAlign: 'center' },
  body: {
    color: VT.textSecondary,
    fontSize: VT.font.body,
    lineHeight: 24,
    textAlign: 'center',
    marginTop: VT.space.sm,
  },
  retry: {
    marginTop: VT.space.lg,
    height: 44,
    paddingHorizontal: VT.space.lg,
    borderRadius: VT.radius.md,
    justifyContent: 'center',
  },
  retryLabel: { color: VT.text, fontSize: VT.font.body, fontWeight: '600' },
});
