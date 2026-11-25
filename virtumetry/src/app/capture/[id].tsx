import { useMutation, useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCaptureConfig } from '@/capture/capture-config';
import { costFor, formatCost } from '@/capture/cost';
import { checkReason, serverReason } from '@/capture/precheck';
import { LABEL } from '@/capture/readiness';
import { discardLocalScan, getLocalScan, updateLocalScan, useLocalScan } from '@/capture/store';
import {
  Layout,
  Neutral,
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
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { toDisplayState, type LocalScan } from '@/library/display-state';
import { ApiError, createScan, getQuote } from '@/lib/api';
import { kickUploadManager, useUploadProgress } from '@/upload/manager';

// D-14..D-21: one route, three steps (review -> quote -> upload), system theme (UI-SPEC §5-§7).
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

// --- Review (D-14/D-15, UI-SPEC §5) ---

function Review({ scan, onUpload }: { scan: LocalScan; onUpload: () => void }) {
  const theme = useTheme();
  const cfg = useCaptureConfig();
  const issues = scan.precheckIssues ?? [];
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
          } catch {
            Alert.alert("Couldn't discard", 'Try again. If it keeps failing, restart the app.', [{ text: 'Back to Review' }]);
          }
        },
      },
    ]);

  const top = (
    <View style={styles.topBar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Library"
        onPress={close}
        style={({ pressed }) => [styles.topButton, pressed && styles.pressed]}>
        <ThemedText maxFontSizeMultiplier={1.6}>Library</ThemedText>
      </Pressable>
    </View>
  );

  return (
    <Layout
      top={top}
      title="Review scan"
      actions={
        <>
          <Primary
            label="Upload"
            disabled={issues.length > 0}
            hint={issues[0] && checkReason(issues[0])}
            onPress={onUpload}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard"
            onPress={discard}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
            <ThemedText type="smallBold" themeColor="destructive" maxFontSizeMultiplier={1.6}>
              Discard
            </ThemedText>
          </Pressable>
        </>
      }>
      <View style={styles.saved}>
        <SymbolView name="iphone" size={14} tintColor={theme.textSecondary} />
        <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6}>
          Saved on phone
        </ThemedText>
      </View>

      <ScrollView horizontal accessible={false} style={styles.section} contentContainerStyle={styles.strip}>
        {sample(scan.frameCount).map((i) => (
          <View key={i} accessible={false} style={[styles.thumb, { backgroundColor: theme.backgroundElement }]}>
            <Image
              source={{ uri: `${scan.dir}/frames/${String(i).padStart(6, '0')}.jpg` }}
              style={styles.thumb}
              contentFit="cover"
            />
          </View>
        ))}
      </ScrollView>

      <ThemedView type="backgroundElement" style={[styles.card, styles.section, styles.rows]}>
        <StatRow label="Frames" value={String(scan.frameCount)} />
        <StatRow label="Duration" value={mss(scan.durationS)} />
        <StatRow label="Estimated cost" value={formatCost(costFor(scan.frameCount, cfg.pricing))} />
      </ThemedView>

      <ThemedView type="backgroundElement" style={[styles.card, styles.section]}>
        <ReadinessPill result={readiness} scheme="system" />
        <View style={[styles.hairline, { backgroundColor: theme.backgroundSelected }]} />
        {issues.length === 0 ? (
          <View accessible accessibilityLabel="Checks passed" style={styles.check}>
            <SymbolView name="checkmark.circle.fill" size={20} tintColor={theme.accent} />
            <ThemedText type="smallBold" maxFontSizeMultiplier={1.6}>
              Checks passed
            </ThemedText>
          </View>
        ) : (
          <View style={styles.rows}>
            <ThemedText type="smallBold" themeColor="destructive" maxFontSizeMultiplier={1.6}>
              {"Didn't pass checks"}
            </ThemedText>
            {issues.map((issue) => (
              <View key={issue.code} accessible accessibilityLabel={`Failed check: ${checkReason(issue)}`} style={styles.check}>
                <SymbolView name="xmark.circle.fill" size={20} tintColor={theme.destructive} />
                <ThemedText type="small" maxFontSizeMultiplier={1.6} style={styles.flex}>
                  {checkReason(issue)}
                </ThemedText>
              </View>
            ))}
          </View>
        )}
      </ThemedView>
    </Layout>
  );
}

