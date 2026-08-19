// Inlines the ES modules into each app as one <script> block.
//
// Single-file output is a hard requirement, not a convenience: the sender runs
// from file:// on an offline Windows box (where module imports are blocked by
// CORS) and the receiver must work with no network at all.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Dependency order, hand-maintained: the graph is small and acyclic.
const MODULES = [
  'core/prng.js', 'core/crc32.js', 'core/sha256.js', 'core/lt.js',
  'core/frame.js', 'core/rs.js', 'core/ecc.js', 'core/inflate.js', 'core/session.js',
  'visual/matrix.js', 'visual/render.js', 'visual/detect.js', 'visual/scan.js',
];

/**
 * Remove comments without a regular expression.
 *
 * Regexes cannot do this correctly: `//` appears inside strings and template
 * literals, and the bundled modules use templates heavily. This walks the
 * source with a small state machine that tracks quoting, including `${}`
 * nesting inside templates.
 *
 * Division is emitted as-is. The bundled modules contain no regular expression
 * literals — telling `/` apart needs the previous token, and guessing wrong
 * would silently delete code — so `assertNoRegexLiteral` refuses to strip a
 * module that introduces one.
 */
export function stripComments(source) {
  const out = [];
  const len = source.length;
  let i = 0;

  // Stack of template-literal states: each entry is the brace depth of the
  // `${}` we are currently inside, or -1 when in the literal text itself.
  const templates = [];
  let quote = null;      // "'" or '"' when inside a plain string

  while (i < len) {
    const c = source[i], next = source[i + 1];

    if (quote) {
      out.push(c);
      if (c === '\\') { out.push(source[i + 1] ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }

    const inTemplateText = templates.length > 0 && templates[templates.length - 1] === -1;
    if (inTemplateText) {
      out.push(c);
      if (c === '\\') { out.push(source[i + 1] ?? ''); i += 2; continue; }
      if (c === '`') { templates.pop(); i++; continue; }
      if (c === '$' && next === '{') { out.push(next); templates[templates.length - 1] = 0; i += 2; continue; }
      i++;
      continue;
    }

    if (c === '/' && next === '/') {
      while (i < len && source[i] !== '\n') i++;      // keep the newline: ASI
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < len && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      out.push(' ');                                  // never merge two tokens
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out.push(c); i++; continue; }
    if (c === '`') { templates.push(-1); out.push(c); i++; continue; }

    if (templates.length > 0 && templates[templates.length - 1] >= 0) {
      if (c === '{') templates[templates.length - 1]++;
      else if (c === '}') {
        if (templates[templates.length - 1] === 0) { templates[templates.length - 1] = -1; out.push(c); i++; continue; }
        templates[templates.length - 1]--;
      }
    }

    out.push(c);
    i++;
  }
  return out.join('').replace(/\n{3,}/g, '\n\n');
}

/** Refuse to strip a module carrying a regex literal; see stripComments. */
function assertNoRegexLiteral(source, path) {
  const withoutComments = stripComments(source);
  const suspicious = /(^|[=(,:;!&|?{[]|\breturn\b|\btypeof\b)\s*\/(?![/*=\s])/;
  const line = withoutComments.split('\n').find((l) => suspicious.test(l));
  if (line) {
    throw new Error(
      `bundle: ${path} appears to contain a regular expression literal ` +
      `(${line.trim().slice(0, 60)}). The comment stripper cannot tell one from ` +
      'division without a tokeniser — move it into a string, or extend the stripper.');
  }
}

function flatten(source) {
  return source
    .replace(/^import\s+[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm, '')
    .replace(/^export\s*\{[\s\S]*?\};[ \t]*$/gm, '')
    .replace(/^export\s+(const|function|class|let|var|async)\s/gm, '$1 ');
}

/**
 * Top-level declarations, so the bundler can refuse to flatten two modules that
 * define the same name.
 *
 * Flattening puts every module in one scope, where a duplicate silently wins by
 * source order and the loser's callers get the wrong function. That happened:
 * a Gray-code helper named `toGray` in visual/matrix.js was shadowed by
 * visual/detect.js's RGBA-to-grayscale `toGray`, so every module-level test
 * passed and the shipped pages decoded nothing.
 */
function declarationsIn(source) {
  const names = [];
  const re = /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (let m; (m = re.exec(source)); ) names.push(m[1]);
  return names;
}

export function bundle({ strip = false } = {}) {
  const seen = new Map();
  const parts = [];
  for (const path of MODULES) {
    let source = readFileSync(join(root, path), 'utf8');
    if (strip) { assertNoRegexLiteral(source, path); source = stripComments(source); }
    for (const name of declarationsIn(source)) {
      const previous = seen.get(name);
      if (previous && previous !== path) {
        throw new Error(
          `bundle: "${name}" is declared in both ${previous} and ${path}. ` +
          'Flattening would let one silently shadow the other — rename it.');
      }
      seen.set(name, path);
    }
    // The module banner is itself a comment, and naming the source files is
    // exactly what stripping is meant to withhold.
    parts.push(strip ? flatten(source) : `// ---- ${path} ----\n${flatten(source)}`);
  }
  return parts.join('\n');
}

export function buildInto(name, outDir, { strip = true } = {}) {
  const template = readFileSync(join(root, 'app', `${name}.template.html`), 'utf8');
  const core = bundle({ strip });
  let out = template.replace('/*__VDTP_CORE__*/', () => core);

  if (strip) {
    // The page's own script has to be stripped after substitution, because the
    // injection point is itself a block comment. Stripping the core twice is
    // harmless — the pass is idempotent.
    out = stripHtmlComments(out).replace(
      /<script>([\s\S]*?)<\/script>/,
      (_, body) => `<script>${stripComments(body)}</script>`);
  }
  const path = join(outDir, `${name}.html`);
  writeFileSync(path, out);
  return { path, bytes: Buffer.byteLength(out) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(root, 'dist'), { recursive: true });
  for (const name of ['sender', 'receiver']) {
    const { path, bytes } = buildInto(name, join(root, 'dist'));
    console.log(`${path.replace(root + '/', '').padEnd(22)} ${(bytes / 1024).toFixed(1).padStart(7)} KB`);
  }
}

/** HTML comments only; the page's own script is stripped with the bundle. */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Run a fixed workload through a bundle and digest the result.
 *
 * Comment stripping walks the source with a hand-written state machine, and a
 * mistake in one — a template literal or a quoted `//` handled wrongly — would
 * delete code rather than a comment. Parsing proves nothing about that. This
 * exercises the layers a shipped page depends on and compares the answers, so
 * a stripper bug fails the build instead of shipping.
 */
export function fingerprint(source) {
  const api = new Function(source + `
    return { sha256, hex, LtEncoder, MatrixLayout, planBands, encodeFrameBands,
             eccEncode, ECC_REDUNDANCY, encodeFrame, FrameType, crc32 };
  `)();

  const bytes = new Uint8Array(4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;

  const parts = [api.hex(api.sha256(bytes)), String(api.crc32(bytes))];

  const enc = new api.LtEncoder(bytes, 256);
  for (const seed of [1, 2, 97, 1000]) parts.push(api.hex(api.sha256(enc.symbol(seed))));

  for (const levels of [2, 4, 8]) {
    for (const n of [64, 128]) {
      const layout = new api.MatrixLayout(n, levels);
      const padded = new Uint8Array(layout.capacityBytes);
      padded.set(bytes.subarray(0, Math.min(bytes.length, layout.capacityBytes)));
      parts.push(api.hex(api.sha256(layout.encode(padded))));
      parts.push(api.hex(api.sha256(layout.decode(layout.encode(padded)))));

      const plan = api.planBands(layout);
      parts.push(`${plan.count}:${plan.payload}:${plan.frameBudget}`);
      const frames = plan.bands.map((_, i) => api.encodeFrame({
        type: api.FrameType.DATA, sessionTag: 7, frameId: i, seed: i + 1, eccLevel: 1,
        payload: bytes.subarray(0, plan.frameBudget),
      }));
      parts.push(api.hex(api.sha256(api.encodeFrameBands(layout, plan, frames, true))));
    }
  }

  parts.push(api.hex(api.sha256(api.eccEncode(bytes.subarray(0, 200), 418, api.ECC_REDUNDANCY))));
  return api.hex(api.sha256(new TextEncoder().encode(parts.join('|'))));
}
