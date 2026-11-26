'use dom';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { glyphs, type GlyphId } from '../design/glyphs';
import { coachText, isSeen, markSeen, urlScope, type ViewerCoachId } from './coach';
import { createEngine, resolveStartPose, type Engine, type Mode } from './engine';
import { hasFloorplan, headingAngle, pixelFromWorld, tapToPixel, worldFromPixel } from './floorplan';
import { announceDistance, distance, formatDistance, isTap, type Vec3 } from './measure';
import { fetchWithProgress } from './progress';
import { VT } from './tokens';
import type { ViewerProps } from './types';

type Load = { stage: 'download'; percent: number | null } | { stage: 'prepare' } | { stage: 'ready' } | { stage: 'error' };

const HINT_MS = 6000;
const JOY_TRAVEL = 32; // px
const LOOK_RAD_PER_PX = 0.005; // ponytail: one sensitivity for touch and mouse; tune on device
const ORBIT_ONLY = 'Orbit only. This scan has no room geometry.';
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
const call = <A,>(fn: ((a: A) => Promise<void>) | undefined, a: A) => void fn?.(a)?.catch(() => {});
/** Merely touching window.localStorage throws in some private modes (T-06.1-08). */
const store = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

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
  // Room geometry (collider) decides the mode bar: unknown → nothing yet, none → one caption chip, no dead segments.
  const [geometry, setGeometry] = useState<'pending' | 'yes' | 'no'>('pending');
  const revealed = useRef(false); // per mount: fresh URLs or a retry never replay the reveal
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
  // Failure is per URL: fresh URLs (owner refetch, web re-open) bring Plan back (review-2 WR-01).
  const [planFailedUrl, setPlanFailedUrl] = useState<string | undefined>(undefined);
  const planFailed = !!props.floorplanUrl && planFailedUrl === props.floorplanUrl;
  const planImgRef = useRef<HTMLDivElement>(null);
  const youRef = useRef<HTMLDivElement>(null);
  const planTap = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const [lost, setLost] = useState(false);
  // Coach marks (UI-SPEC §8.2): coachSeen is read once; dismissals live in a local set, never re-read from props.
  const [coachSeenProp] = useState(() => props.coachSeen);
  const coachDone = useRef(new Set<ViewerCoachId>());
  const coachRef = useRef<ViewerCoachId | null>(null);
  const [coach, setCoachState] = useState<ViewerCoachId | null>(null);
  const setCoach = (id: ViewerCoachId | null) => {
    coachRef.current = id;
    setCoachState(id);
  };
  // Stable and refs-only: safe from the stale closures of window key listeners.
  const [dismissCoach] = useState(() => () => {
    const id = coachRef.current;
    if (!id) return;
    coachDone.current.add(id);
    markSeen(id, propsRef.current.onCoachSeen, store());
    coachRef.current = null;
    setCoachState(null);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ac = new AbortController();
    const engine = createEngine(canvas, { reducedMotion });
    engineRef.current = engine;

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
    // The host (app screen / web page) owns recovery from here: drop our overlay so only its message shows.
    const handOff = () => {
      setLost(false);
      call(propsRef.current.onError, { code: 'context_lost' });
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
      clearTimeout(lostTimer);
      lostTimer = setTimeout(handOff, LOST_MS);
    };
    const onRestored = () => {
      clearTimeout(lostTimer);
      engine
        .rebuild()
        .then(() => setLost(false))
        .catch(handOff);
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    setLoad({ stage: 'download', percent: null });
    setGeometry('pending');
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
        // Wonder moment (critique R1 #9): first ready open per world eases the camera in (engine; skipped under
        // reduced motion) and plays a success haptic. Not after a crash remount (startPose = saved pose).
        const scope = urlScope(splatUrl);
        const reveal = !revealed.current && !propsRef.current.startPose && !isSeen('reveal', coachSeenProp, store(), scope);
        if (reveal) engine.armReveal();
        engine.onFirstFrame(() => {
          setLoad({ stage: 'ready' });
          setHint({ text: ORBIT_HINT[coarse ? 0 : 1], ms: HINT_MS });
          call(propsRef.current.onReady, undefined);
          engine.onFrame(emitPose);
          if (reveal) {
            revealed.current = true;
            call(propsRef.current.onHaptic, 'success' as const);
            markSeen('reveal', propsRef.current.onCoachSeen, store(), scope);
          }
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
      if (!colliderUrl) return setGeometry('no');
      try {
        const res = await fetch(colliderUrl, { signal: ac.signal });
        if (!res.ok) throw new Error(`collider ${res.status}`);
        const buf = await res.arrayBuffer();
        if (ac.signal.aborted) return;
        engine.loadCollider(buf, floorplanMeta?.scene_bounds);
        setGeometry('yes');
      } catch {
        if (!ac.signal.aborted) setGeometry('no');
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
  }, [splatUrl, attempt, reducedMotion, coarse, coachSeenProp]);

  // The plan image is fetched lazily; warm it while its presigned URL is fresh (review-2 WR-01).
  const { floorplanUrl } = props;
  useEffect(() => {
    if (floorplanUrl) new Image().src = floorplanUrl;
  }, [floorplanUrl]);

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
      if (coachRef.current === 'walk') dismissCoach();
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
  }, [mode, dismissCoach]);

  function maybeCoach(id: ViewerCoachId) {
    if (coachRef.current || coachDone.current.has(id) || isSeen(id, coachSeenProp, store())) return;
    setCoach(id);
  }

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
    if (next !== 'orbit' && !engine.hasCollider()) return; // segments only render with geometry
    engine.setMode(next);
    setMode(next);
    call(propsRef.current.onHaptic, 'selection' as const);
    clearMeasure();
    leaveWalkInput();
    setCoach(null); // never two at once; an unacknowledged mark comes back next time
    if (next !== 'orbit') maybeCoach(next);
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
    call(propsRef.current.onHaptic, 'light' as const);
    if (coachRef.current === 'measure') dismissCoach();
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
    setCoach(null);
    setHint({ text: "You're here now", ms: HINT_MS });
    call(propsRef.current.onHaptic, 'light' as const);
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
    if (coachRef.current === 'walk') dismissCoach();
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
  const barBottom = insets.bottom + VT.space.lg;
  const aboveBar = barBottom + 44 + VT.space.sm;
  const measureBar = mode === 'measure' && pointCount > 0;
  const distText = dist != null ? formatDistance(dist) : '';
  const split = distText.indexOf(' (');

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
            <line ref={lineRef} stroke={VT.color.primary} strokeWidth={2} style={{ display: 'none' }} />
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
              {distText}
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

      {ready && showPlan && (
        <div
          role="dialog"
          aria-label="Floor plan"
          aria-hidden={!planOpen}
          className="vm-panel"
          style={{
            ...S.panel,
            ...(planOpen ? S.panelOpen : S.panelClosed),
            top: insets.top + VT.space.sm,
            width: `min(${coarse ? 280 : 320}px, calc(100vw - 32px))`,
          }}>
          <div aria-hidden style={S.panelBack} />
          <div style={S.panelHeader}>
            <span style={S.panelTitle}>Floor plan</span>
            <button
              type="button"
              className="vm-btn"
              aria-label="Close floor plan"
              style={S.close}
              onClick={() => setPlanOpen(false)}>
              <Glyph id="close" />
            </button>
          </div>
          <div
            ref={planImgRef}
            role="button"
            aria-label={t('Floor plan. Tap a spot to move there.', 'Floor plan. Click a spot to move there.')}
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
                setPlanFailedUrl(props.floorplanUrl);
                setPlanOpen(false);
              }}
            />
            <div ref={youRef} aria-hidden style={S.you}>
              <svg width={48} height={48} viewBox="0 0 48 48" style={S.wedge}>
                <path d="M24 24 L44.78 12 A24 24 0 0 1 44.78 36 Z" fill={VT.color.primary} fillOpacity={0.35} />
              </svg>
              <div style={S.youDot} />
            </div>
          </div>
          <span style={S.planHint}>{t('Tap to jump there', 'Click to jump there')}</span>
        </div>
      )}

      {lost && (
        <div style={S.overlay}>
          <div style={S.column} role="status" aria-live="polite">
            <Indeterminate />
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
                    <div className="vm-fill" style={{ ...S.fill, transform: `scaleX(${load.percent / 100})` }} />
                  </div>
                </>
              ) : (
                <Indeterminate />
              )}
            </div>
          ) : (
            <div role="progressbar" aria-label="Preparing room…" style={S.column}>
              <span style={S.stage}>Preparing room…</span>
              <Indeterminate />
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
              <Glyph id="refresh" />
              Try again
            </button>
          </div>
        </div>
      )}

      {ready && (
        <>
          {hint && !coach && (
            <div
              role="status"
              aria-live="polite"
              style={{ ...S.chip, bottom: measureBar ? aboveBar + MEASURE_BAR_H + VT.space.sm : aboveBar }}>
              {hint.text}
            </div>
          )}
          <div aria-live="polite" style={S.srOnly}>
            {announce}
          </div>

          {coach && (
            <div style={{ ...S.coachWrap, bottom: aboveBar + VT.space.sm }}>
              <div role="alert" className="vm-coach" style={S.coach}>
                <span style={S.coachText}>{coachText(coach, coarse)}</span>
                <button type="button" className="vm-btn" style={S.ghost} onClick={dismissCoach}>
                  Got it
                </button>
                <div aria-hidden style={S.caret} />
              </div>
            </div>
          )}

          {measureBar && (
            <div style={{ ...S.measureBar, bottom: aboveBar }}>
              {dist != null ? (
                <span style={S.distance}>
                  {split > 0 ? distText.slice(0, split) : distText}
                  {split > 0 && <span style={S.distanceNote}>{distText.slice(split + 1)}</span>}
                </span>
              ) : (
                <span style={S.stage}>{t('Tap two points', 'Click two points')}</span>
              )}
              <button
                type="button"
                className="vm-btn"
                style={S.ghost}
                onClick={() => {
                  clearMeasure();
                  setHint({ text: t('Tap a point to start', 'Click a point to start'), ms: null });
                }}>
                Clear
              </button>
            </div>
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
                setCoach(null);
                setHint(null);
              }}>
              <Glyph id="reset" />
            </button>
            {showPlan && (
              <button
                type="button"
                className="vm-btn"
                aria-label="Floor plan"
                aria-pressed={planOpen}
                style={{ ...S.round, ...(planOpen ? S.roundPressed : null) }}
                onClick={() => setPlanOpen((o) => !o)}>
                <Glyph id="plan" />
              </button>
            )}
          </div>

          {geometry === 'yes' && (
            <div role="radiogroup" aria-label="View mode" style={{ ...S.modeBar, bottom: barBottom }}>
              {MODES.map(({ id, label }) => {
                const selected = id === mode;
                return (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    className="vm-btn vm-seg"
                    style={{ ...S.segment, ...(selected ? S.selected : null) }}
                    onClick={() => selectMode(id)}>
                    <Glyph id={id} size={16} />
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {geometry === 'no' && <div style={{ ...S.chip, bottom: barBottom + (44 - 32) / 2 }}>{ORBIT_ONLY}</div>}
        </>
      )}
    </div>
  );
}

type Dot = { cx: number; cy: number; r: number };

/** glyphs.ts path data as inline SVG (UI-SPEC §4): 24 grid, stroke 1.75, round caps/joins, dots filled. */
function Glyph({ id, size = 20 }: { id: GlyphId; size?: number }) {
  const g: { d: string; dots?: readonly Dot[] } = glyphs[id];
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round">
      <path d={g.d} />
      {g.dots?.map((c, i) => (
        <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill="currentColor" stroke="none" />
      ))}
    </svg>
  );
}

function Indeterminate() {
  return (
    <div style={S.track}>
      <div className="vm-indet" style={S.indet} />
    </div>
  );
}

const { color, type, space, radius, motion } = VT;
const ease = motion.css.outQuart;
const px = (n: number) => `${n}px`;
const MEASURE_BAR_H = 60; // 44 Clear + 8/8 padding

const CSS = `
html, body { margin: 0; background: ${color.bg}; overscroll-behavior: none; }
@keyframes vm-indet { from { transform: translateX(-100%); } to { transform: translateX(334%); } }
@keyframes vm-coach-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes vm-fade-in { from { opacity: 0; } to { opacity: 1; } }
.vm-indet { animation: vm-indet ${motion.duration.indeterminate}ms ${motion.css.linear} infinite; }
.vm-fill { transition: transform ${motion.duration.progress}ms ${motion.css.linear}; }
.vm-fade { transition: opacity ${motion.duration.base}ms, visibility 0s linear ${motion.duration.base}ms; }
.vm-seg { transition: background-color ${motion.duration.base}ms ${ease}, color ${motion.duration.base}ms ${ease}; }
/* 36-high pill inside the 44 bar: the hit area reaches the bar edges (44 pt target). */
.vm-seg { position: relative; }
.vm-seg::before { content: ''; position: absolute; inset: -4px 0; }
.vm-panel { transition: opacity ${motion.duration.base}ms ${ease}, transform ${motion.duration.base}ms ${ease},
  visibility 0s linear ${motion.duration.base}ms; }
.vm-panel[aria-hidden="false"] { transition-delay: 0s; }
.vm-coach { animation: vm-coach-in ${motion.duration.slow}ms ${motion.css.outExpo}; }
.vm-btn { -webkit-tap-highlight-color: transparent; font-family: ${VT.font.css.ui}; cursor: pointer; }
.vm-btn:focus-visible { outline: 2px solid ${color.primary}; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  .vm-fade, .vm-fill, .vm-seg, .vm-panel { transition: none; }
  .vm-indet { animation: none; transform: translateX(117%); }
  .vm-coach { animation: vm-fade-in ${motion.duration.fast}ms ${motion.css.linear}; }
}
`;

const scrimPill: CSSProperties = { background: color.scrim.hud, color: color.text, border: 'none' };
const labelText: CSSProperties = { fontSize: type.label.fontSize, lineHeight: px(type.label.lineHeight), fontWeight: 500 };
const mono = (role: 'readout' | 'readoutLarge'): CSSProperties => ({
  fontFamily: VT.font.css.mono,
  fontSize: type[role].fontSize,
  lineHeight: px(type[role].lineHeight),
  letterSpacing: type[role].letterSpacing,
  fontVariantNumeric: 'tabular-nums',
});

const S: Record<string, CSSProperties> = {
  root: { position: 'fixed', inset: 0, overflow: 'hidden', background: color.bg, fontFamily: VT.font.css.ui, color: color.text },
  canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none' },
  overlay: {
    position: 'absolute',
    inset: 0,
    background: color.bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 1,
  },
  overlayGone: { opacity: 0, visibility: 'hidden', pointerEvents: 'none' },
  column: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: space.sm, padding: space.lg },
  stage: { ...labelText, color: color.textMuted },
  percent: mono('readoutLarge'),
  track: { position: 'relative', width: 200, height: 4, borderRadius: 2, background: color.surface.raised, overflow: 'hidden' },
  fill: { width: '100%', height: 4, borderRadius: 2, background: color.accent, transformOrigin: 'left' }, // scaleX: no layout per tick
  indet: { width: '30%', height: 4, borderRadius: 2, background: color.accent },
  heading: {
    fontFamily: VT.font.css.heading,
    fontSize: type.heading.fontSize,
    lineHeight: px(type.heading.lineHeight),
    letterSpacing: type.heading.letterSpacing,
    textAlign: 'center',
  },
  body: { fontSize: type.body.fontSize, lineHeight: px(type.body.lineHeight), color: color.textMuted, textAlign: 'center' },
  retry: {
    ...labelText,
    marginTop: space.sm,
    height: 44,
    padding: `0 ${space.lg}px`,
    borderRadius: radius.md,
    border: 'none',
    background: color.secondary,
    color: color.onSecondary,
    display: 'flex',
    alignItems: 'center',
    gap: space.sm,
    fontWeight: 600,
  },
  chip: {
    ...scrimPill,
    ...labelText,
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    height: 32,
    boxSizing: 'border-box',
    padding: `0 ${space.md}px`,
    borderRadius: radius.pill,
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
    border: `2px solid ${color.text}`,
    background: color.primary,
    pointerEvents: 'none',
    display: 'none',
  },
  label: {
    ...scrimPill,
    ...mono('readout'),
    position: 'absolute',
    left: 0,
    top: 0,
    height: 32,
    padding: `0 ${space.md}px`,
    borderRadius: radius.pill,
    lineHeight: '32px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    display: 'none',
  },
  measureBar: {
    ...scrimPill,
    position: 'absolute',
    left: space.lg,
    height: MEASURE_BAR_H,
    boxSizing: 'border-box',
    maxWidth: `calc(100% - ${space.lg * 2 + 44 + space.sm}px)`,
    padding: `${space.sm}px ${space.md}px`,
    borderRadius: radius.md,
    display: 'flex',
    alignItems: 'center',
    gap: space.md,
  },
  distance: { ...mono('readoutLarge'), whiteSpace: 'nowrap' },
  distanceNote: {
    fontFamily: VT.font.css.ui,
    fontSize: type.caption.fontSize,
    letterSpacing: type.caption.letterSpacing,
    color: color.textMuted,
    marginLeft: space.xs,
  },
  ghost: {
    ...labelText,
    flexShrink: 0,
    height: 44,
    minWidth: 44,
    padding: `0 ${space.md}px`,
    borderRadius: radius.md,
    border: 'none',
    background: 'transparent',
    color: color.primary,
    fontWeight: 600,
  },
  coachWrap: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'max-content',
    // clear of the 44 rail on both sides
    maxWidth: `min(300px, calc(100% - ${2 * (space.lg + 44 + space.sm)}px))`,
  },
  coach: {
    position: 'relative',
    boxSizing: 'border-box',
    padding: `${space.md}px ${space.lg}px ${space.xs}px`,
    borderRadius: radius.md,
    background: color.surface.overlay,
    border: `1.5px solid ${color.accent}`,
    boxShadow: `0 8px 24px color-mix(in srgb, ${color.shadow} 45%, transparent)`,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  coachText: { ...labelText, alignSelf: 'stretch', color: color.text },
  caret: {
    position: 'absolute',
    left: '50%',
    bottom: -7,
    width: 12,
    height: 12,
    marginLeft: -6,
    transform: 'rotate(45deg)',
    background: color.surface.overlay,
    borderRight: `1.5px solid ${color.accent}`,
    borderBottom: `1.5px solid ${color.accent}`,
  },
  walkLayer: { position: 'absolute', left: 0, right: 0, touchAction: 'none' },
  joyBase: {
    position: 'absolute',
    width: 112,
    height: 112,
    boxSizing: 'border-box',
    borderRadius: 56,
    background: color.ghost.fill,
    border: `1px solid ${color.ghost.stroke}`,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
  joyKnob: { width: 48, height: 48, borderRadius: 24, background: color.ghost.knob },
  rail: { position: 'absolute', right: space.lg, display: 'flex', flexDirection: 'column', gap: space.sm },
  round: {
    ...scrimPill,
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  roundPressed: { background: color.secondary, color: color.onSecondary },
  modeBar: {
    position: 'absolute',
    left: '50%',
    transform: 'translateX(-50%)',
    height: 44,
    boxSizing: 'border-box',
    padding: space.xs,
    borderRadius: radius.pill,
    background: color.scrim.hud,
    display: 'flex',
    gap: 0,
  },
  segment: {
    ...labelText,
    minWidth: 88,
    height: 36,
    padding: `0 ${space.md}px`,
    borderRadius: radius.pill,
    border: 'none',
    background: 'transparent',
    color: color.textMuted,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  selected: { background: color.primary, color: color.onPrimary, fontWeight: 600 },
  panel: {
    position: 'absolute',
    left: space.lg,
    boxSizing: 'border-box',
    padding: space.sm,
    borderRadius: radius.lg,
    display: 'flex',
    flexDirection: 'column',
  },
  panelOpen: { opacity: 1, transform: 'none', visibility: 'visible' },
  panelClosed: { opacity: 0, transform: 'translateY(8px)', visibility: 'hidden', pointerEvents: 'none' },
  // 0.94 panel alpha without a colour literal: token fill on a backing layer + opacity.
  panelBack: { position: 'absolute', inset: 0, borderRadius: radius.lg, background: color.surface.overlay, opacity: 0.94 },
  panelHeader: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { ...labelText, fontWeight: 600, paddingLeft: space.xs },
  close: {
    width: 44,
    height: 44,
    border: 'none',
    background: 'transparent',
    color: color.text,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
  },
  planImage: {
    position: 'relative',
    borderRadius: radius.sm,
    background: color.surface.raised,
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
    border: `2px solid ${color.text}`,
    background: color.primary,
  },
  planHint: { ...labelText, position: 'relative', marginTop: space.sm, color: color.textMuted },
  reconnecting: { ...labelText, color: color.text },
};
