// Builds the Android receiver apk from the same page that ships as dist/receiver.html.
//
// Uses Debian's android-sdk-build-tools for the native tools (aapt, zipalign):
// they are built for the host architecture, whereas Google ships x86-64 only,
// which does not run on an aarch64 build machine.
//
// Debian packages no dexer, so D8 comes from Google's official r8.jar. That one
// is pure Java, so architecture is not a problem — it is fetched once into
// build/out/ and cached. (Note: apt's `dx` package is OpenDX, an unrelated
// visualisation tool, not the Android dexer.)
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const ANDROID_JAR = '/usr/lib/android-sdk/platforms/android-23/android.jar';
const work = join(root, 'build', 'out', 'apk');
const keystore = join(root, 'build', 'out', 'debug.keystore');
const R8_JAR = join(root, 'build', 'out', 'r8.jar');
const R8_VERSION = '8.5.35';
const R8_URL = `https://maven.google.com/com/android/tools/r8/${R8_VERSION}/r8-${R8_VERSION}.jar`;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

export function buildApk(outDir) {
  if (!existsSync(ANDROID_JAR)) throw new Error(`missing ${ANDROID_JAR} (apt: android-sdk-platform-23)`);

  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'assets'), { recursive: true });
  mkdirSync(join(work, 'classes'), { recursive: true });

  // The apk carries the very same page the web receiver ships.
  copyFileSync(join(outDir, 'receiver.html'), join(work, 'assets', 'receiver.html'));

  const android = join(root, 'android');
  const unsigned = join(work, 'app-unsigned.apk');

  run('aapt', ['package', '-f',
    '-M', join(android, 'AndroidManifest.xml'),
    '-S', join(android, 'res'),
    '-A', join(work, 'assets'),
    '-I', ANDROID_JAR,
    '-F', unsigned]);

  const sources = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.java')) sources.push(p);
    }
  })(join(android, 'java'));

  run('javac', ['-nowarn', '-source', '8', '-target', '8',
    '-bootclasspath', ANDROID_JAR, '-classpath', ANDROID_JAR,
    '-d', join(work, 'classes'), ...sources]);

  if (!existsSync(R8_JAR)) {
    console.log(`fetching D8 (${R8_URL}) …`);
    run('curl', ['-fsSL', '--max-time', '180', '-o', R8_JAR, R8_URL]);
  }

  const classes = [];
  (function walkClasses(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkClasses(p);
      else if (e.name.endsWith('.class')) classes.push(p);
    }
  })(join(work, 'classes'));

  run('java', ['-cp', R8_JAR, 'com.android.tools.r8.D8',
    '--release', '--min-api', '23', '--lib', ANDROID_JAR,
    '--output', work, ...classes]);

  run('aapt', ['add', unsigned, 'classes.dex'], { cwd: work });

  if (!existsSync(keystore)) {
    // Debug key: fine for sideloading, not for distribution. A release build
    // should pass a real keystore rather than reuse this one.
    run('keytool', ['-genkeypair', '-keystore', keystore, '-alias', 'vdtp',
      '-storepass', 'android', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048',
      '-validity', '10000', '-dname', 'CN=VDTP, OU=Dev, O=VDTP, C=CN']);
  }

  const aligned = join(work, 'app-aligned.apk');
  run('zipalign', ['-f', '4', unsigned, aligned]);

  const apk = join(outDir, 'VDTP接收端.apk');
  // v4 signing writes a side-car .idsig that sideloading never uses; leaving it
  // in dist/ just makes the delivery folder confusing.
  run('apksigner', ['sign', '--ks', keystore,
    '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
    '--v4-signing-enabled', 'false',
    '--out', apk, aligned]);

  run('apksigner', ['verify', apk]);
  return { path: apk, bytes: statSync(apk).size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, 'dist');
  const { path, bytes } = buildApk(out);
  console.log(`${path.replace(root + '/', '')}  ${(bytes / 1024).toFixed(1)} KB`);
}
