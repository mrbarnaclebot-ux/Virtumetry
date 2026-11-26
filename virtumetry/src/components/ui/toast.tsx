// UI-SPEC §9: the one toast system. Module store so mutation callbacks can call toast.* outside React.
import { Fragment, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AccessibilityInfo, PanResponder, Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';

import { ThemedText } from '@/components/themed-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { haptic } from '@/design/haptics';
import { ease, useReduceMotion } from '@/design/motion';
import { color, elevation, motion, radius, space } from '@/design/tokens';

type Kind = 'success' | 'error' | 'info';
type Item = { id: number; kind: Kind; msg: string };
type State = { current: Item | null; leaving: boolean; queue: Item[] };

const QUEUE_MAX = 3;
let state: State = { current: null, leaving: false, queue: [] };
let nextId = 1;
let screenReader = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const getState = () => state;
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

const duration = (kind: Kind) => motion.toast[kind] * (screenReader ? motion.toast.screenReaderMultiplier : 1);

function arm(item: Item) {
  clearTimeout(timer);
  timer = setTimeout(dismissToast, duration(item.kind));
}

function show(item: Item) {
  set({ current: item, leaving: false });
  arm(item);
  AccessibilityInfo.announceForAccessibility(item.msg);
  if (item.kind === 'success') haptic.success();
  if (item.kind === 'error') haptic.error();
}

/** Starts the exit; the next queued toast shows once the 150 ms exit has run. */
function dismissToast() {
  if (!state.current || state.leaving) return;
  clearTimeout(timer);
  set({ leaving: true });
  timer = setTimeout(() => {
    const [head, ...rest] = state.queue;
    set({ current: null, leaving: false, queue: rest });
    if (head) show(head);
  }, motion.duration.fast);
}

function push(kind: Kind, msg: string) {
  const { current, leaving, queue } = state;
  if (current && current.msg === msg) {
    // Coalesce: keep the visible one and restart its timer (also rescues one mid-exit).
    if (leaving) set({ leaving: false });
    arm(current);
    return;
  }
  if (queue.some((q) => q.msg === msg)) return;
  const item = { id: nextId++, kind, msg };
  if (!current) return show(item);
  set({ queue: [...queue, item].slice(-QUEUE_MAX) });
}

export const toast = {
  success: (msg: string) => push('success', msg),
  error: (msg: string) => push('error', msg),
  info: (msg: string) => push('info', msg),
};

export function __resetToastsForTest() {
  clearTimeout(timer);
  timer = undefined;
  screenReader = false;
  state = { current: null, leaving: false, queue: [] };
  listeners.forEach((l) => l());
}

const ICON: Record<Kind, { name: IconName; tint: string }> = {
  success: { name: 'ready', tint: color.success },
  error: { name: 'warning', tint: color.danger },
  info: { name: 'info', tint: color.info },
};

// Host lives in a FullWindowOverlay on iOS so toasts sit above native-stack modals (RESEARCH Pattern 7).
const Overlay = Platform.OS === 'ios' ? FullWindowOverlay : Fragment;

/** Mount once in AuthedLayout (never PublicLayout). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { current, leaving } = useSyncExternalStore(subscribe, getState, getState);

  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled()
      .then((v) => (screenReader = v))
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', (v) => (screenReader = v));
    return () => sub.remove();
  }, []);

  return (
    <>
      {children}
      {/* Overlay only while a toast exists, so an idle overlay can never swallow touches. */}
      {current && (
        <Overlay>
          <ToastView key={current.id} item={current} leaving={leaving} />
        </Overlay>
      )}
    </>
  );
}

function ToastView({ item, leaving }: { item: Item; leaving: boolean }) {
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const opacity = useSharedValue(0);
  const y = useSharedValue(reduce ? 0 : -16);
  const [pan] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderRelease: (_, g) => {
        if (g.dy < -24 || g.vy < -0.5) dismissToast();
      },
    }),
  );

  useEffect(() => {
    // Reduce Motion: opacity only, 150 ms both ways, and force it to run (ReduceMotion.Never).
    const cfg = reduce
      ? { duration: motion.duration.fast, reduceMotion: ReduceMotion.Never }
      : leaving
        ? { duration: motion.duration.fast, easing: ease.inQuart }
        : { duration: motion.duration.slow, easing: ease.outExpo };
    opacity.set(withTiming(leaving ? 0 : 1, cfg));
    y.set(reduce ? 0 : withTiming(leaving ? -8 : 0, cfg));
  }, [leaving, reduce, opacity, y]);

  const anim = useAnimatedStyle(() => ({ opacity: opacity.get(), transform: [{ translateY: y.get() }] }));
  const icon = ICON[item.kind];

  return (
    <View pointerEvents="box-none" style={[styles.host, { top: insets.top + space.sm }]}>
      <Animated.View testID="toast" style={[styles.toast, anim]} {...pan.panHandlers}>
        <Pressable
          onPress={dismissToast}
          accessibilityRole={item.kind === 'error' ? 'alert' : 'button'}
          accessibilityLabel={item.msg}
          accessibilityHint="Dismisses the message"
          accessibilityLiveRegion="polite"
          style={styles.body}>
          <Icon name={icon.name} color={icon.tint} />
          <ThemedText type="label" tone="text" numberOfLines={2} style={styles.msg}>
            {item.msg}
          </ThemedText>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: space.lg, right: space.lg, alignItems: 'center' },
  toast: {
    width: '100%',
    maxWidth: 560,
    backgroundColor: color.surface.overlay,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.md,
    ...elevation.level2,
  },
  body: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  msg: { flex: 1 },
});
