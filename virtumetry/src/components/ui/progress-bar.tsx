import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { useReduceMotion } from '@/design/motion';
import { color, motion, radius } from '@/design/tokens';

type Props = {
  /** 0-100; null = indeterminate (never invent a percentage). */
  value: number | null;
  height?: 4 | 6;
  tone?: 'accent' | 'success';
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

const SEGMENT = 30; // % of the track

/** UI-SPEC §5 / §11: determinate width 300 ms linear; indeterminate 30% segment slides 1200 ms loop; Reduce Motion is static. */
export function ProgressBar({ value, height = 4, tone = 'accent', accessibilityLabel, testID, style }: Props) {
  const reduce = useReduceMotion();
  const indeterminate = value == null;
  const pct = indeterminate ? 0 : Math.min(100, Math.max(0, value));

  const width = useSharedValue(pct);
  const slide = useSharedValue(0); // segment left edge, % of track

  useEffect(() => {
    if (indeterminate) return;
    width.set(reduce ? pct : withTiming(pct, { duration: motion.duration.progress, easing: Easing.linear }));
  }, [indeterminate, pct, reduce, width]);

  useEffect(() => {
    cancelAnimation(slide);
    if (!indeterminate || reduce) {
      slide.set(0);
      return;
    }
    slide.set(-SEGMENT);
    slide.set(withRepeat(withTiming(100, { duration: motion.duration.indeterminate, easing: Easing.linear }), -1, false));
  }, [indeterminate, reduce, slide]);

  const fillStyle = useAnimatedStyle(() =>
    indeterminate ? { left: `${slide.get()}%`, width: `${SEGMENT}%` } : { left: '0%', width: `${width.get()}%` },
  );

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={indeterminate ? { min: 0, max: 100 } : { min: 0, max: 100, now: pct }}
      accessibilityState={{ busy: indeterminate }}
      style={[styles.track, { height }, style]}>
      <Animated.View
        testID={testID ? `${testID}-fill` : 'progress-fill'}
        style={[styles.fill, { backgroundColor: tone === 'success' ? color.success : color.accent }, fillStyle]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { backgroundColor: color.surface.pressed, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { position: 'absolute', top: 0, bottom: 0, borderRadius: radius.pill },
});
