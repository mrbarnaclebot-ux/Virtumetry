import { Text, type TextProps } from 'react-native';

import { ThemeColor } from '@/constants/theme';
import { color, type as typeScale } from '@/design/tokens';
import { useTheme } from '@/hooks/use-theme';

type Role = keyof typeof typeScale;

// Legacy role names from the starter, kept so existing call sites compile.
const LEGACY = { default: 'body', small: 'label', smallBold: 'bodyStrong', subtitle: 'heading' } as const;

const TONES = {
  text: color.text,
  muted: color.textMuted,
  faint: color.textFaint,
  primary: color.primary,
  onPrimary: color.onPrimary,
  onSecondary: color.onSecondary,
  success: color.success,
  warning: color.warning,
  danger: color.danger,
  info: color.info,
} as const;

export type ThemedTextProps = TextProps & {
  type?: Role | keyof typeof LEGACY;
  tone?: keyof typeof TONES;
  /** Legacy colour key; `tone` wins when both are set. */
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'body', tone, themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();
  const role: Role = type in LEGACY ? LEGACY[type as keyof typeof LEGACY] : (type as Role);
  const { maxScale, ...roleStyle } = typeScale[role];
  const textColor = tone ? TONES[tone] : theme[themeColor ?? 'text'];

  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={rest.maxFontSizeMultiplier ?? maxScale}
      style={[{ color: textColor }, roleStyle, style]}
    />
  );
}
