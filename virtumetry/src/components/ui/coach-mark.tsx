// UI-SPEC §8.2: once-only anchored callout. A module lock keeps two from ever showing at once.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { AccessibilityInfo, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { isCoachSeen, markCoachSeen, type CoachId } from '@/design/first-run';
import { ease, useReduceMotion } from '@/design/motion';
import { color, elevation, motion, radius, space } from '@/design/tokens';

type Lock = { active: CoachId | null; leaving: boolean };
let lock: Lock = { active: null, leaving: false };
const done = new Set<CoachId>(); // dismissed this session (SecureStore is unavailable on web)
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const getLock = () => lock;
const setLock = (next: Lock) => {
  lock = next;
  listeners.forEach((l) => l());
};
const release = (id: CoachId) => {
  if (lock.active === id) setLock({ active: null, leaving: false });
};

/**
 * Dismiss from an external trigger (e.g. pressing Start): marks it seen and runs the exit.
 * The caller initiated it, so `onDismiss` is not called.
 */
export function dismissCoach(id: CoachId) {
  markCoachSeen(id);
  done.add(id);
  if (lock.active !== id || lock.leaving) return;
  setLock({ active: id, leaving: true });
  setTimeout(() => release(id), motion.duration.fast);
}

export function __resetCoachLockForTest() {
  lock = { active: null, leaving: false };
  done.clear();
}

const MAX_W = 300;
const CARET = 11; // rotated 45°: sticks out ~8 px

type Props = {
  id: CoachId;
  text: string;
  /** Window coords from measureInWindow; the mark is laid out in a full-window parent. */
  anchor: { x: number; y: number; width: number; height: number };
  placement: 'above' | 'below';
  visible?: boolean;
  onDismiss: () => void;
};

export function CoachMark({ id, text, anchor, placement, visible = true, onDismiss }: Props) {
  const [seen] = useState(() => isCoachSeen(id));
  const { active, leaving } = useSyncExternalStore(subscribe, getLock, getLock);
  const want = visible && !seen && !done.has(id);

  useEffect(() => {
    // Read the live lock, not the render snapshot: two marks mounting together must not both claim.
    if (want && lock.active === null) setLock({ active: id, leaving: false });
    if (!want && !lock.leaving) release(id); // hidden by the caller; a dismissal releases after its exit
  }, [want, active, id]);
  useEffect(() => () => release(id), [id]);

  const shown = want || (active === id && leaving); // stay mounted through the exit
  const mine = active === id && shown;
  useEffect(() => {
    if (mine && !leaving) AccessibilityInfo.announceForAccessibility(text);
    // Announce once per appearance, not on text edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine]);

  if (!mine) return null;
  return (
    <Callout
      text={text}
      anchor={anchor}
      placement={placement}
      leaving={leaving}
      onGotIt={() => {
        dismissCoach(id);
        onDismiss();
      }}
    />
  );
}

function Callout({
  text,
  anchor,
  placement,
  leaving,
  onGotIt,
}: Pick<Props, 'text' | 'anchor' | 'placement'> & { leaving: boolean; onGotIt: () => void }) {
  const win = useWindowDimensions();
  const reduce = useReduceMotion();
  const opacity = useSharedValue(0);
  const y = useSharedValue(reduce ? 0 : 6);

  useEffect(() => {
    const cfg = reduce
      ? { duration: motion.duration.fast, reduceMotion: ReduceMotion.Never }
      : leaving
        ? { duration: motion.duration.fast, easing: ease.inQuart }
        : { duration: motion.duration.slow, easing: ease.outExpo };
    opacity.set(withTiming(leaving ? 0 : 1, cfg));
    y.set(reduce ? 0 : withTiming(leaving ? 6 : 0, cfg));
  }, [leaving, reduce, opacity, y]);
  const anim = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ translateY: y.get() }] }));

  const width = Math.min(MAX_W, win.width - space.lg * 2);
  const center = anchor.x + anchor.width / 2;
  const left = Math.max(space.lg, Math.min(center - width / 2, win.width - width - space.lg));
  const caretLeft = Math.max(radius.md, Math.min(center - left - CARET / 2, width - radius.md - CARET));
  const below = placement === 'below';
  const pos = below ? { top: anchor.y + anchor.height + space.sm } : { bottom: win.height - anchor.y + space.sm };

  return (
    <Animated.View testID="coach-mark" accessibilityViewIsModal={false} style={[styles.box, { width, left }, pos, anim]}>
      <View style={[styles.caret, { left: caretLeft }, below ? styles.caretUp : styles.caretDown]} />
      <ThemedText type="label" tone="text" accessibilityRole="alert">
        {text}
      </ThemedText>
      <Button variant="ghost" size="md" label="Got it" haptic={false} onPress={onGotIt} style={styles.gotIt} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    backgroundColor: color.surface.overlay,
    borderWidth: 1.5,
    borderColor: color.accent,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: space.sm,
    ...elevation.level2,
  },
  caret: {
    position: 'absolute',
    width: CARET,
    height: CARET,
    backgroundColor: color.surface.overlay,
    borderColor: color.accent,
    transform: [{ rotate: '45deg' }],
  },
  caretUp: { top: -CARET / 2 - 1, borderTopWidth: 1.5, borderLeftWidth: 1.5 },
  caretDown: { bottom: -CARET / 2 - 1, borderBottomWidth: 1.5, borderRightWidth: 1.5 },
  gotIt: { alignSelf: 'flex-end' },
});
