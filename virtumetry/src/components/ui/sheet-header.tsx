import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { color, space } from '@/design/tokens';

type Action = { label: string; onPress: () => void };

/**
 * 56-tall top bar with a hairline bottom: optional leading chevron + destination name (capture steps),
 * optional `heading` title (sheets), optional trailing ghost action.
 */
export function SheetHeader({
  title,
  leading,
  trailing,
  style,
}: {
  title?: string;
  leading?: Action;
  trailing?: Action;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.bar, leading && styles.withLeading, style]}>
      {leading && <Button variant="ghost" size="md" icon="back" label={leading.label} onPress={leading.onPress} />}
      <View style={styles.title}>
        {title ? (
          <ThemedText type="heading" accessibilityRole="header" numberOfLines={1}>
            {title}
          </ThemedText>
        ) : null}
      </View>
      {trailing && <Button variant="ghost" size="md" label={trailing.label} onPress={trailing.onPress} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: space.lg,
    paddingRight: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  withLeading: { paddingLeft: space.sm },
  title: { flex: 1 },
});
