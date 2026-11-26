import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { useReduceMotion } from '@/design/motion';
import { color, motion, radius as radii, space } from '@/design/tokens';

type Props = { width: DimensionValue; height: number; radius?: number; testID?: string };

/** UI-SPEC §5 / §11: opacity 0.5↔1 over 1200 ms linear on surface.raised; Reduce Motion: static 0.7. */
export function Skeleton({ width, height, radius = radii.sm, testID }: Props) {
  const reduce = useReduceMotion();
  const opacity = useSharedValue(0.7);

  useEffect(() => {
    cancelAnimation(opacity);
    if (reduce) {
      opacity.set(0.7);
      return;
    }
    opacity.set(0.5);
    opacity.set(withRepeat(withTiming(1, { duration: motion.duration.indeterminate, easing: Easing.linear }), -1, true));
  }, [reduce, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return (
    <Animated.View
      testID={testID}
      accessible={false}
      style={[{ width, height, borderRadius: radius, backgroundColor: color.surface.raised }, style]}
    />
  );
}

/** Library row placeholder: 64 thumb + two bars. The caller's container carries the a11y label + busy state. */
export function SkeletonRow({ testID }: { testID?: string }) {
  return (
    <View testID={testID} style={styles.row} accessible={false}>
      <Skeleton width={64} height={64} radius={radii.sm} />
      <View style={styles.bars}>
        <Skeleton width="70%" height={16} />
        <Skeleton width="40%" height={14} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 96, paddingVertical: space.lg },
  bars: { flex: 1, gap: space.md },
});
