import test from 'node:test';
import assert from 'node:assert/strict';
import { Scanner } from '../visual/scan.js';
import { MatrixLayout } from '../visual/matrix.js';
import { rasterize } from '../visual/render.js';
import { bandedCells } from './helpers.mjs';

async function capture(gridSize, { seed = 1, scale = 8 } = {}) {
  const layout = new MatrixLayout(gridSize);
  const { cells, payloads, plan } = await bandedCells(layout, { sessionTag: 0x11223344, seedBase: seed });
  const { gray, size } = rasterize(cells, gridSize, scale);
  // The first band is what single-frame assertions look at.
  return { gray, size, payload: payloads[0], seed: seed * 1000, bands: plan.count };
}

test('locks onto the grid size without being told it', async () => {
  for (const n of [64, 128, 256]) {
    const scanner = new Scanner();
    const cap = await capture(n, { seed: n });
    const got = scanner.scan(cap.gray, cap.size, cap.size);
    assert.ok(got, `grid ${n} not scanned`);
    assert.equal(got.gridSize, n);
    assert.equal(got.frame.seed, n * 1000);
    assert.deepEqual(Uint8Array.from(got.frame.payload), cap.payload);
    assert.equal(scanner.locked, n);
  }
});

test('the lock makes the matching size first choice on later frames', async () => {
  const scanner = new Scanner();
  for (let i = 1; i <= 5; i++) {
    const cap = await capture(128, { seed: 100 + i, frameId: i });
    const got = scanner.scan(cap.gray, cap.size, cap.size);
    assert.ok(got, `frame ${i} missed`);
    assert.ok(got.frames.length >= 1);
  }
  assert.equal(scanner.locked, 128);
  assert.equal(scanner.misses, 0);
});

test('a blank capture yields nothing and eventually drops the lock', async () => {
  const scanner = new Scanner({ relockAfter: 3 });
  const cap = await capture(128, { seed: 7 });
  assert.ok(scanner.scan(cap.gray, cap.size, cap.size));
  assert.equal(scanner.locked, 128);

  const blank = new Uint8Array(600 * 600).fill(240);
  for (let i = 0; i < 3; i++) assert.equal(scanner.scan(blank, 600, 600), null);
  assert.equal(scanner.locked, null, 'lock was not released after repeated misses');
});

test('the sender can change density mid-stream and the scanner follows', async () => {
  const scanner = new Scanner({ relockAfter: 1 });
  const a = await capture(128, { seed: 21 });
  assert.equal(scanner.scan(a.gray, a.size, a.size).gridSize, 128);

  const b = await capture(256, { seed: 22 });
  const got = scanner.scan(b.gray, b.size, b.size);
  assert.ok(got, 'did not re-acquire at the new density');
  assert.equal(got.gridSize, 256);
});

test('tracking serves later frames without a full search', async () => {
  const scanner = new Scanner();
  const first = await capture(128, { seed: 201 });
  assert.equal(scanner.scan(first.gray, first.size, first.size).tracked, false);
  assert.equal(scanner.searched, 1);

  // Same framing, new payload — exactly the steady state of a real transfer.
  for (let i = 2; i <= 6; i++) {
    const cap = await capture(128, { seed: 200 + i, frameId: i });
    const got = scanner.scan(cap.gray, cap.size, cap.size);
    assert.ok(got, `frame ${i} missed`);
    assert.equal(got.tracked, true, `frame ${i} fell back to a full search`);
    assert.ok(got.frames.length >= 1);
  }
  assert.equal(scanner.searched, 1, 'tracking did not avoid repeat searches');
  assert.equal(scanner.tracked, 5);
});

test('tracking gives up and re-searches when the frame moves', async () => {
  const scanner = new Scanner();
  const a = await capture(128, { seed: 301, scale: 8 });
  assert.ok(scanner.scan(a.gray, a.size, a.size));

  // A capture at a different scale puts the frame somewhere else entirely.
  const b = await capture(128, { seed: 302, scale: 6 });
  const got = scanner.scan(b.gray, b.size, b.size);
  assert.ok(got, 're-acquisition failed after the frame moved');
  assert.equal(got.tracked, false);
  assert.equal(scanner.searched, 2);
});
