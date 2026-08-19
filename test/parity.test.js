// Proves the C sender and the JS receiver agree bit for bit.
//
// This is not a nice-to-have. Frames carry a seed, not a neighbour list, so a
// single disagreement about degree or block indices makes the receiver XOR the
// wrong blocks — producing a file that looks fine until SHA-256 rejects it at
// the very end, with nothing to point at. Every shared primitive is compared by
// digest over a canonical serialisation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { mix32, makeRng } from '../core/prng.js';
import { crc32 } from '../core/crc32.js';
import { sha256, hex } from '../core/sha256.js';
import { solitonCdf, neighbours, LtEncoder } from '../core/lt.js';
import { encodeFrame, FrameType, OVERHEAD } from '../core/frame.js';
import { MatrixLayout, planBands } from '../visual/matrix.js';
import { rsEncode } from '../core/rs.js';
import { eccPlan, eccEncode, ECC_REDUNDANCY } from '../core/ecc.js';
import { rand } from './helpers.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const BIN = join(ROOT, 'build', 'out', 'vdtp-vectors');

function buildVectors() {
  mkdirSync(join(ROOT, 'build', 'out'), { recursive: true });
  execFileSync('gcc', [
    '-std=c99', '-O2', '-Wall', '-Wextra',
    join(ROOT, 'native', 'vdtp.c'), join(ROOT, 'native', 'vectors.c'),
    '-o', BIN, '-lm',
  ], { stdio: 'pipe' });
}

let vectors = null;
try {
  if (!existsSync(BIN)) buildVectors();
  vectors = Object.fromEntries(
    execFileSync(BIN, { encoding: 'utf8' }).trim().split('\n')
      .map((line) => { const [name, digest, len] = line.split('\t'); return [name, { digest, len: +len }]; }),
  );
} catch (err) {
  console.log(`      parity vectors unavailable (${err.code || err.message}); C parity NOT verified`);
}

/** Growable byte sink mirroring native/vectors.c's `buf`. */
class Sink {
  constructor() { this.parts = []; this.len = 0; }
  put(bytes) { this.parts.push(bytes); this.len += bytes.length; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); this.put(b); }
  digest() {
    const all = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) { all.set(p, off); off += p.length; }
    return { digest: hex(sha256(all)), len: this.len };
  }
}

function check(name, build) {
  test(`C and JS agree on ${name}`, { skip: vectors ? false : 'no C toolchain' }, () => {
    const sink = new Sink();
    build(sink);
    const got = sink.digest();
    const want = vectors[name];
    assert.ok(want, `C emitted no vector for ${name}`);
    assert.equal(got.len, want.len, `${name}: serialisation length differs`);
    assert.equal(got.digest, want.digest, `${name}: C and JS disagree`);
  });
}

check('mix32', (s) => {
  for (let x = 0; x < 2000; x++) s.u32(mix32(x));
  for (let x = 0xfffff000; x <= 0xffffffff; x++) s.u32(mix32(x >>> 0));
});

check('rng', (s) => {
  for (const seed of [1, 2, 3, 1000, 65535, 0x7fffffff, 0xffffffff, 0]) {
    const r = makeRng(seed);
    for (let j = 0; j < 200; j++) s.u32(r());
  }
});

check('crc32', (s) => {
  for (let n = 0; n <= 300; n++) s.u32(crc32(rand(n, n + 1)));
});

check('sha256', (s) => {
  const lens = [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 4096, 65536];
  lens.forEach((len, i) => s.put(sha256(rand(len, i + 7))));
});

check('soliton_cdf', (s) => {
  for (const K of [1, 2, 7, 64, 205, 256, 512, 1400, 2048, 4096]) {
    const cdf = solitonCdf(K);
    for (let j = 0; j <= K; j++) s.u32(cdf[j]);
  }
});

check('neighbours', (s) => {
  for (const K of [64, 256, 2048]) {
    const cdf = solitonCdf(K);
    for (let seed = 1; seed <= 5000; seed++) {
      const ids = neighbours(seed, K, cdf);
      s.u32(ids.length);
      for (const i of ids) s.u32(i);
    }
  }
});

