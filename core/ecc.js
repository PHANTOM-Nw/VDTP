// Intra-frame error correction: RS block splitting and interleaving.
//
// Wraps a serialised VDTP frame so that a matrix read with a few wrong modules
// still yields the exact frame. Measured motivation: the per-module error rate
// is ~0% while the optics hold and jumps to ~1% once pixels-per-module crosses
// about 4, while an uncorrected 64x64 frame needs better than 3.1e-5 to survive
// 90% of the time. Correction is what turns that cliff into usable density.
//
// Not a fix for a capture that spans a screen update. A tear typically ruins
// 30-50% of the matrix; interleaving spreads that damage evenly instead of
// concentrating it, but spreading does not reduce it, and no affordable
// redundancy corrects half a frame. Those captures stay a job for the fountain
// layer above.
import { rsEncode, rsDecode } from './rs.js';

const MAX_BLOCK = 255;

/**
 * The one redundancy the format uses. Measured at a fixed 640 px on screen:
 *
 *   grid 128 (5.0 px/module)  12/12 without, 12/12 with — correction unneeded
 *   grid 160 (4.0)             7/12 without, 12/12 with
 *   grid 192 (3.3)             6/12 without, 10/12 with
 *   grid 224 (2.9)             0/12 without,  0/12 with — past the cliff
 *
 * It buys roughly one and a half density steps, which at a tearing-limited five
 * clean frames a second is 2.0 KB/s at grid 64 against 18.5 KB/s at grid 192.
 * Beyond 224 the modules no longer carry the information at all and no amount
 * of parity invents it.
 */
export const ECC_REDUNDANCY = 0.12;

/**
 * How a frame of `capacity` bytes is divided.
 *
 * Blocks are as equal as the field allows; the first `capacity % blocks` carry
 * one extra symbol. Parity is sized per block so every block gets the same
 * proportion of protection regardless of that remainder.
 */
export function eccPlan(capacity, redundancy) {
  if (!(redundancy > 0 && redundancy < 0.5)) {
    throw new RangeError(`redundancy ${redundancy} must be in (0, 0.5)`);
  }
  const blocks = Math.ceil(capacity / MAX_BLOCK);
  const base = Math.floor(capacity / blocks);
  const extra = capacity % blocks;

  const sizes = [], parity = [];
  let dataBytes = 0;
  for (let i = 0; i < blocks; i++) {
    const total = base + (i < extra ? 1 : 0);
    // Even parity count: RS corrects nsym/2 errors, and an odd symbol buys
    // nothing. At least 2 so every block can fix at least one module.
    let nsym = Math.max(2, Math.round(total * redundancy / 2) * 2);
    if (nsym >= total) nsym = total - 1;
    sizes.push(total);
    parity.push(nsym);
    dataBytes += total - nsym;
  }
  return { blocks, sizes, parity, capacity, dataBytes };
}

/** Payload bytes a frame of `capacity` can carry at this redundancy. */
export function eccCapacity(capacity, redundancy) {
  return eccPlan(capacity, redundancy).dataBytes;
}

/**
 * data -> exactly `capacity` bytes, RS protected and interleaved.
 *
 * Interleaving is round-robin across blocks, so a contiguous run of damaged
 * modules lands one symbol at a time in each codeword rather than wiping one
 * out entirely.
 */
export function eccEncode(data, capacity, redundancy) {
  const plan = eccPlan(capacity, redundancy);
  if (data.length > plan.dataBytes) {
    throw new RangeError(`${data.length} bytes exceeds ECC capacity ${plan.dataBytes}`);
  }

  const encoded = [];
  let offset = 0;
  for (let i = 0; i < plan.blocks; i++) {
    const k = plan.sizes[i] - plan.parity[i];
    const chunk = new Uint8Array(k);
    chunk.set(data.subarray(offset, Math.min(offset + k, data.length)));
    offset += k;
    encoded.push(rsEncode(chunk, plan.parity[i]));
  }

  const out = new Uint8Array(capacity);
  let w = 0;
  for (let pos = 0; ; pos++) {
    let wrote = false;
    for (let b = 0; b < plan.blocks; b++) {
      if (pos < encoded[b].length) { out[w++] = encoded[b][pos]; wrote = true; }
    }
    if (!wrote) break;
  }
  return out;
}

/**
 * Inverse of eccEncode. Returns the data bytes, or null if any block was
 * damaged beyond its code — never a guess, so the fountain layer above can
 * treat a failure as a lost frame rather than as corrupt data.
 */
export function eccDecode(buffer, redundancy) {
  const plan = eccPlan(buffer.length, redundancy);
  const blocks = [];
  for (let i = 0; i < plan.blocks; i++) blocks.push(new Uint8Array(plan.sizes[i]));

  let r = 0;
  for (let pos = 0; ; pos++) {
    let read = false;
    for (let b = 0; b < plan.blocks; b++) {
      if (pos < plan.sizes[b]) { blocks[b][pos] = buffer[r++]; read = true; }
    }
    if (!read) break;
  }

  const out = new Uint8Array(plan.dataBytes);
  let w = 0;
  for (let i = 0; i < plan.blocks; i++) {
    const data = rsDecode(blocks[i], plan.parity[i]);
    if (!data) return null;
    out.set(data, w);
    w += data.length;
  }
  return out;
}
