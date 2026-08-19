// Camera image -> cell grid (V2.0 §11 receive path: locate, perspective
// correct, grid sample, binarise).
//
// Threshold is derived per-frame from the frame's own black and white rings
// rather than from a global histogram (spec §16 "White/Black Reference"):
// screen brightness, camera exposure and auto-gain all drift during a
// transfer, but ring 0 is black and ring 1 is white in every single frame.

// Reused across frames: at 4K this is 8 MB, and allocating it per captured
// frame is pure GC pressure on a device already working hard.
let grayBuf = null;

/**
 * RGBA -> a single brightness plane, using max(R,G,B) rather than luminance.
 *
 * Luminance weights the channels very unevenly — blue lands near 29 and red
 * near 76 — so a colour-modulated frame reads as roughly three eighths ink,
 * and the locator's connected-component search, which expects about a tenth,
 * crawls through enormous merged regions. With max(R,G,B) only a fully black
 * module is dark, since every other colour has at least one channel at full,
 * and ink drops back to an eighth.
 *
 * For a monochrome frame R, G and B are equal, so this is luminance — the
 * change costs nothing there and fixes locating outright for colour.
 */
export function toBrightness(rgba, width, height) {
  const n = width * height;
  if (!grayBuf || grayBuf.length < n) grayBuf = new Uint8Array(n);
  const out = grayBuf;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    out[i] = r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  return n === out.length ? out : out.subarray(0, n);
}

/**
 * Nearest-neighbour subsample by an integer stride.
 *
 * Used only to locate the frame. Connected-component search is linear in pixel
 * count, so a 4K capture would cost seconds per frame; locating only needs to
 * know roughly where the outline is, while every bit that gets decoded is
 * sampled from the full-resolution image.
 */
export function subsample(gray, width, height, stride) {
  if (stride <= 1) return { gray, width, height };
  const w = Math.floor(width / stride), h = Math.floor(height / stride);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride * width;
    for (let x = 0; x < w; x++) out[y * w + x] = gray[row + x * stride];
  }
  return { gray: out, width: w, height: h };
}

/**
 * Ink mask: pixels that are dark *relative to their neighbourhood*.
 *
 * Replaces a global Otsu threshold, which fails badly on the scene this system
 * actually runs in — a bright screen in a dim room. Otsu splits room from
 * screen, so the frame's ring, the monitor bezel and the entire room all land
 * on the dark side: 89% of the image at room brightness 90, fused into one
 * component that touches the border and is discarded. Nothing found, and a
 * flood fill across most of the image to discover that.
 *
 * Local contrast has neither problem. A uniformly dim room is not darker than
 * its own surroundings, so it is not ink; the ring on its white page is.
 */
let integralBuf = null, maskBuf = null;

export function inkMask(gray, width, height, { window = 31, margin = 10 } = {}) {
  const n = width * height;
  const iw = width + 1;
  if (!integralBuf || integralBuf.length < iw * (height + 1)) {
    integralBuf = new Uint32Array(iw * (height + 1));
  }
  if (!maskBuf || maskBuf.length < n) maskBuf = new Uint8Array(n);
  const integral = integralBuf, mask = maskBuf;

  integral.fill(0, 0, iw * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const src = y * width, cur = (y + 1) * iw, prev = y * iw;
    for (let x = 0; x < width; x++) {
      rowSum += gray[src + x];
      integral[cur + x + 1] = integral[prev + x + 1] + rowSum;
    }
  }

  const r = window >> 1;
  for (let y = 0; y < height; y++) {
    const y0 = y - r < 0 ? 0 : y - r;
    const y1 = y + r >= height ? height - 1 : y + r;
    const top = y0 * iw, bot = (y1 + 1) * iw;
    const rows = y1 - y0 + 1;
    for (let x = 0; x < width; x++) {
      const x0 = x - r < 0 ? 0 : x - r;
      const x1 = x + r >= width ? width - 1 : x + r;
      const sum = integral[bot + x1 + 1] - integral[top + x1 + 1]
                - integral[bot + x0] + integral[top + x0];
      const mean = sum / (rows * (x1 - x0 + 1));
      mask[y * width + x] = gray[y * width + x] < mean - margin ? 1 : 0;
    }
  }
  return mask;
}

