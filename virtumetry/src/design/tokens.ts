/**
 * Virtumetry design tokens (UI-SPEC 06.1 §1). The single source of design values and the ONLY
 * file in src/ allowed to hold colour literals. Zero imports: the 'use dom' viewer and the web
 * share page import this module directly.
 */

export const color = {
  bg: '#060a0a',
  surface: { raised: '#10181a', overlay: '#182326', pressed: '#1f2c30' },
  hairline: '#223035',
  border: '#687c81',
  text: '#e7f2f2',
  textMuted: '#a3b3b5',
  textFaint: '#6f7f82',
  primary: '#a2cccb',
  primaryPressed: '#8bb9b8',
  onPrimary: '#060a0a',
  secondary: '#3e4a71',
  secondaryPressed: '#4a5785',
  onSecondary: '#e7f2f2',
  accent: '#6b6cae',
  success: '#8fd1a7',
  warning: '#e6c27a',
  danger: '#f2949a',
  info: '#a9b9f0',
  warningSurface: '#262011',
  dangerSurface: '#2a1517',
  scrim: { hud: 'rgba(6,10,10,0.8)', modal: 'rgba(6,10,10,0.6)' },
  ghost: {
    fill: 'rgba(231,242,242,0.15)',
    stroke: 'rgba(231,242,242,0.3)',
    knob: 'rgba(231,242,242,0.6)',
    unseen: 'rgba(231,242,242,0.2)',
  },
  shadow: '#000000',
} as const;

export const font = {
  display: 'SchibstedGrotesk_700Bold',
  heading: 'SchibstedGrotesk_600SemiBold',
  mono: 'MartianMono_500Medium',
  css: {
    display: "'SchibstedGrotesk_700Bold', system-ui, -apple-system, 'Segoe UI', sans-serif",
    heading: "'SchibstedGrotesk_600SemiBold', system-ui, -apple-system, 'Segoe UI', sans-serif",
    ui: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    mono: "'MartianMono_500Medium', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  },
} as const;

// Custom faces set fontFamily only; system roles set fontWeight only (iOS falls back otherwise).
export const type = {
  display: { fontFamily: font.display, fontSize: 34, lineHeight: 40, letterSpacing: -0.5, maxScale: 1.3 },
  title: { fontFamily: font.display, fontSize: 28, lineHeight: 34, letterSpacing: -0.3, maxScale: 1.3 },
  heading: { fontFamily: font.heading, fontSize: 20, lineHeight: 26, letterSpacing: -0.1, maxScale: 1.3 },
  body: { fontWeight: '400', fontSize: 17, lineHeight: 24, letterSpacing: 0.1, maxScale: 1.6 },
  bodyStrong: { fontWeight: '600', fontSize: 17, lineHeight: 24, letterSpacing: 0.1, maxScale: 1.6 },
  label: { fontWeight: '500', fontSize: 15, lineHeight: 20, letterSpacing: 0.1, maxScale: 1.6 },
  caption: { fontWeight: '400', fontSize: 13, lineHeight: 18, letterSpacing: 0.2, maxScale: 1.6 },
  readout: { fontFamily: font.mono, fontSize: 15, lineHeight: 20, letterSpacing: 0, maxScale: 1.4 },
  readoutLarge: { fontFamily: font.mono, fontSize: 28, lineHeight: 32, letterSpacing: -0.5, maxScale: 1.4 },
  eyebrow: {
    fontFamily: font.mono,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 1.2,
    maxScale: 1.2,
    textTransform: 'uppercase',
  },
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48, huge: 64 } as const;

export const radius = { sm: 8, md: 12, lg: 16, xl: 28, pill: 999 } as const;

// Level 2 only (toasts, coach marks, rename dialog); dark UI uses lighter surfaces, not shadows.
export const elevation = {
  level2: {
    shadowColor: color.shadow,
    shadowOpacity: 0.45,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
} as const;

export const motion = {
  duration: { press: 120, fast: 150, base: 200, slow: 250, progress: 300, pulse: 600, indeterminate: 1200 },
  easing: {
    outQuart: [0.25, 1, 0.5, 1],
    outExpo: [0.16, 1, 0.3, 1],
    inQuart: [0.5, 0, 0.75, 0],
  },
  css: {
    outQuart: 'cubic-bezier(0.25, 1, 0.5, 1)',
    outExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
    inQuart: 'cubic-bezier(0.5, 0, 0.75, 0)',
    linear: 'linear',
  },
  pressScale: 0.97,
  toast: { info: 3000, success: 3000, error: 6000, screenReaderMultiplier: 2 },
} as const;

export const minTarget = 44;

export const layout = { gutter: 16, maxContent: 800, maxForm: 480 } as const;

export const tokens = { color, font, type, space, radius, elevation, motion, minTarget, layout } as const;
