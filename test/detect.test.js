import test from 'node:test';
import assert from 'node:assert/strict';
import { MatrixLayout, orient } from '../visual/matrix.js';
import { rasterize } from '../visual/render.js';
import { detect, findQuad, homography } from '../visual/detect.js';
import { encodeFrame, decodeFrame, FrameType } from '../core/frame.js';
import { rand, simulateCapture } from './helpers.mjs';

const SQUARE = (m, s) => [[m,m],[m+s,m],[m+s,m+s],[m,m+s]];

test('homography maps the unit square onto the quad corners', () => {
  const quad = [[10,20],[300,15],[310,290],[5,280]];
  const map = homography(quad);
  const expect = [[0,0],[1,0],[1,1],[0,1]];
  for (let i = 0; i < 4; i++) {
    const [x, y] = map(...expect[i]);
    assert.ok(Math.abs(x - quad[i][0]) < 1e-6 && Math.abs(y - quad[i][1]) < 1e-6, `corner ${i}`);
  }
});

test('the ring is found by bounding box, not by pixel count', () => {
  const layout = new MatrixLayout(64);
  const { gray, size, pad } = rasterize(layout.encode(rand(layout.capacityBytes, 2)), 64, 6);
  const quad = findQuad(gray, size, size);
  assert.ok(quad, 'no quad found');
  // Corners sit just inside the quiet zone, at the matrix outline.
  for (const [x, y] of quad.corners) {
    const onEdge = (v) => Math.abs(v - pad) < 3 || Math.abs(v - (size - pad - 1)) < 3;
    assert.ok(onEdge(x) && onEdge(y), `corner ${x},${y} is not on the matrix outline`);
  }
});

test('without a quiet zone the frame is not decoded (never silently mis-read)', () => {
  const layout = new MatrixLayout(64);
  const { gray, size } = rasterize(layout.encode(rand(layout.capacityBytes, 2)), 64, 6, 0);

  // findQuad may still latch onto some interior blob; what matters is that the
  // pipeline refuses it rather than returning wrong bytes.
  const found = detect(gray, size, size, 64);
  if (found) assert.equal(orient(found.cells, layout), null, 'edge-to-edge frame was mis-read');
});

test('establishes the pixels-per-module the channel actually needs', () => {
  const layout = new MatrixLayout(64);
  const data = rand(layout.capacityBytes, 77);
  const { gray, size } = rasterize(layout.encode(data), 64, 8);

  const results = [];
  for (const out of [200, 260, 320, 400, 520, 700]) {
    const margin = Math.round(out * 0.06);
    const cap = simulateCapture(gray, size, {
      out, quad: SQUARE(margin, out - 2 * margin), blur: 1, noise: 10, seed: 5,
    });
    const found = detect(cap.gray, cap.size, cap.size, 64);
    const fixed = found && orient(found.cells, layout);
    let ok = false;
    if (fixed) {
      const got = layout.decode(fixed.cells);
      ok = got.every((b, i) => b === data[i]);
    }
    // Modules span the quad minus the quiet zone the source carries.
    const ppm = ((out - 2 * margin) * (64 / (64 + 2 * 2))) / 64;
    results.push({ ppm: ppm.toFixed(2), ok });
  }
  console.log('      px/module -> exact decode: ' +
    results.map((r) => `${r.ppm}:${r.ok ? 'yes' : 'NO'}`).join('  '));

  // The high end must work; this is the guarantee the sender's grid sizing relies on.
  assert.ok(results[results.length - 1].ok, 'decode failed even at the highest resolution');
});

test('flat-on capture with mild blur decodes exactly', () => {
  const layout = new MatrixLayout(128);
  const data = rand(layout.capacityBytes, 5);
  const { gray, size } = rasterize(layout.encode(data), 128, 5);
  const cap = simulateCapture(gray, size, { out: 1080, quad: SQUARE(60, 960), blur: 1 });

  const found = detect(cap.gray, cap.size, cap.size, 128);
  assert.ok(found, 'detection failed');
  const fixed = orient(found.cells, layout);
  assert.ok(fixed, 'orientation failed');
  assert.deepEqual(layout.decode(fixed.cells), data);
});

