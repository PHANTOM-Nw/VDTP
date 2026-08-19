// Regression for the failure seen on real hardware: the receiver never locked
// on and every counter stayed at zero, because the detector was choosing the
// monitor's own bezel — a dark ring with a far larger bounding box than the
// frame — and then sampling the whole monitor as if it were the payload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MatrixLayout } from '../visual/matrix.js';
import { rasterize } from '../visual/render.js';
import { Scanner } from '../visual/scan.js';
import { rand, simulateMonitorScene, bandedCells } from './helpers.mjs';

/**
 * `side` is how much of the capture the frame occupies. It has to grow with the
 * grid: decoding needs about 4 camera pixels per module, so a 128-module frame
 * demands roughly twice the on-screen area of a 64-module one. Asking for a
 * dense grid in a small part of the shot is not a detector bug, it is asking
 * for information the pixels do not carry.
 */
async function framedCapture(grid, { seed = 5, scale = 10, out = 1080, side = 430 } = {}) {
  const layout = new MatrixLayout(grid);
  const { cells, payloads } = await bandedCells(layout, { sessionTag: 0x5a5a5a5a, seedBase: seed });
  const payload = payloads[0];
  const { gray, size } = rasterize(cells, grid, scale);
  const x = Math.round((out - side) / 2), y = Math.round((out - side) / 2);
  const cap = simulateMonitorScene(gray, size, {
    out,
    // Slight tilt: a handheld shot is never square-on.
    quad: [[x, y], [x + side, y + 12], [x + side - 8, y + side], [x - 8, y + side - 10]],
    blur: 1, noise: 10,
  });
  return { cap, payload, seed: seed * 1000, pxPerModule: side / grid };
}

test('a frame on a monitor with a dark bezel is still found', async () => {
  const { cap, payload, seed } = await framedCapture(64);
  const scanner = new Scanner();
  const hit = scanner.scan(cap.gray, cap.size, cap.size);
  assert.ok(hit, 'detector locked onto the bezel instead of the frame');
  assert.equal(hit.frame.seed, seed);
  assert.deepEqual(Uint8Array.from(hit.frame.payload), payload);
});

test('a dark surround does not stop lock-on at any supported grid size', async () => {
  // Each grid is given the on-screen area its density actually requires.
  for (const [grid, side] of [[64, 430], [128, 760]]) {
    const { cap, seed, pxPerModule } = await framedCapture(grid, { seed: grid, scale: 10, side });
    assert.ok(pxPerModule >= 4, `test framing gives only ${pxPerModule.toFixed(1)} px/module`);
    const scanner = new Scanner();
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    assert.ok(hit, `grid ${grid} not found against a dark surround`);
    assert.equal(hit.gridSize, grid);
    assert.equal(hit.frame.seed, seed);
  }
});

test('too little on-screen area fails cleanly rather than decoding garbage', async () => {
  // 128 modules across 280 px is 2.2 px/module, below Nyquist for the grid.
  // (430 px used to fail too; bands and correction now rescue part of that
  // capture, which is the point of both — so the bar moved.)
  const { cap } = await framedCapture(128, { seed: 3, scale: 10, side: 280 });
  const scanner = new Scanner({ candidates: [128] });
  const hit = scanner.scan(cap.gray, cap.size, cap.size);
  assert.equal(hit, null, 'produced a frame from insufficient resolution');
  assert.ok(scanner.diag.quads > 0, 'diagnostics should still report candidate outlines');
});

test('a dim room does not hide the frame', async () => {
  // Global thresholding split room from screen, which put the ring, the bezel
  // and the whole room on the dark side — 89% of the image fused into one
  // border-touching blob, so nothing was found and the flood fill crawled.
  // Local contrast has neither problem.
  for (const room of [200, 120, 60, 20]) {
    const layout = new MatrixLayout(64);
    const { cells } = await bandedCells(layout, { seedBase: room });
    const { gray, size } = rasterize(cells, 64, 10);
    const cap = simulateMonitorScene(gray, size, {
      out: 1080, quad: [[330, 300], [760, 312], [752, 742], [322, 730]],
      blur: 1, noise: 10, room, bezel: 20,
    });
    const scanner = new Scanner();
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    assert.ok(hit, `room brightness ${room} defeated detection`);
    assert.equal(hit.frame.seed, room * 1000);
  }
});

