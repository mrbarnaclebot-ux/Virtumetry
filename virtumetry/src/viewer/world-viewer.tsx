'use dom';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { createEngine, resolveStartPose, type Engine, type Mode } from './engine';
import { hasFloorplan, headingAngle, pixelFromWorld, tapToPixel, worldFromPixel } from './floorplan';
import { announceDistance, distance, formatDistance, isTap, type Vec3 } from './measure';
import { fetchWithProgress } from './progress';
import { VT } from './tokens';
import type { ViewerProps } from './types';

type Load = { stage: 'download'; percent: number | null } | { stage: 'prepare' } | { stage: 'ready' } | { stage: 'error' };

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HINT_MS = 6000;
const DISABLED_HINT_MS = 4000;
const JOY_TRAVEL = 32; // px
const LOOK_RAD_PER_PX = 0.005; // ponytail: one sensitivity for touch and mouse; tune on device
const NO_GEOMETRY = "Walking and measuring need room geometry. This scan doesn't have it.";
const ORBIT_HINT = ['Drag to orbit · Pinch to zoom', 'Drag to orbit · Scroll to zoom · Right-drag to pan'] as const;
const MODES: { id: Mode; label: string }[] = [
  { id: 'orbit', label: 'Orbit' },
  { id: 'walk', label: 'Walk' },
  { id: 'measure', label: 'Measure' },
];
type Dir = 'f' | 'b' | 'l' | 'r';
const KEYS: Record<string, Dir> = {
  KeyW: 'f',
  ArrowUp: 'f',
  KeyS: 'b',
  ArrowDown: 'b',
  KeyA: 'l',
  ArrowLeft: 'l',
  KeyD: 'r',
  ArrowRight: 'r',
};
const STILL = { moveX: 0, moveZ: 0, sprint: false };

type Hint = { text: string; ms: number | null } | null;
type Joy = { x: number; y: number; kx: number; ky: number } | null;
type Ptr = { kind: 'joy' | 'look'; x0: number; y0: number; x: number; y: number };
const PROGRESS_MS = 100; // UI-SPEC: percent text and onProgress at most 10 Hz
const POSE_MS = 500; // T-05-23: onPose at most 2 Hz, only on change
const LOST_MS = 5000; // D-13a: context not restored in 5 s -> native/web layer takes over

const media = (q: string) => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches;

