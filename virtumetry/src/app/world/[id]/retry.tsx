import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuid } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Pressable, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Layout, Neutral, Primary, QUOTE_ERROR, QuoteCard, overBudget, styles, useAnnounce } from '@/components/approval';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useTheme } from '@/hooks/use-theme';
import { chargeLine, failureGuidance, failureText, type LibraryItem } from '@/library/display-state';
import { ApiError, getQuote, getWorld, retryWorld, useWorlds } from '@/lib/api';

const LOAD_ERROR = "Couldn't open this scan. Check your connection, then try again.";
const NOT_RETRYABLE = "This scan can't be retried anymore. Close this and check its status in your Library.";
const PRICE_CHANGED = 'The cost changed. Check the new quote, then approve again.';
const RATE_LIMITED = 'Too many tries. Wait a minute, then try again.';
const RETRY_ERROR = "Couldn't start the retry. Check your connection and try again.";

const close = () => router.back();

function retryError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'not_retryable') return NOT_RETRYABLE;
    if (e.code === 'approval_below_quote') return PRICE_CHANGED;
    if (e.status === 429) return RATE_LIMITED;
  }
  return RETRY_ERROR;
}

/** D-11 failure sheet (06-UI-SPEC §B/§C): fresh-quote retry when the server says retryable, else guidance. */
export default function RetrySheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const worlds = useWorlds();
  const cached = worlds.data?.worlds.find((w) => w.id === id);
  const detail = useQuery({
    queryKey: ['world', id],
    queryFn: () => getWorld(id),
    enabled: !cached && !worlds.isPending,
    retry: false,
  });
  const world = cached ?? detail.data?.world;

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView edges={['bottom']} style={styles.flex}>
        {world ? (
          world.retryable === true ? (
            <Retryable world={world} />
          ) : (
            <NotRetryable world={world} />
          )
        ) : detail.isError ? (
          <View style={styles.content} accessibilityLiveRegion="polite">
            <ThemedText type="small" themeColor="destructive" maxFontSizeMultiplier={1.6} style={styles.section}>
              {LOAD_ERROR}
            </ThemedText>
            <Neutral
              label="Try again"
              onPress={() => {
                worlds.refetch();
                detail.refetch();
              }}
              style={styles.retry}
            />
          </View>
        ) : (
          <ActivityIndicator color={theme.accent} style={styles.section} />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

function ReasonCard({ world }: { world: LibraryItem }) {
  const theme = useTheme();
  const reason = failureText(world.failure_code, world.failure_stage, world.retryable === true);
  const guidance = failureGuidance(world.failure_stage, world.failure_code, world.charged, world.retryable === true);
  const charge = chargeLine(world.charged);
  return (
    <ThemedView
      type="backgroundElement"
      accessible
      accessibilityLabel={`Failed, ${reason}. ${guidance}. ${charge}`}
      style={[styles.card, styles.section]}>
      <View style={styles.check}>
        <SymbolView name="exclamationmark.triangle.fill" size={20} tintColor={theme.destructive} />
        <ThemedText type="smallBold" themeColor="destructive" maxFontSizeMultiplier={1.6} style={styles.flex}>
          {`Failed · ${reason}`}
        </ThemedText>
      </View>
      <ThemedText maxFontSizeMultiplier={1.6} style={styles.gap}>
        {guidance}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={styles.gap}>
        {charge}
      </ThemedText>
    </ThemedView>
  );
}

function TextButton({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.textButton, disabled && styles.disabled, pressed && styles.pressed]}>
      <ThemedText maxFontSizeMultiplier={1.6}>{label}</ThemedText>
    </Pressable>
  );
}

function Retryable({ world }: { world: LibraryItem }) {
  const qc = useQueryClient();
  // One key per sheet open, reused on every press: a lost response replays the same retry (T-06-11).
  const [key] = useState(() => uuid.v4());
  const [closed, setClosed] = useState(false);
  // Never cached: budget and price change (T-06-12).
  const quote = useQuery({
    queryKey: ['quote', 'retry', world.id],
    queryFn: () => getQuote(world.frame_count!),
    enabled: !!world.frame_count,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const retry = useMutation({
    mutationFn: (credits: number) => retryWorld(world.id, credits, key),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['worlds'] });
      AccessibilityInfo.announceForAccessibility('Retry started');
      close();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'approval_below_quote') quote.refetch();
      if (e instanceof ApiError && e.code === 'not_retryable') {
        setClosed(true);
        qc.invalidateQueries({ queryKey: ['worlds'] });
      }
    },
  });

  const data = quote.data;
  const over = overBudget(data, 'retry');
  const error = retry.isError ? retryError(retry.error) : null;
  useAnnounce(quote.isError ? QUOTE_ERROR : error);

  return (
    <Layout
      title="Retry processing"
      actions={
        <>
          {!closed && (
            <Primary
              label="Approve and retry"
              disabled={!(data?.withinBudget === true)}
              busy={retry.isPending}
              hint={over ?? undefined}
              onPress={() => data && retry.mutate(data.credits)}
            />
          )}
          <TextButton label={closed ? 'Close' : 'Cancel'} disabled={retry.isPending} onPress={close} />
        </>
      }>
      <ReasonCard world={world} />
      <QuoteCard quote={quote} noun="retry" />
      {error && (
        <ThemedText
          type="small"
          themeColor="destructive"
          accessibilityLiveRegion="polite"
          maxFontSizeMultiplier={1.6}
          style={styles.section}>
          {error}
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={styles.section}>
        This is a new paid run. Nothing is charged until you approve.
      </ThemedText>
    </Layout>
  );
}

function NotRetryable({ world }: { world: LibraryItem }) {
  return (
    <Layout
      title="Scan failed"
      actions={
        <>
          <Primary label="Scan again" disabled={false} onPress={() => router.replace('/capture/prep')} />
          <TextButton label="Close" onPress={close} />
        </>
      }>
      <ReasonCard world={world} />
    </Layout>
  );
}
