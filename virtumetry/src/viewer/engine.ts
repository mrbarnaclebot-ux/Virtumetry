/**
 * Imperative three + Spark engine (D-04/D-06/D-07). Runs inside the 'use dom' WorldViewer only;
 * never imported by jest (covered by the mocked screen test + manual UAT).
 */
import { getSplatFileType, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { acceleratedRaycast, computeBoundsTree, type MeshBVH } from 'three-mesh-bvh';

import { cameraToThree, EYE_HEIGHT, fallbackPose, matToPose, needsFlip, splatFrameFor, type Pose } from './coords';
import type { Bounds, FloorplanMeta } from './types';
import { floorYAt, resolveCapsule, stepWalk, type WalkInput } from './walk';

// Pattern 5: BVH-accelerated raycasts; the collider is never added to the scene (it would draw over the splat).
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

/** D-06: conservative iOS LoD budget (Spark's iOS default is 1.5M). Tune on device; undefined = Spark default. */
export const LOD_SPLAT_COUNT = process.env.EXPO_DOM_HOST_OS === 'ios' ? 1_000_000 : undefined;

export type Mode = 'orbit' | 'walk' | 'measure';
export type Engine = ReturnType<typeof createEngine>;

const RESET_MS = 400;
const TARGET_AHEAD_M = 2;
const MAX_PITCH = (80 * Math.PI) / 180;
const NO_INPUT: WalkInput = { moveX: 0, moveZ: 0, sprint: false };

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
  function makeRenderer() {
    const r = new THREE.WebGLRenderer({ canvas, antialias: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); // 3x iPhone → 2x: ~2.25x fewer pixels
    return r;
  }
  let renderer = makeRenderer();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 1000);
  let spark = new SparkRenderer({ renderer, lodSplatCount: LOD_SPLAT_COUNT });
  scene.add(spark);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  let disposed = false;
  let splat: SplatMesh | null = null;
  let bytes: Uint8Array | null = null; // kept for context-loss rebuild (D-13a, no re-download)
  let startPose: Pose | null = null;
  let mode: Mode = 'orbit';
  let tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
  const firstFrame: (() => void)[] = [];
  let pendingFirstFrame = false;
  const frameListeners = new Set<() => void>();
  let collider: THREE.Mesh | null = null;
  let bvh: MeshBVH | null = null;
  let sceneBounds: Bounds | undefined;
  const walk = { yaw: 0, pitch: 0, floorY: 0, input: NO_INPUT };
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  let lastNow = 0;

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

  function forward() {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  }

  /** Orbit around a point 2 m ahead of where the camera looks (after Walk, no jump). */
  function orbitAhead() {
    controls.target.copy(camera.position).addScaledVector(forward(), TARGET_AHEAD_M);
    controls.update();
  }

  function enterWalk() {
    if (!bvh) return;
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    walk.yaw = e.y;
    walk.pitch = 0;
    walk.input = NO_INPUT;
    const box = bvh.getBoundingBox(new THREE.Box3());
    // Cast from the camera when it is inside the collider box (stays under the ceiling), else from eye height above the lowest point.
    const fromY = box.containsPoint(camera.position) ? camera.position.y : box.min.y + EYE_HEIGHT;
    let { x, z } = camera.position;
    let floor = floorYAt(bvh, x, z, fromY);
    if (floor === null && startPose) {
      // Orbited outside the room: walk from the start pose's spot instead.
      [x, , z] = startPose.position;
      floor = floorYAt(bvh, x, z, Math.min(fromY, box.max.y));
    }
    walk.floorY = floor ?? (sceneBounds ? sceneBounds.min[1] : 0);
    const eye = resolveCapsule(bvh, new THREE.Vector3(x, walk.floorY + EYE_HEIGHT, z), walk.floorY);
    camera.position.copy(eye);
    camera.quaternion.setFromEuler(new THREE.Euler(walk.pitch, walk.yaw, 0, 'YXZ'));
  }

  async function makeSplat(fileBytes: Uint8Array) {
    const type = getSplatFileType(fileBytes);
    const mesh = new SplatMesh({ fileBytes, fileType: type, lod: true });
    if (splatFrameFor(type ?? '') === 'rdf') mesh.rotation.x = Math.PI; // RDF → Y-up (Pitfall 9)
    await mesh.initialized;
    return mesh;
  }

  function getPose(): Pose {
    return {
      position: camera.position.toArray() as Pose['position'],
      quaternion: camera.quaternion.toArray() as Pose['quaternion'],
    };
  }

  let raf = 0;
  function frame(now: number) {
    if (disposed) return;
    resize();
    const dt = lastNow ? (now - lastNow) / 1000 : 0;
    lastNow = now;
    if (mode === 'walk' && bvh) {
      camera.position.copy(stepWalk({ position: camera.position, yaw: walk.yaw, floorY: walk.floorY }, walk.input, bvh, dt));
      camera.quaternion.setFromEuler(new THREE.Euler(walk.pitch, walk.yaw, 0, 'YXZ'));
    } else if (tween) {
      const t = Math.min(1, (now - tween.t0) / RESET_MS);
      const e = 1 - (1 - t) ** 3; // ease-out
      camera.position.lerpVectors(tween.from[0], tween.to[0], e);
      controls.target.lerpVectors(tween.from[1], tween.to[1], e);
      if (t === 1) tween = null;
    }
    if (mode !== 'walk') controls.update(); // OrbitControls.update would re-aim the walk camera at its target
    renderer.render(scene, camera);
    frameListeners.forEach((cb) => cb());
    if (pendingFirstFrame) {
      pendingFirstFrame = false;
      firstFrame.splice(0).forEach((cb) => cb());
    }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  return {
    /** `initialPose` (crash remount, D-13b) wins over the start pose on load; Reset still goes to the start pose. */
    async loadSplat(fileBytes: Uint8Array, initialPose?: Pose | null) {
      bytes = fileBytes;
      const mesh = await makeSplat(fileBytes);
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
      applyPose(initialPose ?? startPose);
      pendingFirstFrame = true;
    },
    /** Collider PLY (mesh-simplified). Throws on a bad file; caller treats that as orbit-only (UI-SPEC B9). */
    loadCollider(buf: ArrayBuffer, bounds?: Bounds) {
      const geometry = new PLYLoader().parse(buf);
      geometry.computeBoundingBox();
      const gb = geometry.boundingBox;
      if (!gb || gb.isEmpty() || !geometry.index) {
        // ponytail: non-indexed/point-cloud PLY is treated as no collider; add toNonIndexed handling if Echo-3 ever ships one.
        geometry.dispose();
        throw new Error('collider has no faces');
      }
      // (x,-y,-z) = 180° about X (det +1, winding kept) when the mesh is RDF (Pitfall 9).
      if (bounds && needsFlip({ min: gb.min.toArray(), max: gb.max.toArray() }, bounds)) geometry.scale(1, -1, -1);
      bvh = geometry.computeBoundsTree() as MeshBVH; // default options.type is MeshBVH
      sceneBounds = bounds;
      collider = new THREE.Mesh(geometry);
      collider.updateMatrixWorld();
    },
    hasCollider() {
      return !!bvh;
    },
    /** Joystick/keys: moveX right, moveZ forward, magnitude ≤ 1. */
    setWalkInput(input: WalkInput) {
      walk.input = input;
    },
    look(dYaw: number, dPitch: number) {
      walk.yaw += dYaw;
      walk.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, walk.pitch + dPitch));
    },
    /** Raycast the collider at NDC (-1..1); world point or null on a miss. */
    measureTap(ndcX: number, ndcY: number): [number, number, number] | null {
      if (!collider) return null;
      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      const hit = raycaster.intersectObject(collider)[0];
      return hit ? (hit.point.toArray() as [number, number, number]) : null;
    },
    /** World point → canvas CSS px; visible = in front of the camera. */
    projectToScreen(p: readonly [number, number, number]) {
      const v = new THREE.Vector3(...p).project(camera);
      return {
        x: ((v.x + 1) / 2) * canvas.clientWidth,
        y: ((1 - v.y) / 2) * canvas.clientHeight,
        visible: v.z > -1 && v.z < 1,
      };
    },
    /** Called after every render (DOM overlays re-project here). Returns an unsubscribe. */
    onFrame(cb: () => void) {
      frameListeners.add(cb);
      return () => {
        frameListeners.delete(cb);
      };
    },
    getPose,
    /** Camera forward on the floor plane: [x, z]. */
    getHeading(): [number, number] {
      const f = forward();
      return [f.x, f.z];
    },
    /**
     * Floor-plan tap (D-11, B6): stand at (x, z) at eye height, pushed out of the collider.
     * With a collider this switches to Walk (returns 'walk'); without one it moves the orbit camera there and stays in Orbit.
     */
    teleport(x: number, z: number, bounds?: Bounds): Mode {
      tween = null;
      walk.input = NO_INPUT;
      const box = bvh?.getBoundingBox(new THREE.Box3());
      const floor = (bvh && box && floorYAt(bvh, x, z, box.min.y + EYE_HEIGHT)) ?? (sceneBounds ?? bounds)?.min[1] ?? 0;
      if (bvh) {
        if (mode !== 'walk') {
          walk.yaw = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ').y;
          walk.pitch = 0;
        }
        mode = 'walk';
        controls.enabled = false;
        walk.floorY = floor;
        camera.position.copy(resolveCapsule(bvh, new THREE.Vector3(x, floor + EYE_HEIGHT, z), floor, 3));
        camera.quaternion.setFromEuler(new THREE.Euler(walk.pitch, walk.yaw, 0, 'YXZ'));
      } else {
        camera.position.set(x, floor + EYE_HEIGHT, z);
        orbitAhead();
      }
      return mode;
    },
    /**
     * WebGL context restored (D-13a): new renderer + SparkRenderer + SplatMesh from the cached bytes (no re-download).
     * The camera, controls and collider BVH are plain JS and survive the loss as-is.
     */
    async rebuild() {
      scene.remove(spark);
      try {
        spark.dispose();
        splat?.dispose();
        renderer.dispose();
      } catch {
        // GPU objects of a lost context may refuse to dispose; they are garbage either way.
      }
      if (splat) scene.remove(splat);
      splat = null;
      renderer = makeRenderer();
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      spark = new SparkRenderer({ renderer, lodSplatCount: LOD_SPLAT_COUNT });
      scene.add(spark);
      if (!bytes) return;
      const mesh = await makeSplat(bytes);
      if (disposed) {
        mesh.dispose();
        return;
      }
      splat = mesh;
      scene.add(mesh);
    },
    setStartPose(pose: Pose) {
      startPose = pose;
      applyPose(pose);
    },
    /** Back to the start pose and Orbit (D-07); 400 ms ease-out, instant under reduced motion. */
    reset() {
      if (mode === 'walk') orbitAhead();
      mode = 'orbit';
      walk.input = NO_INPUT;
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
      if (next === mode) return;
      if ((next === 'walk' || next === 'measure') && !bvh) return; // D-10
      const wasWalk = mode === 'walk';
      mode = next;
      tween = null;
      walk.input = NO_INPUT;
      if (mode === 'walk') enterWalk();
      else if (wasWalk) orbitAhead();
      controls.enabled = mode !== 'walk'; // Measure keeps one-finger orbit (B7)
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
      frameListeners.clear();
      collider?.geometry.dispose();
      splat?.dispose();
      renderer.dispose();
    },
  };
}
