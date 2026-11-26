import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, G, Path, Polygon, Rect } from 'react-native-svg';

import { glyphs } from '@/design/glyphs';
import { ease } from '@/design/motion';
import { color, motion } from '@/design/tokens';

// Critique F3: flat `secondary` field + faint drafting grid; art lines in text, line highlights in info (3:1 on secondary), fills in accent with a text ring (no mint).
const LINE = { stroke: color.text, strokeOpacity: 0.85, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const GRID = 16;
const GRID_OPACITY = 0.08;

const FLOOR = '160,210 260,160 160,110 60,160';
const LEFT_WALL = '60,160 160,110 160,20 60,70';
const RIGHT_WALL = '160,110 260,160 260,70 160,20';

const ACircle = Animated.createAnimatedComponent(Circle);

/** Flat secondary field with a 0.5 pt drafting grid every 16 pt. Decorative. */
export function DraftingField({ width, height, children }: { width: number; height: number; children?: ReactNode }) {
  let d = '';
  for (let x = GRID; x < width; x += GRID) d += `M${x} 0V${height}`;
  for (let y = GRID; y < height; y += GRID) d += `M0 ${y}H${width}`;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.field, { width, height }]}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill} accessible={false}>
        <G opacity={GRID_OPACITY}>
          <Path d={d} stroke={color.text} strokeWidth={0.5} fill="none" />
        </G>
      </Svg>
      {children}
    </View>
  );
}

const DOTS = [
  [124, 204],
  [150, 204],
  [176, 204],
  [202, 204],
  [232, 192],
  [244, 164],
] as const;

/** Dot i shows once the reveal passes i/n (60 ms stagger over the timeline). */
function KeyDot({ i, cx, cy, t }: { i: number; cx: number; cy: number; t: SharedValue<number> }) {
  const props = useAnimatedProps(() => ({ opacity: Math.min(1, Math.max(0, t.get() * DOTS.length - i)) }));
  return <ACircle cx={cx} cy={cy} r={3} fill={color.text} animatedProps={props} />;
}

/** A. Top-down room, dashed walking loop, phone with a view cone, keyframe dots appearing behind it. */
function WalkTheRoom({ t }: { t: SharedValue<number> }) {
  return (
    <>
      <Path d="M140 240H52a12 12 0 0 1-12-12V52a12 12 0 0 1 12-12h216a12 12 0 0 1 12 12v176a12 12 0 0 1-12 12H180" {...LINE} strokeOpacity={0.6} fill="none" />
      <Rect x={76} y={76} width={168} height={128} rx={48} stroke={color.info} strokeWidth={3} strokeLinecap="round" strokeDasharray="2 10" fill="none" />
      {DOTS.map(([cx, cy], i) => (
        <KeyDot key={cx} i={i} cx={cx} cy={cy} t={t} />
      ))}
      <G transform="rotate(-20 92 180)">
        <Polygon points="92,160 72,90 112,90" fill={color.text} fillOpacity={0.18} />
        <Rect x={81} y={160} width={22} height={40} rx={6} fill={color.bg} {...LINE} />
      </G>
    </>
  );
}

/** B. Stacked photo cards, a passed-check badge and a readout pill. */
function CheckBeforeYouPay() {
  return (
    <>
      {[70, 90, 110].map((o) => (
        <Rect key={o} x={o} y={o} width={120} height={84} rx={8} fill={color.bg} fillOpacity={0.35} {...LINE} />
      ))}
      <Path d="M110 170H230" {...LINE} />
      <Circle cx={140} cy={140} r={8} fill="none" {...LINE} />
      <Circle cx={230} cy={110} r={22} fill={color.accent} stroke={color.text} strokeWidth={2} />
      <Path d="M219 110l7 7 14-14" stroke={color.text} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Rect x={90} y={214} width={140} height={28} rx={14} fill={color.bg} fillOpacity={0.5} />
      {[
        [104, 40],
        [152, 24],
        [184, 32],
      ].map(([x, w]) => (
        <Rect key={x} x={x} y={225} width={w} height={6} rx={3} fill={color.text} fillOpacity={0.7} />
      ))}
    </>
  );
}

function SolidRoom({ half }: { half?: boolean }) {
  const faces = half ? ['160,110 260,160 160,210', RIGHT_WALL] : [FLOOR, LEFT_WALL, RIGHT_WALL];
  return (
    <>
      {faces.map((p) => (
        <Polygon key={p} points={p} fill={color.text} fillOpacity={0.08} {...LINE} />
      ))}
    </>
  );
}

