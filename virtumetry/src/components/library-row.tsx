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
import { toDisplayState, type DisplayState, type LibraryItem, type LocalScan } from '@/library/display-state';

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
  const thumbnailUrl = 'local' in item ? undefined : item.assets?.thumbnail_url;
  const [imageFailed, setImageFailed] = useState(false);
  const retryable = !('local' in item) && item.status === 'failed' && item.retryable === true;
  const label = [state.displayTitle, state.statusLine, state.secondaryLine].filter(Boolean).join(', ');
  const kind: StatusKind = 'local' in item && item.uploadState === 'paused' ? 'paused' : state.kind;

  return (
    <View style={[styles.row, { opacity: state.rowOpacity }]}>
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
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}>
        <View accessible={false} style={styles.thumb}>
          {thumbnailUrl && !imageFailed ? (
            <Image
              source={{ uri: thumbnailUrl }}
              style={styles.thumb}
              contentFit="cover"
              transition={motion.duration.fast}
              onError={() => setImageFailed(true)}
            />
          ) : (
            <Icon name="world" size={24} color={color.textMuted} />
          )}
        </View>
        <View style={styles.text}>
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
      <IconButton
        icon="more"
        accessibilityLabel={`More actions for ${state.displayTitle}`}
        accessibilityHint={retryable ? 'Retry, rename or delete' : 'Rename or delete'}
        onPress={() => onMore(item, state)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 96 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: space.lg, paddingVertical: space.lg },
  pressed: { backgroundColor: color.surface.pressed },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: color.surface.raised,
  },
  text: { flex: 1 },
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
