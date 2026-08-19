// Builds every shipped artifact and enforces the size budget.
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(), '..');
function dirname() { return join(fileURLToPath(import.meta.url), '..'); }

const BUDGET = 3 * 1024 * 1024;
const dist = join(root, 'dist');
const CC = 'x86_64-w64-mingw32-gcc';

mkdirSync(dist, { recursive: true });
for (const f of readdirSync(dist)) rmSync(join(dist, f), { recursive: true, force: true });

const { buildInto, bundle, fingerprint } = await import('./bundle.mjs');

// Comments are stripped from what ships: the pages carry the whole source, and
// the apk carries the same page, so the design notes would travel with every
// copy. Set VDTP_KEEP_COMMENTS=1 to build readable artifacts for debugging.
const strip = !process.env.VDTP_KEEP_COMMENTS;
if (strip) {
  const plain = fingerprint(bundle());
  const stripped = fingerprint(bundle({ strip: true }));
  if (plain !== stripped) {
    console.error('!! comment stripping changed behaviour — refusing to build');
    console.error(`   with comments: ${plain}`);
    console.error(`   stripped:      ${stripped}`);
    process.exit(1);
  }
}

const pages = ['sender', 'receiver'].map((n) => buildInto(n, dist, { strip }));

let apk = null;
try {
  const { buildApk } = await import('./android.mjs');
  apk = buildApk(dist);
} catch (err) {
  console.error(`\n!! Android receiver NOT built: ${String(err.message || err).split('\n')[0]}`);
  console.error('   Install with:  sudo apt-get install default-jdk-headless android-sdk-build-tools \\');
  console.error('                                     apksigner zipalign android-sdk-platform-23\n');
  if (process.env.VDTP_REQUIRE_APK) process.exit(1);
}

let exe = null;
try {
  const out = join(dist, 'VDTP发送端.exe');
  execFileSync(CC, [
    '-std=c99', '-O2', '-Wall', '-Wextra', '-municode', '-mwindows',
    join(root, 'native', 'vdtp.c'), join(root, 'native', 'deflate.c'),
    join(root, 'native', 'sender_win32.c'),
    '-o', out, '-lcomdlg32', '-lgdi32', '-lbcrypt', '-lshell32', '-s',
  ], { stdio: 'pipe' });
  exe = { path: out, bytes: statSync(out).size };
} catch (err) {
  console.error(`\n!! Windows sender NOT built: ${CC} failed or is missing.`);
  console.error('   Install it with:  sudo apt-get install gcc-mingw-w64-x86-64\n');
  if (process.env.VDTP_REQUIRE_EXE) process.exit(1);
}

const items = [...(exe ? [exe] : []), ...(apk ? [apk] : []), ...pages];
let total = 0;
console.log('\nShipped artifacts');
for (const { path, bytes } of items) {
  total += bytes;
  console.log(`  ${path.replace(root + '/', '').padEnd(26)} ${(bytes / 1024).toFixed(1).padStart(8)} KB`);
}
const pct = (total / BUDGET * 100).toFixed(1);
console.log(`  ${'TOTAL'.padEnd(26)} ${(total / 1024).toFixed(1).padStart(8)} KB   ${pct}% of the 3 MB budget`);
if (total > BUDGET) { console.error('OVER BUDGET'); process.exit(1); }
