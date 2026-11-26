import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { uuid } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Layout, Primary, QUOTE_ERROR, QuoteCard, overBudget, styles, useAnnounce } from '@/components/approval';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/skeleton';
import { Surface } from '@/components/ui/surface';
import { toast } from '@/components/ui/toast';
import { color, radius } from '@/design/tokens';
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
            <ErrorState
              icon="warning"
              title="Couldn't load"
              body={LOAD_ERROR}
              action={{
                label: 'Try again',
                onPress: () => {
                  worlds.refetch();
                  detail.refetch();
                },
              }}
              style={styles.section}
            />
          </View>
        ) : (
          <View style={styles.content}>
            <View accessible accessibilityLabel="Loading scan" accessibilityState={{ busy: true }} style={styles.section}>
              <Skeleton width="100%" height={120} radius={radius.lg} />
            </View>
          </View>
        )}
      </SafeAreaView>
    </ThemedView>
  );
}

function ReasonCard({ world }: { world: LibraryItem }) {
  const reason = failureText(world.failure_code, world.failure_stage, world.retryable === true);
  const guidance = failureGuidance(world.failure_stage, world.failure_code, world.charged, world.retryable === true);
  const charge = chargeLine(world.charged);
  return (
    <Surface
      tone="danger"
      padded
      accessible
      accessibilityLabel={`Failed, ${reason}. ${guidance}. ${charge}`}
      style={styles.section}>
      <View style={styles.check}>
        <Icon name="warning" color={color.danger} />
        <ThemedText type="bodyStrong" tone="danger" style={styles.flex}>
          {`Failed · ${reason}`}
        </ThemedText>
      </View>
      <ThemedText type="body" style={styles.gap}>
        {guidance}
      </ThemedText>
      <ThemedText type="caption" tone="muted" style={styles.gap}>
        {charge}
      </ThemedText>
    </Surface>
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
      toast.success('Retry started'); // the toast announces and owns the haptic (§9.3, §10)
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
      titleType="heading"
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
          <Button variant="ghost" label={closed ? 'Close' : 'Cancel'} disabled={retry.isPending} onPress={close} />
        </>
      }>
      <ReasonCard world={world} />
      <QuoteCard quote={quote} noun="retry" />
      {error && (
        <View accessibilityLiveRegion="polite" style={[styles.check, styles.section]}>
          <Icon name="warning" color={color.danger} />
          <ThemedText type="label" tone="danger" style={styles.flex}>
            {error}
          </ThemedText>
        </View>
      )}
      <ThemedText type="caption" tone="muted" style={styles.section}>
        This is a new paid run. Nothing is charged until you approve.
      </ThemedText>
    </Layout>
  );
}

function NotRetryable({ world }: { world: LibraryItem }) {
  return (
    <Layout
      title="Scan failed"
      titleType="heading"
      actions={
        <>
          <Primary label="Scan again" disabled={false} onPress={() => router.replace('/capture/prep')} />
          <Button variant="ghost" label="Close" onPress={close} />
        </>
      }>
      <ReasonCard world={world} />
    </Layout>
  );
}
