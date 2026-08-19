import test from 'node:test';
import assert from 'node:assert/strict';
import { VdtpSender, VdtpReceiver } from '../core/session.js';
import { sha256, hex } from '../core/sha256.js';

function rand(n, seed = 1) {
  const o = new Uint8Array(n); let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { s=(s^(s<<13))>>>0; s=(s^(s>>>17))>>>0; s=(s^(s<<5))>>>0; o[i]=s&0xff; }
  return o;
}

/** Lossy optical channel: drops a fraction of frames deterministically. */
function* channel(frames, { loss = 0, skip = 0, seed = 7 } = {}) {
  const noise = rand(1 << 20, seed);
  let i = 0;
  for (const frame of frames) {
    if (i++ < skip) continue;                      // receiver was not aimed yet
    if (noise[i & 0xfffff] / 255 < loss) continue; // frame not decodable
    yield frame;
  }
}

function receive(sender, opts, limit = 400000) {
  const rx = new VdtpReceiver();
  let count = 0;
  for (const frame of channel(sender.stream(), opts)) {
    rx.onFrame(frame);
    if (rx.complete || ++count > limit) break;
  }
  return rx;
}

test('clean channel: file survives round trip and verifies', () => {
  const data = rand(200 * 1024, 11);
  const sender = new VdtpSender(data, { fileName: 'report.pdf', mimeType: 'application/pdf' });
  const rx = receive(sender, {});

  assert.ok(rx.complete, 'transfer did not complete');
  assert.equal(rx.result.verified, true, 'SHA-256 mismatch');
  assert.deepEqual(rx.result.bytes, data);
  assert.equal(rx.result.name, 'report.pdf');
  assert.equal(rx.result.mime, 'application/pdf');
  assert.equal(rx.result.sha256, hex(sha256(data)));
});

test('2 MB file over a 30% lossy channel with a late-joining receiver', () => {
  const data = rand(2 * 1024 * 1024, 21);
  const sender = new VdtpSender(data, { fileName: 'payload.bin', blockSize: 1024 });
  assert.equal(sender.nominalFrameCount, 2048);

  // skip:300 => the camera missed the first metadata broadcast entirely.
  const rx = receive(sender, { loss: 0.3, skip: 300 });

  assert.ok(rx.complete, `stalled at ${(rx.progress * 100).toFixed(1)}%`);
  assert.equal(rx.result.verified, true);
  assert.deepEqual(rx.result.bytes, data);
  console.log(`      2 MB: valid=${rx.stats.valid} dup=${rx.stats.duplicate} ` +
              `buffered-before-metadata=${rx.stats.buffered} ` +
              `overhead=${((rx.stats.valid / 2048 - 1) * 100).toFixed(1)}%`);
});

test('data frames arriving before metadata are buffered, not wasted', () => {
  const data = rand(64 * 1024, 31);
  const sender = new VdtpSender(data, { blockSize: 1024, metadataInterval: 1000 });
  const rx = new VdtpReceiver();

  const frames = sender.stream();
  frames.next(); // discard the metadata frame — receiver joins mid-stream

  for (let i = 0; i < 40; i++) rx.onFrame(frames.next().value);
  assert.equal(rx.metadata, null);
  assert.equal(rx.stats.buffered, 40, 'orphans were dropped');
  assert.equal(rx.stats.valid, 0);

  rx.onFrame(sender.metadataFrame());
  assert.ok(rx.metadata, 'metadata not accepted');
  assert.equal(rx.stats.valid, 40, 'buffered frames were not replayed into the decoder');
});

test('corrupt frames are counted and dropped, and do not poison the decode', () => {
  const data = rand(32 * 1024, 41);
  const sender = new VdtpSender(data, { blockSize: 1024 });
  const rx = new VdtpReceiver();

  let flipped = 0;
  for (const frame of sender.stream()) {
    const f = Uint8Array.from(frame);
    if (flipped < 50 && f.length > 40) { f[30] ^= 0xff; flipped++; } // simulate misread modules
    rx.onFrame(f);
    if (rx.complete) break;
  }
  assert.equal(rx.stats.corrupt, 50);
  assert.ok(rx.complete);
  assert.equal(rx.result.verified, true);
  assert.deepEqual(rx.result.bytes, data);
});

test('frames from another session are rejected (replay defence)', () => {
  const a = new VdtpSender(rand(16 * 1024, 51), { blockSize: 1024 });
  const b = new VdtpSender(rand(16 * 1024, 52), { blockSize: 1024 });
  const rx = new VdtpReceiver();

  rx.onFrame(a.metadataFrame());
  const before = rx.stats.valid;
  for (let seed = 1; seed <= 20; seed++) assert.equal(rx.onFrame(b.dataFrame(seed)), 'foreign');
  assert.equal(rx.stats.valid, before);
  assert.equal(rx.stats.foreign, 20);
});

test('a tampered file would fail verification', () => {
  const data = rand(8 * 1024, 61);
  const sender = new VdtpSender(data, { blockSize: 1024 });
  sender.metadata.sha256 = 'deadbeef'.repeat(8); // pretend the sender lied
  sender._metaPayload = new TextEncoder().encode(JSON.stringify(sender.metadata));

  const rx = receive(sender, {});
  assert.ok(rx.complete);
  assert.equal(rx.result.verified, false, 'mismatched hash was accepted');
});

test('a sender restart continues the fountain instead of replaying it', () => {
  // The failure this guards against: restarting playback used to reset the
  // seed while keeping the session id, so every frame afterwards was a symbol
  // the receiver already held. Progress froze at whatever it had reached —
  // and a long transfer that looks stuck is exactly what gets restarted.
  const data = rand(120 * 1024, 61);
  const sender = new VdtpSender(data, { blockSize: 256 });
  const rx = new VdtpReceiver();

  // First run: stopped part way, as an operator would.
  let seed = 1;
  rx.onFrame(sender.metadataFrame());
  for (let i = 0; i < Math.floor(sender.encoder.K * 0.6); i++) rx.onFrame(sender.dataFrame(seed++));
  const afterFirst = rx.stats.valid;
  assert.ok(afterFirst > 0);
  assert.ok(!rx.complete);

  // Restart. The seed keeps climbing rather than returning to 1.
  for (let i = 0; i < sender.encoder.K * 2 && !rx.complete; i++) {
    rx.onFrame(sender.dataFrame(seed++));
  }
  assert.ok(rx.complete, `stalled at ${(rx.progress * 100).toFixed(0)}%`);
  assert.equal(rx.result.verified, true);
  assert.deepEqual(rx.result.bytes, data);
  assert.ok(rx.stats.valid > afterFirst, 'the restart contributed nothing new');

  // And the shape of the bug, stated directly: replaying old seeds is inert.
  const before = rx.stats.duplicate;
  for (let s = 1; s <= 20; s++) rx.onFrame(sender.dataFrame(s));
  assert.equal(rx.stats.duplicate, before, 'a completed receiver should ignore replays');
});
