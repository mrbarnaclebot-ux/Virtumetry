import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg';

import { glyphs } from '@/design/glyphs';
import { color, radius } from '@/design/tokens';

const SCALE = 4.5;
// Centre the 24-grid mark (visual centre 12,13) on (160,86).
const ORIGIN = `translate(${160 - 12 * SCALE} ${86 - 13 * SCALE}) scale(${SCALE})`;

/** 06.1 UI-SPEC §13.3: brand corner on the secondary→accent panel with a dashed walking path over it. Decorative. */
export function LibraryEmptyArt({ width = '100%' }: { width?: number | `${number}%` }) {
  const { arms, ticks, dot } = glyphs.brandMark;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={[styles.panel, { width }]}>
      <Svg width="100%" height={160} viewBox="0 0 320 160" preserveAspectRatio="xMidYMid slice" accessible={false}>
        <Defs>
          <LinearGradient id="emptyField" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={color.secondary} />
            <Stop offset="1" stopColor={color.accent} />
          </LinearGradient>
        </Defs>
        <Rect x={0} y={0} width={320} height={160} fill="url(#emptyField)" />
        {/* Walking path around the corner: semi-ellipse from (70,130) over the top to (250,130). */}
        <Path
          d="M70 130A90 100 0 0 1 250 130"
          stroke={color.primary}
          strokeWidth={2}
          strokeDasharray="2 10"
          strokeLinecap="round"
          fill="none"
        />
        <G transform={ORIGIN}>
          <Path d={arms} stroke={color.text} strokeOpacity={0.9} strokeWidth={0.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          <Path d={ticks} stroke={color.primary} strokeWidth={0.6} strokeLinecap="round" fill="none" />
          <Circle {...dot} fill={color.primary} />
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { height: 160, borderRadius: radius.xl, overflow: 'hidden' },
});
