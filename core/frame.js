// VDTP frame wire format (V2.0 spec §5.3 "Frame Header", §7 frame types).
//
// Layout — 21-byte header, payload, 4-byte trailer:
//   0  u32  magic 'VDTP'
//   4  u8   protocol version
//   5  u8   frame type
//   6  u32  session tag (low 32 bits of the 128-bit session id)
//  10  u32  frame id
//  14  u32  encoding seed
//  18  u8   ecc level
//  19  u16  payload length
//  21  ..   payload
//  +n  u32  CRC32 over bytes [0, 21+n)
import { crc32 } from './crc32.js';

export const MAGIC = 0x56445450; // 'VDTP'
export const VERSION = 1;
export const HEADER_SIZE = 21;
export const TRAILER_SIZE = 4;
export const OVERHEAD = HEADER_SIZE + TRAILER_SIZE;
export const MAX_PAYLOAD = 0xffff;

export const FrameType = {
  BOOTSTRAP: 0, // standard QR, session + metadata (V2.0 §7.1)
  SYNC: 1,      // periodic re-detection anchor (§7.2)
  DATA: 2,      // high-density fountain payload (§7.3)
  END: 3,       // file hash + session result (§7.4)
};

export function encodeFrame({ type, sessionTag, frameId, seed, eccLevel = 0, payload }) {
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`payload ${payload.length} exceeds ${MAX_PAYLOAD}`);
  }
  const buf = new Uint8Array(OVERHEAD + payload.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, MAGIC, false);
  buf[4] = VERSION;
  buf[5] = type;
  dv.setUint32(6, sessionTag >>> 0, false);
  dv.setUint32(10, frameId >>> 0, false);
  dv.setUint32(14, seed >>> 0, false);
  buf[18] = eccLevel;
  dv.setUint16(19, payload.length, false);
  buf.set(payload, HEADER_SIZE);
  dv.setUint32(HEADER_SIZE + payload.length, crc32(buf.subarray(0, HEADER_SIZE + payload.length)), false);
  return buf;
}

/**
 * Parse a frame. Returns null for anything that isn't a valid, intact VDTP
 * frame — a corrupt frame is dropped, never repaired (spec §9: "能解就收,
 * 严重损坏则直接丢弃"), because the fountain layer above absorbs the loss.
 */
export function decodeFrame(buf) {
  if (buf.length < OVERHEAD) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, false) !== MAGIC) return null;
  if (buf[4] !== VERSION) return null;

  const payloadLength = dv.getUint16(19, false);
  const end = HEADER_SIZE + payloadLength;
  if (buf.length < end + TRAILER_SIZE) return null;
  if (dv.getUint32(end, false) !== crc32(buf.subarray(0, end))) return null;

  return {
    type: buf[5],
    sessionTag: dv.getUint32(6, false),
    frameId: dv.getUint32(10, false),
    seed: dv.getUint32(14, false),
    eccLevel: buf[18],
    payload: buf.subarray(HEADER_SIZE, end),
  };
}
