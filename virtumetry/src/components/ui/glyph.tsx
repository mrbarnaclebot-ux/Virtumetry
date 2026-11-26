import Svg, { Circle, Path } from 'react-native-svg';

import { glyphs, type GlyphId } from '@/design/glyphs';
import { color } from '@/design/tokens';

/** UI-SPEC §4 glyph renderer (web share page): 24-grid, stroke 1.75, round, fill none. */
export function Glyph({ id, size = 20, color: tint = color.text }: { id: GlyphId; size?: number; color?: string }) {
  const g: { d: string; dots?: readonly { cx: number; cy: number; r: number }[] } = glyphs[id];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessible={false}>
      <Path d={g.d} stroke={tint} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {g.dots?.map((dot) => <Circle key={`${dot.cx},${dot.cy}`} {...dot} fill={tint} />)}
    </Svg>
  );
}
