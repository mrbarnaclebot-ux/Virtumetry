import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCaptureConfig } from '@/capture/capture-config';
import { costFor, formatCost } from '@/capture/cost';
import { checkReason, serverReason } from '@/capture/precheck';
import { LABEL } from '@/capture/readiness';
import { discardLocalScan, getLocalScan, updateLocalScan, useLocalScan } from '@/capture/store';
import {
  Layout,
  overBudget,
  Primary,
  QUOTE_ERROR,
  QuoteCard,
  StatRow,
  styles as shared,
  useAnnounce,
} from '@/components/approval';
import { ReadinessPill } from '@/components/readiness-pill';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/empty-state';
import { Icon, type IconName } from '@/components/ui/icon';
import { Group } from '@/components/ui/list-row';
import { ProgressBar } from '@/components/ui/progress-bar';
import { StatusPill } from '@/components/ui/status-pill';
import { toast } from '@/components/ui/toast';
import { haptic } from '@/design/haptics';
import { color, radius, space } from '@/design/tokens';
import { toDisplayState, type LocalScan } from '@/library/display-state';
import { ApiError, createScan, getQuote } from '@/lib/api';
import { kickUploadManager, useUploadProgress } from '@/upload/manager';

// D-14..D-21: one route, three steps (review -> quote -> upload) (06.1-UI-SPEC §7.6-§7.8).
type Step = 'review' | 'quote' | 'upload';

const close = () => router.back();
const mss = (sec: number) => {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Up to 5 evenly sampled frame numbers, first to last. */
function sample(n: number, k = 5): number[] {
  if (n <= 0) return [];
  if (n <= k) return Array.from({ length: n }, (_, i) => i + 1);
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)) + 1);
}

export default function CaptureScreen() {
  const { id, step: initial } = useLocalSearchParams<{ id: string; step?: Step }>();
  const scan = useLocalScan(id);
  const [step, setStep] = useState<Step>(
    initial ?? (scan && scan.uploadState !== 'saved' ? 'upload' : 'review'),
  );

  // Missing (or just discarded) scan: back to the Library.
  useEffect(() => {
    if (!scan) close();
  }, [scan]);
  if (!scan) return null;

  return (
    <ThemedView style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        {step === 'review' && <Review scan={scan} onUpload={() => setStep('quote')} />}
        {step === 'quote' && (
          <Quote scan={scan} onBack={() => setStep('review')} onApproved={() => setStep('upload')} />
        )}
        {step === 'upload' && <Upload scan={scan} />}
      </SafeAreaView>
    </ThemedView>
  );
}

// --- Review (D-14/D-15, §7.6) ---

