import { NativeTabs } from 'expo-router/native-tabs';

import { color } from '@/design/tokens';

// UI-SPEC §7.15 tab tints.
export default function AppTabs() {
  return (
    <NativeTabs
      backgroundColor={color.bg}
      indicatorColor={color.surface.raised}
      tintColor={color.primary}
      iconColor={{ default: color.textMuted, selected: color.primary }}
      labelStyle={{ default: { color: color.textMuted }, selected: { color: color.primary } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Library</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'square.stack.3d.up', selected: 'square.stack.3d.up.fill' }}
          src={require('@/assets/images/tabIcons/home.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          src={require('@/assets/images/tabIcons/explore.png')}
          renderingMode="template"
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
