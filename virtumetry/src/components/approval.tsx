import type { UseQueryResult } from '@tanstack/react-query';
import { useNetworkState } from 'expo-network';
import { useEffect, type ReactNode } from 'react';
import { AccessibilityInfo, Platform, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { formatUsd } from '@/capture/cost';
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
  actions: ReactNode;
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
      <View style={styles.actions}>{actions}</View>
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

/** Non-pressable stat row: label muted, value as a tabular readout. */
export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <ThemedText type="label" tone="muted" style={styles.flex}>
        {label}
      </ThemedText>
      <ThemedText type="readout" style={styles.tabular}>
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

/** Quote card (§7.7): skeleton while pending, offline / error + Try again, or cost + budget left + over-budget line. */
export function QuoteCard({ quote, noun }: { quote: UseQueryResult<Quote>; noun: 'scan' | 'retry' }) {
  const network = useNetworkState();
  const data = quote.data;
  const over = overBudget(data, noun);
  const offline = !data && network.isInternetReachable === false;
  const eyebrow = (
    <ThemedText type="eyebrow" tone="muted">
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
            <ThemedText type="readoutLarge" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={styles.amount}>
              {`~${data.credits.toLocaleString('en-US')}`}
              <ThemedText type="body"> credits</ThemedText>
            </ThemedText>
            <ThemedText type="body" tone="muted" style={styles.usd}>
              {`About ${formatUsd(data.usd)}`}
            </ThemedText>
            <ThemedText type="label" tone="muted" style={[styles.left, styles.tabular]}>
              {`${data.budgetRemaining.toLocaleString('en-US')} credits left ${data.budgetWindow === 'monthly' ? 'this month' : 'today'}`}
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
  stat: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 52, paddingHorizontal: space.lg },
  actions: {
    padding: layout.gutter,
    gap: space.sm,
    backgroundColor: color.bg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.hairline,
  },
  retry: { marginTop: space.md },
  tabular: { fontVariant: ['tabular-nums'] },
});
