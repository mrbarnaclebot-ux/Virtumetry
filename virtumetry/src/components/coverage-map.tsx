import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline } from 'react-native-svg';

import { coverage, fitToBox, sectorScreenDeg } from '@/capture/coverage';
import type { KeyframeEvent } from '@/capture/types';
import { Colors } from '@/constants/theme';

// D-10: top-down coverage mini-map. 0 deg = the first frame's look direction, pointing up.
const SIZE = 128;
const C = SIZE / 2;
const R = 52;
const BOX = 72;
const OFF = (SIZE - BOX) / 2;
const HALF_ARC = 15 - 1; // 30 deg sectors with a 2 deg gap between arcs
const UNSEEN = 'rgba(255,255,255,0.2)';

/** Point at clockwise-from-up angle a (deg) on the ring. */
const onRing = (a: number) => {
  const r = (a * Math.PI) / 180;
  return `${(C + R * Math.sin(r)).toFixed(2)} ${(C - R * Math.cos(r)).toFixed(2)}`;
};
const arc = (center: number) => `M ${onRing(center - HALF_ARC)} A ${R} ${R} 0 0 1 ${onRing(center + HALF_ARC)}`;

export function CoverageMap({ frames }: { frames: KeyframeEvent[] }) {
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
          <Path
            key={k}
            d={arc(sectorScreenDeg(k))}
            stroke={seen ? Colors.dark.accent : UNSEEN}
            strokeWidth={6}
            fill="none"
          />
        ))}
        {cov.path.length > 1 && (
          <Polyline
            points={cov.path.map((p) => { const q = at(p); return `${q.x},${q.y}`; }).join(' ')}
            stroke={Colors.dark.text}
            strokeWidth={2}
            fill="none"
          />
        )}
        {cov.ticks.map((t, k) => {
          const p = at(t);
          return (
            <Line key={k} x1={p.x} y1={p.y} x2={p.x + t.dx * 6} y2={p.y + t.dy * 6} stroke={Colors.dark.textSecondary} strokeWidth={2} />
          );
        })}
        {cur && cov.current && (
          <G>
            <Line
              x1={cur.x}
              y1={cur.y}
              x2={cur.x + cov.current.dx * 10}
              y2={cur.y + cov.current.dy * 10}
              stroke={Colors.dark.accent}
              strokeWidth={2}
            />
            <Circle cx={cur.x} cy={cur.y} r={4} fill={Colors.dark.accent} />
          </G>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: SIZE, height: SIZE, borderRadius: 12, overflow: 'hidden', backgroundColor: 'rgba(0,0,0,0.6)' },
});