test('the ring probe keeps the expensive path off non-frames', async () => {
  const layout = new MatrixLayout(64);
  const { cells } = await bandedCells(layout, { sessionTag: 0x88, seedBase: 8 });
  const { gray, size } = rasterize(cells, 64, 10);
  const cap = simulateMonitorScene(gray, size, {
    out: 1080, quad: [[330, 300], [760, 312], [752, 742], [322, 730]],
    blur: 1, noise: 10, room: 120, bezel: 20,
  });

  const scanner = new Scanner();
  assert.ok(scanner.scan(cap.gray, cap.size, cap.size), 'not found');
  assert.ok(scanner.diag.quads > 1, 'test scene should offer several candidates');
  // Without the probe this is candidates x grid sizes; with it, only the real
  // frame ever reaches a full grid sample.
  assert.ok(scanner.diag.sampled <= 2,
    `${scanner.diag.sampled} full grid samples for ${scanner.diag.quads} candidates`);
});

test('native camera resolution decodes through the strided search', async () => {
  // The receiver no longer downscales the capture, so a 4K phone hands over a
  // 3840-wide image; locating runs on a strided copy while every decoded bit
  // still comes from the full-resolution pixels.
  const layout = new MatrixLayout(64);
  const { cells, payloads } = await bandedCells(layout, { sessionTag: 0x99, seedBase: 44 });
  const payload = payloads[0];
  const { gray, size } = rasterize(cells, 64, 10);
  const out = 2160, side = 900, x = Math.round((out - side) / 2);
  const cap = simulateMonitorScene(gray, size, {
    out, quad: [[x, x], [x + side, x + 20], [x + side - 14, x + side], [x - 14, x + side - 18]],
    blur: 1, noise: 10, room: 110, bezel: 20,
  });

  const scanner = new Scanner();
  const hit = scanner.scan(cap.gray, cap.size, cap.size);
  assert.ok(hit, 'high-resolution capture not decoded');
  assert.ok(scanner.diag.stride > 1, 'search should have strided at this size');
  assert.equal(hit.frame.seed, 44 * 1000);
  assert.deepEqual(Uint8Array.from(hit.frame.payload), payload);
});

/** What a capture records when the screen changes mid-exposure or mid-readout. */
function blendRasters(a, b, w) {
  const out = new Uint8Array(a.gray.length);
  for (let i = 0; i < out.length; i++) out[i] = a.gray[i] * (1 - w) + b.gray[i] * w;
  return { gray: out, size: a.size };
}
function tearRasters(a, b, frac) {
  const out = Uint8Array.from(a.gray), row = Math.round(a.size * frac);
  for (let y = row; y < a.size; y++) out.set(b.gray.subarray(y * a.size, (y + 1) * a.size), y * a.size);
  return { gray: out, size: a.size };
}

