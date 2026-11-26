import type { UseQueryResult } from '@tanstack/react-query';
import { useNetworkState } from 'expo-network';
import { useEffect, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { DEFAULT_CAPTURE_CONFIG } from '@/capture/capture-config';
import { formatCredits, formatUsd } from '@/capture/cost';
import { ThemedText } from '@/components/themed-text';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Surface } from '@/components/ui/surface';
import { color, layout, space } from '@/design/tokens';
import type { Quote } from '@/lib/api';

// Shared approval UI (06-UI-SPEC reuse rule, 06.1-UI-SPEC §5/§7.7): capture Quote step and the retry sheet.

export const QUOTE_ERROR = "Couldn't get a quote. Check your connection and try again.";
const QUOTE_OFFLINE = "You're offline. Connect to get a quote.";

/** Polite live region + iOS announcement for errors and blocking headings. */
export function useAnnounce(text: string | null) {
  useEffect(() => {
    if (text && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(text);
  }, [text]);
}

/** Scrolling body on bg + pinned action area with a hairline top separator. */
export function Layout({
  top,
  title,
  titleType = 'title',
  children,
  actions,
}: {
  top?: ReactNode;
  title: string;
  /** `heading` for sheet titles (retry sheet). */
  titleType?: 'title' | 'heading';
  children: ReactNode;
  /** Pinned bottom area; omitted when the step has no primary (upload in progress). */
  actions?: ReactNode;
}) {
  return (
    <>
      {top}
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedText type={titleType} accessibilityRole="header" style={styles.title}>
          {title}
        </ThemedText>
        {children}
      </ScrollView>
      {actions ? <View style={styles.actions}>{actions}</View> : null}
    </>
  );
}

/** Primary lg Button; the accessible name stays `label` while busy. */
export function Primary({ label, disabled, busy, hint, onPress }: { label: string; disabled: boolean; busy?: boolean; hint?: string; onPress: () => void }) {
  return <Button label={label} disabled={disabled} busy={busy} hint={hint} onPress={onPress} />;
}

export function Neutral({ label, onPress, style }: { label: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  return <Button variant="ghost" label={label} onPress={onPress} style={style} />;
}

/** Non-pressable stat row: label muted, value as a tabular readout, optional muted secondary readout under it. */
export function StatRow({ label, value, secondary }: { label: string; value: string; secondary?: string }) {
  return (
    <View style={styles.stat}>
      <ThemedText type="label" tone="muted" style={styles.flex}>
        {label}
      </ThemedText>
      <View style={styles.statValue}>
        <ThemedText type="readout" style={styles.tabular}>
          {value}
        </ThemedText>
        {secondary ? (
          <ThemedText type="readout" tone="muted" style={styles.tabular}>
            {secondary}
          </ThemedText>
        ) : null}
      </View>
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

/** The quote's own rate (USD first, critique R2 #7); the config rate when the quote is free. */
const usdPerCredit = (q: Quote) => (q.credits > 0 ? q.usd / q.credits : DEFAULT_CAPTURE_CONFIG.pricing.usdPerCredit);

/** Quote card (§7.7): skeleton while pending, offline / error + Try again, or cost + budget left + over-budget line. */
export function QuoteCard({ quote, noun }: { quote: UseQueryResult<Quote>; noun: 'scan' | 'retry' }) {
  const network = useNetworkState();
  const data = quote.data;
  const over = overBudget(data, noun);
  const offline = !data && network.isInternetReachable === false;
  const eyebrow = (
    <ThemedText type="caption" tone="muted" style={styles.strong}>
      {`This ${noun} will use`}
    </ThemedText>
  );
  const tryAgain = <Button variant="secondary" size="md" label="Try again" onPress={() => quote.refetch()} style={styles.retry} />;

  return (
    <Surface padded style={styles.section}>
      {offline ? (
        <View accessibilityLiveRegion="polite">
          <View style={styles.check}>
            <Icon name="offline" color={color.textMuted} />
            <ThemedText type="label" tone="muted" style={styles.flex}>
              {QUOTE_OFFLINE}
            </ThemedText>
          </View>
          {tryAgain}
        </View>
      ) : quote.isPending ? (
        <View accessible accessibilityLabel="Getting quote…" accessibilityState={{ busy: true }} style={styles.pending}>
          {eyebrow}
          <Skeleton width={160} height={32} />
          <Skeleton width={120} height={16} />
        </View>
      ) : quote.isError ? (
        <View accessibilityLiveRegion="polite">
          <View style={styles.check}>
            <Icon name="warning" color={color.danger} />
            <ThemedText type="label" tone="danger" style={styles.flex}>
              {QUOTE_ERROR}
            </ThemedText>
          </View>
          {tryAgain}
        </View>
      ) : (
        data && (
          <>
            {eyebrow}
            {/* One money grammar (critique R1 #4): USD primary, credits secondary, then budget left in one muted line. */}
            <ThemedText type="readoutLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={[styles.amount, styles.tabular]}>
              {`~${formatUsd(data.usd)}`}
            </ThemedText>
            <ThemedText type="readout" tone="muted" style={[styles.usd, styles.tabular]}>
              {formatCredits(data.credits)}
            </ThemedText>
            <ThemedText type="label" tone="muted" style={[styles.left, styles.tabular]}>
              {`~${formatUsd(data.budgetRemaining * usdPerCredit(data))} left ${data.budgetWindow === 'monthly' ? 'this month' : 'today'} · ${formatCredits(data.budgetRemaining)}`}
            </ThemedText>
            {over && (
              <View style={[styles.check, styles.gap]}>
                <Icon name="warning" color={color.warning} />
                <ThemedText type="label" tone="warning" style={styles.flex}>
                  {over}
                </ThemedText>
              </View>
            )}
          </>
        )
      )}
    </Surface>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: {
    paddingHorizontal: layout.gutter,
    paddingBottom: space.xxxl,
    width: '100%',
    maxWidth: layout.maxContent,
    alignSelf: 'center',
  },
  title: { marginTop: space.lg },
  section: { marginTop: space.xl },
  gap: { marginTop: space.sm },
  check: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pending: { gap: space.sm },
  amount: { marginTop: space.sm },
  usd: { marginTop: space.xs },
  left: { marginTop: space.md },
  stat: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52, paddingHorizontal: space.lg, paddingVertical: space.sm },
  statValue: { alignItems: 'flex-end' },
  actions: {
    padding: layout.gutter,
    gap: space.sm,
    backgroundColor: color.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  retry: { marginTop: space.md },
  tabular: { fontVariant: ['tabular-nums'] },
  strong: { fontWeight: '600' },

});
