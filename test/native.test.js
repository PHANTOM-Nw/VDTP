// The C sender's real output, decoded by the shipped JS receiver.
//
// test/parity.test.js proves the primitives agree; this proves the assembled
// sender works: frames produced by native/vdtp.c go through a simulated camera
// into the same bundle that dist/receiver.html ships, and must reconstruct the
// original file with a matching SHA-256. Everything in the Windows binary
// except the Win32 window is exercised here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { bundle } from '../build/bundle.mjs';
import { rand, simulateCapture } from './helpers.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const EMIT = join(ROOT, 'build', 'out', 'vdtp-emit');

let available = true;
try {
  if (!existsSync(EMIT)) {
    mkdirSync(join(ROOT, 'build', 'out'), { recursive: true });
    execFileSync('gcc', ['-std=c99', '-O2', join(ROOT, 'native', 'vdtp.c'),
      join(ROOT, 'native', 'deflate.c'), join(ROOT, 'native', 'emit.c'),
      '-o', EMIT, '-lm'], { stdio: 'pipe' });
  }
} catch (err) {
  available = false;
  console.log(`      C emitter unavailable (${err.code || err.message})`);
}

const api = new Function(bundle() + `
  return { VdtpReceiver, Scanner, rasterize, hex, sha256 };
`)();

/** Run the C sender and split its output into per-frame cell grids. */
function emit(data, grid, count, bootstrap = 0, ecc = 0) {
  const path = join(tmpdir(), `vdtp-native-${data.length}-${grid}-${ecc}.bin`);
  writeFileSync(path, data);
  const out = execFileSync(EMIT, [path, String(grid), String(count), String(bootstrap), String(ecc)], {
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(out.subarray(0, 8).toString('ascii'), 'VDTPEMIT', 'bad emitter header');
  const dv = new DataView(out.buffer, out.byteOffset + 8, 8);
  const meta = {
    grid: dv.getUint16(0, false), count: dv.getUint16(2, false),
    K: dv.getUint16(4, false), block: dv.getUint16(6, false),
    sha256: out.subarray(16, 80).toString('ascii'),
  };
  const cellsPer = grid * grid;
  const frames = [];
  for (let i = 0; i < meta.count; i++) {
    frames.push(new Uint8Array(out.subarray(80 + i * cellsPer, 80 + (i + 1) * cellsPer)));
  }
  return { meta, frames };
}

const QUAD = [[46, 38], [598, 52], [590, 600], [38, 588]];

test('the C sender\'s frames decode through the JS receiver', { skip: available ? false : 'no C toolchain' }, () => {
  const data = rand(6 * 1024, 4242);
  const grid = 64;
  const { meta, frames } = emit(data, grid, 60, 0, 1);

  assert.equal(meta.grid, grid);
  assert.equal(meta.sha256, api.hex(api.sha256(data)), 'C and JS disagree on the file digest');

  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();
  let decoded = 0;

  for (const cells of frames) {
    const { gray, size } = api.rasterize(cells, grid, 8);
    const cap = simulateCapture(gray, size, { out: 640, quad: QUAD, blur: 1, noise: 12, seed: 17 });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) { decoded += hit.frames.length; for (const f of hit.frames) receiver.onFrame(f.bytes); }
    if (receiver.complete) break;
  }

  assert.ok(receiver.complete, `stalled at ${(receiver.progress * 100).toFixed(0)}%`);
  assert.equal(receiver.result.verified, true, 'SHA-256 mismatch on a C-produced transfer');
  assert.deepEqual(receiver.result.bytes, data);
  assert.equal(receiver.metadata.k, meta.K, 'C and JS disagree on the block count');
  console.log(`      C sender -> JS receiver: K=${meta.K} block=${meta.block} ` +
              `frames-decoded=${decoded} tracked=${scanner.tracked}`);
});

test('C-produced frames survive a lossy optical channel', { skip: available ? false : 'no C toolchain' }, () => {
  const data = rand(6 * 1024, 99);
  const grid = 64;
  const { frames } = emit(data, grid, 300, 0, 1);
  const drop = rand(256, 61);

  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();
  frames.forEach((cells, i) => {
    if (receiver.complete) return;
    if (drop[i] / 255 < 0.35) return; // camera missed this one
    const { gray, size } = api.rasterize(cells, grid, 8);
    const cap = simulateCapture(gray, size, { out: 640, quad: QUAD, blur: 1, noise: 12, seed: 23 });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) for (const f of hit.frames) receiver.onFrame(f.bytes);
  });

  assert.ok(receiver.complete,
    `stalled at ${(receiver.progress * 100).toFixed(0)}% — matrices=${frames.length - 4} ` +
    `valid=${receiver.stats.valid} dup=${receiver.stats.duplicate} ` +
    `crcFails=${scanner.totals.crcFails} decoded=${scanner.totals.decoded} K=${receiver.metadata.k}`);
  assert.equal(receiver.result.verified, true);
  assert.deepEqual(receiver.result.bytes, data);
});

