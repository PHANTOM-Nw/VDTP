// Deterministic uint32 PRNG shared by sender and receiver: the sender puts only
// a seed in the frame header and the receiver regenerates the identical
// neighbour set from it.
//
// WIRE CONTRACT. Any port (C#, C, WASM) must reproduce mix32 and xorshift32
// bit-for-bit, or the two ends disagree about which source blocks a symbol
// covers and the fountain layer silently produces garbage.

/**
 * splitmix32 finalizer.
 *
 * Required, not cosmetic: raw xorshift32 has almost no avalanche from
 * sequential seeds, and frame seeds ARE sequential. Unmixed, seeds 1..4096 all
 * yielded a first output inside [0, 0.25), which pins every symbol to the same
 * fountain degree and pushes decode overhead past 2.4x.
 */
export function mix32(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x21f0aaad) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x735a2d97) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x >>> 0;
}

export function makeRng(seed) {
  let s = mix32(seed >>> 0);
  if (s === 0) s = 0x9e3779b9; // xorshift is stuck at zero
  return function next() {
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return s;
  };
}
