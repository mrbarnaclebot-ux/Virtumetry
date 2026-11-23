"""Per-frame, per-channel gain compensation (spec §5.2 item 5).

The capture does not reliably lock exposure / white balance (the 2026-09-17
capture has exposureLocked = false), so neighbouring frames disagree in
brightness and seams show as steps. We solve, per channel, for log-gains a_i
minimising

    sum_pairs n_ij (a_i + log m_ij - a_j - log m_ji)^2 + lam * sum_i (a_i - p_i)^2

where m_ij is frame i's mean over its overlap with frame j and n_ij the
overlap size: the Brown-Lowe gain model in the log domain, which recovers an
exact ratio between two frames (the linear form is biased toward 1 by its
prior). p_i is the prior: 0, or the iso * exposureDuration ratio when the
client sent it, so a frame with no overlap still gets its metered correction.
"""

import math

import numpy as np

GAIN_MIN, GAIN_MAX = 0.25, 4.0  # beyond this the frame is broken, not mis-exposed
PRIOR_WEIGHT = 0.01  # x mean overlap size: a weak anchor, overlaps dominate
DISPLAY_GAMMA = 2.2  # JPEG values ~ linear^(1/2.2): an exposure ratio r is r^(1/2.2)
MIN_OVERLAP_PX = 200


def overlap_stats(imgs, masks):
    """[(i, j, n, mean_i(3), mean_j(3))] over pixels both frames see, ignoring
    clipped pixels (a gain cannot move them, so they would bias the ratio)."""
    usable = [m & (im.min(axis=2) > 4) & (im.max(axis=2) < 250) for im, m in zip(imgs, masks)]
    pairs = []
    for i in range(len(imgs)):
        for j in range(i + 1, len(imgs)):
            both = usable[i] & usable[j]
            n = int(both.sum())
            if n >= MIN_OVERLAP_PX:
                mi = imgs[i][both].mean(axis=0)
                mj = imgs[j][both].mean(axis=0)
                pairs.append((i, j, n, mi, mj))
    return pairs


def exposure_prior(poses):
    """Prior log-gains from iso * exposureDuration, or None unless every frame
    has both (a partial prior would skew the frames that have it)."""
    e = []
    for p in poses:
        iso, dur = p.get("iso"), p.get("exposureDuration")
        if not all(isinstance(x, (int, float)) and math.isfinite(x) and x > 0 for x in (iso, dur)):
            return None
        e.append(float(iso) * float(dur))
    log_e = np.log(np.array(e))
    return (np.median(log_e) - log_e) / DISPLAY_GAMMA


def solve_gains(pairs, n, prior=None):
    """(n, 3) per-channel gains from overlap_stats() pairs."""
    prior = np.zeros(n) if prior is None else np.asarray(prior, np.float64)
    lam = PRIOR_WEIGHT * (np.mean([p[2] for p in pairs]) if pairs else 1.0)
    gains = np.ones((n, 3))
    for c in range(3):
        a = lam * np.eye(n)
        b = lam * prior.copy()
        for i, j, cnt, mi, mj in pairs:
            d = math.log(max(mj[c], 1e-3)) - math.log(max(mi[c], 1e-3))
            a[i, i] += cnt
            a[j, j] += cnt
            a[i, j] -= cnt
            a[j, i] -= cnt
            b[i] += cnt * d
            b[j] -= cnt * d
        gains[:, c] = np.exp(np.linalg.solve(a, b))
    return np.clip(gains, GAIN_MIN, GAIN_MAX).astype(np.float32)


def estimate_gains(imgs, masks, prior=None):
    """Gains for analysis-scale layers (uint8 BGR canvases + bool masks)."""
    return solve_gains(overlap_stats(imgs, masks), len(imgs), prior)


def apply_gain(img, gain):
    """float32 image * per-channel gain, clipped to the uint8 range."""
    return np.clip(img.astype(np.float32) * gain, 0, 255)
