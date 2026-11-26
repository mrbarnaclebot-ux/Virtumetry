/**
 * App theme derived from design tokens (UI-SPEC 06.1 §2). Dark-only: one flat Colors object.
 * New code should read `tokens.color.*` from '@/design/tokens' directly.
 */

import { Platform } from 'react-native';

import { color, font, layout } from '@/design/tokens';

export const Colors = {
  // Legacy keys (existing call sites).
  text: color.text,
  background: color.bg,
  backgroundElement: color.surface.raised,
  backgroundSelected: color.surface.pressed,
  textSecondary: color.textMuted,
  // TRAP: legacy `accent` is PRIMARY (mint), not tokens.color.accent (violet). Never use in new code.
  accent: color.primary,
  onAccent: color.onPrimary,
  destructive: color.danger,
  warning: color.warning,
  // Semantic keys.
  success: color.success,
  info: color.info,
  hairline: color.hairline,
  border: color.border,
  secondary: color.secondary,
  onSecondary: color.onSecondary,
  overlay: color.surface.overlay,
  primary: color.primary,
  onPrimary: color.onPrimary,
  textFaint: color.textFaint,
} as const;

export type ThemeColor = keyof typeof Colors;

export const Fonts = font.css;

export const Spacing = {
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = layout.maxContent;
