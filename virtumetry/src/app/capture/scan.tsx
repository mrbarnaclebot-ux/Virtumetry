import { Directory, File, Paths } from 'expo-file-system';
import { Image } from 'expo-image';
import { useKeepAwake } from 'expo-keep-awake';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCaptureConfig } from '@/capture/capture-config';
import { costFor, formatUsd } from '@/capture/cost';
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
import { focusRing } from '@/components/ui/button';
import { CoachMark, dismissCoach } from '@/components/ui/coach-mark';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { toast } from '@/components/ui/toast';

import { haptic } from '@/design/haptics';
import { ease, useReduceMotion } from '@/design/motion';
import { color, minTarget, motion, radius, space } from '@/design/tokens';

// Always dark (camera UI convention), light status bar. HUD text caps at 1.3 (UI-SPEC §1.3, §7.5).
const HUD = 1.3;
const MAP = 152;
const BUZZ_GAP_MS = 2000;
const COACH_TEXT = 'Walk until the ring fills. Stop at Good to finish.';

const SCENARIOS: { label: string; id: FixtureScenario }[] = [
  { label: 'Good', id: 'good' },
  { label: 'Too few', id: 'too-few' },
  { label: 'Gap', id: 'tracking-gap' },
  { label: 'Jump', id: 'pose-jump' },
];
const ALL_SCENARIOS = SCENARIOS.map((s) => s.id);

type Phase = 'idle' | 'starting' | 'recording' | 'stopping';
type Rect = { x: number; y: number; width: number; height: number };

const close = () => router.back();
const mss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** HUD text: token typography capped at 1.3. */
function T(props: ThemedTextProps) {
  return <ThemedText maxFontSizeMultiplier={HUD} {...props} />;
}