/** Otsu threshold. Kept for callers that binarise a clean synthetic image. */
export function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

/**
 * Candidate frame outlines, best first.
 *
 * Deliberately plural. Picking the single largest dark region — by pixel count
 * or by bounding box — assumes the frame is the most prominent dark thing in
 * the shot, and on real hardware it is not: a monitor's bezel is a dark ring
 * whose bounding box encloses the entire screen, so the detector locked onto
 * the monitor and sampled it as if it were the payload. Nothing decoded, and
 * every counter stayed at zero.
 *
 * There is no reliable way to tell a bezel from a frame by shape alone (thin
 * bezels and coarse grids overlap), so this returns several candidates and lets
 * the caller settle it the only way that cannot be fooled: sample each one and
 * see whether the frame structure and CRC agree.
 *
 * Components touching the image border are skipped, so a dark background or a
 * frame running off the edge cannot pose as a candidate — which is why the
 * sender must render a light quiet zone.
 */
// Reused across calls: at 1600x900 these are 11 MB per scan, and allocating
// them per frame is pure GC pressure on a phone.
let scratchLabels = null, scratchStack = null;

export function findQuadsInMask(mask, width, height, limit = 8) {
  const n = width * height;
  if (!scratchLabels || scratchLabels.length < n) {
    scratchLabels = new Int32Array(n);
    scratchStack = new Int32Array(n);
  }
  const labels = scratchLabels, stack = scratchStack;
  labels.fill(-1, 0, n);
  const found = [];

  for (let start = 0; start < n; start++) {
    if (labels[start] !== -1 || !mask[start]) continue;

    let sp = 0, size = 0;
    stack[sp++] = start;
    labels[start] = start;
    let minX = width, maxX = -1, minY = height, maxY = -1, touchesBorder = false;
    let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
    let tl = 0, br = 0, tr = 0, bl = 0;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width, y = (p / width) | 0;
      size++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const sum = x + y, diff = x - y;
      if (sum < minSum) { minSum = sum; tl = p; }
      if (sum > maxSum) { maxSum = sum; br = p; }
      if (diff > maxDiff) { maxDiff = diff; tr = p; }
      if (diff < minDiff) { minDiff = diff; bl = p; }

      if (x > 0 && labels[p - 1] === -1 && mask[p - 1]) { labels[p - 1] = start; stack[sp++] = p - 1; }
      if (x < width - 1 && labels[p + 1] === -1 && mask[p + 1]) { labels[p + 1] = start; stack[sp++] = p + 1; }
      if (y > 0 && labels[p - width] === -1 && mask[p - width]) { labels[p - width] = start; stack[sp++] = p - width; }
      if (y < height - 1 && labels[p + width] === -1 && mask[p + width]) { labels[p + width] = start; stack[sp++] = p + width; }
    }

    if (touchesBorder || size < 64) continue;

    const w = maxX - minX + 1, h = maxY - minY + 1;
    const area = w * h;
    if (area < 1024) continue;
    // A frame stays roughly square even under perspective; reject slivers.
    if (Math.min(w, h) / Math.max(w, h) < 0.25) continue;
    // The ring is thin: a solid dark blob filling its own box is not a frame.
    const fill = size / area;
    if (fill > 0.75) continue;

    const pt = (p) => [p % width, (p / width) | 0];
    found.push({ corners: [pt(tl), pt(tr), pt(br), pt(bl)], size, boundingArea: area, fill });
  }

  found.sort((a, b) => b.boundingArea - a.boundingArea);
  return found.slice(0, limit);
}

