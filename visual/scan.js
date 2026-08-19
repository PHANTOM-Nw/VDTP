// Capture -> VDTP frame bytes: candidate search, grid-size lock-on, tracking.
//
// Two things here are not obvious from the spec, and both came from hardware.
//
// 1. The frame is not simply "the biggest dark thing". A monitor's bezel is a
//    dark ring enclosing the whole screen, so choosing one candidate up front
//    picks the monitor and everything downstream fails silently. Shape cannot
//    settle it — thin bezels and coarse grids look alike — so several
//    candidates are sampled and the frame structure and CRC decide.
//
// 2. The receiver cannot parse a frame without knowing the grid size n, and n
//    is inside the frame. Resolved by trying a short candidate list and then
//    locking onto whatever answered; the grid does not change mid-session.
import { findQuads, sampleGrid, subsample, homography, quantize, quantizeColor } from './detect.js';
import { MatrixLayout, bestOrientation, planBands, decodeBands, LEVELS, GRIDS } from './matrix.js';
import { decodeFrame, OVERHEAD } from '../core/frame.js';
import { eccDecode, ECC_REDUNDANCY } from '../core/ecc.js';

/**
 * Every grid the format defines, so a receiver can read whatever a sender
 * chose. Ordered coarsest-likeliest first: the probe rejects wrong sizes for a
 * few hundred samples each, so the list costs little, but a *missing* size is
 * a frame nobody can read.
 */
export const CANDIDATE_SIZES = GRIDS;

export class Scanner {
  /**
   * `searchTarget` is the working size for locating the frame only. Sampling
   * always runs against the full-resolution capture, so raising camera
   * resolution still buys pixels per module — it just does not multiply the
   * cost of the connected-component search.
   */
  constructor({ candidates = CANDIDATE_SIZES, tolerance = 0.2, relockAfter = 12,
                maxQuads = 6, searchTarget = 1100 } = {}) {
    this.searchTarget = searchTarget;
    // One entry per (grid, modulation depth). Sampling is the expensive part
    // and does not depend on depth, so a capture is sampled once per grid and
    // then quantised at each depth — the frame structure says which was sent.
    this.layouts = new Map();
    this.plans = new Map();
    for (const n of candidates) {
      for (const levels of LEVELS) {
        const layout = new MatrixLayout(n, levels);
        this.layouts.set(`${n}:${levels}`, layout);
        this.plans.set(`${n}:${levels}`, planBands(layout));
      }
    }
    this.lockedLevels = null;
    this.candidates = candidates;
    this.tolerance = tolerance;
    this.relockAfter = relockAfter;
    this.maxQuads = maxQuads;
    this.locked = null;
    this.misses = 0;
    this.corners = null;
    this.tracked = 0;
    this.searched = 0;
    /** Where the pipeline stopped on the last search — the receiver shows this. */
    this.diag = { quads: 0, sampled: 0, bestError: null, crcFails: 0, contrast: null,
                  stride: 1, margin: null, levelRefs: null, levelGap: null };
    /**
     * Cumulative. `crcFails` counts captures whose frame structure matched but
     * whose payload did not survive — the signature of a capture that spans a
     * screen update, where the rings are identical across frames and come
     * through fine while the payload is a mix of two different ones. Without
     * this counter those captures are invisible: scan() returns null, onFrame
     * is never called, and the receiver's "corrupt" stat stays at zero.
     */
    this.totals = { decoded: 0, crcFails: 0, corrected: 0 };
  }

  _sizeOrder() {
    return this.locked
      ? [this.locked, ...this.candidates.filter((n) => n !== this.locked)]
      : this.candidates;
  }

