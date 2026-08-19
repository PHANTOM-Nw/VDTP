// Reed-Solomon over GF(256), systematic, for intra-frame error correction
// (V2.0 §9 Level 1).
//
// Why this exists, measured rather than assumed: a frame carries thousands of
// modules and, without correction, every one of them has to be right. For a
// 64x64 grid (3348 payload cells) a 90% frame survival rate needs a per-module
// error rate below 3.1e-5; for 128x128 it is 7.1e-6. Meanwhile the measured
// error rate does not degrade gracefully — it sits at ~0% while the optics hold
// and jumps to ~1% once pixels-per-module crosses about 4. That is 300x past
// what an uncorrected frame tolerates, which is why density fails as a cliff
// rather than as a slope, and why correction buys so much: 10% redundancy
// pulls the tolerated rate into exactly the regime just past that edge.
//
// GF(256) with the standard QR/DVD polynomial x^8 + x^4 + x^3 + x^2 + 1.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => {
  if (b === 0) throw new RangeError('divide by zero in GF(256)');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const inv = (a) => EXP[255 - LOG[a]];
/** 2^n in GF(256), for any integer n. */
const pow2 = (n) => EXP[(((n % 255) + 255) % 255)];

// Polynomials are arrays in descending degree order: index 0 is the highest
// power. Mixing that convention with the ascending one is the classic way to
// get a Reed-Solomon implementation that encodes fine and silently fails to
// correct at the edge of its range.

function polyScale(p, x) {
  const out = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) out[i] = mul(p[i], x);
  return out;
}

function polyAdd(p, q) {
  const out = new Uint8Array(Math.max(p.length, q.length));
  for (let i = 0; i < p.length; i++) out[i + out.length - p.length] ^= p[i];
  for (let i = 0; i < q.length; i++) out[i + out.length - q.length] ^= q[i];
  return out;
}

function polyMul(p, q) {
  const out = new Uint8Array(p.length + q.length - 1);
  for (let i = 0; i < q.length; i++) {
    if (q[i] === 0) continue;
    for (let j = 0; j < p.length; j++) out[i + j] ^= mul(p[j], q[i]);
  }
  return out;
}

/** Horner evaluation. */
function polyEval(p, x) {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}

function generator(nsym) {
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) g = polyMul(g, new Uint8Array([1, pow2(i)]));
  return g;
}

const genCache = new Map();
function generatorFor(nsym) {
  let g = genCache.get(nsym);
  if (!g) { g = generator(nsym); genCache.set(nsym, g); }
  return g;
}

/** Append `nsym` parity bytes to `data`. */
export function rsEncode(data, nsym) {
  if (data.length + nsym > 255) {
    throw new RangeError(`RS block ${data.length}+${nsym} exceeds 255 symbols`);
  }
  const gen = generatorFor(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(data); // the division above overwrote the systematic prefix
  return out;
}

/** Leading zero keeps the indexing in the Berlekamp-Massey loop honest. */
function syndromes(msg, nsym) {
  const s = new Uint8Array(nsym + 1);
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(msg, pow2(i));
  return s;
}

function errorLocator(synd, nsym) {
  let errLoc = new Uint8Array([1]);
  let oldLoc = new Uint8Array([1]);
  const shift = synd.length - nsym;

  for (let i = 0; i < nsym; i++) {
    const K = i + shift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      delta ^= mul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    }
    const grown = new Uint8Array(oldLoc.length + 1);
    grown.set(oldLoc);
    oldLoc = grown;

    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }

  let start = 0;
  while (start < errLoc.length && errLoc[start] === 0) start++;
  return errLoc.subarray(start);
}

/**
 * Chien search.
 *
 * `errLoc` must arrive reversed relative to what Berlekamp-Massey produces:
 * BM yields the locator with the constant term last, and evaluating that
 * directly puts its root at alpha^-k instead of alpha^k, so the search finds
 * nothing and every error looks uncorrectable.
 */
function errorPositions(errLoc, length) {
  const expected = errLoc.length - 1;
  const positions = [];
  for (let i = 0; i < length; i++) {
    if (polyEval(errLoc, pow2(i)) === 0) positions.push(length - 1 - i);
  }
  return positions.length === expected ? positions : null;
}

/** Forney. */
function correctErrata(msg, synd, positions) {
  const coefPos = positions.map((p) => msg.length - 1 - p);

  let errLoc = new Uint8Array([1]);
  for (const p of coefPos) {
    errLoc = polyMul(errLoc, polyAdd(new Uint8Array([1]), new Uint8Array([pow2(p), 0])));
  }

  // Error evaluator = (reversed syndromes * locator) mod x^(deg+1). The slice
  // keeps deg+1 coefficients, not deg: one short and every magnitude comes out
  // wrong, which shows up as a code that passes on clean input and fails to
  // correct even a single error.
  const reversedSynd = Uint8Array.from(synd).reverse();
  const remainder = polyMul(reversedSynd, errLoc);
  const errEval = remainder.subarray(remainder.length - errLoc.length);

  const X = coefPos.map((p) => pow2(p));

  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let denom = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) denom = mul(denom, 1 ^ mul(xiInv, X[j]));
    }
    if (denom === 0) return false;
    let y = mul(X[i], polyEval(errEval, xiInv));
    msg[positions[i]] ^= div(y, denom);
  }
  return true;
}

/**
 * Correct up to nsym/2 errors and return the data portion, or null if the
 * damage is beyond the code's reach. Never returns a guess: an uncorrectable
 * block is reported lost so the fountain layer replaces it instead.
 */
export function rsDecode(block, nsym) {
  const msg = Uint8Array.from(block);
  const synd = syndromes(msg, nsym);
  if (synd.every((v) => v === 0)) return msg.subarray(0, msg.length - nsym);

  const errLoc = errorLocator(synd, nsym);
  if (errLoc.length - 1 > nsym / 2) return null;

  const positions = errorPositions(Uint8Array.from(errLoc).reverse(), msg.length);
  if (!positions || positions.length === 0) return null;

  if (!correctErrata(msg, synd, positions)) return null;
  if (!syndromes(msg, nsym).every((v) => v === 0)) return null;
  return msg.subarray(0, msg.length - nsym);
}
