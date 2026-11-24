/**
 * Imperative three + Spark engine (D-04/D-06/D-07). Runs inside the 'use dom' WorldViewer only;
 * never imported by jest (covered by the mocked screen test + manual UAT).
 */
import { getSplatFileType, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { cameraToThree, fallbackPose, matToPose, splatFrameFor, type Pose } from './coords';
import type { FloorplanMeta } from './types';

/** D-06: conservative iOS LoD budget (Spark's iOS default is 1.5M). Tune on device; undefined = Spark default. */
export const LOD_SPLAT_COUNT = process.env.EXPO_DOM_HOST_OS === 'ios' ? 1_000_000 : undefined;

export type Mode = 'orbit' | 'walk' | 'measure';
export type Engine = ReturnType<typeof createEngine>;

const RESET_MS = 400;
const TARGET_AHEAD_M = 2;

/** D-07 start pose: explicit pose, else first cameras.json camera, else floor-plan scene bounds; null = use splat bounds. */
export async function resolveStartPose(
  p: { startPose?: Pose | null; camerasUrl?: string; floorplanMeta?: FloorplanMeta | null },
  signal?: AbortSignal,
): Promise<Pose | null> {
  if (p.startPose) return p.startPose;
  if (p.camerasUrl) {
    try {
      const res = await fetch(p.camerasUrl, { signal });
      const first = res.ok ? ((await res.json()) as { frames?: { camera_from_splat?: number[][] }[] }).frames?.[0] : null;
      if (first?.camera_from_splat) return matToPose(cameraToThree(first.camera_from_splat));
    } catch {
      // Cameras are optional: fall through to bounds.
    }
  }
  return p.floorplanMeta?.scene_bounds ? fallbackPose(p.floorplanMeta.scene_bounds) : null;
}

export function createEngine(canvas: HTMLCanvasElement, { reducedMotion }: { reducedMotion: boolean }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 3x iPhone → 2x: ~2.25x fewer pixels
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
  scene.add(new SparkRenderer({ renderer, lodSplatCount: LOD_SPLAT_COUNT }));
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  let disposed = false;
  let splat: SplatMesh | null = null;
  let bytes: Uint8Array | null = null; // kept for context-loss rebuild (05-05)
  let startPose: Pose | null = null;
  let mode: Mode = 'orbit';
  let tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
  const firstFrame: (() => void)[] = [];
  let pendingFirstFrame = false;

  function targetOf(pose: Pose) {
    const pos = new THREE.Vector3(...pose.position);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...pose.quaternion));
    return [pos, pos.clone().addScaledVector(fwd, TARGET_AHEAD_M)] as [THREE.Vector3, THREE.Vector3];
  }

  function applyPose(pose: Pose) {
    const [pos, target] = targetOf(pose);
    camera.position.copy(pos);
    camera.quaternion.set(...pose.quaternion);
    controls.target.copy(target);
    controls.update();
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const size = renderer.getSize(new THREE.Vector2());
    if (size.x === w && size.y === h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  let raf = 0;
  function frame(now: number) {
    if (disposed) return;
    resize();
    if (tween) {
      const t = Math.min(1, (now - tween.t0) / RESET_MS);
      const e = 1 - (1 - t) ** 3; // ease-out
      camera.position.lerpVectors(tween.from[0], tween.to[0], e);
      controls.target.lerpVectors(tween.from[1], tween.to[1], e);
      if (t === 1) tween = null;
    }
    controls.update();
    renderer.render(scene, camera);
    if (pendingFirstFrame) {
      pendingFirstFrame = false;
      firstFrame.splice(0).forEach((cb) => cb());
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    async loadSplat(fileBytes: Uint8Array) {
      bytes = fileBytes;
      const type = getSplatFileType(fileBytes);
      const mesh = new SplatMesh({ fileBytes, fileType: type, lod: true });
      if (splatFrameFor(type ?? '') === 'rdf') mesh.rotation.x = Math.PI; // RDF → Y-up (Pitfall 9)
      await mesh.initialized;
      if (disposed) {
        mesh.dispose();
        return;
      }
      splat = mesh;
      scene.add(mesh);
      if (!startPose) {
        mesh.updateMatrixWorld(true);
        const box = mesh.getBoundingBox().applyMatrix4(mesh.matrixWorld);
        startPose = box.isEmpty()
          ? { position: [0, 1.6, 3], quaternion: [0, 0, 0, 1] }
          : fallbackPose({ min: box.min.toArray(), max: box.max.toArray() });
      }
      applyPose(startPose);
      pendingFirstFrame = true;
    },
    setStartPose(pose: Pose) {
      startPose = pose;
      applyPose(pose);
    },
    /** Back to the start pose and Orbit (D-07); 400 ms ease-out, instant under reduced motion. */
    reset() {
      mode = 'orbit';
      controls.enabled = true;
      if (!startPose) return;
      if (reducedMotion) {
        tween = null;
        applyPose(startPose);
        return;
      }
      tween = { from: [camera.position.clone(), controls.target.clone()], to: targetOf(startPose), t0: performance.now() };
    },
    setMode(next: Mode) {
      mode = next;
      controls.enabled = mode === 'orbit';
    },
    get mode() {
      return mode;
    },
    get bytes() {
      return bytes;
    },
    onFirstFrame(cb: () => void) {
      firstFrame.push(cb);
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      controls.dispose();
      splat?.dispose();
      renderer.dispose();
    },
  };
}
