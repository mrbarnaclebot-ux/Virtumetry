/**
 * SVG glyph path data (UI-SPEC 06.1 §4, §13.1). 24-grid, stroke 1.75, round caps/joins, fill none;
 * `dots` are filled circles drawn by the renderer. Zero imports: used by the 'use dom' viewer.
 */

type Dot = { cx: number; cy: number; r: number };
type Glyph = { d: string; dots?: readonly Dot[] };

export const glyphs = {
  close: { d: 'M6 6l12 12M18 6L6 18' },
  check: { d: 'M5 12.5l4.5 4.5L19 7.5' },
  alert: { d: 'M12 4l9 16H3z M12 10v4.5 M12 17.6v.1' },
  refresh: { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5v4h-4' },
  reset: { d: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3 M4.5 4.5v4h4' },
  plan: { d: 'M4 4h16v16H4z M4 13h7v7 M14 4v5h6' },
  orbit: {
    d: 'M3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5c-1.6 0-3.1-.2-4.4-.6 M9.4 14.6l-2 2 2.4 1.6',
    dots: [{ cx: 12, cy: 12, r: 1.75 }],
  },
  walk: {
    // Leaning stride: torso, bent front and back legs, counter-swinging arms (reads at 16 px).
    d: 'M12.75 8L11 13.25 M11 13.25l2.75 2.75.75 4.5 M11 13.25l-1.25 3.5-3 3 M12.5 9l-2.75 1.5-1 2.75 M12.5 9l2.25 2.25 2.5.5',
    dots: [{ cx: 13.75, cy: 4.5, r: 1.75 }],
  },
  measure: { d: 'M3.5 15.5l12-12 5 5-12 12z M7 12l1.5 1.5 M9.5 9.5l2.5 2.5 M12 7l1.5 1.5' },
  lock: { d: 'M6.5 11h11v9h-11z M8.5 11V8a3.5 3.5 0 0 1 7 0v3' },
  link: { d: 'M10 14a4 4 0 0 1 0-5.6l2-2a4 4 0 0 1 5.6 5.6l-1 1 M14 10a4 4 0 0 1 0 5.6l-2 2a4 4 0 0 1-5.6-5.6l1-1' },
  linkOff: {
    d: 'M10 14a4 4 0 0 1 0-5.6l2-2a4 4 0 0 1 5.6 5.6l-1 1 M14 10a4 4 0 0 1 0 5.6l-2 2a4 4 0 0 1-5.6-5.6l1-1 M4 4l16 16',
  },
  // Room corner inside its isometric outline: three edges in text, outline + vertex dot in primary (round-2 critique: no letter read).
  // Ticks (major + minor) sit on the stem: height is the measurement. Mirrored by scripts/render-brand.py.
  brandMark: {
    arms: 'M12 14L3.77 9.25M12 14L20.23 9.25M12 14V23.5',
    outline: 'M12.0 4.5L3.77 9.25L3.77 18.75L12.0 23.5L20.23 18.75L20.23 9.25Z',
    dot: { cx: 12, cy: 14, r: 1.6 },
  },
} as const satisfies Record<string, Glyph | { arms: string; outline: string; dot: Dot }>;

export type GlyphId = Exclude<keyof typeof glyphs, 'brandMark'>;
