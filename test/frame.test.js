import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, decodeFrame, FrameType, OVERHEAD, MAX_PAYLOAD } from '../core/frame.js';

const sample = { type: FrameType.DATA, sessionTag: 0xdeadbeef, frameId: 42, seed: 0x1234abcd, eccLevel: 2 };

test('frame round-trips every header field', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const parsed = decodeFrame(encodeFrame({ ...sample, payload }));
  assert.deepEqual(
    { ...parsed, payload: [...parsed.payload] },
    { ...sample, payload: [...payload] },
  );
});

test('overhead is exactly 25 bytes', () => {
  assert.equal(encodeFrame({ ...sample, payload: new Uint8Array(1500) }).length, 1500 + OVERHEAD);
  assert.equal(OVERHEAD, 25);
});

test('any single-bit corruption is rejected, never silently accepted', () => {
  const frame = encodeFrame({ ...sample, payload: new Uint8Array([9, 8, 7, 6]) });
  for (let byte = 0; byte < frame.length; byte++) {
    for (const bit of [0, 3, 7]) {
      const bad = Uint8Array.from(frame);
      bad[byte] ^= 1 << bit;
      assert.equal(decodeFrame(bad), null, `byte ${byte} bit ${bit} slipped through`);
    }
  }
});

test('non-VDTP and truncated input is rejected without throwing', () => {
  assert.equal(decodeFrame(new Uint8Array(10)), null);
  assert.equal(decodeFrame(new Uint8Array(64)), null);
  const frame = encodeFrame({ ...sample, payload: new Uint8Array([1, 2, 3]) });
  assert.equal(decodeFrame(frame.subarray(0, frame.length - 1)), null);
});

test('oversized payload is refused', () => {
  assert.throws(() => encodeFrame({ ...sample, payload: new Uint8Array(MAX_PAYLOAD + 1) }), RangeError);
});
