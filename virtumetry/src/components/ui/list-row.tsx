import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { focusRing } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { color, minTarget, radius, space } from '@/design/tokens';

/** Raised group with an eyebrow title, inset hairlines between rows and an optional caption footer. */
export function Group({ title, footer, children }: { title?: string; footer?: string; children: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View>
      {title && (
        <ThemedText type="eyebrow" tone="muted" accessibilityRole="header" style={styles.groupTitle}>
          {title}
        </ThemedText>
      )}
      <View style={styles.group}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {i > 0 && <View style={styles.hairline} />}
            {row}
          </Fragment>
        ))}
      </View>
      {footer && (
        <ThemedText type="caption" tone="muted" style={styles.footer}>
          {footer}
        </ThemedText>
      )}
    </View>
  );
}

type RowProps = {
  title: string;
  subtitle?: string;
  leading?: IconName;
  trailing?: 'chevron' | ReactNode;
  tone?: 'default' | 'danger';
  onPress?: () => void;
  accessibilityHint?: string;
  /** Long-press copy for value rows (e.g. the signed-in email). */
  selectable?: boolean;
  testID?: string;
};

/** Settings-style row. Only rows with onPress are buttons; the rest are plain Views with no role. */
export function ListRow({ title, subtitle, leading, trailing, tone = 'default', onPress, accessibilityHint, selectable, testID }: RowProps) {
  const danger = tone === 'danger';
  const body = (
    <>
      {leading && <Icon name={leading} color={danger ? color.danger : color.textMuted} />}
      <View style={styles.text}>
        <ThemedText type="bodyStrong" tone={danger ? 'danger' : 'text'} selectable={selectable}>
          {title}
        </ThemedText>
        {subtitle && (
          <ThemedText type="label" tone="muted" selectable={selectable}>
            {subtitle}
          </ThemedText>
        )}
      </View>
      {trailing === 'chevron' ? <Icon name="disclosure" color={color.textFaint} /> : trailing}
    </>
  );
  if (!onPress)
    return (
      <View testID={testID} style={styles.row}>
        {body}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={(s) => [styles.row, s.pressed && styles.pressed, focusRing(s)]}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  groupTitle: { marginBottom: space.sm, marginLeft: space.lg },
  group: { backgroundColor: color.surface.raised, borderRadius: radius.lg, overflow: 'hidden' },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: color.hairline, marginLeft: space.lg },
  footer: { marginTop: space.sm, marginHorizontal: space.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: minTarget + space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  pressed: { backgroundColor: color.surface.pressed },
  text: { flex: 1, gap: space.xs },
});