test('a capture spanning a screen update is rejected, never mis-decoded', async () => {
  // The failure mode behind "the handshake reads but data never does". Rings
  // are identical across frames, so the structure check passes and the frame
  // is located; the payload is a mix of two frames and fails the CRC. Any tear
  // is fatal — there is no intra-frame ECC — so the fountain layer has to
  // absorb it, and what matters here is that nothing wrong gets through.
  const layout = new MatrixLayout(64);
  const mk = async (seed) => {
    const { cells, payloads } = await bandedCells(layout, { sessionTag: 0x1234, seedBase: seed });
    return { payload: payloads[0], raster: rasterize(cells, 64, 10) };
  };
  const a = await mk(11), b = await mk(12);
  const side = 430, x = Math.round((1080 - side) / 2);
  const quad = [[x, x], [x + side, x + 12], [x + side - 8, x + side], [x - 8, x + side - 10]];
  const run = (src) => {
    const cap = simulateMonitorScene(src.gray, src.size, {
      out: 1080, quad, blur: 1, noise: 10, room: 120,
    });
    const scanner = new Scanner();
    return { hit: scanner.scan(cap.gray, cap.size, cap.size), diag: scanner.diag };
  };

  const clean = run(a.raster);
  assert.ok(clean.hit, 'a clean capture should decode');
  assert.deepEqual(Uint8Array.from(clean.hit.frame.payload), a.payload);

  // With bands, a tear costs the band straddling it — not the capture. The
  // bands above came whole from one displayed frame and those below from the
  // next, and both are perfectly good symbols.
  for (const frac of [0.9, 0.5, 0.25]) {
    const torn = run(tearRasters(a.raster, b.raster, frac));
    assert.ok(torn.hit, `tear at ${frac} lost the whole capture`);
    // At most one band is lost, and a tear close to an edge may cost nothing
    // at all — correction repairs a band that is only slightly contaminated,
    // which is the two reliability levels doing their separate jobs.
    assert.ok(torn.hit.frames.length >= torn.hit.bands - 1,
      `tear at ${frac} cost ${torn.hit.bands - torn.hit.frames.length} bands`);
    assert.ok(torn.diag.bestError < 0.05, 'structure survives a tear — that is why the CRC matters');
  }

  // An exposure spanning two *identical* frames is harmless, which is exactly
  // why the handshake phase reads reliably where data does not.
  const held = run(blendRasters(a.raster, a.raster, 0.5));
  assert.ok(held.hit, 'a held frame should survive a long exposure');
  assert.deepEqual(Uint8Array.from(held.hit.frame.payload), a.payload);
});

test('signal margin separates a torn capture from an unreadable one', async () => {
  // Both fail the CRC with the structure intact, and they want opposite fixes,
  // so the receiver has to be able to tell them apart. Crisp bits that fail
  // came from a capture spanning a screen update; mushy bits mean the payload
  // never survived the optics.
  const layout = new MatrixLayout(64);
  const mk = async (seed) => rasterize(
    (await bandedCells(layout, { sessionTag: 0x1234, seedBase: seed })).cells, 64, 10);
  const a = await mk(21), b = await mk(22);

  const run = (src, side, blur) => {
    const x = Math.round((1080 - side) / 2);
    const cap = simulateMonitorScene(src.gray, src.size, {
      out: 1080, blur, noise: 10, room: 120,
      quad: [[x, x], [x + side, x + 12], [x + side - 8, x + side], [x - 8, x + side - 10]],
    });
    const scanner = new Scanner({ candidates: [64] });
    return { hit: scanner.scan(cap.gray, cap.size, cap.size), diag: scanner.diag };
  };

  // Measured in this scene: clean and torn both sit above 0.99, an
  // under-resolved capture around 0.88. The cut goes between them.
  const CRISP = 0.95;

  const good = run(a, 430, 1);
  assert.ok(good.hit, 'the clean case should decode');
  assert.ok(good.diag.margin > CRISP, `clean margin was ${good.diag.margin}`);

  // Crisp but wrong: the bands that straddle the tear are sharp, they just
  // span two frames.
  const torn = run(tearRasters(a, b, 0.5), 430, 1);
  assert.ok(torn.diag.margin > CRISP,
    `a torn capture should still look crisp, got ${torn.diag.margin}`);

  // Mushy: too few pixels per module, so the levels collapse toward the middle.
  const starved = run(a, 150, 1);
  assert.equal(starved.hit, null);
  assert.ok(starved.diag.margin < CRISP,
    `an under-resolved capture should lose margin, got ${starved.diag.margin}`);
});
