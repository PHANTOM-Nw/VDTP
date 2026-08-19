// VDTP session layer: file <-> frame stream.
//
// The channel is one-way and the receiver may aim its camera at the screen at
// any moment, so two rules fall out that a networked protocol would not need:
//   1. metadata is re-broadcast periodically, never sent once;
//   2. data frames that arrive before metadata are buffered, not dropped —
//      they are perfectly good symbols, we just cannot place them yet.
import { encodeFrame, decodeFrame, FrameType } from './frame.js';
import { LtEncoder, LtDecoder } from './lt.js';
import { sha256, hex } from './sha256.js';
import { inflateRaw } from './inflate.js';

export const DEFAULT_BLOCK_SIZE = 1024;

/**
 * Symbols typically needed per source block. Measured worst case is 1.17 at
 * K=2048 and 1.26 at K=512; this is the figure the progress estimate uses, not
 * a limit — a transfer that needs more simply sits at 99% until it finishes.
 */
export const EXPECTED_OVERHEAD = 1.15;
export const DEFAULT_METADATA_INTERVAL = 48; // data frames between metadata re-broadcasts

function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function tagOf(sessionId) {
  return new DataView(sessionId.buffer, sessionId.byteOffset, 4).getUint32(0, false);
}

export class VdtpSender {
  /**
   * `compressed` is the deflate-raw form of `bytes`, when it is smaller. The
   * fountain layer then carries the compressed stream and the receiver inflates
   * after reassembly — so `size` and `sha256` still describe the original file
   * and the integrity check still covers what the user actually sent.
   *
   * Compression is the sender's decision because it is the sender that can see
   * whether it helped: an already-compressed file gains nothing, and shipping a
   * larger stream to say so would be worse than not trying.
   */
  constructor(bytes, {
    fileName = 'file.bin',
    mimeType = 'application/octet-stream',
    blockSize = DEFAULT_BLOCK_SIZE,
    metadataInterval = DEFAULT_METADATA_INTERVAL,
    sessionId = randomBytes(16),
    compressed = null,
  } = {}) {
    this.bytes = bytes;
    this.sessionId = sessionId;
    this.sessionTag = tagOf(sessionId);
    this.metadataInterval = metadataInterval;
    const useCompression = compressed !== null && compressed.length < bytes.length;
    const wire = useCompression ? compressed : bytes;
    this.encoder = new LtEncoder(wire, blockSize);
    this.metadata = {
      v: 1,
      sid: hex(sessionId),
      name: fileName,
      size: bytes.length,
      mime: mimeType,
      sha256: hex(sha256(bytes)),
      block: blockSize,
      k: this.encoder.K,
      fec: 'lt',
      ecc: 0,
      compression: useCompression ? 'deflate' : 'none',
      csize: wire.length,
      encryption: 'none',
    };
    this._metaPayload = new TextEncoder().encode(JSON.stringify(this.metadata));
  }

  /** Frames needed on a lossless channel; the real stream is unbounded. */
  get nominalFrameCount() { return this.encoder.K; }

  metadataFrame(frameId = 0) {
    return encodeFrame({
      type: FrameType.BOOTSTRAP,
      sessionTag: this.sessionTag,
      frameId,
      seed: 0,
      payload: this._metaPayload,
    });
  }

  /** `seed` is the fountain seed; seeds 1..K are the systematic prefix. */
  dataFrame(seed) {
    return encodeFrame({
      type: FrameType.DATA,
      sessionTag: this.sessionTag,
      frameId: seed,
      seed,
      payload: this.encoder.symbol(seed),
    });
  }

  endFrame(frameId = 0) {
    return encodeFrame({
      type: FrameType.END,
      sessionTag: this.sessionTag,
      frameId,
      seed: 0,
      payload: new TextEncoder().encode(JSON.stringify({
        sid: this.metadata.sid, size: this.metadata.size, sha256: this.metadata.sha256,
      })),
    });
  }

  /**
   * Unbounded frame stream: metadata, then data forever, with metadata folded
   * back in every `metadataInterval` frames. The sender never knows when to
   * stop — the operator stops it once the receiver reports success.
   */
  *stream() {
    let seed = 1;
    let frameId = 0;
    for (;;) {
      yield this.metadataFrame(frameId++);
      for (let i = 0; i < this.metadataInterval; i++) {
        yield this.dataFrame(seed++);
        frameId++;
      }
    }
  }
}

export class VdtpReceiver {
  constructor({ maxOrphans = 4096 } = {}) {
    this.metadata = null;
    this.decoder = null;
    this.sessionTag = null;
    this.result = null;
    this.stats = { valid: 0, duplicate: 0, corrupt: 0, foreign: 0, buffered: 0 };
    this._orphans = [];
    this._maxOrphans = maxOrphans;
    this._seen = new Set();
  }