/** D-04 viewer: one DOM component, same code in the app WebView and on the web share page. */
export default function WorldViewer(props: ViewerProps) {
  const { splatUrl, title, insets } = props;
  // Every prop change re-renders this tree: the engine reads callbacks/other props through a ref, never recreates.
  const propsRef = useRef(props);
  useLayoutEffect(() => {
    propsRef.current = props;
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ stage: 'download', percent: null });
  const [hint, setHint] = useState<Hint>(null);
  const [reducedMotion] = useState(() => media('(prefers-reduced-motion: reduce)'));
  const [coarse] = useState(() => media('(pointer: coarse)'));
  const t = (touch: string, desktop: string) => (coarse ? touch : desktop);
  const [hasCollider, setHasCollider] = useState(false);
  const [mode, setMode] = useState<Mode>('orbit');
  const seenWalk = useRef(false);
  // Measure (D-12): points live in a ref and are re-projected every frame straight into the DOM.
  const pointsRef = useRef<Vec3[]>([]);
  const [pointCount, setPointCount] = useState(0);
  const [dist, setDist] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const dotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const lineRef = useRef<SVGLineElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const tapRef = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const downCount = useRef(0);
  // Walk (D-09)
  const [joy, setJoy] = useState<Joy>(null);
  const ptrs = useRef(new Map<number, Ptr>());
  const keys = useRef(new Set<Dir>());
  // Floor plan (D-11) and WebGL context loss (D-13a)
  const [planOpen, setPlanOpen] = useState(false);
  const [planFailed, setPlanFailed] = useState(false);
  const planImgRef = useRef<HTMLDivElement>(null);
  const youRef = useRef<HTMLDivElement>(null);
  const planTap = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ac = new AbortController();
    const engine = createEngine(canvas, { reducedMotion });
    engineRef.current = engine;
    const call = <A,>(fn: ((a: A) => Promise<void>) | undefined, a: A) => void fn?.(a)?.catch(() => {});

    let lastAt = 0;
    const onPct = (percent: number | null) => {
      const now = Date.now();
      if (percent !== 100 && percent !== null && now - lastAt < PROGRESS_MS) return;
      lastAt = now;
      setLoad({ stage: 'download', percent });
      call(propsRef.current.onProgress, { stage: 'download' as const, percent });
    };

    // T-05-23: pose to the native side (crash remount, D-13b), only once the real pose is applied.
    let poseAt = 0;
    let lastPose = '';
    const emitPose = () => {
      const now = performance.now();
      if (now - poseAt < POSE_MS) return;
      poseAt = now;
      const pose = engine.getPose();
      const key = [...pose.position, ...pose.quaternion].map((v) => v.toFixed(3)).join();
      if (key === lastPose) return;
      lastPose = key;
      call(propsRef.current.onPose, pose);
    };

    // D-13a: keep the context restorable, rebuild from cached bytes, give up after 5 s.
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => call(propsRef.current.onError, { code: 'context_lost' }), LOST_MS);
    };
    const onRestored = () => {
      clearTimeout(lostTimer);
      engine
        .rebuild()
        .then(() => setLost(false))
        .catch(() => call(propsRef.current.onError, { code: 'context_lost' }));
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    setLoad({ stage: 'download', percent: null });
    setHasCollider(false);
    setMode('orbit');
    setLost(false);
    (async () => {
      try {
        // The start pose is always the computed one (Reset target); a saved crash pose only applies on load.
        const [bytes, pose] = await Promise.all([
          fetchWithProgress(splatUrl, onPct, ac.signal),
          resolveStartPose({ ...propsRef.current, startPose: null }, ac.signal),
        ]);
        if (ac.signal.aborted) return;
        setLoad({ stage: 'prepare' });
        call(propsRef.current.onProgress, { stage: 'prepare' as const, percent: null });
        if (pose) engine.setStartPose(pose);
        engine.onFirstFrame(() => {
          setLoad({ stage: 'ready' });
          setHint({ text: ORBIT_HINT[coarse ? 0 : 1], ms: HINT_MS });
          call(propsRef.current.onReady, undefined);
          engine.onFrame(emitPose);
        });
        await engine.loadSplat(bytes, propsRef.current.startPose);
      } catch {
        if (ac.signal.aborted) return;
        setLoad({ stage: 'error' });
        call(propsRef.current.onError, { code: 'load_failed' });
        return;
      }
      // Collider is optional (D-10, B9, T-05-08): any failure leaves the viewer in Orbit with Walk/Measure off.
      const { colliderUrl, floorplanMeta } = propsRef.current;
      if (!colliderUrl) return;
      try {
        const res = await fetch(colliderUrl, { signal: ac.signal });
        if (!res.ok) throw new Error(`collider ${res.status}`);
        const buf = await res.arrayBuffer();
        if (ac.signal.aborted) return;
        engine.loadCollider(buf, floorplanMeta?.scene_bounds);
        setHasCollider(true);
      } catch {
        // orbit-only
      }
    })();

    return () => {
      ac.abort();
      clearTimeout(lostTimer);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      engine.dispose();
      engineRef.current = null;
    };
  }, [splatUrl, attempt, reducedMotion, coarse]);

  useEffect(() => {
    if (!hint?.ms) return;
    const timer = setTimeout(() => setHint(null), hint.ms);
    return () => clearTimeout(timer);
  }, [hint]);

  // Re-project measure markers, line and label after every scene render.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || pointCount === 0) return;
    return engine.onFrame(() => {
      const s = pointsRef.current.map((p) => engine.projectToScreen(p));
      s.forEach((q, i) => {
        const el = dotRefs.current[i];
        if (!el) return;
        el.style.display = q.visible ? 'block' : 'none';
        el.style.transform = `translate(${q.x - 8}px, ${q.y - 8}px)`;
      });
      const both = s.length === 2 && s[0].visible && s[1].visible;
      const line = lineRef.current;
      if (line) {
        line.style.display = both ? 'inline' : 'none';
        if (both) {
          line.setAttribute('x1', String(s[0].x));
          line.setAttribute('y1', String(s[0].y));
          line.setAttribute('x2', String(s[1].x));
          line.setAttribute('y2', String(s[1].y));
        }
      }
      const label = labelRef.current;
      if (label) {
        label.style.display = both ? 'block' : 'none';
        if (both)
          label.style.transform = `translate(${(s[0].x + s[1].x) / 2}px, ${(s[0].y + s[1].y) / 2}px) translate(-50%, -50%)`;
      }
    });
  }, [pointCount, dist, mode]);

  // You-are-here dot + heading wedge, every frame while the plan is open (B6).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !planOpen || load.stage !== 'ready') return;
    return engine.onFrame(() => {
      const meta = propsRef.current.floorplanMeta;
      const img = planImgRef.current;
      const you = youRef.current;
      if (!img || !you || !hasFloorplan(meta)) return;
      const { position } = engine.getPose();
      const [px, py] = pixelFromWorld(meta, position[0], position[2]);
      const [fx, fz] = engine.getHeading();
      const x = (px * img.clientWidth) / meta.image.width_px;
      const y = (py * img.clientHeight) / meta.image.height_px;
      you.style.transform = `translate(${x}px, ${y}px) rotate(${headingAngle(meta, fx, fz)}rad)`;
    });
  }, [planOpen, load.stage]);

  useEffect(() => {
    if (!planOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlanOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [planOpen]);

  // Desktop walk keys (B5); never while typing in an input (T-05-09).
  useEffect(() => {
    if (mode !== 'walk') return;
    const held = keys.current;
    const push = (sprint: boolean) =>
      engineRef.current?.setWalkInput({
        moveX: (held.has('r') ? 1 : 0) - (held.has('l') ? 1 : 0),
        moveZ: (held.has('f') ? 1 : 0) - (held.has('b') ? 1 : 0),
        sprint,
      });
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      const k = KEYS[e.code];
      if (!k) {
        if (e.key === 'Shift') push(e.type === 'keydown');
        return;
      }
      e.preventDefault();
      if (e.type === 'keydown') held.add(k);
      else held.delete(k);
      setHint((h) => (h?.ms === HINT_MS ? null : h));
      push(e.shiftKey);
    };
    // WR-03: a keyup lost to blur/tab switch would otherwise walk forever.
    const stop = () => {
      held.clear();
      engineRef.current?.setWalkInput(STILL);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', stop);
      stop();
    };
  }, [mode]);

  function clearMeasure() {
    pointsRef.current = [];
    setPointCount(0);
    setDist(null);
    setAnnounce('');
  }

  function leaveWalkInput() {
    setJoy(null);
    ptrs.current.clear();
  }

  function selectMode(next: Mode) {
    const engine = engineRef.current;
    if (!engine || next === mode) return;
    if (next !== 'orbit' && !engine.hasCollider()) {
      setHint({ text: NO_GEOMETRY, ms: DISABLED_HINT_MS });
      return;
    }
    engine.setMode(next);
    setMode(next);
    clearMeasure();
    leaveWalkInput();
    if (next === 'measure') setHint({ text: t('Tap a point to start', 'Click a point to start'), ms: null });
    else if (next === 'walk' && !seenWalk.current) {
      seenWalk.current = true;
      setHint({ text: t('Left side: move · Right side: look', 'WASD or arrow keys to move · Drag to look'), ms: HINT_MS });
    } else setHint(null);
  }

  function measureAt(clientX: number, clientY: number) {
    const engine = engineRef.current;
    const canvas = canvasRef.current;
    if (!engine || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const hit = engine.measureTap(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    if (!hit) {
      setHint({ text: t('Tap on a surface', 'Click on a surface'), ms: null });
      return;
    }
    const pts = pointsRef.current.length >= 2 ? [hit] : [...pointsRef.current, hit]; // 3rd tap starts over
    pointsRef.current = pts;
    setPointCount(pts.length);
    if (pts.length === 1) {
      setDist(null);
      setAnnounce('');
      setHint({ text: t('Tap a second point', 'Click a second point'), ms: null });
    } else {
      const d = distance(pts[0], pts[1]);
      setDist(d);
      setAnnounce(announceDistance(d));
      setHint(null);
    }
  }

  function onPlanDown(e: ReactPointerEvent<HTMLDivElement>) {
    planTap.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp };
  }

  function onPlanUp(e: ReactPointerEvent<HTMLDivElement>) {
    const tap = planTap.current;
    planTap.current = null;
    const engine = engineRef.current;
    const meta = props.floorplanMeta;
    if (!tap || tap.id !== e.pointerId || !engine || !hasFloorplan(meta)) return;
    if (!isTap(e.clientX - tap.x, e.clientY - tap.y, e.timeStamp - tap.t)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const [px, py] = tapToPixel(e.clientX - r.left, e.clientY - r.top, r.width, r.height, meta);
    const [x, z] = worldFromPixel(meta, px, py);
    const next = engine.teleport(x, z, meta.scene_bounds);
    if (next === 'walk') seenWalk.current = true;
    setMode(next);
    clearMeasure();
    leaveWalkInput();
    setHint({ text: "You're here now", ms: HINT_MS });
  }

  function onCanvasDown(e: ReactPointerEvent) {
    downCount.current += 1;
    if (mode === 'orbit') setHint(null);
    if (mode !== 'measure') return;
    // One-finger drag still orbits; only a single short, still touch counts as a tap (B7).
    tapRef.current = downCount.current === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
  }

  function onCanvasUp(e: ReactPointerEvent) {
    downCount.current = Math.max(0, downCount.current - 1);
    const tap = tapRef.current;
    if (mode !== 'measure' || !tap || tap.id !== e.pointerId) return;
    tapRef.current = null;
    if (e.type === 'pointerup' && isTap(e.clientX - tap.x, e.clientY - tap.y, e.timeStamp - tap.t))
      measureAt(e.clientX, e.clientY);
  }

  function onWalkDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHint((h) => (h?.ms === HINT_MS ? null : h));
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const hasJoy = [...ptrs.current.values()].some((p) => p.kind === 'joy');
    const kind = e.pointerType !== 'mouse' && x < r.width / 2 && !hasJoy ? 'joy' : 'look';
    ptrs.current.set(e.pointerId, { kind, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY });
    if (kind === 'joy') setJoy({ x, y, kx: 0, ky: 0 });
  }

  function onWalkMove(e: ReactPointerEvent<HTMLDivElement>) {
    const p = ptrs.current.get(e.pointerId);
    const engine = engineRef.current;
    if (!p || !engine) return;
    if (p.kind === 'look') {
      engine.look(-(e.clientX - p.x) * LOOK_RAD_PER_PX, -(e.clientY - p.y) * LOOK_RAD_PER_PX);
      p.x = e.clientX;
      p.y = e.clientY;
      return;
    }
    let dx = e.clientX - p.x0;
    let dy = e.clientY - p.y0;
    const len = Math.hypot(dx, dy);
    if (len > JOY_TRAVEL) {
      dx = (dx / len) * JOY_TRAVEL;
      dy = (dy / len) * JOY_TRAVEL;
    }
    engine.setWalkInput({ moveX: dx / JOY_TRAVEL, moveZ: -dy / JOY_TRAVEL, sprint: false });
    setJoy((j) => (j ? { ...j, kx: dx, ky: dy } : j));
  }

  function onWalkUp(e: ReactPointerEvent<HTMLDivElement>) {
    const p = ptrs.current.get(e.pointerId);
    ptrs.current.delete(e.pointerId);
    if (p?.kind !== 'joy') return;
    setJoy(null);
    engineRef.current?.setWalkInput(STILL);
  }

  const ready = load.stage === 'ready';
  const showPlan = !!props.floorplanUrl && hasFloorplan(props.floorplanMeta) && !planFailed;
  const barBottom = insets.bottom + VT.space.md;
  const aboveBar = barBottom + 44 + VT.space.sm;

  return (
    <div style={S.root}>
      <style>{CSS}</style>
      <canvas
        // A fresh canvas per engine: dispose() force-loses the old one's WebGL context (WR-02).
        key={`${attempt}:${splatUrl}`}
        ref={canvasRef}
        role="img"
        aria-label={`3D view of ${title}`}
        style={S.canvas}
        onPointerDown={onCanvasDown}
        onPointerUp={onCanvasUp}
        onPointerCancel={onCanvasUp}
      />

      {ready && mode === 'measure' && pointCount > 0 && (
        <>
          <svg style={S.svg} aria-hidden>
            <line ref={lineRef} stroke={VT.accent} strokeWidth={2} style={{ display: 'none' }} />
          </svg>
          {Array.from({ length: pointCount }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                dotRefs.current[i] = el;
              }}
              style={S.marker}
              aria-hidden
            />
          ))}
          {dist != null && (
            <div ref={labelRef} style={S.label}>
              {formatDistance(dist)}
            </div>
          )}
        </>
      )}

      {ready && mode === 'walk' && (
        <div
          style={{ ...S.walkLayer, top: insets.top, bottom: aboveBar }}
          onPointerDown={onWalkDown}
          onPointerMove={onWalkMove}
          onPointerUp={onWalkUp}
          onPointerCancel={onWalkUp}>
          {joy && (
            <div aria-hidden style={{ ...S.joyBase, left: joy.x - 56, top: joy.y - 56 }}>
              <div style={{ ...S.joyKnob, transform: `translate(${joy.kx}px, ${joy.ky}px)` }} />
            </div>
          )}
        </div>
      )}

      {ready && showPlan && planOpen && (
        <div
          role="dialog"
          aria-label="Floor plan"
          style={{ ...S.panel, top: insets.top + VT.space.sm, width: `min(${coarse ? 280 : 320}px, calc(100vw - 32px))` }}>
          <div style={S.panelHeader}>
            <span style={S.panelTitle}>Floor plan</span>
            <button
              type="button"
              className="vm-btn"
              aria-label="Close floor plan"
              style={S.close}
              onClick={() => setPlanOpen(false)}>
              <svg width={16} height={16} viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
                <path d="M3 3l10 10M13 3L3 13" />
              </svg>
            </button>
          </div>
          <div
            ref={planImgRef}
            role="button"
            aria-label="Floor plan. Tap a spot to move there."
            style={S.planImage}
            onPointerDown={onPlanDown}
            onPointerUp={onPlanUp}
            onPointerCancel={() => {
              planTap.current = null;
            }}>
            <img
              src={props.floorplanUrl}
              alt=""
              draggable={false}
              style={S.planImg}
              onError={() => {
                setPlanFailed(true);
                setPlanOpen(false);
              }}
            />
            <div ref={youRef} aria-hidden style={S.you}>
              <svg width={48} height={48} viewBox="0 0 48 48" style={S.wedge}>
                <path d="M24 24 L44.78 12 A24 24 0 0 1 44.78 36 Z" fill={VT.accent} fillOpacity={0.4} />
              </svg>
              <div style={S.youDot} />
            </div>
          </div>
          <span style={S.planHint}>Tap to jump there</span>
        </div>
      )}

      {lost && (
        <div style={S.overlay}>
          <div style={S.column} role="status" aria-live="polite">
            <div className="vm-spinner" />
            <span style={S.reconnecting}>Reconnecting viewer…</span>
          </div>
        </div>
      )}

      {load.stage !== 'error' && (
        <div style={{ ...S.overlay, ...(ready ? S.overlayGone : null) }} className="vm-fade" aria-hidden={ready}>
          {load.stage === 'download' ? (
            <div
              role="progressbar"
              aria-label="Downloading room"
              aria-valuemin={0}
              aria-valuemax={100}
              {...(load.percent != null ? { 'aria-valuenow': load.percent } : {})}
              style={S.column}>
              <span style={S.stage}>Downloading room</span>
              {load.percent != null ? (
                <>
                  <span style={S.percent}>{load.percent}%</span>
                  <div style={S.track}>
                    <div style={{ ...S.fill, width: `${load.percent}%` }} />
                  </div>
                </>
              ) : (
                <div className="vm-spinner" />
              )}
            </div>
          ) : (
            <div role="progressbar" aria-label="Preparing room…" style={S.column}>
              <span style={S.stage}>Preparing room…</span>
              <div className="vm-spinner" />
            </div>
          )}
        </div>
      )}

      {load.stage === 'error' && (
        <div style={S.overlay}>
          <div style={S.column}>
            <span style={S.heading}>Couldn&apos;t load this room</span>
            <span style={S.body}>Check your connection, then try again.</span>
            <button type="button" className="vm-btn" style={S.retry} onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </div>
        </div>
      )}

      {ready && (
        <>
          {hint && (
            <div role="status" aria-live="polite" style={{ ...S.chip, bottom: aboveBar }}>
              {hint.text}
            </div>
          )}
          <div aria-live="polite" style={S.srOnly}>
            {announce}
          </div>

          {mode === 'measure' && pointCount > 0 && (
            <button
              type="button"
              className="vm-btn"
              style={{ ...S.clear, bottom: aboveBar - 6 }}
              onClick={() => {
                clearMeasure();
                setHint({ text: t('Tap a point to start', 'Click a point to start'), ms: null });
              }}>
              Clear
            </button>
          )}

          <div style={{ ...S.rail, bottom: aboveBar }}>
            <button
              type="button"
              className="vm-btn"
              aria-label="Reset view"
              style={S.round}
              onClick={() => {
                engineRef.current?.reset();
                setMode('orbit');
                clearMeasure();
                leaveWalkInput();
                setHint(null);
              }}>
              <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M4.5 7.5A6 6 0 1 1 4 12" strokeLinecap="round" />
                <path d="M4 3.5v4h4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            {showPlan && (
              <button
                type="button"
                className="vm-btn"
                aria-label="Floor plan"
                aria-pressed={planOpen}
                style={{ ...S.round, ...(planOpen ? { background: VT.surfaceSelected } : null) }}
                onClick={() => setPlanOpen((o) => !o)}>
                <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x={3} y={3} width={14} height={14} rx={2} />
                  <path d="M10 3v14M3 10h14" />
                </svg>
              </button>
            )}
          </div>

          <div role="radiogroup" aria-label="View mode" style={{ ...S.modeBar, bottom: barBottom }}>
            {MODES.map(({ id, label }) => {
              const disabled = id !== 'orbit' && !hasCollider;
              const selected = id === mode;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-disabled={disabled || undefined}
                  className="vm-btn"
                  style={{ ...S.segment, ...(selected ? S.selected : null), ...(disabled ? S.disabled : null) }}
                  onClick={() => selectMode(id)}>
                  {label}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const CSS = `
html, body { margin: 0; background: ${VT.bg}; overscroll-behavior: none; }
@keyframes vm-spin { to { transform: rotate(360deg); } }
.vm-spinner { width: 24px; height: 24px; border-radius: 50%; border: 3px solid ${VT.surface};
  border-top-color: ${VT.accent}; animation: vm-spin 0.9s linear infinite; }
.vm-fade { transition: opacity 200ms, visibility 0s linear 200ms; }
.vm-btn { -webkit-tap-highlight-color: transparent; font-family: ${FONT}; }
.vm-btn:focus-visible { outline: 2px solid ${VT.accent}; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .vm-fade { transition: none; } .vm-spinner { animation-duration: 2s; } }
`;

const S: Record<string, CSSProperties> = {
  root: { position: 'fixed', inset: 0, overflow: 'hidden', background: VT.bg, fontFamily: FONT, color: VT.text },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none' },
  overlay: {
    position: 'absolute',
    inset: 0,
    background: VT.bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 1,
  },
  overlayGone: { opacity: 0, visibility: 'hidden', pointerEvents: 'none' },
  column: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: VT.space.sm, padding: VT.space.md },
  stage: { fontSize: VT.font.label, lineHeight: '20px', color: VT.textSecondary },
  percent: {
    fontSize: VT.font.heading,
    lineHeight: '28px',
    fontWeight: VT.weight.semibold,
    fontVariantNumeric: 'tabular-nums',
  },
  track: { width: 200, height: 4, borderRadius: 2, background: VT.surface, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, background: VT.accent, transition: 'width 150ms linear' },
  heading: { fontSize: VT.font.heading, lineHeight: '28px', fontWeight: VT.weight.semibold, textAlign: 'center' },
  body: { fontSize: VT.font.body, lineHeight: '24px', color: VT.textSecondary, textAlign: 'center' },
  retry: {
    marginTop: VT.space.lg - VT.space.sm,
    height: 44,
    padding: `0 ${VT.space.lg}px`,
    borderRadius: VT.radius.md,
    border: 'none',
    background: VT.surface,
    color: VT.text,
    fontSize: VT.font.body,
    fontWeight: VT.weight.semibold,
  },
  chip: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    height: 32,
    padding: `0 ${VT.space.md}px`,
    borderRadius: 16,
    background: VT.scrim,
    fontSize: VT.font.label,
    lineHeight: '32px',
    whiteSpace: 'nowrap',
    maxWidth: 'calc(100% - 32px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    pointerEvents: 'none',
  },
  srOnly: { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' },
  svg: { position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' },
  marker: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 12,
    height: 12,
    borderRadius: 8,
    border: '2px solid #FFFFFF',
    background: VT.accent,
    pointerEvents: 'none',
    display: 'none',
  },
  label: {
    position: 'absolute',
    left: 0,
    top: 0,
    height: 32,
    padding: `0 ${VT.space.md}px`,
    borderRadius: 16,
    background: VT.scrim,
    fontSize: VT.font.body,
    lineHeight: '32px',
    fontWeight: VT.weight.semibold,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    display: 'none',
  },
  clear: {
    position: 'absolute',
    left: VT.space.md,
    height: 44,
    padding: `0 ${VT.space.md}px`,
    borderRadius: VT.radius.pill,
    border: 'none',
    background: VT.scrim,
    color: VT.text,
    fontSize: VT.font.label,
    fontWeight: VT.weight.semibold,
  },
  walkLayer: { position: 'absolute', left: 0, right: 0, touchAction: 'none' },
  joyBase: {
    position: 'absolute',
    width: 112,
    height: 112,
    boxSizing: 'border-box',
    borderRadius: 56,
    background: VT.ghost,
    border: `1px solid ${VT.ghostStroke}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  joyKnob: { width: 48, height: 48, borderRadius: 24, background: VT.knob },
  disabled: { opacity: 0.4 },
  rail: { position: 'absolute', right: VT.space.md, display: 'flex', flexDirection: 'column', gap: VT.space.sm },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    border: 'none',
    background: VT.scrim,
    color: VT.text,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  modeBar: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    height: 44,
    boxSizing: 'border-box',
    padding: VT.space.xs,
    borderRadius: VT.radius.pill,
    background: VT.scrim,
    display: 'flex',
    gap: 0,
  },
  segment: {
    minWidth: 80,
    height: 36,
    borderRadius: 18,
    border: 'none',
    background: 'transparent',
    color: VT.textSecondary,
    fontSize: VT.font.label,
    fontWeight: VT.weight.regular,
  },
  panel: {
    position: 'absolute',
    left: VT.space.md,
    boxSizing: 'border-box',
    padding: VT.space.sm,
    borderRadius: VT.radius.lg,
    background: VT.scrim,
    display: 'flex',
    flexDirection: 'column',
  },
  panelHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { fontSize: VT.font.label, fontWeight: VT.weight.semibold, paddingLeft: VT.space.xs },
  close: {
    width: 44,
    height: 44,
    border: 'none',
    background: 'transparent',
    color: VT.text,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  planImage: {
    position: 'relative',
    borderRadius: VT.radius.sm,
    background: VT.surface,
    overflow: 'hidden',
    touchAction: 'none',
    cursor: 'crosshair',
  },
  planImg: { display: 'block', width: '100%', height: 'auto', userSelect: 'none', pointerEvents: 'none' },
  you: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' },
  wedge: { position: 'absolute', left: -24, top: -24 },
  youDot: {
    position: 'absolute',
    left: -8,
    top: -8,
    width: 12,
    height: 12,
    borderRadius: 8,
    border: '2px solid #FFFFFF',
    background: VT.accent,
  },
  planHint: { marginTop: VT.space.sm, fontSize: VT.font.label, lineHeight: '20px', color: VT.textSecondary },
  reconnecting: { fontSize: VT.font.label, lineHeight: '20px', color: VT.text },
  selected: { background: VT.surfaceSelected, color: VT.text, fontWeight: VT.weight.semibold },
};