function Review({ scan, onUpload }: { scan: LocalScan; onUpload: () => void }) {
  const cfg = useCaptureConfig();
  const issues = scan.precheckIssues ?? [];
  const firstIssue = issues[0] && checkReason(issues[0]);
  const level = scan.readiness ?? 'idle';
  const readiness = {
    level,
    signal: null,
    label: level === 'idle' ? 'Ready to scan' : LABEL[level],
    reason: scan.readinessReason ?? '',
  };

  const discard = () =>
    Alert.alert('Discard this scan?', `This deletes its ${scan.frameCount} photos from your phone. You can't undo this.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: () => {
          try {
            discardLocalScan(scan.id); // the missing-scan effect closes the screen
            toast.success('Scan discarded');
          } catch {
            toast.error("Couldn't discard. Try again.");
          }
        },
      },
    ]);

  const top = (
    <View style={styles.topBar}>
      <Button variant="ghost" size="md" icon="back" label="Library" onPress={close} style={styles.topButton} />
    </View>
  );

  return (
    <Layout
      top={top}
      title="Review scan"
      actions={
        <>
          <Primary label="Upload" disabled={issues.length > 0} hint={firstIssue} onPress={onUpload} />
          {firstIssue && (
            <ThemedText type="caption" tone="muted" style={styles.center}>
              {firstIssue}
            </ThemedText>
          )}
          <Button variant="destructive" label="Discard" onPress={discard} />
        </>
      }>
      <View style={styles.saved}>
        <StatusPill kind="saved_on_phone" label="Saved on phone" />
      </View>

      <ScrollView horizontal accessible={false} style={styles.section} contentContainerStyle={styles.strip}>
        {sample(scan.frameCount).map((i) => (
          <View key={i} accessible={false} style={styles.thumb}>
            <Image
              source={{ uri: `${scan.dir}/frames/${String(i).padStart(6, '0')}.jpg` }}
              style={styles.thumb}
              contentFit="cover"
            />
          </View>
        ))}
      </ScrollView>

      <View style={styles.section}>
        <Group>
          <StatRow label="Frames" value={String(scan.frameCount)} />
          <StatRow label="Duration" value={mss(scan.durationS)} />
          <StatRow label="Estimated cost" value={formatCost(costFor(scan.frameCount, cfg.pricing))} />
        </Group>
      </View>

      <View style={styles.section}>
        <Group>
          <View style={styles.cell}>
            <ReadinessPill result={readiness} scheme="system" />
          </View>
          {issues.length === 0 ? (
            <View accessible accessibilityLabel="Checks passed" style={[styles.cell, shared.check]}>
              <Icon name="ready" color={color.success} />
              <ThemedText type="bodyStrong">Checks passed</ThemedText>
            </View>
          ) : (
            <View style={[styles.cell, styles.rows]}>
              <ThemedText type="bodyStrong" tone="danger">
                {"Didn't pass checks"}
              </ThemedText>
              {issues.map((issue) => (
                <View key={issue.code} accessible accessibilityLabel={`Failed check: ${checkReason(issue)}`} style={shared.check}>
                  <Icon name="failedCheck" color={color.danger} />
                  <ThemedText type="label" style={styles.flex}>
                    {checkReason(issue)}
                  </ThemedText>
                </View>
              ))}
            </View>
          )}
        </Group>
      </View>
    </Layout>
  );
}

// --- Quote (D-18/D-19, §7.7) ---

const APPROVE_ERROR = "Couldn't start the upload. Check your connection and try again.";

function Quote({ scan, onBack, onApproved }: { scan: LocalScan; onBack: () => void; onApproved: () => void }) {
  // Fetched on entering the step, never cached across visits (budget changes).
  const quote = useQuery({
    queryKey: ['quote', scan.id],
    queryFn: () => getQuote(scan.frameCount),
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });
  const data = quote.data;

  // D-19: the only path that creates a billable scan. The approval is persisted first
  // ('approved'), so a lost response or force-quit leaves the manager to finish the
  // idempotent create (WR-02). Only a definite refusal (4xx) puts the scan back to saved.
  const approve = useMutation({
    mutationFn: async (credits: number) => {
      updateLocalScan(scan.id, { approvedMaxCredits: credits, uploadState: 'approved' });
      try {
        const { world } = await createScan({ ...scan, approvedMaxCredits: credits });
        updateLocalScan(scan.id, { serverWorldId: world.id, uploadState: 'uploading' });
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
          // A manager pass may have created the world meanwhile: never revert past a server id (iter-2 WR-02).
          if (!getLocalScan(scan.id)?.serverWorldId) updateLocalScan(scan.id, { uploadState: 'saved' });
          throw e;
        }
        // Network error or 5xx: the outcome is unknown; the manager retries with the same key.
      }
      kickUploadManager();
    },
    onSuccess: () => {
      haptic.success();
      onApproved();
    },
    onError: () => haptic.error(),
  });

  const over = overBudget(data, 'scan');
  const error = quote.isError ? QUOTE_ERROR : approve.isError ? APPROVE_ERROR : null;
  useAnnounce(error);

  return (
    <Layout
      title="Approve processing"
      actions={
        <>
          <Primary
            label="Approve & process"
            disabled={!(data?.withinBudget === true)}
            busy={approve.isPending}
            hint={over ?? undefined}
            onPress={() => data && approve.mutate(data.credits)}
          />
          <Button variant="ghost" label="Back" onPress={onBack} />
        </>
      }>
      <QuoteCard quote={quote} noun="scan" />
      {approve.isError && (
        <View accessibilityLiveRegion="polite" style={[shared.check, styles.section]}>
          <Icon name="warning" color={color.danger} />
          <ThemedText type="label" tone="danger" style={styles.flex}>
            {APPROVE_ERROR}
          </ThemedText>
        </View>
      )}
      <ThemedText type="caption" tone="muted" style={styles.section}>
        {"Nothing is charged until you approve. If the scan fails checks, you're not charged."}
      </ThemedText>
    </Layout>
  );
}

// --- Upload (D-17/D-21, §7.8) ---

function Upload({ scan }: { scan: LocalScan }) {
  const live = useUploadProgress(scan.id) ?? scan.progress;
  const state = scan.uploadState;
  const blocked = state === 'blocked';
  const failed = state === 'failed';
  const failedLine = failed ? toDisplayState({ ...scan, local: true }, new Date()).statusLine : null;
  useAnnounce(blocked ? "Didn't pass checks" : failedLine);

  const actions = <Button variant="secondary" label="Back to Library" onPress={close} />;

  if (blocked || failed) {
    return (
      <Layout title="Uploading" actions={actions}>
        <View accessibilityLiveRegion="polite" style={styles.blocked}>
          <ErrorState
            tone="danger"
            icon="failedCheck"
            title={blocked ? "Didn't pass checks" : (failedLine ?? '')}
            body={blocked ? serverReason(scan.failureCode ?? null) : ''}>
            <ThemedText type="caption" tone="muted">
              Not charged
            </ThemedText>
          </ErrorState>
        </View>
      </Layout>
    );
  }

  const done = state === 'done';
  const paused = state === 'paused';
  const pct = live && live.total > 0 ? Math.round((live.uploaded / live.total) * 100) : null;
  const status = done
    ? 'Uploaded · Processing started'
    : paused
      ? 'Upload paused · Waiting for connection'
      : pct != null
        ? `Uploading · ${pct}%`
        : 'Uploading…';
  // Paused with no known count keeps an empty track rather than a moving bar.
  const value = done ? 100 : pct ?? (paused ? 0 : null);
  const lead: { icon: IconName; tint: string } = done
    ? { icon: 'ready', tint: color.success }
    : paused
      ? { icon: 'offline', tint: color.textMuted }
      : { icon: 'uploading', tint: color.textMuted };

  return (
    <Layout title="Uploading" actions={actions}>
      <View style={styles.section}>
        <View style={shared.check}>
          <Icon name={lead.icon} color={lead.tint} hierarchical />
          <ThemedText type="bodyStrong" tone={paused ? 'muted' : 'text'} style={[styles.flex, shared.tabular]}>
            {status}
          </ThemedText>
        </View>
        <ProgressBar testID="upload-progress" value={value} height={6} tone={done ? 'success' : 'accent'} style={styles.bar} />
        {live && !done && (
          <ThemedText type="readout" tone="muted" style={styles.files}>
            {`${live.uploaded} of ${live.total} files`}
          </ThemedText>
        )}
      </View>
      <ThemedText type="body" tone="muted" style={styles.section}>
        {done
          ? "You'll see progress in your library."
          : 'You can close this screen. The upload picks up where it left off when you open the app again.'}
      </ThemedText>
    </Layout>
  );
}

// Screen-only styles on top of the shared approval styles.
const styles = {
  ...shared,
  ...StyleSheet.create({
    topBar: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
    topButton: { alignSelf: 'flex-start' },
    saved: { marginTop: space.sm },
    strip: { gap: space.sm },
    thumb: { width: 64, height: 64, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: color.surface.raised },
    cell: { paddingHorizontal: space.lg, paddingVertical: space.md },
    rows: { gap: space.sm },
    bar: { marginTop: space.md },
    files: { marginTop: space.sm },
    blocked: { marginTop: space.xxxl },
    center: { textAlign: 'center' },
  }),
};
