// The pages' own state machines, driven through a stub DOM.
//
// apps.test.js can only check that the shipped pages parse and stay offline;
// everything the operator actually touches — which panel is up, what a button
// clears — went untested because there is no browser here. There does not need
// to be one: the page's script is ordinary JavaScript over a handful of DOM
// calls, and stubbing those is enough to run it.
//
// The stub deliberately creates elements for exactly the ids the HTML declares,
// so a getElementById for an id that does not exist returns null and fails on
// the next property access rather than passing quietly. That is the failure
// mode these tests exist for: a reset path that misses a readout leaves the
// previous transfer's file name on screen under the next one's progress.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildInto } from '../build/bundle.mjs';

const out = mkdtempSync(join(tmpdir(), 'vdtp-ui-'));
const pageSource = (name) => readFileSync(buildInto(name, out).path, 'utf8');

class El {
  constructor(id) {
    this.id = id;
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.srcObject = null;
    this.style = { display: '', width: '' };
    this.width = 0; this.height = 0;
    this.clientWidth = 640; this.clientHeight = 480;
    this.videoWidth = 0; this.videoHeight = 0;
    this._classes = new Set();
    this._listeners = new Map();
    this.classList = {
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c),
      toggle: (c, on) => (on ? this._classes.add(c) : this._classes.delete(c)),
      contains: (c) => this._classes.has(c),
    };
  }
  set className(v) { this._classes = new Set(String(v).split(' ').filter(Boolean)); }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  fire(type, ev = {}) {
    return (this._listeners.get(type) || []).map((fn) => fn({ target: this, ...ev }));
  }
  querySelector() { return new El('anon'); }
  getContext() { return DRAW; }
  play() { return Promise.resolve(); }
  appendChild() {} remove() {} click() {} pause() {}
}

// Every 2D context call is a no-op; nothing here inspects pixels.
const DRAW = new Proxy({}, {
  get: (_, k) => (k === 'getImageData' ? () => ({ data: new Uint8ClampedArray(4) }) : () => {}),
});

function stubDom(html) {
  const els = new Map();
  for (const [tag] of html.matchAll(/<[a-z][a-z0-9]*\s[^>]*>/gi)) {
    const id = tag.match(/\bid="([^"]+)"/);
    if (!id) continue;
    const el = new El(id[1]);
    const style = tag.match(/\bstyle="([^"]*)"/);
    if (style && style[1].includes('display:none')) el.style.display = 'none';
    if (tag.includes(' disabled')) el.disabled = true;
    const cls = tag.match(/\bclass="([^"]*)"/);
    if (cls) el.className = cls[1];
    els.set(id[1], el);
  }
  // A <select> reports its selected option; without this every dropdown the
  // page reads at load looks empty.
  for (const [, id, body] of html.matchAll(/<select[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...body.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
    const chosen = options.find((o) => o[2].includes('selected')) || options[0];
    if (chosen) els.get(id).value = chosen[1];
  }

  const listeners = new Map();
  const document = {
    getElementById: (id) => els.get(id) ?? null,
    createElement: () => new El('created'),
    body: new El('body'),
  };
  const addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  const fireWindow = (type, ev = {}) => {
    for (const fn of listeners.get(type) || []) fn({ preventDefault() {}, ...ev });
  };
  const $ = (id) => {
    const el = els.get(id);
    assert.ok(el, `the page has no #${id}`);
    return el;
  };
  return { $, document, addEventListener, fireWindow };
}

const scriptOf = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test('receiver: every route back to the start page clears the transfer', async () => {
  const { $, document, addEventListener } = stubDom(pageSource('receiver'));
  const stopped = [];
  const asked = [];
  const pending = [];
  const navigator = {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] }) },
  };
  El.prototype.requestVideoFrameCallback = (fn) => pending.push(fn);

  new Function('document', 'navigator', 'window', 'addEventListener', 'confirm',
               'requestAnimationFrame', 'performance', 'URL', 'Blob', 'btoa',
    scriptOf(pageSource('receiver')))(
    document, navigator, {}, addEventListener,
    (q) => { asked.push(q); return true; },
    (fn) => pending.push(fn), performance,
    { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, class {}, () => '');

  assert.equal($('startPanel').style.display, '', 'the page must open on the start panel');
  assert.equal($('progressPanel').style.display, 'none');

  await $('start').fire('click')[0];
  assert.equal($('startPanel').style.display, 'none');
  assert.equal($('progressPanel').style.display, 'block');
  assert.equal($('view').style.display, 'block');
  assert.notEqual($('video').srcObject, null);

  // Dirty the readouts the way a running transfer does, then leave.
  $('sName').textContent = 'secret.pdf';
  $('pct').textContent = '42%';
  $('sFrames').textContent = '210 / 4 / 9';
  $('bar').classList.add('done');
  $('backProgress').fire('click');

  assert.equal($('startPanel').style.display, 'block', 'did not return to the start page');
  assert.equal($('progressPanel').style.display, 'none');
  assert.equal($('donePanel').style.display, 'none');
  assert.equal($('view').style.display, 'none');
  assert.equal($('sName').textContent, '—', 'the previous file name survived');
  assert.equal($('pct').textContent, '0%', 'progress survived');
  assert.equal($('sFrames').textContent, '0 / 0 / 0', 'frame counters survived');
  assert.equal($('bar').classList.contains('done'), false, 'the bar is still green');
  assert.equal($('video').srcObject, null, 'the video is still bound to the old stream');
  assert.equal(stopped.length, 1, 'the camera was left running');
  assert.deepEqual(asked, [], 'asked for confirmation with nothing yet received');

  // The button on the live view is the same path.
  await $('start').fire('click')[0];
  $('backLive').fire('click');
  assert.equal($('startPanel').style.display, 'block');
  assert.equal(stopped.length, 2, 'the camera was left running');

  // A frame callback queued before the reset must not restart the loop: two
  // loops running against one receiver would double every counter on screen.
  await $('start').fire('click')[0];
  $('backProgress').fire('click');
  for (const fn of pending.splice(0)) fn();
  assert.equal(pending.length, 0, 'a callback from the stopped run rescheduled itself');
});