check('lt_symbols', (s) => {
  for (const len of [64 * 1024, 64 * 1024 + 377]) {
    const enc = new LtEncoder(rand(len, 4242), 1024);
    s.u32(enc.K);
    for (let seed = 1; seed <= 400; seed++) s.put(enc.symbol(seed));
  }
});

check('rs_encode', (s) => {
  for (let nsym = 2; nsym <= 40; nsym += 2) {
    for (let k = 8; k <= 120; k += 8) s.put(rsEncode(rand(k, k * 31 + nsym), nsym));
  }
});

check('ecc_encode', (s) => {
  for (const capacity of [418, 1010, 1858, 4322, 8100]) {
    const plan = eccPlan(capacity, ECC_REDUNDANCY);
    s.u32(plan.blocks);
    s.u32(plan.dataBytes);
    for (let j = 0; j < plan.blocks; j++) { s.u32(plan.sizes[j]); s.u32(plan.parity[j]); }
    s.put(eccEncode(rand(plan.dataBytes, capacity), capacity, ECC_REDUNDANCY));
  }
});

check('frame', (s) => {
  const payload = rand(1000, 31);
  const frame = encodeFrame({
    type: FrameType.DATA, sessionTag: 0xdeadbeef, frameId: 42, seed: 0x1234abcd,
    eccLevel: 2, payload,
  });
  s.u32(frame.length);
  s.put(frame);
});

check('band_plan', (s) => {
  // Every depth: the band byte count is cells x bits-per-cell, and C once
  // dropped that multiplication. Covering only binary hid it completely, and a
  // sender computing binary-sized bands while the receiver expects colour-sized
  // ones produces frames nobody can parse.
  for (const levels of [2, 4, 8])
  for (const n of [32, 48, 64, 96, 128, 160, 192, 256]) {
    const plan = planBands(new MatrixLayout(n, levels));
    s.u32(plan.count);
    s.u32(plan.payload);
    s.u32(plan.frameBudget);
    for (const band of plan.bands) { s.u32(band.from); s.u32(band.to); s.u32(band.bits); s.u32(band.bytes); }
  }
});

check('matrix', (s) => {
  for (const levels of [2, 4, 8]) {
    for (const n of [64, 128, 256]) {
      const layout = new MatrixLayout(n, levels);
      s.u32(layout.capacityBytes);
      s.put(layout.encode(rand(layout.capacityBytes, n)));
    }
  }
});

test('frame overhead constant matches the C header', () => {
  assert.equal(OVERHEAD, 25);
});

// The build host is not necessarily the target architecture — this repo builds
// the Windows x86-64 sender from an aarch64 machine. The soliton table depends
// on log() and sqrt(), so "it matched on the build host" is not the same claim
// as "it matches on the CPU that ships". Cross-check the shipped word size.
test('the x86-64 build agrees with the host build', async () => {
  const { existsSync: has } = await import('node:fs');
  const CROSS_CC = '/usr/bin/x86_64-linux-gnu-gcc';
  const QEMU = '/usr/bin/qemu-x86_64-static';
  if (!vectors || !has(CROSS_CC) || !has(QEMU)) {
    console.log('      cross-architecture check skipped (no x86-64 toolchain or qemu)');
    return;
  }

  const bin = join(ROOT, 'build', 'out', 'vdtp-vectors-x64');
  if (!has(bin)) {
    execFileSync(CROSS_CC, [
      '-std=c99', '-O2', '-static',
      join(ROOT, 'native', 'vdtp.c'), join(ROOT, 'native', 'vectors.c'),
      '-o', bin, '-lm',
    ], { stdio: 'pipe' });
  }

  const rows = execFileSync(QEMU, [bin], { encoding: 'utf8' }).trim().split('\n');
  for (const line of rows) {
    const [name, digest, len] = line.split('\t');
    assert.ok(vectors[name], `x86-64 emitted an unknown vector ${name}`);
    assert.equal(digest, vectors[name].digest, `${name}: x86-64 and host builds disagree`);
    assert.equal(+len, vectors[name].len, `${name}: length differs across architectures`);
  }
});
