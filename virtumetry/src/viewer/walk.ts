/**
 * Walk mode math (D-09): first-person capsule against the collider BVH, horizontal push-out only.
 * three + three-mesh-bvh only (jest-tested). Recipe: three-mesh-bvh v0.9.18 example/characterMovement.js.
 */
import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';

import { EYE_HEIGHT } from './coords';

export const CAPSULE_RADIUS = 0.25;
export const WALK_SPEED = 1.4; // m/s; Shift = 2x
export const MAX_DT = 0.05; // 2.8 m/s * 0.05 = 14 cm/step < radius: no tunnelling

/** Capsule bottom sits 0.5 m above the floor so floor triangles never push (Pitfall 10). */
const CAPSULE_BOTTOM = 0.5;
const CAPSULE_TOP_BELOW_EYE = 0.1;

export type WalkState = { position: THREE.Vector3; yaw: number; floorY: number };
/** moveX = right, moveZ = forward; magnitude is clamped to 1 (joystick deflection). */
export type WalkInput = { moveX: number; moveZ: number; sprint: boolean };

const DOWN = new THREE.Vector3(0, -1, 0);

/** Floor height under (x, z): first hit of a downward ray from `fromY` (default: above the collider). */
export function floorYAt(bvh: MeshBVH, x: number, z: number, fromY?: number): number | null {
  const top = fromY ?? bvh.getBoundingBox(new THREE.Box3()).max.y + 1;
  const hit = bvh.raycastFirst(new THREE.Ray(new THREE.Vector3(x, top, z), DOWN), THREE.DoubleSide);
  return hit ? hit.point.y : null;
}

/** Push the capsule at `position` (eye) out of the collider, horizontally only. Returns a new eye position, same y. */
export function resolveCapsule(bvh: MeshBVH, position: THREE.Vector3, floorY: number, iterations = 3): THREE.Vector3 {
  const seg = new THREE.Line3(
    new THREE.Vector3(position.x, floorY + CAPSULE_BOTTOM, position.z),
    new THREE.Vector3(position.x, floorY + EYE_HEIGHT - CAPSULE_TOP_BELOW_EYE, position.z),
  );
  const box = new THREE.Box3();
  const triPt = new THREE.Vector3();
  const capPt = new THREE.Vector3();
  const push = new THREE.Vector3();
  for (let i = 0; i < iterations; i++) {
    let moved = false;
    box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end);
    box.min.addScalar(-CAPSULE_RADIUS);
    box.max.addScalar(CAPSULE_RADIUS);
    bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri) => {
        const d = tri.closestPointToSegment(seg, triPt, capPt);
        if (d >= CAPSULE_RADIUS) return false;
        push.subVectors(capPt, triPt).setY(0); // horizontal only (D-09)
        if (push.lengthSq() < 1e-12) return false;
        push.normalize().multiplyScalar(CAPSULE_RADIUS - d);
        seg.start.add(push);
        seg.end.add(push);
        moved = true;
        return false;
      },
    });
    if (!moved) break;
  }
  return new THREE.Vector3(seg.start.x, position.y, seg.start.z);
}

/** One walk step: yaw-relative move, speed x deflection (x2 sprint), dt clamped, then collision. */
export function stepWalk(state: WalkState, input: WalkInput, bvh: MeshBVH, dt: number): THREE.Vector3 {
  let { moveX, moveZ } = input;
  const mag = Math.hypot(moveX, moveZ);
  if (mag < 1e-6) return state.position.clone();
  if (mag > 1) {
    moveX /= mag;
    moveZ /= mag;
  }
  const step = WALK_SPEED * (input.sprint ? 2 : 1) * Math.min(Math.max(dt, 0), MAX_DT);
  // three: yaw 0 looks down -Z; right = (cos, 0, -sin), forward = (-sin, 0, -cos).
  const s = Math.sin(state.yaw);
  const c = Math.cos(state.yaw);
  const next = state.position.clone();
  next.x += (moveX * c - moveZ * s) * step;
  next.z += (-moveX * s - moveZ * c) * step;
  return resolveCapsule(bvh, next, state.floorY);
}
