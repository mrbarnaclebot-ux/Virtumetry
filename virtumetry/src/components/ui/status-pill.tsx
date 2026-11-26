import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { color, space } from '@/design/tokens';
import type { DisplayState } from '@/library/display-state';

export type StatusKind = DisplayState['kind'] | 'paused';

// UI-SPEC §7.2: status is icon + word + colour, never colour alone.
const KINDS = {
  saved_on_phone: { icon: 'savedOnPhone', tone: 'muted' },
  uploading: { icon: 'uploading', tone: 'muted' },
  paused: { icon: 'offline', tone: 'muted' },
  processing: { icon: 'processing', tone: 'muted' },
  ready: { icon: 'ready', tone: 'success' },
  failed: { icon: 'warning', tone: 'danger' },
  cancelled: { icon: 'cancelled', tone: 'muted' },
} as const satisfies Record<StatusKind, { icon: IconName; tone: 'muted' | 'success' | 'danger' }>;

const INK = { muted: color.textMuted, success: color.success, danger: color.danger } as const;

export function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  const { icon, tone } = KINDS[kind];
  return (
    <View style={styles.pill}>
      <Icon name={icon} size={16} color={INK[tone]} hierarchical />
      <ThemedText type="label" tone={tone} style={styles.label}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  label: { fontVariant: ['tabular-nums'], flexShrink: 1 },
});
