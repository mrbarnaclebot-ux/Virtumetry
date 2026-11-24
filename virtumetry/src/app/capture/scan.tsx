import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, View, type TextStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCaptureConfig } from '@/capture/capture-config';
import { costFor, formatCredits, formatUsd } from '@/capture/cost';
import { coverage } from '@/capture/coverage';
import type { FixtureScenario } from '@/capture/fixture-source';
import { precheck } from '@/capture/precheck';
import { readiness } from '@/capture/readiness';
import { getCaptureSource, isFixtureSource } from '@/capture/source';
import { addLocalScan } from '@/capture/store';
import type { KeyframeEvent, Session } from '@/capture/types';
import { CoverageMap } from '@/components/coverage-map';
import { ReadinessPill } from '@/components/readiness-pill';
import { ThemedText, type ThemedTextProps } from '@/components/themed-text';
import { Colors, Spacing } from '@/constants/theme';

// Always dark (camera UI convention): Colors.dark directly, light status bar (UI-SPEC §4).
const D = Colors.dark;
const SCRIM = 'rgba(0,0,0,0.6)';
const HUD = 1.3;

const SCENARIOS: { label: string; value: FixtureScenario }[] = [
  { label: 'Good', value: 'good' },
  { label: 'Too few', value: 'too-few' },
  { label: 'Gap', value: 'tracking-gap' },
  { label: 'Jump', value: 'pose-jump' },
];

type Phase = 'idle' | 'starting' | 'recording' | 'stopping';

const close = () => router.back();
const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** HUD text: ThemedText typography with dark-palette colors. */
function T({ color = D.text, style, ...rest }: ThemedTextProps & { color?: string }) {
  return <ThemedText maxFontSizeMultiplier={HUD} style={[{ color } as TextStyle, style]} {...rest} />;
}

function imageSize(dir: Directory) {
  try {
    const s = JSON.parse(new File(dir, 'session.json').textSync()) as Session;
    return { imageW: s.imageWidth, imageH: s.imageHeight };
  } catch {
    return { imageW: 640, imageH: 480 };
  }
}