test('the handshake phase holds one readable frame, then data follows', { skip: available ? false : 'no C toolchain' }, () => {
  const data = rand(6 * 1024, 131);
  const grid = 64;
  const { frames } = emit(data, grid, 90, 4, 1);   // 4 held handshake frames, then the stream

  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();

  // The operator's cue to press start is the receiver showing the file name,
  // so metadata must be readable from the handshake frames alone.
  for (let i = 0; i < 4; i++) {
    const { gray, size } = api.rasterize(frames[i], grid, 8);
    const cap = simulateCapture(gray, size, { out: 640, quad: QUAD, blur: 1, noise: 12, seed: 9 });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) for (const f of hit.frames) receiver.onFrame(f.bytes);
  }
  assert.ok(receiver.metadata, 'handshake frames did not carry readable metadata');
  assert.equal(receiver.metadata.size, data.length);
  assert.equal(receiver.stats.valid, 0, 'handshake should not have consumed fountain symbols');

  for (const cells of frames.slice(4)) {
    const { gray, size } = api.rasterize(cells, grid, 8);
    const cap = simulateCapture(gray, size, { out: 640, quad: QUAD, blur: 1, noise: 12, seed: 9 });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) for (const f of hit.frames) receiver.onFrame(f.bytes);
    if (receiver.complete) break;
  }
  assert.ok(receiver.complete, `stalled at ${(receiver.progress * 100).toFixed(0)}%`);
  assert.equal(receiver.result.verified, true);
  assert.deepEqual(receiver.result.bytes, data);
});

test('the C sender\'s error-corrected frames decode at a density that fails without', { skip: available ? false : 'no C toolchain' }, () => {
  // Grid 128 at this framing sits where correction starts to matter. The point
  // is not just that it works, but that the C encoder's interleaved RS blocks
  // are laid out exactly as the JS decoder expects — a generator polynomial or
  // block split off by one symbol makes every frame uncorrectable, silently.
  const data = rand(48 * 1024, 777);
  const grid = 128;
  const { frames, meta } = emit(data, grid, 90, 0, 1);

  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();
  let corrected = 0;

  for (const cells of frames) {
    const { gray, size } = api.rasterize(cells, grid, 6);
    const cap = simulateCapture(gray, size, {
      out: 900, quad: [[40, 34], [862, 48], [854, 866], [32, 852]], blur: 1, noise: 12, seed: 19,
    });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) {
      if (hit.corrected) corrected++;
      for (const f of hit.frames) receiver.onFrame(f.bytes);
    }
    if (receiver.complete) break;
  }

  assert.ok(receiver.complete, `stalled at ${(receiver.progress * 100).toFixed(0)}%`);
  assert.equal(receiver.result.verified, true);
  assert.deepEqual(receiver.result.bytes, data);
  assert.ok(corrected > 0, 'correction never engaged — the C frames were not RS wrapped');
  assert.equal(receiver.metadata.block, meta.block);
  console.log(`      C sender + RS: grid=${grid} block=${meta.block}B K=${meta.K} ` +
              `corrected=${corrected}/${scanner.totals.decoded}`);
});

test('the C sender compresses and the receiver inflates to a matching hash', { skip: available ? false : 'no C toolchain' }, () => {
  // Compressible input, so the sender takes the deflate path. The SHA-256 in
  // the metadata describes the *original* file, so a successful verify proves
  // the whole chain: C deflate, fountain, bands, correction, JS inflate.
  // Real source text rather than a repeated phrase: a degenerate corpus
  // compresses to a single fountain block and exercises none of the layers
  // between here and the file.
  const text = new Uint8Array(readFileSync(new URL('../core/lt.js', import.meta.url)));
  const grid = 96;
  const { frames, meta } = emit(text, grid, 120, 0, 1);

  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();
  for (const cells of frames) {
    const { gray, size } = api.rasterize(cells, grid, 7);
    const cap = simulateCapture(gray, size, {
      out: 820, quad: [[36, 30], [786, 44], [778, 790], [28, 776]], blur: 1, noise: 12, seed: 11,
    });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) for (const f of hit.frames) receiver.onFrame(f.bytes);
    if (receiver.complete) break;
  }

  assert.ok(receiver.complete, `stalled at ${(receiver.progress * 100).toFixed(0)}%`);
  assert.equal(receiver.metadata.compression, 'deflate', 'the C sender did not compress');
  assert.ok(receiver.metadata.csize < text.length, 'compression did not shrink it');
  assert.ok(receiver.metadata.k > 3, `K=${receiver.metadata.k} is too small to test the fountain`);
  assert.equal(receiver.result.verified, true);
  assert.deepEqual(receiver.result.bytes, text);
  console.log(`      C deflate: ${text.length} -> ${receiver.metadata.csize} ` +
              `(${(text.length / receiver.metadata.csize).toFixed(2)}x) grid=${grid} K=${meta.K}`);
});