/** Grayscale -> candidates, binarising by local contrast. */
export function findQuads(gray, width, height, limit = 8, opts) {
  return findQuadsInMask(inkMask(gray, width, height, opts), width, height, limit);
}

/** Best single candidate, or null. Kept for callers that do not verify. */
export function findQuad(gray, width, height) {
  const quads = findQuads(gray, width, height, 1);
  return quads.length ? quads[0] : null;
}

/**
 * Projective map from the unit square to a quad.
 * (0,0)->TL, (1,0)->TR, (1,1)->BR, (0,1)->BL.
 */
export function homography([[x0, y0], [x1, y1], [x2, y2], [x3, y3]]) {
  const dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(den) < 1e-9) return null;

  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;

  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

/**
 * Read an n x n grid out of a camera image.
 * Returns raw per-cell luminance plus the ring-calibrated binary grid.
 */
/**
 * Unsharp mask over the cell grid: level + amount * (level - 3x3 mean).
 * Undoes, approximately, the blur that spreads one cell's brightness into its
 * neighbours — the dominant error source once pixels per module gets tight.
 *
 * Deliberately in cell space. Sharpening the camera image would amplify the
 * screen/sensor moire this channel already suffers from; sharpening cells
 * attacks inter-cell bleed, which is what actually costs bits.
 */
export function sharpenCells(levels, n, amount) {
  if (amount <= 0) return levels;
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    const r0 = r > 0 ? r - 1 : 0, r1 = r < n - 1 ? r + 1 : n - 1;
    for (let c = 0; c < n; c++) {
      const c0 = c > 0 ? c - 1 : 0, c1 = c < n - 1 ? c + 1 : n - 1;
      let sum = 0, count = 0;
      for (let rr = r0; rr <= r1; rr++) {
        for (let cc = c0; cc <= c1; cc++) { sum += levels[rr * n + cc]; count++; }
      }
      const v = levels[r * n + c];
      out[r * n + c] = v + amount * (v - sum / count);
    }
  }
  return out;
}

/** Mean over a (2w+1)^2 cell window, via an integral image. */
export function boxMean(levels, n, w) {
  const iw = n + 1;
  const integral = new Float64Array(iw * (n + 1));
  for (let r = 0; r < n; r++) {
    let rowSum = 0;
    for (let c = 0; c < n; c++) {
      rowSum += levels[r * n + c];
      integral[(r + 1) * iw + c + 1] = integral[r * iw + c + 1] + rowSum;
    }
  }
  const out = new Float32Array(n * n);
  for (let r = 0; r < n; r++) {
    const r0 = r - w < 0 ? 0 : r - w, r1 = r + w >= n ? n - 1 : r + w;
    for (let c = 0; c < n; c++) {
      const c0 = c - w < 0 ? 0 : c - w, c1 = c + w >= n ? n - 1 : c + w;
      const sum = integral[(r1 + 1) * iw + c1 + 1] - integral[r0 * iw + c1 + 1]
                - integral[(r1 + 1) * iw + c0] + integral[r0 * iw + c0];
      out[r * n + c] = sum / ((r1 - r0 + 1) * (c1 - c0 + 1));
    }
  }
  return out;
}

/**
 * Unsharp amount and adaptive-threshold window, both measured in cells.
 *
 * Swept over grids {64,128} x pixels-per-module {4.0,4.5,5.5,7.0} x four
 * lighting cases (brightness gradient, glare patch, both, plus extra blur):
 *
 *   no preprocessing        89/128      at 4.5 px/module: 16/32
 *   adaptive threshold     110/128                        30/32
 *   sharpen 0.3 + adaptive 111/128                        31/32
 *   sharpen 0.7 + adaptive 105/128                        26/32
 *
 * The adaptive cut is what pays; heavy sharpening actively hurts alongside it,
 * because the noise it amplifies is noise the local mean then tracks. Under
 * even lighting neither does much — the binding constraint there is sampling
 * resolution, not thresholding.
 */
