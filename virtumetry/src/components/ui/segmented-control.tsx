import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { focusRing } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { haptic } from '@/design/haptics';
import { color, radius, space } from '@/design/tokens';

type Option<T extends string> = { id: T; label: string; icon?: IconName };

type Props<T extends string> = {
  options: readonly Option<T>[];
  value: T;
  onChange: (id: T) => void;
  /** Disabled ids stay pressable so onDisabledPress can explain why. */
  disabled?: readonly T[];
  onDisabledPress?: (id: T) => void;
  variant?: 'surface' | 'scrim';
  /** Group name for screen readers. */
  accessibilityLabel?: string;
  /** Per-option accessible name (default: the label). */
  accessibilityLabelFor?: (opt: Option<T>) => string;
  /** 'button' keeps the legacy scenario-picker contract. */
  optionRole?: 'radio' | 'button';
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = [],
  onDisabledPress,
  variant = 'surface',
  accessibilityLabel,
  accessibilityLabelFor,
  optionRole = 'radio',
}: Props<T>) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={[styles.track, { backgroundColor: variant === 'scrim' ? color.scrim.hud : color.surface.raised }]}>
      {options.map((opt) => {
        const selected = opt.id === value;
        const off = disabled.includes(opt.id);
        return (
          <Pressable
            key={opt.id}
            accessibilityRole={optionRole}
            accessibilityLabel={accessibilityLabelFor?.(opt) ?? opt.label}
            accessibilityState={{ selected, checked: optionRole === 'radio' ? selected : undefined, disabled: off }}
            hitSlop={4}
            onPress={() => {
              if (off) return onDisabledPress?.(opt.id);
              if (selected) return;
              haptic.selection();
              onChange(opt.id);
            }}
            style={(s) => [styles.segment, selected && styles.selected, off && styles.off, focusRing(s)]}>
            {opt.icon && <Icon name={opt.icon} size={16} color={selected ? color.onPrimary : color.textMuted} />}
            <ThemedText type="label" tone={selected ? 'onPrimary' : 'muted'} numberOfLines={1} style={selected && styles.strong}>
              {opt.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', padding: space.xs, borderRadius: radius.pill, gap: space.xs },
  segment: {
    flex: 1,
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  selected: { backgroundColor: color.primary },
  strong: { fontWeight: '600' },
  off: { opacity: 0.4 },
});
