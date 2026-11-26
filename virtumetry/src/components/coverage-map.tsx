import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedProps, useSharedValue, withTiming } from 'react-native-reanimated';
import Svg, { Circle, G, Line, Path, Polyline } from 'react-native-svg';

import { coverage, fitToBox, sectorScreenDeg } from '@/capture/coverage';
import type { KeyframeEvent } from '@/capture/types';
import { ease, useReduceMotion } from '@/design/motion';
import { color, motion, radius } from '@/design/tokens';

// D-10: top-down coverage mini-map. 0 deg = the first frame's look direction, pointing up.
const SIZE = 128;
const C = SIZE / 2;
const R = 52;
const BOX = 72;
const OFF = (SIZE - BOX) / 2;
const HALF_ARC = 15 - 1; // 30 deg sectors with a 2 deg gap between arcs
const APath = Animated.createAnimatedComponent(Path);

/** Point at clockwise-from-up angle a (deg) on the ring. */
const onRing = (a: number) => {
  const r = (a * Math.PI) / 180;
  return `${(C + R * Math.sin(r)).toFixed(2)} ${(C - R * Math.cos(r)).toFixed(2)}`;
};
const arc = (center: number) => `M ${onRing(center - HALF_ARC)} A ${R} ${R} 0 0 1 ${onRing(center + HALF_ARC)}`;

/** UI-SPEC §11: a sector turning seen fades its stroke 0.2 -> 1 over 200 ms outQuart (instant when reduced). */
function Arc({ d, seen, reduce }: { d: string; seen: boolean; reduce: boolean }) {
  const opacity = useSharedValue(1);
  const was = useRef(seen);
  useEffect(() => {
    if (seen && !was.current && !reduce) {
      opacity.set(0.2);
      opacity.set(withTiming(1, { duration: motion.duration.base, easing: ease.outQuart }));
    }
    was.current = seen;
  }, [seen, reduce, opacity]);
  const props = useAnimatedProps(() => ({ strokeOpacity: opacity.get() }));
  return <APath d={d} stroke={seen ? color.primary : color.ghost.unseen} strokeWidth={6} fill="none" animatedProps={props} />;
}

export function CoverageMap({ frames }: { frames: KeyframeEvent[] }) {
  const reduce = useReduceMotion();
  const cov = useMemo(() => coverage(frames), [frames]);
  const map = fitToBox(cov.path, BOX, 1);
  const at = (p: { x: number; y: number }) => {
    const q = map(p);
    return { x: OFF + q.x, y: OFF + q.y };
  };
  const cur = cov.current && at(cov.current);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Coverage: ${cov.seenCount} of 12 directions seen`}
      style={styles.box}>
      <Svg width={SIZE} height={SIZE}>
        {cov.sectorsSeen.map((seen, k) => (
          <Arc key={k} d={arc(sectorScreenDeg(k))} seen={seen} reduce={reduce} />
        ))}
        {cov.path.length > 1 && (
          <Polyline
            points={cov.path.map((p) => { const q = at(p); return `${q.x},${q.y}`; }).join(' ')}
            stroke={color.text}
            strokeWidth={2}
            fill="none"
          />
        )}
        {cov.ticks.map((t, k) => {
          const p = at(t);
          return (
            <Line key={k} x1={p.x} y1={p.y} x2={p.x + t.dx * 6} y2={p.y + t.dy * 6} stroke={color.textMuted} strokeWidth={2} />
          );
        })}
        {cur && cov.current && (
          <G>
            <Line
              x1={cur.x}
              y1={cur.y}
              x2={cur.x + cov.current.dx * 10}
              y2={cur.y + cov.current.dy * 10}
              stroke={color.primary}
              strokeWidth={2}
            />
            <Circle cx={cur.x} cy={cur.y} r={4} fill={color.primary} />
          </G>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: SIZE, height: SIZE, borderRadius: radius.md, overflow: 'hidden', backgroundColor: color.scrim.hud },
});
