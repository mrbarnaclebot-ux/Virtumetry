import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Icon } from '@/components/ui/icon';
import { IconButton } from '@/components/ui/icon-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusPill, type StatusKind } from '@/components/ui/status-pill';
import { ease, useReduceMotion } from '@/design/motion';
import { color, motion, radius, space } from '@/design/tokens';
import { frameUri, toDisplayState, type DisplayState, type LibraryItem, type LocalScan } from '@/library/display-state';

export type RowItem = LibraryItem | (LocalScan & { local: true });

type Props = {
  item: RowItem;
  onMore: (item: RowItem, state: DisplayState) => void;
  /** Local rows only: opens capture/[id] at review or upload (UI-SPEC §2). */
  onOpen?: (item: LocalScan & { local: true }) => void;
  /** Ready server rows only: opens the viewer (D-14). */
  onOpenWorld?: (item: LibraryItem) => void;
  /** Failed server rows only: opens the retry sheet (D-11). */
  onOpenFailed?: (item: LibraryItem) => void;
  /** 06.1 §7.2 first ready moment: one status icon pulse. The screen owns the haptic. */
  justReady?: boolean;
};

export type RowAction = 'Retry' | 'Rename' | 'Delete' | 'Discard';

/**
 * The row menu's actions (D-21), shared by the menu and the More button so neither offers a dead entry.
 * Local: Delete once a server id exists (CR-03), Discard while nothing is server side, else none.
 * Server: Retry only on the server's retryable flag (T-06-21), then Rename and Delete.
 */
export function rowActions(item: RowItem): RowAction[] {
  if ('local' in item) {
    if (item.serverWorldId) return ['Delete'];
    return item.uploadState === 'saved' || item.uploadState === 'blocked' || item.uploadState === 'failed' ? ['Discard'] : [];
  }
  return [...(item.status === 'failed' && item.retryable === true ? (['Retry'] as const) : []), 'Rename', 'Delete'];
}

