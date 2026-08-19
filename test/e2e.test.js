// Full optical loop through the *bundled* code that actually ships in dist/.
//
// Everything else tests a layer. This tests the product: sender frame stream ->
// screen pixels -> a camera that is off-axis, blurred, noisy and drops frames
// -> receiver -> reassembled file -> SHA-256 verified.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundle } from '../build/bundle.mjs';
import { rand, simulateCapture } from './helpers.mjs';

const api = new Function(bundle() + `
  return { MatrixLayout, VdtpSender, VdtpReceiver, Scanner, rasterize, OVERHEAD,
           sha256, hex, planBands, encodeFrameBands, encodeFrameCells };
`)();

/**
 * One matrix worth of cells, the way a sender builds them.
 *
 * Metadata gets a matrix to itself, unbanded: it is held static during the
 * handshake so tearing cannot reach it, and splitting it into bands would cut
 * its budget below what the metadata needs. Data matrices carry one
 * independent frame per band so a tear costs one band instead of everything.
 */
function nextMatrix(layout, plan, sender, state) {
  if (state.sinceMeta === 0 || state.sinceMeta > 6) {
    state.sinceMeta = 1;
    return api.encodeFrameCells(layout, sender.metadataFrame(state.frameId++), true);
  }
  state.sinceMeta++;
  const frames = [];
  for (let i = 0; i < plan.count; i++) frames.push(sender.dataFrame(state.seed++));
  return api.encodeFrameBands(layout, plan, frames, true);
}

test('bundled code recovers a file over a simulated optical channel', () => {
  const data = rand(6 * 1024, 91);
  const layout = new api.MatrixLayout(64);
  const plan = api.planBands(layout);
  const sender = new api.VdtpSender(data, {
    fileName: 'note.txt', mimeType: 'text/plain', blockSize: plan.frameBudget,
  });
  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();

  let shown = 0, decoded = 0;
  const state = { sinceMeta: 0, seed: 1, frameId: 0 };
  for (;;) {
    if (shown++ > 200) break;
    const { gray, size } = api.rasterize(nextMatrix(layout, plan, sender, state), 64, 8);
    const cap = simulateCapture(gray, size, {
      out: 640, quad: [[46, 38], [598, 52], [590, 600], [38, 588]],
      blur: 1, noise: 12, seed: 30 + (shown % 7),
    });
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) { decoded += hit.frames.length; for (const f of hit.frames) receiver.onFrame(f.bytes); }
    if (receiver.complete) break;
  }

  assert.ok(receiver.complete, `stalled at ${(receiver.progress * 100).toFixed(0)}%`);
  assert.equal(receiver.result.verified, true, 'SHA-256 did not match');
  assert.deepEqual(receiver.result.bytes, data);
  assert.equal(receiver.result.name, 'note.txt');
  console.log(`      shown=${shown} optically-decoded=${decoded} ` +
              `tracked=${scanner.tracked} searched=${scanner.searched} corrupt=${receiver.stats.corrupt}`);
});

test('optical channel with 35% frame loss still completes and verifies', () => {
  const data = rand(6 * 1024, 93);
  const layout = new api.MatrixLayout(64);
  const plan = api.planBands(layout);
  const sender = new api.VdtpSender(data, { blockSize: plan.frameBudget });
  const receiver = new api.VdtpReceiver();
  const scanner = new api.Scanner();

  const drop = rand(4096, 777);
  let shown = 0, captured = 0;
  const state = { sinceMeta: 0, seed: 1, frameId: 0 };
  for (;;) {
    if (shown++ > 600) break;
    const cells = nextMatrix(layout, plan, sender, state);
    if (drop[shown] / 255 < 0.35) continue;
    const { gray, size } = api.rasterize(cells, 64, 8);
    const cap = simulateCapture(gray, size, {
      out: 640, quad: [[46, 38], [598, 52], [590, 600], [38, 588]],
      blur: 1, noise: 12, seed: 40 + (shown % 5),
    });
    captured++;
    const hit = scanner.scan(cap.gray, cap.size, cap.size);
    if (hit) for (const f of hit.frames) receiver.onFrame(f.bytes);
    if (receiver.complete) break;
  }

  assert.ok(receiver.complete, `stalled at ${(receiver.progress * 100).toFixed(0)}%`);
  assert.equal(receiver.result.verified, true);
  assert.deepEqual(receiver.result.bytes, data);
  console.log(`      lossy: shown=${shown} captured=${captured} valid=${receiver.stats.valid} ` +
              `K=${receiver.metadata.k} overhead=${((receiver.stats.valid / receiver.metadata.k - 1) * 100).toFixed(0)}%`);
});

test('the loop is genuinely closed: nothing but optical bytes reach the receiver', () => {
  // Guard against the easy mistake of feeding the receiver the sender's own
  // frame object, which would make every optical test vacuous.
  const data = rand(2048, 95);
  const layout = new api.MatrixLayout(64);
  const plan = api.planBands(layout);
  const sender = new api.VdtpSender(data, { blockSize: plan.frameBudget });
  const scanner = new api.Scanner();

  const frame = sender.dataFrame(1);
  const frames = [frame];
  for (let i = 1; i < plan.count; i++) frames.push(sender.dataFrame(1 + i));
  const { gray, size } = api.rasterize(api.encodeFrameBands(layout, plan, frames, true), 64, 8);
  const cap = simulateCapture(gray, size, {
    out: 640, quad: [[46, 38], [598, 52], [590, 600], [38, 588]], blur: 1, noise: 12, seed: 3,
  });
  const hit = scanner.scan(cap.gray, cap.size, cap.size);
  assert.ok(hit, 'frame not recovered');
  assert.ok(hit.bytes, 'scanner did not return raw optical bytes');
  assert.notEqual(hit.bytes, frame, 'scanner handed back the sender object');
  assert.deepEqual(Uint8Array.from(hit.bytes), frame, 'optical bytes differ from what was displayed');
});

test('the shipped bundle exposes the same digest as the module build', async () => {
  const mod = await import('../core/sha256.js');
  const data = rand(1000, 5);
  assert.equal(api.hex(api.sha256(data)), mod.hex(mod.sha256(data)));
});
