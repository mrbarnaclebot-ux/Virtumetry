import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { color, radius, space } from '@/design/tokens';

type Action = { label: string; onPress: () => void; icon?: IconName };

type EmptyProps = {
  /** Illustration; shown in a radius-xl panel. Omit for the compact variant. */
  art?: ReactNode;
  /** Compact variant: small leading icon (24, muted) above the title. */
  icon?: IconName;
  title: string;
  body: string;
  steps?: string[];
  action?: Action;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** UI-SPEC §5 / §7.2: first-run and "nothing here yet" states. */
export function EmptyState({ art, icon, title, body, steps, action, compact = false, style, testID }: EmptyProps) {
  return (
    <View testID={testID} style={[compact ? styles.compact : styles.full, style]}>
      {art != null && !compact && <View style={styles.art}>{art}</View>}
      {icon && <Icon name={icon} size={24} color={color.textMuted} />}
      <ThemedText type={compact ? 'bodyStrong' : 'heading'} accessibilityRole="header">
        {title}
      </ThemedText>
      <ThemedText type={compact ? 'label' : 'body'} tone="muted">
        {body}
      </ThemedText>
      {steps && steps.length > 0 && (
        <View style={styles.steps}>
          {steps.map((step, i) => (
            <View key={step} style={styles.step}>
              <ThemedText type="label" tone="muted" style={styles.numeral}>
                {`${i + 1}.`}
              </ThemedText>
              <ThemedText type="body" style={styles.stepText}>
                {step}
              </ThemedText>
            </View>
          ))}
        </View>
      )}
      {action && <Button label={action.label} icon={action.icon} onPress={action.onPress} style={styles.cta} />}
    </View>
  );
}

type ErrorProps = {
  icon: IconName;
  title: string;
  body: string;
  /** Secondary button (e.g. "Try again"). */
  action?: { label: string; onPress: () => void };
  tone?: 'neutral' | 'danger';
  /** maxFontSizeMultiplier for world/viewer contexts (1.3). */
  cap?: number;
  /** Extra actions or captions under the main action. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** UI-SPEC §5: load failures, offline, blocked. Copy is caller-supplied fixed text, never raw server errors. */
export function ErrorState({ icon, title, body, action, tone = 'neutral', cap, children, style, testID }: ErrorProps) {
  return (
    <View testID={testID} style={[styles.error, style]}>
      <Icon name={icon} size={48} color={tone === 'danger' ? color.danger : color.textMuted} />
      <ThemedText type="heading" accessibilityRole="header" maxFontSizeMultiplier={cap} style={styles.center}>
        {title}
      </ThemedText>
      <ThemedText type="body" tone="muted" maxFontSizeMultiplier={cap} style={styles.center}>
        {body}
      </ThemedText>
      {action && <Button variant="secondary" label={action.label} onPress={action.onPress} style={styles.errorAction} />}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  full: { gap: space.sm },
  compact: { gap: space.xs, alignItems: 'flex-start' },
  art: { borderRadius: radius.xl, overflow: 'hidden', marginBottom: space.xl },
  steps: { gap: space.md, marginTop: space.xl },
  step: { flexDirection: 'row', alignItems: 'baseline', gap: space.md },
  numeral: { width: space.xl },
  stepText: { flex: 1 },
  cta: { marginTop: space.xxxl },
  error: { alignItems: 'center', gap: space.md, paddingHorizontal: space.xl },
  center: { textAlign: 'center' },
  errorAction: { marginTop: space.md, alignSelf: 'stretch' },
});