export const SHARPEN = 0.3;
export const LOCAL_WINDOW = 8;

/**
 * Read an n x n grid of cell levels.
 *
 * `stride`/`offset` let the same code read a packed luminance buffer (1, 0) or
 * one channel of an RGBA capture (4, 0..2), so colour sampling costs three
 * passes of this rather than a second implementation of it.
 */
export function sampleGrid(buf, width, height, corners, n, stride = 1, offset = 0) {
  const map = homography(corners);
  if (!map) return null;

  const levels = new Float32Array(n * n);
  // 3x3 subsample per cell, kept close to the centre: sampling wider averages
  // out sensor noise but drags in neighbouring cells once the image is blurred,
  // and inter-cell bleed costs more bits than noise does.
  const offsets = [0.38, 0.5, 0.62];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      let acc = 0, count = 0;
      for (const dv of offsets) {
        for (const du of offsets) {
          const [x, y] = map((c + du) / n, (r + dv) / n);
          // Bilinear: at a few pixels per module, rounding to the nearest pixel
          // is itself a significant error term.
          const fx = x - 0.5, fy = y - 0.5;
          const x0 = Math.floor(fx), y0 = Math.floor(fy);
          if (x0 < 0 || y0 < 0 || x0 + 1 >= width || y0 + 1 >= height) continue;
          const tx = fx - x0, ty = fy - y0;
          const i0 = (y0 * width + x0) * stride + offset, i1 = i0 + width * stride;
          acc += buf[i0] * (1 - tx) * (1 - ty) + buf[i0 + stride] * tx * (1 - ty)
               + buf[i1] * (1 - tx) * ty       + buf[i1 + stride] * tx * ty;
          count++;
        }
      }
      levels[r * n + c] = count ? acc / count : 255;
    }
  }

  // ---- preprocessing, in cell space rather than pixel space ----
  //
  // Both steps run on per-cell levels, not on the camera image. Sharpening
  // pixels would amplify the screen/sensor moire that this channel already
  // suffers from; sharpening cells attacks the thing that actually costs bits,
  // which is optical blur bleeding a cell's value into its neighbours.
  const sharp = sharpenCells(levels, n, SHARPEN);

  // Self-calibrate from the rings this frame actually carries.
  let blackSum = 0, blackN = 0, whiteSum = 0, whiteN = 0;
  const hi = n - 1;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ring = Math.min(r, c, hi - r, hi - c);
      if (ring === 0) { blackSum += sharp[r * n + c]; blackN++; }
      else if (ring === 1) { whiteSum += sharp[r * n + c]; whiteN++; }
    }
  }
  if (!blackN || !whiteN) return null;

  const black = blackSum / blackN, white = whiteSum / whiteN;
  if (white - black < 12) return null; // no usable contrast; drop the frame

  // Adaptive threshold. A single global cut is wrong whenever the screen is
  // not evenly lit — viewing angle, glare and backlight gradients all tilt one
  // side of the matrix — so each cell is cut against its own neighbourhood.
  // Clamped into the middle half of the calibrated range so that a uniformly
  // white or uniformly black patch, where the local mean carries no
  // information, still resolves the way the rings say it should.
  const local = boxMean(sharp, n, LOCAL_WINDOW);
  const lo = black + 0.25 * (white - black);
  const highCut = white - 0.25 * (white - black);
  const threshold = (black + white) / 2;


  // Signal margin: how bimodal the *raw* cell levels are, on a scale where 1
  // means every cell sits at full black or full white and 0 means they have
  // all collapsed to mid grey.
  //
  // Measured against the calibrated midpoint, not the adaptive threshold, and
  // before sharpening — both of those track the signal and would report a
  // healthy margin for a picture that carries no information.
  //
  // This is what separates the two ways a frame can pass its structure check
  // and still fail its CRC. Blur, moire and too few pixels per module pull
  // levels toward the middle, so the margin collapses and the bits are
  // guesses. A capture spanning a screen update does the opposite: the bits
  // are crisp and confident, and simply belong to the wrong frame. Same
  // symptom, opposite remedies — one wants a bigger module or a closer shot,
  // the other a shorter exposure.
  let rawBlack = 0, rawBlackN = 0, rawWhite = 0, rawWhiteN = 0;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const ring = Math.min(r, c, hi - r, hi - c);
      if (ring === 0) { rawBlack += levels[r * n + c]; rawBlackN++; }
      else if (ring === 1) { rawWhite += levels[r * n + c]; rawWhiteN++; }
    }
  }
  const rawMid = (rawBlack / rawBlackN + rawWhite / rawWhiteN) / 2;
  const rawHalfRange = (rawWhite / rawWhiteN - rawBlack / rawBlackN) / 2;
  let marginSum = 0;
  for (let i = 0; i < levels.length; i++) {
    marginSum += Math.min(1, Math.abs(levels[i] - rawMid) / rawHalfRange);
  }
  const margin = marginSum / levels.length;

  return { sharp, levels, local, black, white, threshold, lo, highCut, margin, n };
}

