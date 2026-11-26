import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { color, space } from '@/design/tokens';

/** 56-tall sheet title bar with an optional trailing ghost action and a hairline bottom. */
export function SheetHeader({ title, trailing }: { title: string; trailing?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.bar}>
      <ThemedText type="heading" accessibilityRole="header" numberOfLines={1} style={styles.title}>
        {title}
      </ThemedText>
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
  title: { flex: 1 },
});
