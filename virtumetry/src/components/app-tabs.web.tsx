import { Tabs, TabList, TabTrigger, TabSlot, TabTriggerSlotProps, TabListProps } from 'expo-router/ui';
import { Pressable, PressableProps, View, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { focusRing } from '@/components/ui/button';
import { BrandMark } from '@/components/ui/brand-mark';
import { color, layout, minTarget, radius, space } from '@/design/tokens';

// UI-SPEC §7.15: floating raised bar, brand lockup, selected tab on secondary.
export default function AppTabs() {
  return (
    <Tabs>
      <TabSlot style={{ height: '100%' }} />
      <TabList asChild>
        <CustomTabList>
          <TabTrigger name="index" href="/" asChild>
            <TabButton>Library</TabButton>
          </TabTrigger>
          <TabTrigger name="settings" href="/settings" asChild>
            <TabButton>Settings</TabButton>
          </TabTrigger>
        </CustomTabList>
      </TabList>
    </Tabs>
  );
}

export function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  return (
    <Pressable
      {...(props as PressableProps)}
      accessibilityState={{ selected: !!isFocused }}
      style={(s) => [styles.tab, isFocused ? styles.selected : s.pressed && styles.pressed, focusRing(s)]}>
      <ThemedText type="label" tone={isFocused ? 'text' : 'muted'}>
        {children}
      </ThemedText>
    </Pressable>
  );
}

export function CustomTabList(props: TabListProps) {
  return (
    <View {...props} style={styles.tabListContainer}>
      <View style={styles.innerContainer}>
        <View style={styles.brand}>
          <BrandMark size={20} variant="lockup" />
        </View>
        {props.children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  tabListContainer: {
    position: 'absolute',
    width: '100%',
    padding: space.lg,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row',
  },
  innerContainer: {
    paddingVertical: space.sm,
    paddingLeft: space.xl,
    paddingRight: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.surface.raised,
    flexDirection: 'row',
    alignItems: 'center',
    flexGrow: 1,
    gap: space.sm,
    maxWidth: layout.maxContent,
  },
  brand: { marginRight: 'auto' },
  tab: {
    minHeight: minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  selected: { backgroundColor: color.secondary },
  pressed: { backgroundColor: color.surface.pressed },
});