test('sender: a file dropped anywhere on the window loads, and clearing undoes it', async () => {
  const html = pageSource('sender');
  const { $, document, addEventListener, fireWindow } = stubDom(html);
  new Function('document', 'window', 'addEventListener', 'requestAnimationFrame', 'performance',
    scriptOf(html))(document, {}, addEventListener, () => {}, performance);

  const bytes = new Uint8Array(64 * 1024).map((_, i) => (i * 37 + 11) & 0xff);
  const file = (name, data) => ({
    name, size: data.length,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
  });
  const withFiles = (files) => ({ types: ['Files'], files, dropEffect: '' });

  assert.equal($('start').disabled, true, 'playback is offered with no file');
  assert.equal($('clear').disabled, true, 'clearing is offered with nothing to clear');

  // The overlay must survive the pointer crossing into a child element: the
  // enter for the new target arrives before the leave for the old one.
  fireWindow('dragenter', { dataTransfer: withFiles([]) });
  assert.equal($('dropzone').classList.contains('on'), true, 'no overlay while dragging a file');
  fireWindow('dragenter', { dataTransfer: withFiles([]) });
  fireWindow('dragleave', { dataTransfer: withFiles([]) });
  assert.equal($('dropzone').classList.contains('on'), true, 'the overlay flickered off over a child');
  fireWindow('dragleave', { dataTransfer: withFiles([]) });
  assert.equal($('dropzone').classList.contains('on'), false, 'the overlay stuck after the drag left');

  // A drag with no file in it is none of our business.
  fireWindow('dragenter', { dataTransfer: { types: ['text/plain'], files: [] } });
  assert.equal($('dropzone').classList.contains('on'), false, 'the overlay armed for a text drag');

  let prevented = 0;
  fireWindow('dragenter', { dataTransfer: withFiles([]) });
  fireWindow('drop', {
    dataTransfer: withFiles([file('report.pdf', bytes)]),
    preventDefault: () => prevented++,
  });
  // Without this the browser navigates to the dropped file and the page is gone.
  assert.equal(prevented, 1, 'the drop default was not cancelled');
  assert.equal($('dropzone').classList.contains('on'), false, 'the overlay outlived the drop');

  await waitFor(() => $('mHash').textContent.length === 64, 'the dropped file to be hashed');
  assert.equal($('fname').textContent, 'report.pdf');
  assert.equal($('fileInfo').style.display, 'flex');
  assert.equal($('start').disabled, false, 'playback is still refused after a drop');
  assert.equal($('clear').disabled, false, 'clearing is still refused after a drop');
  assert.notEqual($('mK').textContent, '—', 'the block count was never computed');
  const first = $('mHash').textContent;

  $('clear').fire('click');
  assert.equal($('start').disabled, true, 'playback survived the clear');
  assert.equal($('clear').disabled, true);
  assert.equal($('fileInfo').style.display, 'none', 'the file row survived the clear');
  assert.equal($('fname').textContent, '', 'the file name survived the clear');
  assert.equal($('mK').textContent, '—', 'the block count survived the clear');
  assert.equal($('mHash').textContent, '—', 'the digest survived the clear');
  assert.equal($('mComp').textContent, '—', 'the compression note survived the clear');
  // Without this the same file picked again fires no change event and nothing
  // happens, which reads as a broken page.
  assert.equal($('pick').value, '', 'the file input kept its selection');
  assert.equal($('grid').value, '64', 'the grid is not back at its default');
  assert.equal($('fps').value, '10', 'the frame rate is not back at its default');
  assert.equal($('levels').value, '2', 'the modulation depth is not back at its default');

  fireWindow('drop', { dataTransfer: withFiles([file('other.bin', bytes.slice(0, 4096))]) });
  await waitFor(() => $('fname').textContent === 'other.bin', 'the second file to load');
  await waitFor(() => $('mHash').textContent !== first && $('mHash').textContent.length === 64,
                'the second file to be hashed');
  assert.equal($('start').disabled, false, 'the second file cannot be played');
});
