// The receiver's DEFLATE decoder, checked against a reference encoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { inflateRaw } from '../core/inflate.js';
import { rand } from './helpers.mjs';

const CASES = [
  ['text', readFileSync(new URL('../README.md', import.meta.url))],
  ['source', readFileSync(new URL('../core/lt.js', import.meta.url))],
  ['incompressible', Buffer.from(rand(64 * 1024, 7))],
  ['all zeroes', Buffer.alloc(32768)],
  ['empty', Buffer.alloc(0)],
  ['highly repetitive', Buffer.from('abcabcabc'.repeat(5000))],
  ['single byte', Buffer.from([0x42])],
];

test('inflates every block type zlib produces', () => {
  for (const [name, data] of CASES) {
    for (const [label, opts] of [
      ['dynamic', {}],
      ['fixed', { strategy: zlib.constants.Z_FIXED }],
      ['stored', { level: 0 }],
    ]) {
      const comp = new Uint8Array(zlib.deflateRawSync(data, opts));
      const back = Buffer.from(inflateRaw(comp, data.length));
      assert.ok(back.equals(data), `${name} / ${label}`);
    }
  }
});

test('malformed input throws rather than returning rubbish', () => {
  // Silently returning garbage would corrupt a transfer with nothing to catch
  // it — the receiver reports the failure and lets SHA-256 stay meaningful.
  assert.throws(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff])));
  const good = new Uint8Array(zlib.deflateRawSync(Buffer.from('hello world')));
  assert.throws(() => inflateRaw(good.subarray(0, 2)));
});

test('overlapping back-references copy byte by byte', () => {
  // A run built from a distance-1 match is the classic case a bulk copy breaks.
  const data = Buffer.alloc(1000, 0xab);
  const comp = new Uint8Array(zlib.deflateRawSync(data));
  assert.ok(Buffer.from(inflateRaw(comp, data.length)).equals(data));
});