/** UI-SPEC §7.5 shutter: 72 pt ring; press scales 0.94 over 120 ms (none with Reduce Motion). */
function Shutter({ phase, onPress }: { phase: Phase; onPress: () => void }) {
  const reduce = useReduceMotion();
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  const to = (v: number) => {
    if (!reduce) scale.set(withTiming(v, { duration: motion.duration.press, easing: ease.outQuart }));
  };
  const stopping = phase === 'recording' || phase === 'stopping';
  const busy = phase === 'starting' || phase === 'stopping';
  return (
    <View style={styles.action}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={stopping ? 'Stop scan' : 'Start scan'}
        accessibilityState={{ busy, disabled: busy }}
        disabled={busy}
        onPressIn={() => to(0.94)}
        onPressOut={() => to(1)}
        onPress={onPress}
        style={focusRing}>
        <Animated.View style={[styles.shutter, anim]}>
          {busy ? (
            <ActivityIndicator size="small" color={color.text} />
          ) : (
            <View style={stopping ? styles.stopSquare : styles.disk} />
          )}
        </Animated.View>
      </Pressable>
      <T type="label" style={styles.shutterLabel}>
        {stopping ? 'Stop' : 'Start scan'}
      </T>
    </View>
  );
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
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const [phase, setPhase] = useState<Phase>('idle');
  const [frames, setFrames] = useState<KeyframeEvent[]>([]);
  const [preview, setPreview] = useState<string | null>(null);
  const [scenario, setScenario] = useState<FixtureScenario>('good');
  const [elapsed, setElapsed] = useState(0);
  const [mapRect, setMapRect] = useState<Rect | null>(null);
  const mapRef = useRef<ComponentRef<typeof View>>(null);
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

  // §10: success on reaching Good to finish; warning on a drop to Keep scanning. At most once per 2 s.
  const lastLevel = useRef(ready.level);
  const lastBuzz = useRef(0);
  useEffect(() => {
    const prev = lastLevel.current;
    lastLevel.current = ready.level;
    if (prev === ready.level || Date.now() - lastBuzz.current < BUZZ_GAP_MS) return;
    if (ready.level === 'green') haptic.success();
    else if (ready.level === 'red' && (prev === 'green' || prev === 'amber')) haptic.warning();
    else return;
    lastBuzz.current = Date.now();
  }, [ready.level]);

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
      toast.error("Couldn't start the scan. Try again."); // the toast owns the error haptic
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

  function onShutter() {
    haptic.medium();
    if (recording) return void stop();
    dismissCoach('capture-prep'); // §8.2: pressing Start also marks the coach seen
    void start();
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
  // Until measureInWindow reports, estimate the map from the layout constants below.
  const anchor = mapRect ?? {
    x: win.width - space.lg - MAP,
    y: insets.top + minTarget + space.lg + (fixture ? 76 : 0),
    width: MAP,
    height: MAP,
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View accessible={false} style={[StyleSheet.absoluteFill, styles.preview]}>
        {preview ? (
          <Image source={{ uri: preview }} style={StyleSheet.absoluteFill} contentFit="cover" transition={0} />
        ) : (
          fixture && (
            <T type="label" tone="muted" style={styles.placeholder}>
              Test capture. Photos appear here when you start.
            </T>
          )
        )}
      </View>

      <View style={[styles.topBar, { paddingTop: insets.top }]}>
        <View style={styles.side}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel scan"
            onPress={cancel}
            style={(s) => [styles.topButton, s.pressed && styles.pressed, focusRing(s)]}>
            <T type="bodyStrong">Cancel</T>
          </Pressable>
        </View>
        {recording && (
          <T
            type="readout"
            accessibilityRole="timer"
            accessibilityLabel={`Elapsed ${Math.floor(elapsed / 60)} minutes ${elapsed % 60} seconds`}>
            {mss(elapsed)}
          </T>
        )}
        <View style={[styles.side, styles.right]}>
          {fixture && (
            <View style={styles.chip}>
              <T type="caption" tone="onSecondary">
                Test capture
              </T>
            </View>
          )}
        </View>
      </View>

      {fixture && (
        <View style={styles.scenarios}>
          <T type="label" tone="muted" style={styles.eyebrow}>
            Test scenario
          </T>
          <SegmentedControl
            variant="scrim"
            options={SCENARIOS}
            value={scenario}
            onChange={setScenario}
            disabled={phase === 'idle' ? [] : ALL_SCENARIOS}
            optionRole="button"
            accessibilityLabel="Test scenario"
            accessibilityLabelFor={(o) => `${o.label} scenario`}
          />
        </View>
      )}

      <View style={styles.mapRow}>
        <View
          ref={mapRef}
          onLayout={() =>
            mapRef.current?.measureInWindow((x, y, width, height) => {
              if (width > 0) setMapRect({ x, y, width, height });
            })
          }>
          <CoverageMap frames={frames} />
        </View>
      </View>

      <View style={styles.flex} />

      <View style={[styles.panel, { paddingBottom: space.lg + insets.bottom }]}>
        <ReadinessPill result={ready} scheme="dark" />
        <T
          type="readout"
          tone="muted"
          numberOfLines={1}
          accessibilityLabel={`${n === 1 ? '1 frame' : `${n} frames`}, estimated cost ${cost.usd.toFixed(2)} dollars`}
          style={styles.meter}>
          {`${n === 1 ? '1 frame' : `${n} frames`} · ~${formatUsd(cost.usd)}`}
        </T>
        <Shutter phase={phase} onPress={onShutter} />
      </View>

      <CoachMark
        id="capture-prep"
        text={COACH_TEXT}
        anchor={anchor}
        placement="below"
        visible={phase === 'idle'}
        onDismiss={() => {}}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  flex: { flex: 1 },
  preview: { backgroundColor: color.surface.raised, alignItems: 'center', justifyContent: 'center' },
  placeholder: { textAlign: 'center', paddingHorizontal: space.xl },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.lg, backgroundColor: color.scrim.hud },
  side: { flex: 1, height: minTarget, justifyContent: 'center', alignItems: 'flex-start' },
  right: { alignItems: 'flex-end' },
  topButton: {
    minHeight: minTarget,
    minWidth: minTarget,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    marginLeft: -space.sm,
    borderRadius: radius.md,
  },
  pressed: { backgroundColor: color.surface.pressed },
  chip: { backgroundColor: color.secondary, borderRadius: radius.pill, paddingVertical: space.xs, paddingHorizontal: space.md },
  scenarios: { marginTop: space.lg, marginHorizontal: space.lg },
  eyebrow: { marginBottom: space.sm },
  mapRow: { marginTop: space.lg, marginRight: space.lg, alignItems: 'flex-end' },
  panel: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, backgroundColor: color.scrim.hud },
  meter: { marginTop: space.md },
  action: { marginTop: space.xl, alignItems: 'center' },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: color.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disk: { width: 60, height: 60, borderRadius: 30, backgroundColor: color.primary },
  stopSquare: { width: 28, height: 28, borderRadius: 8, backgroundColor: color.danger },
  shutterLabel: { marginTop: space.sm },
});
