// VDTP visual layer: bytes <-> N x N cell matrix (V2.0 §5 frame structure).
//
// Deliberately not QR. We own both ends, so we skip QR's format info, mode
// segments, alignment patterns and GF(256) ECC entirely — integrity is already
// handled by the frame CRC32 (§9 level 1) and frame loss by the fountain layer
// (§9 level 2). What is left is the minimum a camera actually needs: something
// to find, something to measure pitch with, and something to fix rotation.
//
// Ring layout, outermost first:
//   ring 0  solid black   quad detection target
//   ring 1  solid white   separation, keeps ring 0 from bleeding into data
//   ring 2  timing        alternating cells, verifies grid pitch
//   inner   payload, minus a 2x2 orientation block in each corner
//
// Orientation: top-left inner block is black, the other three are white, so a
// decoder can try four rotations and keep the one that matches.

import { eccEncode, eccCapacity, ECC_REDUNDANCY } from '../core/ecc.js';
import { OVERHEAD } from '../core/frame.js';
import { mix32 } from '../core/prng.js';

/**
 * Deterministic mask applied to payload bytes before they become cells.
 *
 * Without it a frame's content decides its appearance, and sparse content
 * makes a terrible optical target: the handshake frame is mostly padding, so
 * 91% of its modules landed on one level. That biases the camera's
 * auto-exposure, and it breaks the multi-level decoder outright, whose local
 * brightness correction assumes a roughly even mix of levels — a 4-level
 * handshake frame failed to decode even in simulation.
 *
 * Masking is why QR codes have a masking stage. mix32 is reused because it is
 * already proven identical between the C and JS implementations.
 */
export function maskByte(index) {
  return mix32(index >>> 0) & 0xff;
}

/**
 * Gray coding for multi-level symbols: adjacent levels differ in exactly one
 * bit, so the misreads that actually happen — confusing a level with its
 * neighbour — cost one bit instead of two. Identity at 1 bit per cell.
 */
export function grayEncode(v) { return v ^ (v >>> 1); }


export function grayDecode(g) {
  let v = g;
  for (let shift = 1; shift < 8; shift <<= 1) v ^= v >>> shift;
  return v;
}

/** Big-endian bit packing, `width` bits at a time. */
function readBits(bytes, bit, width) {
  let v = 0;
  for (let i = 0; i < width; i++) {
    const p = bit + i, byte = p >> 3;
    const src = byte < bytes.length ? bytes[byte] ^ maskByte(byte) : maskByte(byte);
    v = (v << 1) | ((src >> (7 - (p & 7))) & 1);
  }
  return v;
}

function writeBits(out, bit, width, value) {
  for (let i = 0; i < width; i++) {
    const p = bit + i, byte = p >> 3;
    if (byte >= out.length) return;
    const bitValue = ((value >> (width - 1 - i)) & 1) ^ ((maskByte(byte) >> (7 - (p & 7))) & 1);
    if (bitValue) out[byte] |= 1 << (7 - (p & 7));
  }
}

export const RING_BLACK = 0;
export const RING_WHITE = 1;
export const RING_TIMING = 2;
export const BORDER = 3;      // rings consumed before payload starts
export const ORIENT = 2;      // orientation block is ORIENT x ORIENT

/**
 * Modulation depths the format allows.
 *
 *   2  one bit per module, black and white
 *   4  two bits, grey levels — cheap but with only a third of binary's margin
 *   8  three bits, one per colour channel — three full-margin binary decisions
 *
 * Eight is colour, not eight greys: the value is (R<<2)|(G<<1)|B and each bit
 * drives a channel fully on or off.
 */
export const LEVELS = [2, 4, 8];

/** True when the depth is carried by colour channels rather than brightness. */
export const isColor = (levels) => levels === 8;

/**
 * Grid sizes the format defines, coarsest-likeliest first.
 *
 * Single source of truth for both ends. A sender offering a size the scanner
 * does not try produces a frame nobody can read, with no error anywhere —
 * which is what happened when 96 was added to the sender alone.
 */
export const GRIDS = [64, 96, 128, 32, 48, 160, 192, 256];

