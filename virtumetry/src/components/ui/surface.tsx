import { StyleSheet, View, type ViewProps } from 'react-native';

import { color, elevation, radius, space } from '@/design/tokens';

type Props = ViewProps & {
  /** 1 = raised card, 2 = overlay with hairline + shadow (toasts, coach marks, dialogs). */
  level?: 1 | 2;
  tone?: 'default' | 'warning' | 'danger';
  padded?: boolean;
};

const TONE_FILL = { warning: color.warningSurface, danger: color.dangerSurface } as const;

export function Surface({ level = 1, tone = 'default', padded, style, ...rest }: Props) {
  return (
    <View
      {...rest}
      style={[
        styles.base,
        level === 2 && styles.overlay,
        tone !== 'default' && { backgroundColor: TONE_FILL[tone] },
        padded && styles.padded,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: { backgroundColor: color.surface.raised, borderRadius: radius.lg },
  overlay: {
    backgroundColor: color.surface.overlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    ...elevation.level2,
  },
  padded: { padding: space.lg },
});
