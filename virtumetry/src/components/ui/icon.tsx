import { SymbolView, type AndroidSymbol, type SymbolViewProps } from 'expo-symbols';

import { color } from '@/design/tokens';

type SF = Extract<SymbolViewProps['name'], string>;

// UI-SPEC §4: one concept, one glyph, everywhere.
const ICONS = {
  world: { sf: 'cube.transparent', md: 'deployed_code' },
  library: { sf: 'square.stack.3d.up', sfSelected: 'square.stack.3d.up.fill', md: 'stacks' },
  settings: { sf: 'gearshape', sfSelected: 'gearshape.fill', md: 'settings' },
  newScan: { sf: 'plus', md: 'add' },
  more: { sf: 'ellipsis', md: 'more_horiz' },
  close: { sf: 'xmark', md: 'close' },
  back: { sf: 'chevron.left', md: 'chevron_left' },
  disclosure: { sf: 'chevron.right', md: 'chevron_right' },
  share: { sf: 'square.and.arrow.up', md: 'ios_share' },
  link: { sf: 'link', md: 'link' },
  lock: { sf: 'lock.fill', md: 'lock' },
  savedOnPhone: { sf: 'iphone', md: 'smartphone' },
  uploading: { sf: 'arrow.up.circle', md: 'upload' },
  offline: { sf: 'wifi.slash', md: 'wifi_off' },
  processing: { sf: 'hourglass', md: 'hourglass_empty' },
  ready: { sf: 'checkmark.circle.fill', md: 'check_circle' },
  warning: { sf: 'exclamationmark.triangle.fill', md: 'warning' },
  almost: { sf: 'exclamationmark.circle.fill', md: 'error' },
  failedCheck: { sf: 'xmark.circle.fill', md: 'cancel' },
  cancelled: { sf: 'xmark.circle', md: 'cancel' },
  info: { sf: 'info.circle', md: 'info' },
  refresh: { sf: 'arrow.clockwise', md: 'refresh' },
  replay: { sf: 'arrow.counterclockwise.circle', md: 'replay' },
  logout: { sf: 'rectangle.portrait.and.arrow.right', md: 'logout' },
  camera: { sf: 'camera', md: 'photo_camera' },
  cameraOff: { sf: 'video.slash', md: 'videocam_off' },
  lights: { sf: 'lightbulb', md: 'lightbulb' },
  doors: { sf: 'door.left.hand.open', md: 'door_open' },
  glare: { sf: 'sun.max', md: 'light_mode' },
  walk: { sf: 'figure.walk', md: 'directions_walk' },
  orbit: { sf: 'rotate.3d', md: '3d_rotation' },
  measure: { sf: 'ruler', md: 'straighten' },
  floorPlan: { sf: 'map', md: 'map' },
  resetView: { sf: 'arrow.counterclockwise', md: 'restart_alt' },
} as const satisfies Record<string, { sf: SF; sfSelected?: SF; md: AndroidSymbol }>;

export type IconName = keyof typeof ICONS;

type Props = {
  name: IconName;
  size?: 16 | 20 | 24 | 48;
  color?: string;
  hierarchical?: boolean;
  /** Tab icons: use the filled SF variant when one exists. */
  selected?: boolean;
  /** Omit for decorative icons (not exposed to screen readers). */
  accessibilityLabel?: string;
};

export function Icon({ name, size = 20, color: tint = color.text, hierarchical, selected, accessibilityLabel }: Props) {
  const entry: { sf: SF; sfSelected?: SF; md: AndroidSymbol } = ICONS[name];
  return (
    <SymbolView
      name={{ ios: (selected && entry.sfSelected) || entry.sf, android: entry.md, web: entry.md }}
      weight="medium"
      size={size}
      tintColor={tint}
      type={hierarchical ? 'hierarchical' : 'monochrome'}
      accessible={!!accessibilityLabel}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
    />
  );
}