export class MatrixLayout {
  /**
   * `levels` is how many brightness steps a module carries. Four doubles the
   * payload at *unchanged* module size, which matters because the binding
   * limit on this channel is spatial frequency — blur and moire destroy fine
   * detail long before they touch contrast, and a link with margin to spare
   * should spend it on depth rather than on smaller modules.
   *
   * Measured symbol error, 64 modules: identical to binary (0%) when clear,
   * blurred or unevenly lit, even at 5 px/module. Under a glare patch it costs
   * something — 0.5-2.2% against binary's 0% — because the steps sit a third as
   * far apart. Correction absorbs that; the receiver tries both depths and
   * keeps whichever the frame structure confirms.
   */
  constructor(n, levels = 2) {
    if (!Number.isInteger(n) || n < 4 * BORDER + 4 * ORIENT) {
      throw new RangeError(`matrix size ${n} is too small`);
    }
    if (!LEVELS.includes(levels)) throw new RangeError(`levels ${levels} unsupported`);
    this.n = n;
    this.levels = levels;
    this.color = isColor(levels);
    // Gray coding helps when neighbouring *levels* get confused, which is the
    // grey-scale failure. Colour errors are single channels flipping, and the
    // channel encoding already costs exactly one bit for that, so Gray coding
    // would only scramble it.
    this.grayCoded = levels === 4;
    this.bitsPerCell = Math.log2(levels);
    this.inner = n - 2 * BORDER;
    this.cellCount = this.inner * this.inner - 4 * ORIENT * ORIENT;
    this.capacityBits = this.cellCount * this.bitsPerCell;
    this.capacityBytes = this.capacityBits >> 3;
    // At three bits per cell the last cell straddles the final byte, so encode
    // and decode have to agree on how many cells carry data. Round *up*: the
    // cell covering the last byte's tail is needed, and the bits it holds past
    // the buffer are simply dropped on the way back. Cells beyond this still
    // get a mask-derived value so they look like the rest.
    this.usableCells = Math.min(
      this.cellCount, Math.ceil((this.capacityBytes * 8) / this.bitsPerCell));
  }

  /** Cells that carry structure rather than payload. */
  isReserved(r, c) {
    const n = this.n, lo = BORDER, hi = n - BORDER - 1;
    if (r < lo || c < lo || r > hi || c > hi) return true; // rings
    const inOrient = (rr, cc) => rr < ORIENT && cc < ORIENT;
    return inOrient(r - lo, c - lo)
        || inOrient(r - lo, hi - c)
        || inOrient(hi - r, c - lo)
        || inOrient(hi - r, hi - c);
  }

  /**
   * Structural cell value, or -1 for payload cells.
   *
   * Values are levels, not ink: 0 is darkest and `levels - 1` lightest, which
   * for a binary matrix reduces to the old 1-is-black convention inverted
   * consistently everywhere. The timing ring cycles through *every* level, so
   * a multi-level frame carries its own brightness calibration and a receiver
   * can tell the two depths apart by which pattern fits.
   */
  structureAt(r, c) {
    const n = this.n, hi = n - 1, top = this.levels - 1;
    const ring = Math.min(r, c, hi - r, hi - c);
    if (ring === RING_BLACK) return 0;
    if (ring === RING_WHITE) return top;
    if (ring === RING_TIMING) {
      const along = (r === ring || r === hi - ring) ? c : r;
      return along % this.levels;
    }
    const lo = BORDER, hiI = n - BORDER - 1;
    const orient = (rr, cc) => rr < ORIENT && cc < ORIENT;
    if (orient(r - lo, c - lo)) return 0;            // top-left: darkest
    if (orient(r - lo, hiI - c)) return top;
    if (orient(hiI - r, c - lo)) return top;
    if (orient(hiI - r, hiI - c)) return top;
    return -1;
  }

  /**
   * Split the payload area into `count` horizontal bands.
   *
   * Each band carries a complete, independently checked frame, so a capture
   * that spans a screen update loses only the band or two straddling the tear
   * instead of everything. That is the established fix for unsynchronised
   * screen-camera links (LightSync, MobiCom 2013): decode the imperfect frame
   * rather than discard it.
   *
   * Bands are cut on cell rows, so their capacities differ slightly where the
   * orientation blocks sit; each band reports its own.
   */
  bands(count) {
    const lo = BORDER, hi = this.n - BORDER - 1;
    const rows = hi - lo + 1;
    if (!Number.isInteger(count) || count < 1 || count > rows) {
      throw new RangeError(`band count ${count} does not fit ${rows} rows`);
    }
    const out = [];
    for (let b = 0; b < count; b++) {
      const from = lo + Math.floor((b * rows) / count);
      const to = lo + Math.floor(((b + 1) * rows) / count) - 1;
      let cells = 0;
      for (let r = from; r <= to; r++) {
        for (let c = lo; c <= hi; c++) if (!this.isReserved(r, c)) cells++;
      }
      const bits = cells * this.bitsPerCell;
      out.push({ from, to, bits, bytes: bits >> 3 });
    }
    return out;
  }