  get complete() { return this.result !== null; }

  /**
   * Progress, measured in symbols accepted rather than blocks recovered.
   *
   * Peeling resolves in an avalanche at the very end: at K=2000 the decoder
   * held 90 blocks after 1800 symbols, 361 after 2000, and all 2000 by 2264.
   * Blocks recovered therefore reads as "stuck near zero" for most of a
   * transfer and then jumps, which is indistinguishable from a broken link.
   * Symbols accepted against the number typically needed is smooth and honest.
   */
  get progress() {
    if (this.complete) return 1;
    if (!this.decoder) return 0;
    const needed = Math.ceil(this.decoder.K * EXPECTED_OVERHEAD);
    return Math.min(0.99, this.stats.valid / needed);
  }

  /** Blocks actually recovered — a diagnostic, not a progress bar. */
  get blocksProgress() { return this.decoder ? this.decoder.progress : 0; }

  /** Source blocks still missing — what the UI shows as "还需 N 个有效帧". */
  get remaining() {
    if (!this.decoder) return null;
    return this.decoder.K - this.decoder.decodedCount;
  }

  /**
   * Feed one captured frame. Returns one of:
   * 'corrupt' | 'foreign' | 'metadata' | 'buffered' | 'duplicate' | 'progress' | 'complete' | 'done'
   */
  onFrame(raw) {
    if (this.complete) return 'done';

    const frame = decodeFrame(raw);
    if (!frame) { this.stats.corrupt++; return 'corrupt'; }

    if (this.sessionTag !== null && frame.sessionTag !== this.sessionTag) {
      this.stats.foreign++; // a different transfer, or a replayed recording
      return 'foreign';
    }

    switch (frame.type) {
      case FrameType.BOOTSTRAP: return this._onMetadata(frame);
      case FrameType.DATA: return this._onData(frame);
      case FrameType.END: return this._finalise() ? 'complete' : 'progress';
      default: return 'foreign';
    }
  }

  _onMetadata(frame) {
    if (this.metadata) return 'metadata'; // already have it; re-broadcasts are expected
    let meta;
    try {
      meta = JSON.parse(new TextDecoder().decode(frame.payload));
    } catch {
      this.stats.corrupt++;
      return 'corrupt';
    }
    if (meta.fec !== 'lt') { this.stats.corrupt++; return 'corrupt'; }

    this.metadata = meta;
    this.sessionTag = frame.sessionTag;
    // The fountain carries the wire form; csize is its length, which equals
    // size when nothing was compressed.
    this.decoder = new LtDecoder(meta.k, meta.block, meta.csize || meta.size);

    // Replay everything that arrived before we knew how to place it.
    const orphans = this._orphans;
    this._orphans = [];
    for (const o of orphans) this._onData(o);
    return 'metadata';
  }

  _onData(frame) {
    if (!this.decoder) {
      if (this._orphans.length < this._maxOrphans) {
        // Copy: `payload` is a view onto the caller's buffer, which may be reused.
        this._orphans.push({ ...frame, payload: Uint8Array.from(frame.payload) });
        this.stats.buffered = this._orphans.length;
      }
      return 'buffered';
    }
    if (this._seen.has(frame.seed)) { this.stats.duplicate++; return 'duplicate'; }
    this._seen.add(frame.seed);

    this.decoder.addSymbol(frame.seed, frame.payload);
    this.stats.valid++;

    if (this.decoder.complete) return this._finalise() ? 'complete' : 'progress';
    return 'progress';
  }

  /** Rebuild and verify. Returns true only if SHA-256 matches (spec §18). */
  _finalise() {
    if (!this.decoder || !this.decoder.complete || this.result) return this.complete;
    const wire = this.decoder.toBytes();

    let bytes;
    if (this.metadata.compression === 'deflate') {
      try {
        bytes = inflateRaw(wire, this.metadata.size);
      } catch {
        // A stream that reassembled but will not inflate is corrupt in a way
        // the CRCs did not catch; report it rather than hand back rubbish.
        this.result = { bytes: wire, name: this.metadata.name, mime: this.metadata.mime,
                        sha256: '', verified: false };
        return true;
      }
    } else {
      bytes = wire;
    }

    const digest = hex(sha256(bytes));
    this.result = {
      bytes,
      name: this.metadata.name,
      mime: this.metadata.mime,
      sha256: digest,
      verified: digest === this.metadata.sha256,
    };
    return true;
  }
}
