// Guards on the shipped pages themselves.
//
// There is no browser in this environment, so the DOM code cannot be executed
// here. These are the strongest checks available without one: the page must
// parse, and it must not reach the network — an offline receiver that silently
// depends on a CDN fails in exactly the situation it exists for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildInto, bundle, stripComments, fingerprint } from '../build/bundle.mjs';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

const out = mkdtempSync(join(tmpdir(), 'vdtp-apps-'));
const pages = ['sender', 'receiver'].map((name) => {
  const { path } = buildInto(name, out);
  return { name, html: readFileSync(path, 'utf8') };
});

for (const { name, html } of pages) {
  test(`${name}.html has exactly one inline script and it parses`, () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1, 'expected a single inline script');
    assert.equal(scripts[0][1].trim(), '', 'script must have no attributes (no src, no type=module)');
    // Module syntax would need an external fetch; the page must be plain script.
    assert.doesNotThrow(() => new Function(scripts[0][2]), 'inline script does not parse');
  });

  test(`${name}.html makes no external requests`, () => {
    const offenders = [
      [/\bsrc\s*=\s*["'](?!data:)/i, 'external src attribute'],
      [/<link\b[^>]*\bhref\s*=/i, 'external stylesheet'],
      // Require a real host character after the slashes: the receiver prints
      // "https://" as prose when explaining the secure-context requirement.
      [/https?:\/\/(?!localhost)[a-z0-9]/i, 'absolute URL to a remote host'],
      [/\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket/i, 'network call'],
      [/@import\b/i, 'CSS @import'],
    ];
    for (const [re, what] of offenders) {
      const m = html.match(re);
      assert.equal(m, null, `${what} found: ${m && m[0]}`);
    }
  });

  test(`${name}.html declares its charset before any content`, () => {
    // Chinese UI text is mojibake without this, and it must appear early.
    const idx = html.indexOf('<meta charset="utf-8">');
    assert.ok(idx > 0 && idx < 200, 'charset must be declared in the first bytes of <head>');
  });
}

test('the receiver explains the file:// camera restriction', () => {
  const { html } = pages.find((p) => p.name === 'receiver');
  // The single most likely support question; the page must answer it itself.
  assert.match(html, /file:\/\//, 'receiver does not mention the file:// limitation');
  assert.match(html, /localhost/, 'receiver does not offer a working alternative');
});

test('both pages carry the same protocol core', () => {
  const core = (html) => html.match(/const MAGIC = 0x56445450;[\s\S]*?const VERSION = 1;/);
  for (const { name, html } of pages) assert.ok(core(html), `${name} is missing the frame core`);
});

test('the bundler refuses to flatten two modules that declare the same name', () => {
  // Flattening puts every module in one scope, where a duplicate wins by source
  // order and the loser's callers silently get the wrong function. That is not
  // hypothetical: a Gray-code helper named toGray in visual/matrix.js was
  // shadowed by visual/detect.js's RGBA-to-grayscale toGray, so every
  // module-level test passed while the shipped pages decoded nothing.
  assert.doesNotThrow(() => bundle(), 'the current module set collides');

  const src = bundle();
  const declared = new Map();
  const re = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m; (m = re.exec(src)); ) {
    declared.set(m[1], (declared.get(m[1]) || 0) + 1);
  }
  const clashes = [...declared].filter(([, n]) => n > 1).map(([name]) => name);
  assert.deepEqual(clashes, [], `duplicate top-level names in the bundle: ${clashes}`);
});

test('shipped pages carry no source commentary', () => {
  // The pages contain the whole receiver, and the apk carries the same page,
  // so every comment ships with every copy — including the design notes and
  // the measurements behind them. Stripping is part of building, not a
  // nice-to-have, and this is what keeps it that way.
  for (const { name, html } of pages) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    // `*` only continues a block comment when a space or `/` follows it;
    // `*stream() {` is a generator method, not commentary.
    const commentLines = script.split('\n').filter((l) => /^\s*(\/\/|\/\*|\*[\s/])/.test(l));
    assert.ok(commentLines.length <= 2,
      `${name}: ${commentLines.length} comment lines survived, e.g. ${commentLines[0]}`);
    assert.doesNotMatch(script, /\/\/ ---- /, `${name} still names its source modules`);
  }
});

test('stripping comments does not change what the code does', () => {
  // The stripper is a hand-written state machine over quoting and template
  // literals. A mistake in one deletes code rather than a comment, and parsing
  // would still succeed. Comparing behaviour is the check that actually holds.
  assert.equal(fingerprint(bundle({ strip: true })), fingerprint(bundle()),
    'the stripped bundle computes different answers');
});

test('the stripper keeps strings and template literals intact', () => {
  // These are what a regex-based stripper gets wrong: a `//` inside a string,
  // and the nested braces of a template substitution.
  const cases = [
    ['const a = "http://x"; // gone', 'const a = "http://x"; '],
    ['const b = `a${x ? `//${y}` : "/*"}b`; /* gone */ const c = 1;',
     'const b = `a${x ? `//${y}` : "/*"}b`;   const c = 1;'],
    ['const d = 1; /* multi\nline */ const e = 2;', 'const d = 1;   const e = 2;'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripComments(input).replace(/\n/g, ' '), expected.replace(/\n/g, ' '), input);
  }
});