  /**
   * Cheap gate before committing to a full grid sample.
   *
   * Only the two outermost rings are read, a few hundred points rather than n²
   * cells: ring 0 is solid black and ring 1 solid white in every frame, so a
   * candidate whose outer edge is not clearly darker than the band just inside
   * it cannot be a frame. A monitor bezel fails here — the band inside its
   * outline is still bezel — which is what keeps the expensive path off it.
   *
   * Fails open. The gate exists to skip obvious non-frames, not to make
   * acceptance decisions; those belong to the structure check and the CRC.
   */
  _probe(gray, width, height, corners, n) {
    const map = homography(corners);
    if (!map) return false;
    const hi = n - 1;

    const at = (r, c) => {
      const [x, y] = map((c + 0.5) / n, (r + 0.5) / n);
      const xi = Math.round(x), yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= width || yi >= height) return -1;
      return gray[yi * width + xi];
    };

    let dark = 0, darkN = 0, light = 0, lightN = 0;
    const step = Math.max(1, Math.floor(n / 24));
    for (let i = 0; i <= hi; i += step) {
      for (const v of [at(0, i), at(hi, i), at(i, 0), at(i, hi)]) {
        if (v >= 0) { dark += v; darkN++; }
      }
    }
    for (let i = 1; i < hi; i += step) {
      for (const v of [at(1, i), at(hi - 1, i), at(i, 1), at(i, hi - 1)]) {
        if (v >= 0) { light += v; lightN++; }
      }
    }
    if (!darkN || !lightN) return false;
    return (light / lightN) - (dark / darkN) >= 15;
  }

  /** Depths to try, cheapest-first once something has answered. */
  _levelOrder() {
    return this.lockedLevels
      ? [this.lockedLevels, ...LEVELS.filter((l) => l !== this.lockedLevels)]
      : LEVELS;
  }

  /** Sample one candidate outline at one grid size and try to parse it. */
  _attempt(gray, width, height, corners, n) {
    if (!this._probe(gray, width, height, corners, n)) return null;
    const sample = sampleGrid(gray, width, height, corners, n);
    if (!sample) return null;
    this._lastCorners = corners;
    this._lastSize = { width, height };

    this.diag.sampled++;
    if (this.diag.contrast === null || sample.white - sample.black > this.diag.contrast) {
      this.diag.contrast = sample.white - sample.black;
    }
    if (this.diag.margin === null || sample.margin > this.diag.margin) this.diag.margin = sample.margin;

    for (const levels of this._levelOrder()) {
      const hit = this._readAt(sample, n, levels, corners);
      if (hit) return hit;
    }
    return null;
  }

  /** Quantise one sample at one depth and try to read frames out of it. */
  _readAt(sample, n, levels, corners) {
    const key = `${n}:${levels}`;
    const layout = this.layouts.get(key);

    let cells;
    if (layout.color) {
      // Colour needs the channels, which luminance has already thrown away.
      if (!this.rgba) return null;
      const { width, height } = this._lastSize;
      const planes = [0, 1, 2].map(
        (ch) => sampleGrid(this.rgba, width, height, this._lastCorners, n, 4, ch));
      if (planes.some((p) => !p)) return null;
      cells = quantizeColor(planes, layout);
    } else {
      cells = quantize(sample, layout);
    }
    // Report what the optical chain delivered even when the read fails: a level
    // pair that arrives too close together is not something calibration can fix,
    // and without the number there is no way to tell that from a bad frame.
    if (sample.refs && (this.diag.levelGap === null || sample.minGap > this.diag.levelGap)) {
      this.diag.levelRefs = Array.from(sample.refs, (v) => Math.round(v));
      this.diag.levelGap = sample.minGap;
    }
    if (!cells) return null;

    const best = bestOrientation(cells, layout);
    if (this.diag.bestError === null || best.error < this.diag.bestError) {
      this.diag.bestError = best.error;
    }
    if (best.error > this.tolerance) return null;

    // Each band is an independent frame. A capture spanning a screen update
    // loses only the band straddling the tear — the bands above it came whole
    // from one displayed frame and those below from the next, and both are
    // perfectly good symbols.
    const plan = this.plans.get(key);
    const raws = decodeBands(layout, plan.bands, best.cells);

    const frames = [];
    let corrected = 0;
    for (const raw of raws) {
      // Plain first: one CRC check, and it is what an uncorrected sender
      // produces. Only on failure is correction worth paying for, which also
      // keeps the mode out of the wire format — where the flag announcing it
      // would have to survive the errors it describes.
      let frame = decodeFrame(raw), bytes = raw, wasCorrected = false;
      if (!frame) {
        const repaired = eccDecode(raw, ECC_REDUNDANCY);
        if (repaired) {
          const parsed = decodeFrame(repaired);
          if (parsed) { frame = parsed; bytes = repaired; wasCorrected = true; }
        }
      }
      if (!frame) { this.diag.crcFails++; this.totals.crcFails++; continue; }
      if (wasCorrected) corrected++;
      this.totals.decoded++;
      frames.push({ frame, bytes: bytes.subarray(0, OVERHEAD + frame.payload.length) });
    }

    // A matrix carrying one frame across its whole payload area, rather than
    // one per band. The handshake uses that shape: it holds a single static
    // frame, so tearing cannot touch it and banding would only shrink the
    // metadata's budget below what it needs.
    if (!frames.length) {
      const whole = layout.decode(best.cells);
      let frame = decodeFrame(whole), bytes = whole;
      if (!frame) {
        const repaired = eccDecode(whole, ECC_REDUNDANCY);
        if (repaired) {
          const parsed = decodeFrame(repaired);
          if (parsed) { frame = parsed; bytes = repaired; corrected++; }
        }
      }
      if (frame) frames.push({ frame, bytes: bytes.subarray(0, OVERHEAD + frame.payload.length) });
    }

    if (!frames.length) return null;
    this.totals.corrected += corrected;

    this.lockedLevels = levels;
    return {
      frames,
      // The first band, so callers that only ever expected one frame keep
      // working; anything reading a whole capture should use `frames`.
      frame: frames[0].frame,
      bytes: frames[0].bytes,
      bands: plan.count,
      gridSize: n,
      levels,
      structureError: best.error,
      corrected: corrected > 0,
      corners,
    };
  }

  /**
   * Frame-to-frame tracking (V2.0 §6). Between consecutive captures the frame
   * has barely moved, so re-sampling at the previous corners usually works and
   * skips the connected-component search — the expensive part of the pipeline
   * and the thing that caps receive FPS.
   */
  _track(gray, width, height) {
    if (!this.corners || !this.locked) return null;
    const hit = this._attempt(gray, width, height, this.corners, this.locked);
    if (!hit) return null;
    this.tracked++;
    return { ...hit, tracked: true };
  }

  /**
   * Capture -> { frames, bytes, ... } or null.
   *
   * `rgba` is optional and only needed for colour modulation; locating and
   * grey-scale reading both work from luminance alone.
   */
  scan(gray, width, height, rgba = null) {
    this.rgba = rgba;
    const stride = Math.max(1, Math.ceil(Math.max(width, height) / this.searchTarget));
    this.diag = { quads: 0, sampled: 0, bestError: null, crcFails: 0, contrast: null,
                  stride, margin: null, levelRefs: null, levelGap: null };

    const tracked = this._track(gray, width, height);
    if (tracked) { this.misses = 0; return tracked; }

    this.searched++;
    const small = subsample(gray, width, height, stride);
    const quads = findQuads(small.gray, small.width, small.height, this.maxQuads);
    this.diag.quads = quads.length;

    const sizes = this._sizeOrder();
    for (const quad of quads) {
      // Back to full-resolution coordinates; every sampled bit comes from the
      // original capture, never from the search copy.
      const corners = stride === 1 ? quad.corners
        : quad.corners.map(([x, y]) => [x * stride, y * stride]);
      for (const n of sizes) {
        const hit = this._attempt(gray, width, height, corners, n);
        if (!hit) continue;
        this.locked = n;
        this.misses = 0;
        this.corners = corners;
        return { ...hit, tracked: false };
      }
    }

    this.corners = null; // stale position; next scan searches again
    if (this.locked && ++this.misses >= this.relockAfter) {
      this.locked = null; // the sender may have changed density, or we drifted
      this.lockedLevels = null;
      this.misses = 0;
    }
    return null;
  }
}
