import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';

import { DraftingField } from '@/components/onboarding/art';
import { glyphs } from '@/design/glyphs';
import { color, radius } from '@/design/tokens';

const H = 160;
const SCALE = 4.5;
// Centre the 24-grid mark (visual centre 12,13) on (160,86).
const ORIGIN = `translate(${160 - 12 * SCALE} ${86 - 13 * SCALE}) scale(${SCALE})`;

/** Critique F3: brand corner on the flat drafting field (same as onboarding), accent walking path, no mint. Decorative. */
export function LibraryEmptyArt() {
  const { arms, outline, dot } = glyphs.brandMark;
  const [w, setW] = useState(0);
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={styles.panel} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <DraftingField width={w} height={H}>
        <Svg width={w} height={H} viewBox="0 0 320 160" style={StyleSheet.absoluteFill} accessible={false}>
          {/* Walking path around the corner: semi-ellipse from (70,130) over the top to (250,130). */}
          <Path d="M70 130A90 100 0 0 1 250 130" stroke={color.info} strokeWidth={3} strokeDasharray="2 10" strokeLinecap="round" fill="none" />
          <G transform={ORIGIN}>
            <Path d={arms} stroke={color.text} strokeOpacity={0.9} strokeWidth={0.8} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <Path d={outline} stroke={color.text} strokeOpacity={0.9} strokeWidth={0.6} strokeLinecap="round" fill="none" />
            <Circle {...dot} fill={color.accent} stroke={color.text} strokeWidth={0.4} />
          </G>
        </Svg>
      </DraftingField>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { height: H, borderRadius: radius.xl, overflow: 'hidden' },
});
