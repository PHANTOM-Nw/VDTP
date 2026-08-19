import test from 'node:test';
import assert from 'node:assert/strict';
import { LtEncoder, LtDecoder, neighbours, solitonCdf, CDF_SCALE } from '../core/lt.js';

function randomBytes(n, seed = 1) {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

test('soliton cdf is an integer table: monotonic, normalised, exact', () => {
  for (const K of [1, 2, 7, 64, 256, 1400, 4096]) {
    const cdf = solitonCdf(K);
    assert.ok(cdf instanceof Uint32Array, `K=${K} must be an integer table`);
    assert.equal(cdf[K], CDF_SCALE, `K=${K} tail`);
    for (let i = 2; i <= K; i++) assert.ok(cdf[i] >= cdf[i - 1], `K=${K} non-monotonic at ${i}`);
    assert.ok(cdf[1] > 0, `K=${K} degree 1 has no mass`);
  }
});

test('neighbours are reproducible from the seed alone and stay in range', () => {
  const K = 500;
  const cdf = solitonCdf(K);
  for (const seed of [1, 2, 12345, 0xffffffff, 7777777]) {
    const a = neighbours(seed, K, cdf);
    assert.deepEqual(a, neighbours(seed, K, cdf), `seed ${seed} not reproducible`);
    assert.equal(new Set(a).size, a.length, `seed ${seed} has duplicate indices`);
    for (const i of a) assert.ok(i >= 0 && i < K, `index ${i} out of range`);
  }
});

test('a clean channel recovers at modest overhead', () => {
  // Block size chosen so K lands where real transfers do: bands cap a frame's
  // payload at a few hundred bytes, so any file worth sending has K in the
  // hundreds or thousands.
  const data = randomBytes(80 * 1024, 9);
  const enc = new LtEncoder(data, 256);
  assert.ok(enc.K > 300);
  const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);
  let seed = 1;
  while (!dec.complete && seed <= 20000) dec.addSymbol(seed++, enc.symbol(seed - 1));
  assert.ok(dec.complete, `only ${dec.decodedCount}/${enc.K}`);
  assert.deepEqual(dec.toBytes(), data);
  assert.ok(dec.received < enc.K * 1.25, `clean overhead ${(dec.received / enc.K).toFixed(3)}`);
});

test('very small block counts cost more, and that is bounded', () => {
  // LT's weak spot: the robust soliton distribution is an asymptotic result,
  // and at a few dozen blocks it is nowhere near it. Documented rather than
  // hidden — the absolute cost is trivial (a 40 KB file sends 76 KB of
  // symbols) and bands keep real transfers far away from here. The bound is
  // what stops a regression turning 1.9x into 5x unnoticed.
  const data = randomBytes(40 * 1024, 9);
  const enc = new LtEncoder(data, 1024);
  assert.ok(enc.K < 64);
  const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);
  let seed = 1;
  while (!dec.complete && seed <= 20000) dec.addSymbol(seed++, enc.symbol(seed - 1));
  assert.ok(dec.complete);
  assert.deepEqual(dec.toBytes(), data);
  const overhead = dec.received / enc.K;
  console.log(`      K=${enc.K} small-block overhead ${overhead.toFixed(3)}`);
  assert.ok(overhead < 2.5, `small-K overhead ${overhead.toFixed(3)}`);
});

test('recovers with 30% frame loss and reports overhead', () => {
  const data = randomBytes(256 * 1024, 3);
  const enc = new LtEncoder(data, 1024);
  const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);

  let seed = 1, sent = 0;
  const drop = randomBytes(200000, 77);
  while (!dec.complete && seed < 200000) {
    if (drop[seed] >= 77) { dec.addSymbol(seed, enc.symbol(seed)); sent++; }
    seed++;
  }
  assert.ok(dec.complete, `stalled at ${dec.decodedCount}/${enc.K}`);
  assert.deepEqual(dec.toBytes(), data);

  const overhead = dec.received / enc.K;
  console.log(`      K=${enc.K} received=${dec.received} overhead=${(overhead * 100 - 100).toFixed(1)}%`);
  assert.ok(overhead < 1.6, `overhead ${overhead.toFixed(3)} too high`);
});

test('survives loss, duplication and reordering together', () => {
  const data = randomBytes(64 * 1024, 5);
  const enc = new LtEncoder(data, 512);
  const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);

  // Build a batch, shuffle it, drop half, duplicate some — then feed it in.
  const noise = randomBytes(400000, 11);
  let seed = 1;
  while (!dec.complete && seed < 100000) {
    const batch = [];
    for (let i = 0; i < 64; i++, seed++) {
      if (noise[seed] < 128) continue;             // 50% loss
      batch.push(seed);
      if (noise[seed] > 240) batch.push(seed);     // occasional duplicate
    }
    for (let i = batch.length - 1; i > 0; i--) {   // reorder
      const j = noise[(i * 7 + seed) % noise.length] % (i + 1);
      [batch[i], batch[j]] = [batch[j], batch[i]];
    }
    for (const s of batch) dec.addSymbol(s, enc.symbol(s));
  }
  assert.ok(dec.complete, `stalled at ${dec.decodedCount}/${enc.K}`);
  assert.deepEqual(dec.toBytes(), data);
});

test('a single source block still round-trips', () => {
  const data = randomBytes(300, 2);
  const enc = new LtEncoder(data, 1024);
  assert.equal(enc.K, 1);
  const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);
  let seed = 1;
  while (!dec.complete && seed <= 100) dec.addSymbol(seed++, enc.symbol(seed - 1));
  assert.ok(dec.complete);
  assert.deepEqual(dec.toBytes(), data);
});

test('toBytes refuses to hand back a partial file', () => {
  const enc = new LtEncoder(randomBytes(8192, 4), 1024);
  const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);
  dec.addSymbol(1, enc.symbol(1));
  assert.throws(() => dec.toBytes(), /incomplete/);
});

test('decode overhead stays within budget across realistic K and loss', () => {
  // The number that decides how much airtime a transfer costs. Bands made real
  // block counts large, so this samples the K range transfers actually hit.
  //
  // Every loop is hard-bounded: a decoder that stops making progress must fail
  // this test, never hang the machine running it.
  const LIMIT = 400000;
  for (const K of [512, 2048]) {
    const blockSize = 256;
    const data = randomBytes(K * blockSize, K);
    let worst = 0;

    for (const loss of [0, 0.3, 0.5]) {
      const enc = new LtEncoder(data, blockSize);
      const dec = new LtDecoder(enc.K, enc.blockSize, enc.byteLength);
      const drop = randomBytes(1 << 16, 900 + K + Math.round(loss * 100));

      let seed = 1;
      while (!dec.complete && seed < LIMIT) {
        if (drop[seed & 0xffff] / 255 >= loss) dec.addSymbol(seed, enc.symbol(seed));
        seed++;
      }
      assert.ok(dec.complete, `K=${K} loss=${loss} stalled at ${dec.decodedCount}/${enc.K}`);
      assert.deepEqual(dec.toBytes(), data, `K=${K} loss=${loss}`);
      worst = Math.max(worst, dec.received / enc.K);
    }

    console.log(`      K=${K} worst overhead ${worst.toFixed(3)}`);
    assert.ok(worst < 1.35, `K=${K} worst overhead ${worst.toFixed(3)} exceeds budget`);
  }
});