/**
 * Sample -> cell values, at whatever modulation depth the layout uses.
 *
 * Binary keeps the per-cell adaptive cut. Multi-level cannot: its steps sit a
 * third as far apart, so it needs both a reference for every level and a way to
 * follow local brightness. The references come from the timing ring, which
 * cycles through all of them, and the local shift from a wide box mean of the
 * cells themselves — in a field with a roughly even level mix that mean tracks
 * illumination rather than data. Glare is exactly that kind of shift, and the
 * correction takes multi-level symbol error from 4.9-10.7% down to 0.5-2.2%.
 */
export function quantize(sample, layout) {
  const n = sample.n;
  const cells = new Uint8Array(n * n);

  if (layout.levels === 2) {
    for (let i = 0; i < cells.length; i++) {
      let t = sample.local[i];
      if (t < sample.lo) t = sample.lo; else if (t > sample.highCut) t = sample.highCut;
      // Cell values are levels now: 0 darkest, 1 lightest.
      cells[i] = sample.sharp[i] < t ? 0 : 1;
    }
    return cells;
  }

  // Ring index of the timing ring; kept local so this module stays free of the
  // matrix layout's imports.
  const TIMING_RING = 2;
  const hi = n - 1, levels = layout.levels;
  const sums = new Float64Array(levels), counts = new Uint32Array(levels);
  for (let i = TIMING_RING; i <= hi - TIMING_RING; i++) {
    for (const [r, c] of [[TIMING_RING, i], [hi - TIMING_RING, i],
                          [i, TIMING_RING], [i, hi - TIMING_RING]]) {
      const want = layout.structureAt(r, c);
      if (want < 0) continue;
      sums[want] += sample.sharp[r * n + c];
      counts[want]++;
    }
  }
  const refs = new Float64Array(levels);
  for (let L = 0; L < levels; L++) {
    if (!counts[L]) return null;                  // ring never carried this level
    refs[L] = sums[L] / counts[L];
  }
  // Report what the optical chain actually delivered before judging it. Display
  // gamma and camera gamma roughly cancel, but auto-exposure and tone curves do
  // not, and a level pair that arrives too close together cannot be recovered
  // by any amount of calibration.
  sample.refs = refs;
  let minGap = Infinity;
  for (let L = 1; L < levels; L++) {
    const gap = refs[L] - refs[L - 1];
    if (gap < minGap) minGap = gap;
  }
  sample.minGap = minGap;
  for (let L = 1; L < levels; L++) if (refs[L] <= refs[L - 1]) return null;

  let mean = 0;
  for (let i = 0; i < sample.sharp.length; i++) mean += sample.sharp[i];
  mean /= sample.sharp.length;

  // Clamp the illumination correction to a quarter of one level step. It has
  // to follow a glare gradient, but left unbounded it also follows the rings —
  // whose extreme values skew the local mean — and can shove a cell across a
  // decision boundary. Unclamped this misread one cell in 3348 on a render
  // with no blur and no noise at all.
  const step = (refs[levels - 1] - refs[0]) / (levels - 1);
  const limit = step / 4;

  for (let i = 0; i < cells.length; i++) {
    let shift = sample.local[i] - mean;
    if (shift > limit) shift = limit; else if (shift < -limit) shift = -limit;
    const v = sample.sharp[i] - shift;
    let best = 0, bestD = Infinity;
    for (let L = 0; L < levels; L++) {
      const d = Math.abs(v - refs[L]);
      if (d < bestD) { bestD = d; best = L; }
    }
    cells[i] = best;
  }
  return cells;
}

