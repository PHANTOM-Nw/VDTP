// LT fountain code (spec §8, Level 2 reliability).
//
// The whole point: the receiver never asks for a specific frame. The sender
// emits an unbounded stream of encoded symbols; once enough *independent*
// symbols land, the file reconstructs. There is no ACK and no retransmission,
// which is what makes a one-way optical channel workable.
//
// Sender and receiver never exchange neighbour sets — only a uint32 seed per
// frame. Both derive the same degree and the same source-block indices from it.
import { makeRng } from './prng.js';

// Robust soliton parameters. C was swept over K in {205, 512, 1400, 2048} at
// loss rates {0, 15, 30, 50}%: C=0.05 gave the best and most K-stable decode
// overhead (~1.22x average, ~1.38x worst). C=0.01 cost ~8 points more.
const C = 0.05;
const DELTA = 0.05;

/**
 * Robust soliton CDF over degrees 1..K, quantised to CDF_SCALE.
 *
 * Integer, deliberately. The distribution needs log() and sqrt(), and glibc and
 * V8 may disagree in the last ULP; a single degree that differs between the C
 * sender and the JS receiver makes the decoder XOR the wrong source blocks and
 * silently corrupts the file until SHA-256 catches it at the very end.
 * Quantising collapses that into a discrete table that ports can be proved
 * identical to, byte for byte, instead of sampled and hoped about.
 */
export const CDF_SCALE = 1 << 24;

export function solitonCdf(K) {
  if (!Number.isInteger(K) || K < 1) throw new RangeError(`K must be a positive integer, got ${K}`);
  const cdf = new Uint32Array(K + 1);
  if (K === 1) { cdf[1] = CDF_SCALE; return cdf; }

  const R = C * Math.log(K / DELTA) * Math.sqrt(K);
  const pivot = Math.floor(K / R);
  const p = new Float64Array(K + 1);

  for (let i = 1; i <= K; i++) {
    const rho = i === 1 ? 1 / K : 1 / (i * (i - 1));
    let tau = 0;
    if (i < pivot) tau = R / (i * K);
    else if (i === pivot) tau = (R * Math.log(R / DELTA)) / K;
    p[i] = rho + tau;
  }

  let beta = 0;
  for (let i = 1; i <= K; i++) beta += p[i];

  let acc = 0;
  for (let i = 1; i <= K; i++) {
    acc += p[i] / beta;
    const q = Math.floor(acc * CDF_SCALE);
    cdf[i] = q > CDF_SCALE ? CDF_SCALE : q;
  }
  cdf[K] = CDF_SCALE; // absorb quantisation loss into the last degree
  return cdf;
}

/** Source-block indices XORed into the symbol carried by `seed`. */
export function neighbours(seed, K, cdf) {
  const rng = makeRng(seed);
  const u = rng() >>> 8; // 24 bits, matching CDF_SCALE

  let lo = 1, hi = K;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (u < cdf[mid]) hi = mid; else lo = mid + 1;
  }
  const degree = Math.min(lo, K);

  const picked = [];
  const seen = new Set();
  while (picked.length < degree) {
    const i = rng() % K;
    if (!seen.has(i)) { seen.add(i); picked.push(i); }
  }
  return picked;
}

function xorInto(dst, src) {
  for (let i = 0; i < dst.length; i++) dst[i] ^= src[i];
}

/** Split a payload into K fixed-size blocks, zero-padding the tail. */
export function toBlocks(bytes, blockSize) {
  const K = Math.max(1, Math.ceil(bytes.length / blockSize));
  const blocks = [];
  for (let i = 0; i < K; i++) {
    const b = new Uint8Array(blockSize);
    b.set(bytes.subarray(i * blockSize, Math.min((i + 1) * blockSize, bytes.length)));
    blocks.push(b);
  }
  return blocks;
}

export class LtEncoder {
  constructor(bytes, blockSize) {
    this.blocks = toBlocks(bytes, blockSize);
    this.K = this.blocks.length;
    this.blockSize = blockSize;
    this.byteLength = bytes.length;
    this.cdf = solitonCdf(this.K);
  }

  /**
   * Symbol for `seed` — always genuine random-degree fountain output.
   *
   * Seeds 1..K used to be a systematic prefix, sending block seed-1 plain, so
   * a lossless channel finished in exactly K frames. It costs more than it
   * saves on a channel that always loses frames: once the prefix has delivered
   * most blocks, a later low-degree symbol usually covers only blocks already
   * known, reduces to nothing, and is discarded. Measured decode overhead at
   * K=2048 went 1.239 -> 1.148 by removing it, and at K=7000, 1.250 -> 1.100.
   *
   * The trade is real but one-sided here: at small K (a few hundred blocks)
   * the prefix was slightly ahead. Bands made block sizes small enough that
   * real transfers sit at K in the thousands, where the prefix loses.
   */
  symbol(seed) {
    const out = new Uint8Array(this.blockSize);
    for (const i of neighbours(seed, this.K, this.cdf)) xorInto(out, this.blocks[i]);
    return out;
  }
}

export class LtDecoder {
  constructor(K, blockSize, byteLength) {
    this.K = K;
    this.blockSize = blockSize;
    this.byteLength = byteLength;
    this.cdf = solitonCdf(K);
    this.decoded = new Array(K).fill(null);
    this.decodedCount = 0;
    this.pending = Array.from({ length: K }, () => []); // source index -> symbols still covering it
    this.received = 0;
  }

  get complete() { return this.decodedCount === this.K; }
  get progress() { return this.decodedCount / this.K; }

  _neighbours(seed) {
    return neighbours(seed, this.K, this.cdf);
  }

  /** Returns true if this symbol advanced the decode. */
  addSymbol(seed, data) {
    if (this.complete) return false;
    this.received++;

    const sym = { ids: new Set(this._neighbours(seed)), data: Uint8Array.from(data), done: false };
    for (const i of [...sym.ids]) {
      if (this.decoded[i]) { xorInto(sym.data, this.decoded[i]); sym.ids.delete(i); }
    }

    if (sym.ids.size === 0) return false; // fully redundant
    if (sym.ids.size > 1) {
      for (const i of sym.ids) this.pending[i].push(sym);
      return false; // held until peeling frees it
    }

    const before = this.decodedCount;
    this._peel(sym);
    return this.decodedCount > before;
  }

  _peel(seed) {
    const queue = [seed];
    while (queue.length) {
      const sym = queue.pop();
      if (sym.done || sym.ids.size !== 1) continue;

      const i = sym.ids.values().next().value;
      sym.done = true;
      if (this.decoded[i]) continue;

      this.decoded[i] = sym.data;
      this.decodedCount++;

      const dependents = this.pending[i];
      this.pending[i] = [];
      for (const s of dependents) {
        if (s.done || !s.ids.has(i)) continue;
        xorInto(s.data, this.decoded[i]);
        s.ids.delete(i);
        if (s.ids.size === 1) queue.push(s);
      }
    }
  }

  toBytes() {
    if (!this.complete) throw new Error(`decode incomplete: ${this.decodedCount}/${this.K}`);
    const out = new Uint8Array(this.K * this.blockSize);
    for (let i = 0; i < this.K; i++) out.set(this.decoded[i], i * this.blockSize);
    return out.subarray(0, this.byteLength);
  }
}
