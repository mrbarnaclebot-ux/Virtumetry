'use dom';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { createEngine, resolveStartPose, type Engine } from './engine';
import { fetchWithProgress } from './progress';
import { VT } from './tokens';
import type { ViewerProps } from './types';

type Load = { stage: 'download'; percent: number | null } | { stage: 'prepare' } | { stage: 'ready' } | { stage: 'error' };

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HINT_MS = 6000;
const PROGRESS_MS = 100; // UI-SPEC: percent text and onProgress at most 10 Hz

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
  const [hint, setHint] = useState(false);
  const [reducedMotion] = useState(() => media('(prefers-reduced-motion: reduce)'));
  const [coarse] = useState(() => media('(pointer: coarse)'));

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

    setLoad({ stage: 'download', percent: null });
    (async () => {
      try {
        const [bytes, pose] = await Promise.all([
          fetchWithProgress(splatUrl, onPct, ac.signal),
          resolveStartPose(propsRef.current, ac.signal),
        ]);
        if (ac.signal.aborted) return;
        setLoad({ stage: 'prepare' });
        call(propsRef.current.onProgress, { stage: 'prepare' as const, percent: null });
        if (pose) engine.setStartPose(pose);
        engine.onFirstFrame(() => {
          setLoad({ stage: 'ready' });
          setHint(true);
          call(propsRef.current.onReady, undefined);
        });
        await engine.loadSplat(bytes);
      } catch {
        if (ac.signal.aborted) return;
        setLoad({ stage: 'error' });
        call(propsRef.current.onError, { code: 'load_failed' });
      }
    })();

    return () => {
      ac.abort();
      engine.dispose();
      engineRef.current = null;
    };
  }, [splatUrl, attempt, reducedMotion]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(false), HINT_MS);
    return () => clearTimeout(t);
  }, [hint]);

  const ready = load.stage === 'ready';
  const barBottom = insets.bottom + VT.space.md;
  const aboveBar = barBottom + 44 + VT.space.sm;

  return (
    <div style={S.root}>
      <style>{CSS}</style>
      <canvas
        key={attempt}
        ref={canvasRef}
        role="img"
        aria-label={`3D view of ${title}`}
        style={S.canvas}
        onPointerDown={() => setHint(false)}
      />

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
              {coarse ? 'Drag to orbit · Pinch to zoom' : 'Drag to orbit · Scroll to zoom · Right-drag to pan'}
            </div>
          )}

          <div style={{ ...S.rail, bottom: aboveBar }}>
            <button
              type="button"
              className="vm-btn"
              aria-label="Reset view"
              style={S.round}
              onClick={() => engineRef.current?.reset()}>
              <svg width={20} height={20} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}>
                <path d="M4.5 7.5A6 6 0 1 1 4 12" strokeLinecap="round" />
                <path d="M4 3.5v4h4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          <div role="radiogroup" aria-label="View mode" style={{ ...S.modeBar, bottom: barBottom }}>
            <button type="button" role="radio" aria-checked className="vm-btn" style={{ ...S.segment, ...S.selected }}>
              Orbit
            </button>
            {/* ponytail: Walk/Measure ship in 05-03; disabled shells until then. */}
            {['Walk', 'Measure'].map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={false}
                aria-disabled="true"
                className="vm-btn"
                style={{ ...S.segment, opacity: 0.4 }}>
                {m}
              </button>
            ))}
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
  },
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
  selected: { background: VT.surfaceSelected, color: VT.text, fontWeight: VT.weight.semibold },
};
