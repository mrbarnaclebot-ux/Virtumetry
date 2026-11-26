import { useEffect, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import type { Readiness } from '@/capture/readiness';
import { ThemedText } from '@/components/themed-text';
import { Icon, type IconName } from '@/components/ui/icon';
import { color, radius, space } from '@/design/tokens';

// D-07: level is never color alone: icon shape + label word + reason (UI-SPEC §4, §5).
const LOOK: Record<Readiness['level'], { icon: IconName | null; tint: string; hudTint: string }> = {
  green: { icon: 'ready', tint: color.success, hudTint: color.success },
  amber: { icon: 'almost', tint: color.warning, hudTint: color.warning },
  // HUD headline stays text on red: "Keep scanning" is the normal mid-scan state, not an alarm.
  red: { icon: 'failedCheck', tint: color.danger, hudTint: color.text },
  idle: { icon: null, tint: color.text, hudTint: color.text },
};

/** `scheme="dark"` is the capture HUD headline: no pill fill, `hudStatus` type, text capped at 1.3. */
type Props = { result: Readiness; scheme?: 'dark' | 'system' };

export function ReadinessPill({ result, scheme = 'system' }: Props) {
  const hud = scheme === 'dark';
  const font = hud ? 1.3 : 1.6;
  const { icon, tint, hudTint } = LOOK[result.level];
  const label = `Readiness: ${result.label}. ${result.reason}`;

  // Announce only when the level changes, not on every reason/count update.
  const prev = useRef(result.level);
  useEffect(() => {
    if (prev.current !== result.level) AccessibilityInfo.announceForAccessibility(label);
    prev.current = result.level;
  }, [result.level, label]);

  return (
    <View accessible accessibilityLabel={label} accessibilityLiveRegion="polite">
      <View style={[styles.pill, !hud && styles.filled]}>
        {icon && <Icon name={icon} size={hud ? 24 : 20} color={tint} hierarchical />}
        <ThemedText
          type={hud ? 'hudStatus' : 'bodyStrong'}
          maxFontSizeMultiplier={font}
          style={{ color: hud ? hudTint : tint }}>
          {result.label}
        </ThemedText>
      </View>
      <ThemedText type="label" tone="text" maxFontSizeMultiplier={font} style={styles.reason}>
        {result.reason}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'flex-start', minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  filled: { backgroundColor: color.surface.raised, borderRadius: radius.pill, paddingHorizontal: space.md },
  reason: { marginTop: space.xs },
});