  /** Payload cell coordinates of one band, row-major. */
  *bandCells(band) {
    const lo = BORDER, hi = this.n - BORDER - 1;
    for (let r = band.from; r <= band.to; r++) {
      for (let c = lo; c <= hi; c++) if (!this.isReserved(r, c)) yield [r, c];
    }
  }

  /** Payload cell coordinates, row-major — the bit order both ends agree on. */
  *payloadCells() {
    const lo = BORDER, hi = this.n - BORDER - 1;
    for (let r = lo; r <= hi; r++) {
      for (let c = lo; c <= hi; c++) {
        if (!this.isReserved(r, c)) yield [r, c];
      }
    }
  }

  /** bytes -> Uint8Array(n*n) of 0/1, zero-padded to capacity. */
  encode(bytes) {
    if (bytes.length > this.capacityBytes) {
      throw new RangeError(`${bytes.length} bytes exceeds capacity ${this.capacityBytes}`);
    }
    const n = this.n;
    const cells = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const s = this.structureAt(r, c);
        if (s >= 0) cells[r * n + c] = s;
      }
    }
    let bit = 0;
    const w = this.bitsPerCell;
    for (const [r, c] of this.payloadCells()) {
      const raw = readBits(bytes, bit, w);
      cells[r * n + c] = this.grayCoded ? grayEncode(raw) : raw;
      bit += w;
    }
    return cells;
  }

  /** Inverse of encode. Length is capacityBytes; the caller trims via the frame header. */
  decode(cells) {
    const out = new Uint8Array(this.capacityBytes);
    let bit = 0, used = 0;
    const w = this.bitsPerCell;
    for (const [r, c] of this.payloadCells()) {
      if (used++ >= this.usableCells) break;
      const cell = cells[r * this.n + c];
      writeBits(out, bit, w, this.grayCoded ? grayDecode(cell) : cell);
      bit += w;
    }
    return out;
  }

  /**
   * How badly `cells` violates the expected structure, as a fraction in [0,1].
   * Used to pick the right rotation and to reject frames that are not VDTP.
   */
  structureError(cells) {
    const n = this.n;
    let checked = 0, wrong = 0;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const s = this.structureAt(r, c);
        if (s < 0) continue;
        checked++;
        if (cells[r * n + c] !== s) wrong++;
      }
    }
    return wrong / checked;
  }
}

/** Rotate an n x n cell grid by 90 degrees clockwise, `times` times. */
export function rotate(cells, n, times) {
  let cur = cells;
  for (let t = 0; t < ((times % 4) + 4) % 4; t++) {
    const next = new Uint8Array(n * n);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) next[c * n + (n - 1 - r)] = cur[r * n + c];
    }
    cur = next;
  }
  return cur;
}

/**
 * Best of the four rotations, always. Returns the error even when it is far too
 * high to be a frame, because "how wrong was the closest match" is the number
 * that tells you whether a receiver is nearly working or nowhere near.
 */
export function bestOrientation(cells, layout) {
  let best = null, bestErr = Infinity, bestTurns = 0;
  for (let t = 0; t < 4; t++) {
    const candidate = rotate(cells, layout.n, t);
    const err = layout.structureError(candidate);
    if (err < bestErr) { bestErr = err; best = candidate; bestTurns = t; }
  }
  return { cells: best, error: bestErr, turns: bestTurns };
}

/** As bestOrientation, but null when even the best rotation is not a frame. */
export function orient(cells, layout, tolerance = 0.25) {
  const best = bestOrientation(cells, layout);
  return best.error <= tolerance ? best : null;
}

/**
 * Several independent frames -> one cell grid, one frame per band.
 *
 * `buffers[i]` must already be exactly `bands[i].bytes` long — the caller sizes
 * its frames and correction to the band, since each band stands alone.
 */