const ARC = 2 * Math.PI * 120;
const ARC_SHOWN = ARC * 0.65;

/** C. Isometric room: dot grid on the left half becoming solid faces on the right, progress arc drawing to 65%. */
function WeBuildIt({ t }: { t: SharedValue<number> }) {
  const dots: [number, number][] = [];
  for (let x = 60; x <= 160; x += 16) for (let y = 20; y <= 210; y += 16) dots.push([x, y]);
  const arc = useAnimatedProps(() => ({ strokeDashoffset: ARC_SHOWN * (1 - t.get()) }));
  return (
    <>
      <Defs>
        <ClipPath id="vm-ob-build">
          <Polygon points={LEFT_WALL} />
          <Polygon points="60,160 160,110 160,210" />
        </ClipPath>
      </Defs>
      <G clipPath="url(#vm-ob-build)">
        {dots.map(([cx, cy]) => (
          <Circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={2} fill={color.text} fillOpacity={0.5} />
        ))}
      </G>
      <SolidRoom half />
      <Circle cx={160} cy={150} r={120} stroke={color.text} strokeOpacity={0.15} strokeWidth={3} fill="none" />
      <ACircle
        cx={160}
        cy={150}
        r={120}
        stroke={color.info}
        strokeWidth={4}
        strokeLinecap="round"
        strokeDasharray={`${ARC_SHOWN} ${ARC}`}
        transform="rotate(-90 160 150)"
        fill="none"
        animatedProps={arc}
      />
    </>
  );
}

/** D. Solid room, a measure line across the floor and a share badge with the link glyph. */
function WalkMeasureShare() {
  return (
    <>
      <SolidRoom />
      <Path d="M110 175L205 150" stroke={color.info} strokeWidth={3} strokeLinecap="round" />
      <Rect x={129.5} y={151.5} width={56} height={22} rx={11} fill={color.bg} fillOpacity={0.7} />
      {[
        [110, 175],
        [205, 150],
      ].map(([cx, cy]) => (
        <Circle key={cx} cx={cx} cy={cy} r={5} fill={color.accent} stroke={color.text} strokeWidth={2} />
      ))}
      <Circle cx={262} cy={232} r={24} fill={color.bg} {...LINE} />
      <G transform="translate(247.6 217.6) scale(1.2)">
        <Path d={glyphs.link.d} stroke={color.text} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </G>
    </>
  );
}

const ART: ((p: { t: SharedValue<number> }) => ReactNode)[] = [WalkTheRoom, CheckBeforeYouPay, WeBuildIt, WalkMeasureShare];
// Page timelines: A reveals 6 dots at a 60 ms stagger (linear); C draws the arc 0→65% in 600 ms outExpo.
const REVEAL = [
  { duration: DOTS.length * 60, easing: Easing.linear },
  null,
  { duration: 600, easing: ease.outExpo },
  null,
];

type Props = { page: 0 | 1 | 2 | 3; width: number; height: number; active: boolean; reduce: boolean };

/** Decorative: the page's accessibilityLabel carries the meaning. Static under Reduce Motion. */
export function OnboardingArt({ page, width, height, active, reduce }: Props) {
  const Art = ART[page];
  const reveal = REVEAL[page];
  const t = useSharedValue(1); // page timeline
  const enter = useSharedValue(1); // art layer opacity 0→1 + translateX 16→0

  useEffect(() => {
    if (reduce) {
      t.set(1);
      enter.set(1);
      return;
    }
    // Inactive pages wait at the start so the motion plays when they settle.
    t.set(0);
    enter.set(0);
    if (!active) return;
    enter.set(withTiming(1, { duration: motion.duration.slow, easing: ease.outQuart }));
    t.set(reveal ? withTiming(1, reveal) : 1);
  }, [active, reduce, reveal, t, enter]);

  const style = useAnimatedStyle(() => ({ opacity: enter.get(), transform: [{ translateX: (1 - enter.get()) * 16 }] }));

  return (
    <DraftingField width={width} height={height}>
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
        <Svg width={width} height={height} viewBox="0 0 320 280" accessible={false}>
          <Art t={t} />
        </Svg>
      </Animated.View>
    </DraftingField>
  );
}

const styles = StyleSheet.create({
  field: { backgroundColor: color.secondary, overflow: 'hidden' },
});
