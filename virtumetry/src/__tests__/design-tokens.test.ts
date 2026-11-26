import fs from 'fs';
import path from 'path';

import { glyphs } from '@/design/glyphs';
import { color, tokens, type } from '@/design/tokens';

// WCAG 2.x relative luminance (UI-SPEC §1.2).
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const L = (hex: string) => {
  const [r, g, b] = rgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [L(a), L(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
// Composite an rgba() colour over an opaque hex (worst case for scrims: over white).
const composite = (rgba: string, over: string) => {
  const [r, g, b, a] = rgba.match(/[\d.]+/g)!.map(Number);
  const base = rgb(over).map((c) => c * 255);
  return (
    '#' +
    [r, g, b]
      .map((c, i) => Math.round(c * a + base[i] * (1 - a)))
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')
  );
};

const scrim = composite(color.scrim.hud, '#ffffff');
const s = color.surface;
const statusSet = ['text', 'textMuted', 'primary', 'success', 'warning', 'danger', 'info'] as const;

const pairs: [string, string, string, string, number][] = [
  // [fg name, bg name, fg, bg, needs]
  ...(
    [
      ['bg', color.bg],
      ['raised', s.raised],
      ['overlay', s.overlay],
      ['pressed', s.pressed],
    ] as const
  ).flatMap(([bn, bv]) => statusSet.map((f) => [f, bn, color[f], bv, 4.5] as [string, string, string, string, number])),
  ...(
    [
      ['bg', color.bg],
      ['raised', s.raised],
      ['overlay', s.overlay],
    ] as const
  ).flatMap(([bn, bv]) =>
    (['accent', 'border', 'primary'] as const).map(
      (f) => [`${f} (graphic)`, bn, color[f], bv, 3] as [string, string, string, string, number],
    ),
  ),
  ['onPrimary', 'primary', color.onPrimary, color.primary, 4.5],
  ['onPrimary', 'primaryPressed', color.onPrimary, color.primaryPressed, 4.5],
  ['onSecondary', 'secondary', color.onSecondary, color.secondary, 4.5],
  ['onSecondary', 'secondaryPressed', color.onSecondary, color.secondaryPressed, 4.5],
  ['text', 'accent', color.text, color.accent, 3],
  ['text', 'warningSurface', color.text, color.warningSurface, 4.5],
  ['textMuted', 'warningSurface', color.textMuted, color.warningSurface, 4.5],
  ['warning', 'warningSurface', color.warning, color.warningSurface, 3],
  ['text', 'dangerSurface', color.text, color.dangerSurface, 4.5],
  ['danger', 'dangerSurface', color.danger, color.dangerSurface, 4.5],
  ['text', 'scrim.hud/white', color.text, scrim, 4.5],
  ['textMuted', 'scrim.hud/white', color.textMuted, scrim, 4.5],
  ['primary', 'scrim.hud/white', color.primary, scrim, 3],
  ['success', 'scrim.hud/white', color.success, scrim, 4.5],
  ['warning', 'scrim.hud/white', color.warning, scrim, 4.5],
  ['danger', 'scrim.hud/white', color.danger, scrim, 4.5],
];

describe('contrast', () => {
  it('composites scrim.hud over white to #383b3b', () => {
    expect(scrim).toBe('#383b3b');
  });

  it('covers every §1.2 pair', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(40);
  });

  it.each(pairs)('%s on %s meets its threshold', (_f, _b, fg, bg, needs) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(needs);
  });

  // Known failures that justify the bans in UI-SPEC §1.1/§1.2; do not "fix" by relaxing these.
  it('textMuted on secondary fails AA (only text on secondary)', () => {
    expect(ratio(color.textMuted, color.secondary)).toBeLessThan(4.5);
  });
  it('accent on the HUD scrim fails 3:1 (no accent on scrims)', () => {
    expect(ratio(color.accent, scrim)).toBeLessThan(3);
  });
});

describe('token shape', () => {
  it('aggregates every group', () => {
    expect(Object.keys(tokens).sort()).toEqual(
      ['color', 'elevation', 'font', 'layout', 'minTarget', 'motion', 'radius', 'space', 'type'].sort(),
    );
  });

  it('has the 10 type roles with family XOR weight', () => {
    const roles = Object.keys(type);
    expect(roles).toHaveLength(10);
    for (const r of roles) {
      const t = type[r as keyof typeof type] as Record<string, unknown>;
      expect('fontFamily' in t !== 'fontWeight' in t).toBe(true);
      for (const k of ['fontSize', 'lineHeight', 'letterSpacing', 'maxScale']) expect(typeof t[k]).toBe('number');
    }
    expect(type.eyebrow.textTransform).toBe('uppercase');
  });

  it('glyphs include the brand mark and the §4 ids', () => {
    expect(glyphs.brandMark.dot).toEqual({ cx: 12, cy: 14, r: 1.6 });
    for (const id of ['close', 'check', 'alert', 'refresh', 'reset', 'plan', 'orbit', 'walk', 'measure', 'lock', 'linkOff', 'link']) {
      expect(glyphs).toHaveProperty(id);
    }
  });

  it.each(['tokens.ts', 'glyphs.ts'])('%s has no imports (DOM viewer safe)', (f) => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'design', f), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/require\(/);
  });
});