test('perspective, blur and sensor noise still decode exactly', () => {
  const layout = new MatrixLayout(128);
  const data = rand(layout.capacityBytes, 8);
  const { gray, size } = rasterize(layout.encode(data), 128, 5);

  // Camera held off-axis: the far edge is shorter and the frame is tilted.
  const quad = [[105, 60], [990, 132], [918, 990], [69, 900]];
  const cap = simulateCapture(gray, size, { out: 1080, quad, blur: 2, noise: 18, seed: 4 });

  const found = detect(cap.gray, cap.size, cap.size, 128);
  assert.ok(found, 'detection failed');
  const fixed = orient(found.cells, layout);
  assert.ok(fixed, `orientation failed`);
  assert.deepEqual(layout.decode(fixed.cells), data);
  console.log(`      perspective+blur+noise: structure error ${(fixed.error * 100).toFixed(2)}%, ` +
              `black=${found.black.toFixed(0)} white=${found.white.toFixed(0)}`);
});

test('a real VDTP frame survives the whole optical round trip', () => {
  const layout = new MatrixLayout(128);
  const payload = rand(layout.capacityBytes - 25, 12); // leave room for frame overhead
  const frame = encodeFrame({
    type: FrameType.DATA, sessionTag: 0xabcd1234, frameId: 77, seed: 4242, eccLevel: 0, payload,
  });

  const { gray, size } = rasterize(layout.encode(frame), 128, 5);
  const cap = simulateCapture(gray, size, { out: 1080, quad: [[78,66],[972,90],[960,978],[60,951]], blur: 2, noise: 14, seed: 21 });

  const found = detect(cap.gray, cap.size, cap.size, 128);
  const fixed = orient(found.cells, layout);
  const parsed = decodeFrame(layout.decode(fixed.cells));

  assert.ok(parsed, 'frame CRC rejected the optically recovered bytes');
  assert.equal(parsed.seed, 4242);
  assert.equal(parsed.frameId, 77);
  assert.equal(parsed.sessionTag, 0xabcd1234);
  assert.deepEqual(Uint8Array.from(parsed.payload), payload);
});

test('a frame that is not there is rejected, not hallucinated', () => {
  const noise = rand(600 * 600, 31);
  const gray = new Uint8Array(600 * 600);
  for (let i = 0; i < gray.length; i++) gray[i] = noise[i];
  const found = detect(gray, 600, 600, 128);
  if (found) assert.equal(orient(found.cells, new MatrixLayout(128)), null, 'noise decoded as a frame');
});

test('uneven screen lighting is handled by the adaptive cut', () => {
  // An LCD shot off-axis fades across the panel and a lamp puts a bright patch
  // on the glass. A single global black/white cut cannot follow either, and
  // this is the case that justifies the per-cell threshold: measured 16/32 to
  // 30/32 at 4.5 px/module when it was introduced.
  const layout = new MatrixLayout(64);
  const data = rand(layout.capacityBytes, 404);
  const { gray, size } = rasterize(layout.encode(data), 64, 8);

  let ok = 0, total = 0;
  for (const [gradient, glare] of [[0.45, 0], [0, 70], [0.45, 60], [0.6, 40]]) {
    total++;
    const out = 420, m = 26;
    const cap = simulateCapture(gray, size, {
      out, quad: [[m, m], [out - m, m + 6], [out - m - 4, out - m], [m - 2, out - m - 4]],
      blur: 1, noise: 12, seed: 5, gradient, glare,
    });
    const found = detect(cap.gray, cap.size, cap.size, 64);
    const fixed = found && orient(found.cells, layout);
    if (fixed) {
      const got = layout.decode(fixed.cells);
      if (got.every((b, i) => b === data[i])) ok++;
    }
  }
  assert.ok(ok >= 3, `only ${ok}/${total} lighting cases decoded`);
});
