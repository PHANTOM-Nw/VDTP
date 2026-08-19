import test from 'node:test';
import assert from 'node:assert/strict';
import { eccPlan, eccCapacity, eccEncode, eccDecode } from '../core/ecc.js';
import { rand } from './helpers.mjs';
import { MatrixLayout } from '../visual/matrix.js';

const R = 0.12;

test('the plan fills the frame exactly and leaves usable payload', () => {
  for (const n of [32, 48, 64, 96, 128, 192]) {
    const capacity = new MatrixLayout(n).capacityBytes;
    const plan = eccPlan(capacity, R);
    assert.equal(plan.sizes.reduce((a, b) => a + b, 0), capacity, `n=${n} sizes`);
    assert.ok(plan.dataBytes > capacity * 0.8, `n=${n} lost too much to parity`);
    for (let i = 0; i < plan.blocks; i++) {
      assert.ok(plan.sizes[i] <= 255, `n=${n} block ${i} exceeds the field`);
      assert.equal(plan.parity[i] % 2, 0, `n=${n} block ${i} odd parity buys nothing`);
    }
  }
});

test('round trips with no damage', () => {
  for (const n of [32, 64, 128, 192]) {
    const capacity = new MatrixLayout(n).capacityBytes;
    const data = rand(eccCapacity(capacity, R), n);
    const frame = eccEncode(data, capacity, R);
    assert.equal(frame.length, capacity);
    assert.deepEqual(eccDecode(frame, R), data);
  }
});

test('survives scattered module errors at the measured 1% rate', () => {
  // The rate observed once pixels-per-module crosses the cliff — the regime
  // this layer exists to make usable.
  const capacity = new MatrixLayout(192).capacityBytes;
  const data = rand(eccCapacity(capacity, R), 3);
  for (let trial = 0; trial < 20; trial++) {
    const frame = eccEncode(data, capacity, R);
    const noise = rand(capacity, trial * 31 + 7);
    let hits = 0;
    for (let i = 0; i < frame.length; i++) {
      if (noise[i] < 3) { frame[i] ^= noise[i] | 1; hits++; }  // ~1.2%
    }
    assert.ok(hits > 0);
    assert.deepEqual(eccDecode(frame, R), data, `trial ${trial}: ${hits} damaged symbols`);
  }
});

test('interleaving turns a contiguous burst into survivable damage', () => {
  const capacity = new MatrixLayout(128).capacityBytes;
  const data = rand(eccCapacity(capacity, R), 11);
  const frame = eccEncode(data, capacity, R);
  // A scratch or glare patch wipes a run of modules.
  for (let i = 400; i < 400 + Math.floor(capacity * 0.04); i++) frame[i] ^= 0xa5;
  assert.deepEqual(eccDecode(frame, R), data);
});

test('damage beyond the code is reported, never guessed', () => {
  // The property the fountain layer depends on: a lost frame, not a wrong one.
  const capacity = new MatrixLayout(64).capacityBytes;
  const data = rand(eccCapacity(capacity, R), 5);
  const frame = eccEncode(data, capacity, R);
  for (let i = 0; i < Math.floor(capacity * 0.4); i++) frame[i] ^= 0x5a;
  const out = eccDecode(frame, R);
  if (out) assert.deepEqual(out, data, 'returned wrong data instead of failing');
});
