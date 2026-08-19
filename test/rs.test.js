// Reed-Solomon over GF(256), the intra-frame correction layer (V2.0 §9 L1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rsEncode, rsDecode } from '../core/rs.js';
import { rand } from './helpers.mjs';

/** Corrupt `count` distinct positions deterministically. */
function damage(block, count, seed) {
  const bad = Uint8Array.from(block);
  const noise = rand(count * 8 + 32, seed);
  const hit = new Set();
  for (let e = 0; e < count; e++) {
    let p, k = 0;
    do { p = noise[(e * 5 + k++) % noise.length] % block.length; }
    while (hit.has(p) && k < 120);
    hit.add(p);
    bad[p] ^= noise[(e * 3 + 1) % noise.length] | 1;
  }
  return bad;
}

test('encoding is systematic: the data is untouched at the front', () => {
  const data = rand(100, 1);
  const block = rsEncode(data, 16);
  assert.equal(block.length, 116);
  assert.deepEqual(block.subarray(0, 100), data);
});

test('an undamaged block decodes back to exactly the data', () => {
  for (const nsym of [4, 10, 16, 32]) {
    const data = rand(80, nsym);
    assert.deepEqual(rsDecode(rsEncode(data, nsym), nsym), data);
  }
});

test('corrects up to nsym/2 errors, wherever they land', () => {
  for (const nsym of [10, 16, 32]) {
    const t = nsym >> 1;
    for (const errs of [1, 2, t - 1, t]) {
      for (let trial = 0; trial < 60; trial++) {
        const data = rand(100, trial + 1);
        const block = rsEncode(data, nsym);
        const out = rsDecode(damage(block, errs, trial * 13 + 3), nsym);
        assert.ok(out, `nsym=${nsym} errs=${errs} trial=${trial}: reported uncorrectable`);
        assert.deepEqual(out, data, `nsym=${nsym} errs=${errs} trial=${trial}`);
      }
    }
  }
});

test('beyond its range it reports failure rather than returning a guess', () => {
  // This is the property the fountain layer depends on. A block that silently
  // decoded to the wrong bytes would corrupt the file with nothing to catch it
  // until the final SHA-256, and by then there is no way to know which frame.
  for (const nsym of [10, 16, 32]) {
    const t = nsym >> 1;
    for (const errs of [t + 1, t + 4, t + 8]) {
      for (let trial = 0; trial < 60; trial++) {
        const data = rand(100, trial + 7);
        const block = rsEncode(data, nsym);
        const out = rsDecode(damage(block, errs, trial * 17 + 5), nsym);
        if (out) {
          assert.deepEqual(out, data,
            `nsym=${nsym} errs=${errs}: returned wrong data instead of failing`);
        }
      }
    }
  }
});

test('a burst of consecutive errors is corrected like any other', () => {
  // Interleaving turns a torn stripe into scattered single-symbol errors, but
  // a burst inside one block must work too.
  const data = rand(100, 9);
  const block = rsEncode(data, 16);
  const bad = Uint8Array.from(block);
  for (let i = 40; i < 48; i++) bad[i] ^= 0xa5;
  assert.deepEqual(rsDecode(bad, 16), data);
});

test('block size is bounded by the field', () => {
  assert.throws(() => rsEncode(new Uint8Array(250), 16), RangeError);
});
