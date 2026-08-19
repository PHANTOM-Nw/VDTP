// Raw DEFLATE decoder (RFC 1951).
//
// Written rather than delegated to DecompressionStream for two reasons: that
// API is asynchronous, which would make the whole receive path async for a step
// that runs once at the end, and it needs a recent WebView. This is synchronous
// and works wherever the rest of the receiver does.

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman decoding table from a list of code lengths. */
function buildTable(lengths) {
  let maxBits = 0;
  for (const l of lengths) if (l > maxBits) maxBits = l;
  if (maxBits === 0) return null;

  const blCount = new Int32Array(maxBits + 1);
  for (const l of lengths) if (l) blCount[l]++;

  const nextCode = new Int32Array(maxBits + 2);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  // counts[len] and symbols sorted by (length, symbol) — the canonical order a
  // bit-at-a-time decoder walks.
  const counts = new Int32Array(maxBits + 1);
  const symbols = new Int32Array(lengths.length);
  for (let i = 0; i <= maxBits; i++) counts[i] = blCount[i];
  let offset = 0;
  const offsets = new Int32Array(maxBits + 2);
  for (let bits = 1; bits <= maxBits; bits++) { offsets[bits] = offset; offset += blCount[bits]; }
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym;
  }
  return { counts, symbols, maxBits };
}

class BitReader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; this.bit = 0; }

  read(count) {
    let v = 0;
    for (let i = 0; i < count; i++) {
      if (this.pos >= this.bytes.length) throw new RangeError('deflate: out of input');
      v |= ((this.bytes[this.pos] >> this.bit) & 1) << i;
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v;
  }

  align() { if (this.bit) { this.bit = 0; this.pos++; } }

  /** Huffman symbols are stored most-significant bit first. */
  symbol(table) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= table.maxBits; len++) {
      code |= this.read(1);
      const count = table.counts[len];
      if (code - first < count) return table.symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new RangeError('deflate: bad Huffman code');
  }
}

function fixedTables() {
  const lit = new Uint8Array(288);
  lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288);
  const dist = new Uint8Array(30).fill(5);
  return { literal: buildTable(lit), distance: buildTable(dist) };
}

function dynamicTables(r) {
  const hlit = r.read(5) + 257, hdist = r.read(5) + 1, hclen = r.read(4) + 4;
  const clen = new Uint8Array(19);
  for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = r.read(3);
  const clTable = buildTable(clen);

  const lengths = new Uint8Array(hlit + hdist);
  for (let i = 0; i < lengths.length;) {
    const sym = r.symbol(clTable);
    if (sym < 16) { lengths[i++] = sym; }
    else if (sym === 16) {
      if (i === 0) throw new RangeError('deflate: repeat with no previous length');
      const prev = lengths[i - 1], n = 3 + r.read(2);
      for (let k = 0; k < n; k++) lengths[i++] = prev;
    } else if (sym === 17) { const n = 3 + r.read(3); i += n; }
    else { const n = 11 + r.read(7); i += n; }
  }
  return {
    literal: buildTable(lengths.subarray(0, hlit)),
    distance: buildTable(lengths.subarray(hlit)),
  };
}

/** Raw DEFLATE stream -> bytes. Throws on malformed input. */
export function inflateRaw(bytes, expectedSize = 0) {
  const r = new BitReader(bytes);
  let out = new Uint8Array(expectedSize > 0 ? expectedSize : Math.max(64, bytes.length * 4));
  let len = 0;
  const grow = (need) => {
    if (len + need <= out.length) return;
    let cap = out.length * 2;
    while (cap < len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, len));
    out = next;
  };

  for (;;) {
    const final = r.read(1), type = r.read(2);

    if (type === 0) {
      r.align();
      if (r.pos + 4 > bytes.length) throw new RangeError('deflate: truncated stored block');
      const n = bytes[r.pos] | (bytes[r.pos + 1] << 8);
      r.pos += 4;
      grow(n);
      out.set(bytes.subarray(r.pos, r.pos + n), len);
      len += n; r.pos += n;
    } else if (type === 1 || type === 2) {
      const { literal, distance } = type === 1 ? fixedTables() : dynamicTables(r);
      for (;;) {
        const sym = r.symbol(literal);
        if (sym === 256) break;
        if (sym < 256) { grow(1); out[len++] = sym; continue; }

        const li = sym - 257;
        if (li >= LENGTH_BASE.length) throw new RangeError('deflate: bad length code');
        const length = LENGTH_BASE[li] + r.read(LENGTH_EXTRA[li]);
        const di = r.symbol(distance);
        if (di >= DIST_BASE.length) throw new RangeError('deflate: bad distance code');
        const dist = DIST_BASE[di] + r.read(DIST_EXTRA[di]);
        if (dist > len) throw new RangeError('deflate: distance before start of output');

        grow(length);
        // Byte at a time on purpose: overlapping copies are legal and common.
        for (let i = 0, from = len - dist; i < length; i++) out[len++] = out[from + i];
      }
    } else {
      throw new RangeError('deflate: reserved block type');
    }

    if (final) break;
  }
  return out.subarray(0, len);
}
