// Guards on the Android receiver apk.
//
// The apk exists to solve one problem a plain web page cannot: getUserMedia is
// gated on a secure context, so a page opened from file:// can never reach the
// camera. The shell serves the identical page over an https:// origin instead.
// These checks hold that contract — the page must be the shipped one, the
// camera permission must be declared, and the apk must be installable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInto } from '../build/bundle.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

let apk = null, reason = null;
try {
  const out = mkdtempSync(join(tmpdir(), 'vdtp-apk-'));
  buildInto('receiver', out);
  const { buildApk } = await import('../build/android.mjs');
  apk = { ...buildApk(out), pageDir: out };
} catch (err) {
  reason = String(err.message || err).split('\n')[0];
  console.log(`      apk not built (${reason})`);
}

const opts = () => ({ skip: apk ? false : `no android toolchain: ${reason}` });

test('the apk carries the byte-identical shipped receiver page', opts(), () => {
  const inside = execFileSync('unzip', ['-p', apk.path, 'assets/receiver.html'], { maxBuffer: 1 << 24 });
  const shipped = readFileSync(join(apk.pageDir, 'receiver.html'));
  assert.deepEqual(new Uint8Array(inside), new Uint8Array(shipped),
    'the page in the apk drifted from the page that ships on the web');
});

test('the manifest declares what the camera path needs', opts(), () => {
  const badging = execFileSync('aapt', ['dump', 'badging', apk.path], { encoding: 'utf8' });
  assert.match(badging, /uses-permission: name='android\.permission\.CAMERA'/);
  assert.match(badging, /launchable-activity: name='com\.vdtp\.receiver\.MainActivity'/);
  // Below 23 there is no runtime permission model; Android 14 refuses to
  // install anything targeting below 23 at all.
  assert.match(badging, /sdkVersion:'2[3-9]'|sdkVersion:'[3-9]\d'/);
});

test('the apk is signed and verifies', opts(), () => {
  const out = execFileSync('apksigner', ['verify', '--verbose', apk.path], { encoding: 'utf8' });
  assert.match(out, /Verifies/);
  assert.match(out, /v2 scheme \(APK Signature Scheme v2\): true/);
});

test('the shell serves the page over https, not file://', () => {
  const src = readFileSync(join(ROOT, 'android/java/com/vdtp/receiver/MainActivity.java'), 'utf8');
  assert.match(src, /String ORIGIN = "https:\/\//, 'assets must be served from an https origin');
  // Match what is loaded, not what the comments discuss.
  const loads = [...src.matchAll(/loadUrl\(\s*([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(loads.length > 0, 'nothing is loaded');
  for (const target of loads) {
    assert.doesNotMatch(target, /"file:/,
      'file:// is not a secure context — getUserMedia would be refused');
    assert.match(target, /ORIGIN/, `unexpected load target: ${target}`);
  }
  assert.match(src, /onPermissionRequest/, 'the page can never open the camera without this');
});
