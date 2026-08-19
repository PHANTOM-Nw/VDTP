import test from 'node:test';
import assert from 'node:assert/strict';
import { MatrixLayout, rotate, orient, BORDER } from '../visual/matrix.js';

function rand(n, seed = 1) {
  const o = new Uint8Array(n); let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { s=(s^(s<<13))>>>0; s=(s^(s>>>17))>>>0; s=(s^(s<<5))>>>0; o[i]=s&0xff; }
  return o;
}

test('payload round-trips at every matrix size', () => {
  for (const n of [64, 128, 256]) {
    const layout = new MatrixLayout(n);
    const data = rand(layout.capacityBytes, n);
    const decoded = layout.decode(layout.encode(data));
    assert.deepEqual(decoded, data, `n=${n}`);
  }
});

test('a freshly encoded matrix has zero structure error', () => {
  const layout = new MatrixLayout(128);
  assert.equal(layout.structureError(layout.encode(rand(layout.capacityBytes, 3))), 0);
});

test('payload cells never collide with structure cells', () => {
  const layout = new MatrixLayout(64);
  for (const [r, c] of layout.payloadCells()) {
    assert.equal(layout.structureAt(r, c), -1, `payload cell ${r},${c} overlaps structure`);
    assert.ok(!layout.isReserved(r, c));
  }
  // Every cell is either payload or structure, never neither, never both.
  let payload = 0;
  for (const _ of layout.payloadCells()) payload++;
  assert.equal(payload, layout.capacityBits);
});

test('orientation is recovered from any of the four rotations', () => {
  const layout = new MatrixLayout(128);
  const data = rand(layout.capacityBytes, 7);
  const cells = layout.encode(data);

  for (let turns = 0; turns < 4; turns++) {
    // Undo the sender's rotation: rotating by `turns` then by `4-turns` is identity.
    const seen = rotate(cells, layout.n, turns);
    const fixed = orient(seen, layout);
    assert.ok(fixed, `rotation ${turns} not recognised`);
    assert.equal(fixed.error, 0, `rotation ${turns} error`);
    assert.deepEqual(layout.decode(fixed.cells), data, `rotation ${turns} payload`);
  }
});

test('orientation survives noisy structure cells but rejects noise-only input', () => {
  const layout = new MatrixLayout(128);
  const cells = layout.encode(rand(layout.capacityBytes, 9));

  // Flip 5% of all cells: still recognisable.
  const noisy = Uint8Array.from(cells);
  const noise = rand(noisy.length, 13);
  let flipped = 0;
  for (let i = 0; i < noisy.length; i++) if (noise[i] < 13) { noisy[i] ^= 1; flipped++; }
  assert.ok(flipped > 0);
  assert.ok(orient(noisy, layout), 'lightly damaged frame was rejected');

  // Pure noise: must be rejected rather than silently decoded as garbage.
  const garbage = new Uint8Array(layout.n * layout.n);
  const g = rand(garbage.length, 17);
  for (let i = 0; i < garbage.length; i++) garbage[i] = g[i] & 1;
  assert.equal(orient(garbage, layout), null, 'random noise passed as a VDTP frame');
});

test('capacity is enforced', () => {
  const layout = new MatrixLayout(64);
  assert.throws(() => layout.encode(new Uint8Array(layout.capacityBytes + 1)), RangeError);
  assert.throws(() => new MatrixLayout(8), RangeError);
});

test('rings are nested squares, in level values with 0 darkest', () => {
  for (const levels of [2, 4]) {
    const layout = new MatrixLayout(64, levels);
    const n = layout.n, top = levels - 1;

    // Ring index is Chebyshev distance to the border, so inner rings stop
    // short of the corners — each ring is only checked over its own span.
    for (let c = 0; c < n; c++) {
      assert.equal(layout.structureAt(0, c), 0, `dark ring broken at col ${c}`);
    }
    for (let c = 1; c <= n - 2; c++) {
      assert.equal(layout.structureAt(1, c), top, `light ring broken at col ${c}`);
    }
    // The timing ring cycles every level, which is both the pitch reference
    // and the per-frame brightness calibration multi-level decoding needs.
    const seen = new Set();
    for (let c = 2; c <= n - 3; c++) {
      const v = layout.structureAt(2, c);
      assert.equal(v, c % levels, `timing ring wrong at col ${c}`);
      seen.add(v);
    }
    assert.equal(seen.size, levels, `timing ring did not carry all ${levels} levels`);

    // Corners belong to the outermost ring they touch.
    assert.equal(layout.structureAt(1, 0), 0);
    assert.equal(layout.structureAt(2, 1), top);
  }
});

test('payload round-trips at both modulation depths', () => {
  for (const levels of [2, 4]) {
    for (const n of [64, 128]) {
      const layout = new MatrixLayout(n, levels);
      const data = rand(layout.capacityBytes, n + levels);
      assert.deepEqual(layout.decode(layout.encode(data)), data, `n=${n} levels=${levels}`);
    }
  }
});

