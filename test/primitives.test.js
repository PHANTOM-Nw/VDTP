import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { crc32 } from '../core/crc32.js';
import { sha256, hex } from '../core/sha256.js';
import { makeRng } from '../core/prng.js';

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('sha256 matches published vectors', () => {
  assert.equal(hex(sha256(new Uint8Array(0))),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(new TextEncoder().encode('abc'))),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 agrees with node:crypto across block boundaries', () => {
  for (const n of [1, 55, 56, 63, 64, 65, 119, 120, 1000, 65536]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const expected = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hex(sha256(bytes)), expected, `length ${n}`);
  }
});

test('rng is deterministic and never sticks at zero', () => {
  const a = makeRng(12345), b = makeRng(12345);
  for (let i = 0; i < 100; i++) assert.equal(a(), b());
  const z = makeRng(0);
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(z());
  assert.ok(seen.size > 900, `expected spread, got ${seen.size} distinct`);
});
