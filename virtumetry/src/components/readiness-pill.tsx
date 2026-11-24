import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import type { Readiness } from '@/capture/readiness';
import { ThemedText } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

// D-07: level is never color alone — icon shape + label word + reason (UI-SPEC §4).
const LOOK: Record<Readiness['level'], { icon: SymbolViewProps['name'] | null; color: 'accent' | 'warning' | 'destructive' | 'text' }> = {
  green: { icon: 'checkmark.circle.fill', color: 'accent' },
  amber: { icon: 'exclamationmark.circle.fill', color: 'warning' },
  red: { icon: 'xmark.circle.fill', color: 'destructive' },
  idle: { icon: null, color: 'text' },
};

type Props = { result: Readiness; scheme?: 'dark' | 'system' };

export function ReadinessPill({ result, scheme = 'system' }: Props) {
  const system = useTheme();
  const theme = scheme === 'dark' ? Colors.dark : system;
  const font = scheme === 'dark' ? 1.3 : 1.6;
  const { icon, color } = LOOK[result.level];
  const label = `Readiness: ${result.label}. ${result.reason}`;

  // Announce only when the level changes, not on every reason/count update.
  const prev = useRef(result.level);
  useEffect(() => {
    if (prev.current !== result.level) AccessibilityInfo.announceForAccessibility(label);
    prev.current = result.level;
  }, [result.level, label]);

  return (
    <View accessible accessibilityLabel={label} accessibilityLiveRegion="polite">
      <View style={[styles.pill, { backgroundColor: theme.backgroundElement }]}>
        {icon && <SymbolView name={icon} size={20} tintColor={theme[color]} />}
        <ThemedText type="smallBold" maxFontSizeMultiplier={font} style={{ color: theme[color] }}>
          {result.label}
        </ThemedText>
      </View>
      <ThemedText type="small" maxFontSizeMultiplier={font} style={[styles.reason, { color: theme.text }]}>
        {result.reason}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    minHeight: 32,
    borderRadius: 16,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  reason: { marginTop: Spacing.one },
});