export function encodeBands(layout, bands, buffers) {
  const n = layout.n;
  const cells = new Uint8Array(n * n);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const s = layout.structureAt(r, c);
      if (s >= 0) cells[r * n + c] = s;
    }
  }
  for (let b = 0; b < bands.length; b++) {
    const buf = buffers[b];
    let bit = 0;
    const w = layout.bitsPerCell;
    for (const [r, c] of layout.bandCells(bands[b])) {
      const raw = readBits(buf, bit, w);
      cells[r * n + c] = layout.grayCoded ? grayEncode(raw) : raw;
      bit += w;
    }
  }
  return cells;
}

/** Inverse of encodeBands: cells -> one byte buffer per band. */
export function decodeBands(layout, bands, cells) {
  const n = layout.n;
  return bands.map((band) => {
    const out = new Uint8Array(band.bytes);
    const usable = Math.ceil((band.bytes * 8) / layout.bitsPerCell);
    let bit = 0, used = 0;
    const w = layout.bitsPerCell;
    for (const [r, c] of layout.bandCells(band)) {
      if (used++ >= usable) break;
      const cell = cells[r * n + c];
      writeBits(out, bit, w, layout.grayCoded ? grayDecode(cell) : cell);
      bit += w;
    }
    return out;
  });
}

/**
 * Serialised frame -> cells, optionally wrapped in intra-frame correction.
 *
 * The receiver is not told which was used: it tries the plain reading first,
 * which costs a CRC check, and falls back to the corrected one. That keeps the
 * choice out of the wire format, where it would need signalling that itself
 * has to survive the errors it is describing.
 */
export function encodeFrameCells(layout, frameBytes, ecc = true) {
  return layout.encode(ecc
    ? eccEncode(frameBytes, layout.capacityBytes, ECC_REDUNDANCY)
    : frameBytes);
}

/** Most bands worth cutting: past this the per-band frame header dominates. */
export const MAX_BANDS = 8;

/**
 * Share of captures that span a screen update. Set from what the hardware
 * reports: with the sender at 10 FPS and a rolling shutter reading over
 * roughly a third of that period, plus panel response time, a little under
 * half of all captures straddle a boundary.
 */
export const TEAR_RATE = 0.4;

/**
 * Choose a band count by maximising the payload a capture actually delivers.
 *
 * Two forces pull opposite ways. More bands means a tear costs a smaller
 * fraction — one band in `count` — but each band repeats the 25-byte frame
 * header and rounds its own correction blocks, so total payload shrinks.
 *
 * Expected delivery is `payload x [(1 - t) + t x (count-1)/count]`, which
 * reduces to `payload x (1 - t/count)`. Scoring an unsplit frame on payload
 * alone would let it win every time by ignoring that a tear costs it
 * everything — the whole reason bands exist.
 *
 * The optimum genuinely moves with the grid: 4 bands at 64, 8 by 128.
 */
export function planBands(layout, redundancy = ECC_REDUNDANCY, tearRate = TEAR_RATE) {
  let best = null;
  for (let count = 1; count <= MAX_BANDS; count++) {
    let bands;
    try { bands = layout.bands(count); } catch { break; }

    let payload = 0, frameBudget = Infinity, viable = true;
    for (const band of bands) {
      const budget = eccCapacity(band.bytes, redundancy) - OVERHEAD;
      if (budget < 24) { viable = false; break; }
      payload += budget;
      if (budget < frameBudget) frameBudget = budget;
    }
    if (!viable) continue;

    const delivered = payload * (1 - tearRate / count);
    // frameBudget is the *smallest* band: one payload size that fits every
    // band means the sender can emit interchangeable frames instead of sizing
    // each to its slot, and a band that ends up short simply pads.
    if (!best || delivered > best.delivered) {
      best = { count, bands, payload, frameBudget, delivered };
    }
  }
  if (!best) throw new RangeError(`grid ${layout.n} is too small to carry a frame`);
  return best;
}

/**
 * Frames -> cells, one frame per band, each independently correctable.
 *
 * `frames[i]` is a serialised VDTP frame no longer than the band's ECC budget;
 * it is wrapped and padded to fill the band exactly.
 */
export function encodeFrameBands(layout, plan, frames, ecc = true) {
  const buffers = plan.bands.map((band, i) => {
    const frame = frames[i];
    if (ecc) return eccEncode(frame, band.bytes, ECC_REDUNDANCY);
    const out = new Uint8Array(band.bytes);
    out.set(frame.subarray(0, Math.min(frame.length, band.bytes)));
    return out;
  });
  return encodeBands(layout, plan.bands, buffers);
}
