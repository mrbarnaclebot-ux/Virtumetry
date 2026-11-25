import type { UseQueryResult } from '@tanstack/react-query';
import { SymbolView } from 'expo-symbols';
import { useEffect, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { formatCredits, formatUsd } from '@/capture/cost';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { Quote } from '@/lib/api';

// Shared approval UI (06-UI-SPEC reuse rule): capture Quote step and the retry sheet, one set of visuals.

export const QUOTE_ERROR = "Couldn't get a quote. Check your connection and try again.";

/** Polite live region + iOS announcement for errors and blocking headings. */
export function useAnnounce(text: string | null) {
  useEffect(() => {
    if (text && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

/** Scrolling content + pinned action area with a hairline top separator. */
export function Layout({ top, title, children, actions }: { top?: ReactNode; title: string; children: ReactNode; actions: ReactNode }) {
  const theme = useTheme();
  return (
    <>
      {top}
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type="title" accessibilityRole="header" maxFontSizeMultiplier={1.6} style={styles.title}>
          {title}
        </ThemedText>
        {children}
      </ScrollView>
      <View style={[styles.actions, { backgroundColor: theme.background, borderTopColor: theme.backgroundSelected }]}>
        {actions}
      </View>
    </>
  );
}

export function Primary({ label, disabled, busy, hint, onPress }: { label: string; disabled: boolean; busy?: boolean; hint?: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={disabled ? hint : undefined}
      accessibilityState={{ disabled: disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: theme.accent },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}>
      {busy ? (
        <ActivityIndicator color={theme.onAccent} />
      ) : (
        <ThemedText type="smallBold" themeColor="onAccent" maxFontSizeMultiplier={1.6}>
          {label}
        </ThemedText>
      )}
    </Pressable>
  );
}

export function Neutral({ label, onPress, style }: { label: string; onPress: () => void; style?: object }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.neutral, { backgroundColor: theme.backgroundSelected }, pressed && styles.pressed, style]}>
      <ThemedText type="smallBold" maxFontSizeMultiplier={1.6}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6}>
        {label}
      </ThemedText>
      <ThemedText type="smallBold" maxFontSizeMultiplier={1.6} style={styles.tabular}>
        {value}
      </ThemedText>
    </View>
  );
}

/** Over-budget sentence for a quote, or null when within budget. */
export function overBudget(data: Quote | undefined, noun: 'scan' | 'retry'): string | null {
  if (data?.withinBudget !== false) return null;
  return data.budgetWindow === 'monthly'
    ? `This ${noun} would go over this month's limit.`
    : `This ${noun} would go over today's limit. Try again tomorrow.`;
}

/** Quote card body: loading, error + Try again, or cost + budget left + over-budget line. */
export function QuoteCard({ quote, noun }: { quote: UseQueryResult<Quote>; noun: 'scan' | 'retry' }) {
  const theme = useTheme();
  const data = quote.data;
  const over = overBudget(data, noun);
  return (
    <ThemedView type="backgroundElement" style={[styles.card, styles.section]}>
      {quote.isPending ? (
        <View style={styles.check}>
          <ActivityIndicator color={theme.accent} />
          <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6}>
            Getting quote…
          </ThemedText>
        </View>
      ) : quote.isError ? (
        <View accessibilityLiveRegion="polite">
          <ThemedText type="small" themeColor="destructive" maxFontSizeMultiplier={1.6}>
            {QUOTE_ERROR}
          </ThemedText>
          <Neutral label="Try again" onPress={() => quote.refetch()} style={styles.retry} />
        </View>
      ) : (
        data && (
          <>
            <ThemedText maxFontSizeMultiplier={1.6}>
              {`This ${noun} will use `}
              <ThemedText type="subtitle" style={styles.tabular}>
                ~{formatCredits(data.credits)}
              </ThemedText>
              {` ≈ ${formatUsd(data.usd)}`}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={styles.gap}>
              {`${formatCredits(data.budgetRemaining)} left ${data.budgetWindow === 'monthly' ? 'this month' : 'today'}`}
            </ThemedText>
            {over && (
              <View style={[styles.check, styles.gap]}>
                <SymbolView name="exclamationmark.triangle.fill" size={20} tintColor={theme.warning} />
                <ThemedText type="small" themeColor="warning" maxFontSizeMultiplier={1.6} style={styles.flex}>
                  {over}
                </ThemedText>
              </View>
            )}
          </>
        )
      )}
    </ThemedView>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: Spacing.three,
    paddingBottom: Spacing.five,
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
  },
  title: { marginTop: Spacing.three },
  section: { marginTop: Spacing.four },
  gap: { marginTop: Spacing.two },
  card: { borderRadius: 12, padding: Spacing.three },
  stat: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  check: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  actions: { padding: Spacing.three, borderTopWidth: StyleSheet.hairlineWidth },
  button: { height: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  neutral: { minHeight: 52, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  retry: { marginTop: Spacing.three, minHeight: 44 },
  textButton: { marginTop: Spacing.three, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  tabular: { fontVariant: ['tabular-nums'] },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