/**
 * Colour: three independent binary planes, one bit per channel.
 *
 * More robust than four grey levels, not less. Four levels put three decision
 * boundaries inside one dynamic range, leaving each about a sixth of it as
 * margin; three channels give three separate decisions, each with the full
 * margin of plain binary. Per-channel references from the timing ring absorb
 * white balance outright, and measured symbol error stays at 0.07% even with
 * 30% channel cross-talk at 4 px/module.
 */
export function quantizeColor(samples, layout) {
  const n = samples[0].n;
  const cells = new Uint8Array(n * n);
  const TIMING_RING = 2;
  const hi = n - 1;

  for (let ch = 0; ch < 3; ch++) {
    const sample = samples[ch];
    const bit = 2 - ch;                       // value is (R<<2)|(G<<1)|B
    const local = boxMean(sample.sharp, n, LOCAL_WINDOW);

    // This channel's on and off references, read off the timing ring.
    let on = 0, onN = 0, off = 0, offN = 0;
    for (let i = TIMING_RING; i <= hi - TIMING_RING; i++) {
      for (const [r, c] of [[TIMING_RING, i], [hi - TIMING_RING, i],
                            [i, TIMING_RING], [i, hi - TIMING_RING]]) {
        const want = layout.structureAt(r, c);
        if (want < 0) continue;
        const v = sample.sharp[r * n + c];
        if ((want >> bit) & 1) { on += v; onN++; } else { off += v; offN++; }
      }
    }
    if (!onN || !offN) return null;

    const onRef = on / onN, offRef = off / offN;
    if (onRef - offRef < 12) return null;     // this channel carries no signal

    const lo = offRef + 0.25 * (onRef - offRef);
    const highCut = onRef - 0.25 * (onRef - offRef);
    for (let i = 0; i < cells.length; i++) {
      let t = local[i];
      if (t < lo) t = lo; else if (t > highCut) t = highCut;
      if (sample.sharp[i] >= t) cells[i] |= 1 << bit;
    }
  }
  return cells;
}

/**
 * Convenience pipeline over the single best candidate. Real receiving goes
 * through Scanner, which tries every candidate and verifies; this is for
 * callers that already know the frame is the only dark object in the image.
 */
export function detect(gray, width, height, n, layout = null, rgba = null) {
  const quad = findQuad(gray, width, height);
  if (!quad) return null;
  const sample = sampleGrid(gray, width, height, quad.corners, n);
  if (!sample) return null;

  const target = layout || { levels: 2 };
  let cells;
  if (target.color) {
    // Colour needs the channels, which the brightness plane has discarded.
    if (!rgba) return null;
    const planes = [0, 1, 2].map(
      (ch) => sampleGrid(rgba, width, height, quad.corners, n, 4, ch));
    if (planes.some((p) => !p)) return null;
    cells = quantizeColor(planes, target);
  } else {
    cells = quantize(sample, target);
  }
  if (!cells) return null;
  return { ...sample, cells, corners: quad.corners };
}
