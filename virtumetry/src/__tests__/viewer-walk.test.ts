import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';

import { EYE_HEIGHT } from '@/viewer/coords';
import { CAPSULE_RADIUS, floorYAt, resolveCapsule, stepWalk, WALK_SPEED } from '@/viewer/walk';

const box = (w: number, h: number, d: number, x: number, y: number, z: number) =>
  new MeshBVH(new THREE.BoxGeometry(w, h, d).translate(x, y, z));

// Wall 0.2 thick centred on x = 1 (face at x = 0.9), floor-to-ceiling, long in z.
const wall = box(0.2, 3, 20, 1, 1.5, 0);
// Floor slab top at y = 0, 10 x 10 around the origin.
const slab = box(10, 0.1, 10, 0, -0.05, 0);

const still = { moveX: 0, moveZ: 0, sprint: false };

describe('walk', () => {
  it('stops at the wall, never past it', () => {
    let state = { position: new THREE.Vector3(0, EYE_HEIGHT, 0), yaw: -Math.PI / 2, floorY: 0 }; // facing +x
    for (let i = 0; i < 200; i++) state = { ...state, position: stepWalk(state, { moveX: 0, moveZ: 1, sprint: false }, wall, 0.05) };
    expect(state.position.x).toBeLessThanOrEqual(0.9 - CAPSULE_RADIUS + 0.01);
    expect(state.position.x).toBeGreaterThanOrEqual(0.9 - CAPSULE_RADIUS - 0.01);
  });

  it('slides along the wall when moving diagonally into it', () => {
    let state = { position: new THREE.Vector3(0, EYE_HEIGHT, 0), yaw: 0, floorY: 0 }; // facing -z
    for (let i = 0; i < 60; i++) state = { ...state, position: stepWalk(state, { moveX: 1, moveZ: 1, sprint: false }, wall, 0.05) };
    expect(state.position.x).toBeCloseTo(0.9 - CAPSULE_RADIUS, 1);
    expect(state.position.z).toBeLessThan(-1.5); // tangential motion kept
  });

  it('floor triangles never push (y unchanged, xz unchanged)', () => {
    const p = new THREE.Vector3(1.23, EYE_HEIGHT, -2.5);
    const out = resolveCapsule(slab, p, 0);
    expect(out.toArray()).toEqual(p.toArray());
  });

  it('floorYAt returns the slab top under the point, null outside', () => {
    expect(floorYAt(slab, 1, 1)).toBeCloseTo(0, 5);
    expect(floorYAt(slab, 20, 0)).toBeNull();
    expect((floorYAt(slab, 0, 0) ?? NaN) + EYE_HEIGHT).toBeCloseTo(1.6, 5);
  });

  it('clamps dt to 0.05 s and caps speed at 1.4 m/s (2x with sprint)', () => {
    const state = { position: new THREE.Vector3(0, EYE_HEIGHT, 0), yaw: 0, floorY: 0 };
    expect(stepWalk(state, { moveX: 0, moveZ: 1, sprint: false }, slab, 1).z).toBeCloseTo(-WALK_SPEED * 0.05, 6);
    expect(stepWalk(state, { moveX: 0, moveZ: 2, sprint: true }, slab, 1).z).toBeCloseTo(-2 * WALK_SPEED * 0.05, 6);
    expect(stepWalk(state, still, slab, 0.05).toArray()).toEqual(state.position.toArray());
  });
});