// --- Quote (D-18/D-19, UI-SPEC §6) ---

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
    onSuccess: onApproved,
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
            <ThemedText maxFontSizeMultiplier={1.6}>Back</ThemedText>
          </Pressable>
        </>
      }>
      <QuoteCard quote={quote} noun="scan" />
      {approve.isError && (
        <ThemedText
          type="small"
          themeColor="destructive"
          accessibilityLiveRegion="polite"
          maxFontSizeMultiplier={1.6}
          style={styles.section}>
          {APPROVE_ERROR}
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={styles.section}>
        {"Nothing is charged until you approve. If the scan fails checks, you're not charged."}
      </ThemedText>
    </Layout>
  );
}

// --- Upload (D-17/D-21, UI-SPEC §7) ---

function Upload({ scan }: { scan: LocalScan }) {
  const theme = useTheme();
  const live = useUploadProgress(scan.id) ?? scan.progress;
  const state = scan.uploadState;
  const blocked = state === 'blocked';
  const failed = state === 'failed';
  const failedLine = failed ? toDisplayState({ ...scan, local: true }, new Date()).statusLine : null;
  useAnnounce(blocked ? "Didn't pass checks" : failedLine);

  const actions = <Neutral label="Back to Library" onPress={close} />;

  if (blocked || failed) {
    return (
      <Layout title="Uploading" actions={actions}>
        <View accessibilityLiveRegion="polite" style={styles.blocked}>
          <View accessible={false}>
            <SymbolView name="xmark.circle.fill" size={48} tintColor={theme.destructive} />
          </View>
          <ThemedText type="subtitle" accessibilityRole="header" maxFontSizeMultiplier={1.6} style={styles.blockedHeading}>
            {blocked ? "Didn't pass checks" : failedLine}
          </ThemedText>
          {blocked && (
            <ThemedText maxFontSizeMultiplier={1.6} style={[styles.center, styles.gap]}>
              {serverReason(scan.failureCode ?? null)}
            </ThemedText>
          )}
          <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={styles.gap}>
            Not charged
          </ThemedText>
        </View>
      </Layout>
    );
  }

  const done = state === 'done';
  const pct = live && live.total > 0 ? Math.round((live.uploaded / live.total) * 100) : null;
  const status = done
    ? 'Uploaded · Processing started'
    : state === 'paused'
      ? 'Upload paused · Waiting for connection'
      : pct != null
        ? `Uploading · ${pct}%`
        : 'Uploading…';
  const fill = done ? 100 : pct;

  return (
    <Layout title="Uploading" actions={actions}>
      <View style={styles.section}>
        <ThemedText
          type="smallBold"
          themeColor={state === 'paused' ? 'textSecondary' : 'text'}
          maxFontSizeMultiplier={1.6}
          style={styles.tabular}>
          {status}
        </ThemedText>
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 0, max: 100, now: fill ?? 0 }}
          style={[styles.track, { backgroundColor: theme.backgroundElement }]}>
          {fill != null && <View style={[styles.fill, { width: `${fill}%`, backgroundColor: theme.accent }]} />}
        </View>
        {live && !done && (
          <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={[styles.gap, styles.tabular]}>
            {`${live.uploaded} of ${live.total} files`}
          </ThemedText>
        )}
      </View>
      <ThemedText type="small" themeColor="textSecondary" maxFontSizeMultiplier={1.6} style={styles.section}>
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
    topBar: { height: 44, justifyContent: 'center', paddingHorizontal: Spacing.three },
    topButton: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
    saved: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, marginTop: Spacing.two },
    strip: { gap: Spacing.two },
    thumb: { width: 64, height: 64, borderRadius: 8, overflow: 'hidden' },
    rows: { gap: Spacing.two },
    hairline: { height: StyleSheet.hairlineWidth, marginTop: Spacing.two, marginBottom: Spacing.three },
    track: { height: 4, borderRadius: 2, marginTop: Spacing.one, overflow: 'hidden' },
    fill: { height: 4, borderRadius: 2 },
    blocked: { alignItems: 'center', marginTop: Spacing.five },
    blockedHeading: { marginTop: Spacing.three, textAlign: 'center' },
    center: { textAlign: 'center' },
  }),
};
