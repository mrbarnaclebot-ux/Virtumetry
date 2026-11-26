import { StyleSheet, View } from 'react-native';
import Svg, { Circle, ClipPath, Defs, G, LinearGradient, Path, Polygon, Rect, Stop } from 'react-native-svg';

import { glyphs } from '@/design/glyphs';
import { color, radius } from '@/design/tokens';

// UI-SPEC §13.2: 320x280 art on a secondary→accent panel. Lines text 0.85, fills bg 0.35, highlights primary.
const LINE = { stroke: color.text, strokeOpacity: 0.85, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const FLOOR = '160,210 260,160 160,110 60,160';
const LEFT_WALL = '60,160 160,110 160,20 60,70';
const RIGHT_WALL = '160,110 260,160 260,70 160,20';

/** A. Top-down room, dashed walking loop, phone with a view cone, keyframe dots behind it. */
function WalkTheRoom() {
  return (
    <>
      <Path d="M140 240H52a12 12 0 0 1-12-12V52a12 12 0 0 1 12-12h216a12 12 0 0 1 12 12v176a12 12 0 0 1-12 12H180" {...LINE} strokeOpacity={0.6} fill="none" />
      <Rect x={76} y={76} width={168} height={128} rx={48} stroke={color.primary} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="2 10" fill="none" />
      {[
        [124, 204],
        [150, 204],
        [176, 204],
        [202, 204],
        [232, 192],
        [244, 164],
      ].map(([cx, cy]) => (
        <Circle key={cx} cx={cx} cy={cy} r={3} fill={color.text} />
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
      <Circle cx={230} cy={110} r={22} fill={color.primary} />
      <Path d="M219 110l7 7 14-14" stroke={color.onPrimary} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
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

/** C. Isometric room: dot grid on the left half becoming solid faces on the right, 65% progress arc. */
function WeBuildIt() {
  const dots: [number, number][] = [];
  for (let x = 60; x <= 160; x += 16) for (let y = 20; y <= 210; y += 16) dots.push([x, y]);
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
      <Circle
        cx={160}
        cy={150}
        r={120}
        stroke={color.primary}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${ARC * 0.65} ${ARC}`}
        transform="rotate(-90 160 150)"
        fill="none"
      />
    </>
  );
}

/** D. Solid room, a measure line across the floor and a share badge with the link glyph. */
function WalkMeasureShare() {
  return (
    <>
      <SolidRoom />
      <Path d="M110 175L205 150" stroke={color.primary} strokeWidth={2.5} strokeLinecap="round" />
      <Rect x={129.5} y={151.5} width={56} height={22} rx={11} fill={color.bg} fillOpacity={0.7} />
      {[
        [110, 175],
        [205, 150],
      ].map(([cx, cy]) => (
        <Circle key={cx} cx={cx} cy={cy} r={5} fill={color.primary} stroke={color.text} strokeWidth={2} />
      ))}
      <Circle cx={262} cy={232} r={24} fill={color.bg} {...LINE} />
      <G transform="translate(247.6 217.6) scale(1.2)">
        <Path d={glyphs.link.d} stroke={color.text} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </G>
    </>
  );
}

const ART = [WalkTheRoom, CheckBeforeYouPay, WeBuildIt, WalkMeasureShare];

type Props = { page: 0 | 1 | 2 | 3; width: number; height: number };

/** Decorative: the page's accessibilityLabel carries the meaning. */
export function OnboardingArt({ page, width, height }: Props) {
  const Art = ART[page];
  const grad = `vm-ob-grad-${page}`;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.panel, { width, height }]}>
      <Svg width={width} height={height} style={StyleSheet.absoluteFill} accessible={false}>
        <Defs>
          <LinearGradient id={grad} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color.secondary} />
            <Stop offset="1" stopColor={color.accent} />
          </LinearGradient>
        </Defs>
        <Rect width={width} height={height} fill={`url(#${grad})`} />
      </Svg>
      <Svg width={width} height={height} viewBox="0 0 320 280" accessible={false}>
        <Art />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { borderRadius: radius.xl, overflow: 'hidden' },
});
