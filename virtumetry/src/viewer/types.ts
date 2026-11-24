/** Viewer contract (D-04 + UI-SPEC insets). Type-only: safe to import from the DOM component, RN screens and tests. */

/** three.js world pose: quaternion is [x, y, z, w]. */
export type Pose = { position: [number, number, number]; quaternion: [number, number, number, number] };

export type Bounds = { min: number[]; max: number[] };

/** floorplan.json as stored by the importer (loosely typed: only what the viewer reads). */
export type FloorplanMeta = {
  image?: {
    width_px: number;
    height_px: number;
    world_xz_from_pixel: number[][];
    pixel_from_world_xz: number[][];
  };
  scene_bounds?: Bounds;
  [k: string]: unknown;
};

export type ViewerProps = {
  splatUrl: string;
  colliderUrl?: string;
  floorplanUrl?: string;
  floorplanMeta?: FloorplanMeta | null;
  camerasUrl?: string;
  startPose?: Pose | null;
  title: string;
  insets: { top: number; bottom: number };
  onProgress?: (p: { stage: 'download' | 'prepare'; percent: number | null }) => Promise<void>;
  onReady?: () => Promise<void>;
  onError?: (e: { code: string }) => Promise<void>;
  onPose?: (p: Pose) => Promise<void>;
  dom?: import('expo/dom').DOMProps;
};