test('four levels doubles capacity and survives the optical path', async () => {
  const { rasterize } = await import('../visual/render.js');
  const { detect } = await import('../visual/detect.js');
  const { bestOrientation } = await import('../visual/matrix.js');
  const { simulateCapture } = await import('./helpers.mjs');

  const binary = new MatrixLayout(64, 2), quad = new MatrixLayout(64, 4);
  assert.ok(quad.capacityBytes >= binary.capacityBytes * 2 - 1,
    `four levels carried ${quad.capacityBytes} against ${binary.capacityBytes}`);

  // Same module size, twice the bits: the point of depth is that it does not
  // spend any of the spatial frequency the channel is actually short of.
  const data = rand(quad.capacityBytes, 606);
  const { gray, size } = rasterize(quad.encode(data), 64, 8, 2, 4);
  const out = 720, m = 40;
  const cap = simulateCapture(gray, size, {
    out, quad: [[m, m], [out - m, m + 6], [out - m - 4, out - m], [m - 2, out - m - 4]],
    blur: 1, noise: 10, seed: 3,
  });

  const found = detect(cap.gray, cap.size, cap.size, 64, quad);
  assert.ok(found, 'four-level frame not detected');
  const fixed = bestOrientation(found.cells, quad);
  assert.ok(fixed.error < 0.05, `structure error ${fixed.error}`);
  assert.deepEqual(quad.decode(fixed.cells), data);
});

test('a sparse frame still looks like noise, at both depths', async () => {
  // The handshake frame is mostly padding. Unmasked, 91% of its modules landed
  // on one level: that biases the camera's auto-exposure, and it broke
  // multi-level decoding outright, whose local brightness correction assumes a
  // roughly even mix. Content must not decide appearance.
  const { encodeFrameCells } = await import('../visual/matrix.js');
  const { encodeFrame, FrameType } = await import('../core/frame.js');

  for (const levels of [2, 4]) {
    const layout = new MatrixLayout(128, levels);
    // A frame carrying almost nothing: the worst case for level balance.
    const frame = encodeFrame({
      type: FrameType.BOOTSTRAP, sessionTag: 1, frameId: 0, seed: 0, eccLevel: 1,
      payload: new Uint8Array(120),
    });
    const cells = encodeFrameCells(layout, frame, true);

    const counts = new Array(levels).fill(0);
    let total = 0;
    for (const [r, c] of layout.payloadCells()) { counts[cells[r * layout.n + c]]++; total++; }
    for (let L = 0; L < levels; L++) {
      const share = counts[L] / total;
      assert.ok(share > 0.35 / levels * 2 && share < 1.65 / levels,
        `levels=${levels}: level ${L} took ${(share * 100).toFixed(1)}% of the payload`);
    }
  }
});

test('masking is reversible and does not touch structure cells', () => {
  for (const levels of [2, 4]) {
    const layout = new MatrixLayout(64, levels);
    const data = rand(layout.capacityBytes, 77 + levels);
    const cells = layout.encode(data);
    assert.deepEqual(layout.decode(cells), data, `levels=${levels}`);
    assert.equal(layout.structureError(cells), 0, `levels=${levels}: structure disturbed`);
  }
});

test('colour carries three bits a module through a simulated camera', async () => {
  // Colour beats four grey levels because it is three independent binary
  // decisions, each keeping the full margin of plain binary, where four levels
  // squeeze three boundaries into one dynamic range. This exercises the two
  // things only colour must survive: Bayer chroma loss and channel cross-talk.
  const { rasterizeRgba } = await import('../visual/render.js');
  const { detect, toBrightness } = await import('../visual/detect.js');
  const { bestOrientation } = await import('../visual/matrix.js');
  const { simulateColorCapture } = await import('./helpers.mjs');

  const layout = new MatrixLayout(64, 8);
  const binary = new MatrixLayout(64, 2);
  // Three times, give or take the byte each depth loses to its own rounding.
  assert.ok(Math.abs(layout.capacityBytes - binary.capacityBytes * 3) <= 2,
    `${layout.capacityBytes} against ${binary.capacityBytes} x 3`);

  const data = rand(layout.capacityBytes, 808);
  const truth = layout.encode(data);
  const { rgba, size } = rasterizeRgba(truth, 64, 9, 2, 8);

  const out = 720, m = 46;
  const cap = simulateColorCapture(rgba, size, {
    out, quad: [[m, m], [out - m, m + 6], [out - m - 4, out - m], [m - 2, out - m - 4]],
    blur: 1, chromaBlur: 1, crosstalk: 0.15, seed: 4,
  });

  const gray = toBrightness(cap.rgba, cap.size, cap.size);
  const found = detect(gray, cap.size, cap.size, 64, layout, cap.rgba);
  assert.ok(found, 'colour frame not detected');
  const fixed = bestOrientation(found.cells, layout);
  assert.ok(fixed.error < 0.05, `structure error ${fixed.error}`);

  let wrong = 0, total = 0;
  for (const [r, c] of layout.payloadCells()) {
    total++;
    if (fixed.cells[r * 64 + c] !== truth[r * 64 + c]) wrong++;
  }
  console.log(`      colour: ${wrong}/${total} modules wrong (${(wrong / total * 100).toFixed(3)}%)`);
  // Correction covers a few per mille; what must not happen is wholesale loss.
  assert.ok(wrong / total < 0.01, `${(wrong / total * 100).toFixed(2)}% of modules misread`);
});
