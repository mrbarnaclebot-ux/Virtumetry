import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { ThemedText } from '@/components/themed-text';
import { glyphs } from '@/design/glyphs';
import { color, space } from '@/design/tokens';

type Props = {
  size?: number;
  variant?: 'mark' | 'lockup';
  /** One colour for every stroke and the dot. */
  mono?: boolean;
  /** Mono colour (default textMuted). */
  color?: string;
};

/** UI-SPEC §13.1 "room corner with a scale". Only the lockup is exposed to screen readers. */
export function BrandMark({ size = 32, variant = 'mark', mono, color: monoColor = color.textMuted }: Props) {
  const { arms, outline, dot } = glyphs.brandMark;
  const stem = mono ? monoColor : color.text;
  const accent = mono ? monoColor : color.primary;
  const mark = (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path d={arms} stroke={stem} strokeWidth={size <= 20 ? 1.75 : 2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Path d={outline} stroke={accent} strokeWidth={1} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <Circle {...dot} fill={accent} />
    </Svg>
  );
  if (variant === 'mark') return mark;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="Virtumetry" style={styles.lockup}>
      {mark}
      <ThemedText
        type="title"
        tone={mono ? undefined : 'text'}
        maxFontSizeMultiplier={1.3}
        style={[styles.word, { fontSize: Math.round(size * 0.7), lineHeight: size }, mono && { color: monoColor }]}>
        Virtumetry
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  word: { letterSpacing: -0.3 },
});
