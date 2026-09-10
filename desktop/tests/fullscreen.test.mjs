import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFullscreen } from '../client/fullscreen.js';

class Target {
  listeners = new Map();
  addEventListener(type, fn) { const set = this.listeners.get(type) ?? new Set(); set.add(fn); this.listeners.set(type, set); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type, event = {}) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
const settled = () => new Promise(resolve => setImmediate(resolve));
function fixture(native = true) {
  const doc = new Target(), button = new Target();
  doc.fullscreenEnabled = native; doc.fullscreenElement = null;
  const root = { ownerDocument: doc, dataset: {} };
  button.attributes = {}; button.setAttribute = (name, value) => { button.attributes[name] = value; };
  let requests = 0, exits = 0;
  root.requestFullscreen = () => { requests++; doc.fullscreenElement = root; doc.emit('fullscreenchange'); return Promise.resolve(); };
  doc.exitFullscreen = () => { exits++; doc.fullscreenElement = null; doc.emit('fullscreenchange'); return Promise.resolve(); };
  const view = installFullscreen(root, button);
  return { doc, root, button, view, click: () => button.emit('click'), counts: () => ({ requests, exits }) };
}

test('native fullscreen and browser-driven exit keep one controller and an accurate button', async () => {
  const f = fixture();
  f.click(); await settled();
  assert.equal(f.root.dataset.desktopFullscreen, 'native');
  assert.equal(f.button.textContent, 'Exit full screen');
  assert.equal(f.button.attributes['aria-pressed'], 'true');
  f.doc.fullscreenElement = null; f.doc.emit('fullscreenchange');
  assert.equal(f.root.dataset.desktopFullscreen, undefined);
  assert.equal(f.button.textContent, 'Full screen');
  assert.deepEqual(f.view.stats(), { mode: 'none', pending: false, listeners: 3 });
  f.view.dispose(); assert.equal(f.doc.count() + f.button.count(), 0);
});

test('unsupported or denied native fullscreen uses expanded-page mode and Escape exits locally', async () => {
  for (const denied of [false, true]) {
    const f = fixture(denied);
    if (denied) f.root.requestFullscreen = () => Promise.reject(new Error('Not allowed'));
    f.click(); await settled();
    assert.equal(f.root.dataset.desktopFullscreen, 'page');
    assert.equal(f.button.textContent, 'Exit expanded view');
    let prevented = 0, stopped = 0;
    f.doc.emit('keydown', { key: 'Escape', preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    assert.equal(f.root.dataset.desktopFullscreen, undefined);
    f.view.dispose(); assert.equal(f.doc.count() + f.button.count(), 0);
  }
});

test('10,000 taps while native entry is pending do not queue requests or retain listeners', async () => {
  const f = fixture(); let resolve, requests = 0;
  f.root.requestFullscreen = () => { requests++; return new Promise(done => { resolve = done; }); };
  for (let i = 0; i < 10000; i++) f.click();
  assert.equal(requests, 1); assert.equal(f.doc.count() + f.button.count(), 3);
  assert.equal(f.view.stats().mode, 'none');
  f.doc.fullscreenElement = f.root; f.doc.emit('fullscreenchange'); resolve(); await settled();
  assert.equal(f.doc.fullscreenElement, null);
  assert.equal(f.view.stats().pending, false);
  assert.equal(f.counts().exits, 1);
  f.view.dispose(); assert.equal(f.doc.count() + f.button.count(), 0);
});

test('late entry completion after disposal exits native mode without reviving the view', async () => {
  const f = fixture(); let resolve;
  f.root.requestFullscreen = () => new Promise(done => { resolve = done; });
  f.click(); f.view.dispose(); f.view.dispose();
  assert.equal(f.doc.count() + f.button.count(), 0);
  f.doc.fullscreenElement = f.root; f.doc.emit('fullscreenchange'); resolve(); await settled();
  assert.equal(f.doc.fullscreenElement, null);
  assert.equal(f.root.dataset.desktopFullscreen, undefined);
  f.click(); assert.equal(f.view.stats().mode, 'none');
});

test('reset preserves reusable listeners for back/forward-cache restoration', async () => {
  const f = fixture(false);
  for (let i = 0; i < 100; i++) { f.click(); assert.equal(f.view.stats().mode, 'page'); f.view.reset(); }
  assert.equal(f.doc.count() + f.button.count(), 3);
  f.click(); assert.equal(f.view.stats().mode, 'page');
  f.view.dispose(); await settled();
  assert.equal(f.doc.count() + f.button.count(), 0);
});

test('an unrelated element fullscreen is never exited and synchronous API failures fall back safely', async () => {
  const f = fixture(); f.doc.fullscreenElement = {};
  f.click(); assert.equal(f.view.stats().mode, 'page'); f.view.reset();
  assert.equal(f.counts().requests, 0); assert.equal(f.counts().exits, 0);
  f.doc.fullscreenElement = null;
  f.root.requestFullscreen = () => { throw new Error('Unsupported'); };
  f.click(); await settled(); assert.equal(f.view.stats().mode, 'page'); assert.equal(f.view.stats().pending, false);
  f.view.dispose();
});
