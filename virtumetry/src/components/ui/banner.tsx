import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { focusRing } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { IconButton } from '@/components/ui/icon-button';
import { ease } from '@/design/motion';
import { color, minTarget, motion, radius, space } from '@/design/tokens';

const TONES = {
  warning: { bg: color.warningSurface, ink: color.warning },
  danger: { bg: color.dangerSurface, ink: color.danger },
  info: { bg: color.surface.raised, ink: color.info },
  neutral: { bg: color.surface.raised, ink: color.textMuted },
} as const;

type Props = {
  tone: keyof typeof TONES;
  icon: IconName;
  title: string;
  body?: string;
  action?: { label: string; onPress: () => void };
  style?: StyleProp<ViewStyle>;
  testID?: string;
} & ({ onDismiss: () => void; dismissLabel: string } | { onDismiss?: undefined; dismissLabel?: undefined });

/** UI-SPEC §5: full tinted surface, no side stripe; alert role for warning/danger. Reduce Motion: Reanimated System default. */
export function Banner({ tone, icon, title, body, action, onDismiss, dismissLabel, style, testID }: Props) {
  const t = TONES[tone];
  const alert = tone === 'warning' || tone === 'danger';
  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.base).easing(ease.outQuart)}
      exiting={FadeOut.duration(motion.duration.fast)}
      layout={LinearTransition.duration(motion.duration.base).easing(ease.outQuart)}
      style={style}>
      <View testID={testID} accessibilityRole={alert ? 'alert' : undefined} style={[styles.banner, { backgroundColor: t.bg }]}>
        <Icon name={icon} size={20} color={t.ink} />
        <View style={styles.text}>
          <ThemedText type="label" style={styles.title}>
            {title}
          </ThemedText>
          {body && (
            <ThemedText type="label" tone="muted">
              {body}
            </ThemedText>
          )}
          {/* Link-style text button flush with the text; hitSlop keeps the 44 pt target. */}
          {action && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action.label}
              onPress={action.onPress}
              hitSlop={LINK_SLOP}
              style={(s) => [styles.action, focusRing(s)]}>
              {({ pressed }) => (
                <ThemedText type="label" style={[styles.link, pressed && styles.linkPressed]}>
                  {action.label}
                </ThemedText>
              )}
            </Pressable>
          )}
        </View>
        {onDismiss && <IconButton icon="close" accessibilityLabel={dismissLabel} onPress={onDismiss} style={styles.dismiss} />}
      </View>
    </Animated.View>
  );
}

const LINK_SLOP = { top: (minTarget - 20) / 2, bottom: (minTarget - 20) / 2, left: space.sm, right: space.lg };

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, padding: space.lg, borderRadius: radius.md },
  text: { flex: 1, gap: space.xs },
  title: { fontWeight: '600' },
  action: { alignSelf: 'flex-start', marginTop: space.xs },
  link: { color: color.primary, fontWeight: '600' },
  linkPressed: { color: color.primaryPressed },
  dismiss: { marginTop: -space.md, marginRight: -space.md },
});