export default function ScanScreen() {
  useKeepAwake();
  const src = getCaptureSource();
  const fixture = isFixtureSource(src);
  const cfg = useCaptureConfig();
  const [phase, setPhase] = useState<Phase>('idle');
  const [frames, setFrames] = useState<KeyframeEvent[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [scenario, setScenario] = useState<FixtureScenario>('good');
  const [elapsed, setElapsed] = useState(0);
  const dir = useRef<Directory | null>(null);
  /** A capture is running and not yet saved or discarded. */
  const live = useRef(false);

  // Leaving the screen any other way (unmount, reload, back) discards an unsaved capture (WR-05).
  useEffect(
    () => () => {
      if (live.current) void src.cancel();
    },
    [src],
  );

  // D-01: the HUD is fed by source events only.
  useEffect(() => {
    const sub = src.addListener('keyframe', (e) => {
      setFrames((f) => [...f, e]);
      if (dir.current) setPreview(new File(dir.current, e.file).uri);
    });
    return () => sub.remove();
  }, [src]);

  // The fixture source is a singleton that outlives this screen: sync it to what the UI
  // shows on mount too, not only on a tap (CR-04).
  useEffect(() => {
    if (isFixtureSource(src)) src.setScenario(scenario);
  }, [src, scenario]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  const cov = coverage(frames);
  const ready = readiness(frames, cov.seenCount, cfg.readiness);
  const cost = costFor(frames.length, cfg.pricing);
  const recording = phase === 'recording';
  const busy = phase === 'starting' || phase === 'stopping';

  const pickScenario = setScenario;

  async function start() {
    setPhase('starting');
    setFrames([]);
    setPreview(null);
    setElapsed(0);
    live.current = true;
    try {
      const { sessionId } = await src.start({});
      dir.current = new Directory(Paths.document, 'sessions', sessionId);
      setPhase('recording');
    } catch {
      live.current = false;
      setPhase('idle');
    }
  }

  async function discardAndClose() {
    live.current = false;
    await src.cancel();
    close();
  }

  // D-12/D-13: Stop saves on the phone first, then replaces into review.
  async function stop() {
    setPhase('stopping');
    const r = await src.stop();
    if (r.frameCount === 0) return discardAndClose();
    live.current = false;
    addLocalScan({
      id: r.sessionId,
      sessionId: r.sessionId,
      title: null,
      createdAt: new Date().toISOString(),
      dir: r.dir,
      frameCount: r.frameCount,
      durationS: frames.length ? frames[frames.length - 1].t - frames[0].t : 0,
      ...(dir.current ? imageSize(dir.current) : { imageW: 640, imageH: 480 }),
      readiness: ready.level,
      readinessReason: ready.reason,
      precheckIssues: precheck(frames, cov.seenCount, { ...cfg.precheck, maxFrames: cfg.limits.maxFrames }),
      uploadState: 'saved',
    });
    router.replace({ pathname: '/capture/[id]', params: { id: r.sessionId, step: 'review' } });
  }

  function cancel() {
    if (phase === 'idle') return close();
    if (frames.length === 0) return void discardAndClose();
    Alert.alert('Cancel scan?', `The ${frames.length} photos captured so far will be deleted.`, [
      { text: 'Keep scanning', style: 'cancel' },
      { text: 'Delete scan', style: 'destructive', onPress: () => void discardAndClose() },
    ]);
  }

  const n = frames.length;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View accessible={false} style={[StyleSheet.absoluteFill, styles.preview]}>
        {preview ? (
          <Image source={{ uri: preview }} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
        ) : (
          <T type="small" color={D.textSecondary}>
            Test capture ready
          </T>
        )}
      </View>

      <SafeAreaView style={styles.flex}>
        <View style={[styles.topBar, { backgroundColor: SCRIM }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel scan"
            onPress={cancel}
            style={({ pressed }) => [styles.topButton, pressed && styles.pressed]}>
            <T>Cancel</T>
          </Pressable>
          {recording && (
            <T
              type="smallBold"
              accessibilityRole="timer"
              accessibilityLabel={`Elapsed ${Math.floor(elapsed / 60)} minutes ${elapsed % 60} seconds`}
              style={styles.tabular}>
              {mss(elapsed)}
            </T>
          )}
          <View style={styles.topRight}>
            {fixture && (
              <View style={[styles.chip, { backgroundColor: D.backgroundElement }]}>
                <T type="small" color={D.textSecondary}>
                  Test capture
                </T>
              </View>
            )}
          </View>
        </View>

        {fixture && (
          <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: D.backgroundElement }]}>
            {SCENARIOS.map((s) => {
              const selected = s.value === scenario;
              return (
                <Pressable
                  key={s.value}
                  accessibilityRole="button"
                  accessibilityLabel={`${s.label} scenario`}
                  accessibilityState={{ selected, disabled: phase !== 'idle' }}
                  disabled={phase !== 'idle'}
                  hitSlop={4}
                  onPress={() => pickScenario(s.value)}
                  style={[
                    styles.segment,
                    selected && { backgroundColor: D.backgroundSelected },
                    phase !== 'idle' && styles.disabled,
                  ]}>
                  <T type="small" color={selected ? D.text : D.textSecondary}>
                    {s.label}
                  </T>
                </Pressable>
              );
            })}
          </View>
        )}

        <View style={styles.mapRow}>
          <CoverageMap frames={frames} />
        </View>

        <View style={styles.flex} />

        <View style={[styles.panel, { backgroundColor: SCRIM }]}>
          <ReadinessPill result={ready} scheme="dark" />
          <View style={styles.meterRow}>
            <T
              type="subtitle"
              accessibilityLabel={`Estimated cost ${cost.usd.toFixed(2)} dollars, ${cost.credits} credits`}
              style={styles.tabular}>
              {formatUsd(cost.usd)}
              <T type="small" color={D.textSecondary}>
                {` · ${formatCredits(cost.credits)}`}
              </T>
            </T>
            <T type="small" color={D.textSecondary} style={styles.tabular}>
              {n === 1 ? '1 frame' : `${n} frames`}
            </T>
          </View>
          <View style={styles.action}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={recording || phase === 'stopping' ? 'Stop scan' : 'Start scan'}
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              onPress={recording ? stop : start}
              style={({ pressed }) => [
                styles.shutter,
                recording || phase === 'stopping'
                  ? { borderWidth: 4, borderColor: D.text }
                  : { backgroundColor: D.accent },
                pressed && styles.pressed,
              ]}>
              {busy ? (
                <ActivityIndicator color={D.text} />
              ) : (
                recording && <View style={[styles.stopSquare, { backgroundColor: D.text }]} />
              )}
            </Pressable>
            <T type="small" style={styles.shutterLabel}>
              {recording || phase === 'stopping' ? 'Stop' : 'Start scan'}
            </T>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: D.background },
  flex: { flex: 1 },
  preview: { backgroundColor: D.backgroundElement, alignItems: 'center', justifyContent: 'center' },
  topBar: { height: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: Spacing.three },
  topButton: { minHeight: 44, minWidth: 44, justifyContent: 'center' },
  topRight: { minWidth: 44, alignItems: 'flex-end' },
  chip: { borderRadius: 12, paddingVertical: Spacing.one, paddingHorizontal: Spacing.two },
  segments: { marginTop: Spacing.three, marginHorizontal: Spacing.three, flexDirection: 'row', borderRadius: 12, padding: 2 },
  segment: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  mapRow: { marginTop: Spacing.three, marginRight: Spacing.three, alignItems: 'flex-end' },
  panel: { borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: Spacing.three },
  meterRow: { marginTop: Spacing.three, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  action: { marginTop: Spacing.four, alignItems: 'center' },
  shutter: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  stopSquare: { width: 28, height: 28, borderRadius: 8 },
  shutterLabel: { marginTop: Spacing.two },
  tabular: { fontVariant: ['tabular-nums'] },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
});
