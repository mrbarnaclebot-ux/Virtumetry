# tiny-session fixture

A 30-frame session in Virtumetry session format schema 1 (`session.json`, `frames.jsonl`, `frames/000001.jpg …`), used by the bundle, validator and mock-provider tests.

## Source and licence

Derived from the **TUM RGB-D benchmark**, sequence `rgbd_dataset_freiburg3_nostructure_texture_far`
(https://cvg.cit.tum.de/data/datasets/rgbd-dataset), licensed **CC BY 4.0**
(https://creativecommons.org/licenses/by/4.0/).

> J. Sturm, N. Engelhard, F. Endres, W. Burgard, D. Cremers,
> "A Benchmark for the Evaluation of RGB-D SLAM Systems", IROS 2012.

Frames used: 30 RGB frames from `rgb/1341839847.710094.png` to `rgb/1341839855.485969.png`
(lines 71–301 of `rgb.txt`), at least 0.25 s apart.

## Modifications

- PNG converted to JPEG (ffmpeg `-q:v 3 -bitexact`). No EXIF; the backend adds it at pack time.
- Groundtruth poses converted to the raw ARKit convention: `T_arkit = W · T_tum · F`, with
  `F = diag(1,-1,-1,1)` (OpenCV camera axes to ARKit camera axes) and `W` rotating the mocap
  world's +Z (up) onto +Y. Stored column-major, as ARKit's `camera.transform`.
- Intrinsics are TUM's published fr3 values (`fx 535.4, fy 539.2, cx 320.1, cy 247.6`, 640x480,
  already undistorted). `tracking` is `"normal"`, `tzOffset` `"+02:00"`, `wallMs` is the TUM timestamp.

Regenerate with `npx tsx scripts/make-tiny-session.ts <extracted sequence dir> test/fixtures`
(run from `backend/`; needs ffmpeg).