/** "Retry, rename or delete" from the actions actually offered. */
const actionHint = (actions: RowAction[]) => {
  const words = actions.map((a, i) => (i === 0 ? a : a.toLowerCase()));
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}` : words[0];
};

const ICON = 16;
const HALF = motion.duration.pulse / 2;

/** One 600 ms pulse over the StatusPill icon: scale 1 → 1.25 → 1 plus a success ring fading 0.6 → 0. Reduce Motion: none. */
function ReadyPulse() {
  const reduce = useReduceMotion();
  const scale = useSharedValue(1);
  const ring = useSharedValue(0);

  useEffect(() => {
    cancelAnimation(scale);
    cancelAnimation(ring);
    if (reduce) {
      scale.set(1);
      ring.set(0);
      return;
    }
    scale.set(
      withSequence(
        withTiming(1.25, { duration: HALF, easing: ease.outQuart }),
        withTiming(1, { duration: HALF, easing: ease.outQuart }),
      ),
    );
    ring.set(0.6);
    ring.set(withTiming(0, { duration: motion.duration.pulse, easing: ease.outQuart }));
  }, [reduce, scale, ring]);

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  // The ring grows as it fades.
  const ringStyle = useAnimatedStyle(() => ({ opacity: ring.get(), transform: [{ scale: 1 + (0.6 - ring.get()) * 1.5 }] }));

  return (
    <View pointerEvents="none" style={styles.pulse}>
      <Animated.View style={[styles.ring, ringStyle]} />
      <Animated.View style={iconStyle}>
        <Icon name="ready" size={ICON} color={color.success} hierarchical />
      </Animated.View>
    </View>
  );
}

export function LibraryRow({ item, onMore, onOpen, onOpenWorld, onOpenFailed, justReady = false }: Props) {
  const state = toDisplayState(item, new Date());
  // Critique F3: local scans show their first frame (capture/[id] path convention) until upload deletes the files.
  const thumbnailUrl =
    'local' in item
      ? item.uploadState !== 'done' && item.frameCount > 0 && item.dir
        ? frameUri(item, 1)
        : undefined
      : item.assets?.thumbnail_url;
  // Review WR-03: failure is keyed to the URL, so a fresh presigned URL after refetch retries the image.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageFailed = !!thumbnailUrl && failedUrl === thumbnailUrl;
  const retryable = !('local' in item) && item.status === 'failed' && item.retryable === true;
  const label = [state.displayTitle, state.statusLine, state.secondaryLine].filter(Boolean).join(', ');
  const kind: StatusKind = 'local' in item && item.uploadState === 'paused' ? 'paused' : state.kind;
  const actions = rowActions(item);
  // Critique R3 #1: a finished room is the payoff, so it gets a full-width 16:10 frame; other states stay compact rows.
  const hero = kind === 'ready' && !('local' in item) && !!thumbnailUrl && !imageFailed;

  return (
    <View style={[hero ? styles.heroRow : styles.row, { opacity: state.rowOpacity }]}>
      <Pressable
        accessible
        accessibilityLabel={label}
        {...('local' in item
          ? {
              accessibilityRole: 'button' as const,
              accessibilityHint: item.uploadState === 'saved' ? 'Opens review' : 'Shows upload',
              onPress: () => onOpen?.(item),
            }
          : item.status === 'ready'
            ? {
                accessibilityRole: 'button' as const,
                accessibilityHint: 'Opens the room',
                onPress: () => onOpenWorld?.(item),
              }
            : item.status === 'failed'
              ? {
                  accessibilityRole: 'button' as const,
                  accessibilityHint: retryable ? 'Shows the cost to try again' : 'Shows what happened',
                  onPress: () => onOpenFailed?.(item),
                }
              : { disabled: true })}
        style={({ pressed }) => [hero ? styles.heroMain : styles.main, pressed && styles.pressed]}>
        <View accessible={false} style={hero ? styles.heroThumb : styles.thumb}>
          {thumbnailUrl && !imageFailed ? (
            <Image
              testID="row-thumb"
              source={{ uri: thumbnailUrl }}
              style={hero ? styles.heroThumb : styles.thumb}
              contentFit="cover"
              transition={motion.duration.fast}
              onError={() => setFailedUrl(thumbnailUrl)}
            />
          ) : (
            <Icon name="world" size={24} color={color.textMuted} />
          )}
        </View>
        <View style={[styles.text, hero && styles.heroText]}>
          <ThemedText type="bodyStrong" numberOfLines={2}>
            {state.displayTitle}
          </ThemedText>
          <View style={styles.status}>
            <StatusPill kind={kind} label={state.statusLine} />
            {justReady && kind === 'ready' && <ReadyPulse />}
          </View>
          {state.progress != null && <ProgressBar testID="row-progress" value={state.progress} height={4} style={styles.progress} />}
          {state.secondaryLine && (
            <ThemedText type="caption" tone={state.secondaryTone === 'warning' ? 'warning' : 'muted'} style={styles.secondary}>
              {state.secondaryLine}
            </ThemedText>
          )}
        </View>
      </Pressable>
      {/* An approved or uploading local scan has no actions yet: no More button rather than an empty menu. */}
      {actions.length > 0 && (
        <IconButton
          style={hero ? styles.heroMore : undefined}
          icon="more"
          accessibilityLabel={`More actions for ${state.displayTitle}`}
          accessibilityHint={actionHint(actions)}
          onPress={() => onMore(item, state)}
        />
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 96 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: space.lg, paddingVertical: space.lg },
  pressed: { backgroundColor: color.surface.pressed },
  // 4:3, like the frames.
  thumb: {
    width: 88,
    height: 66,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: color.surface.raised,
  },
  text: { flex: 1 },
  heroRow: { paddingVertical: space.lg },
  heroMain: { gap: space.md },
  heroThumb: {
    width: '100%',
    aspectRatio: 16 / 10,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: color.surface.raised,
  },
  heroText: { paddingRight: 44 + space.sm }, // room for the More button beside the title
  heroMore: { position: 'absolute', right: 0, bottom: space.lg },
  status: { marginTop: space.sm },
  pulse: { position: 'absolute', left: 0, top: 0, bottom: 0, width: ICON, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    width: ICON + space.sm,
    height: ICON + space.sm,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.success,
  },
  progress: { marginTop: space.xs },
  secondary: { marginTop: space.xs },
});
