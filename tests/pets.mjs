// Run: node --experimental-vm-modules --test tests/pets.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { petAnimations, nextPetId, fits, clearPath, safeDestination, gestureAction, turnIsCurrent } from '../js/ui/pet-behavior.js';

test('pet sheets use their actual action rows and valid occupied frames', () => {
  const violet = petAnimations('violet.webp'), lilith = petAnimations('lilith.webp');
  assert.equal(violet.thinking.row, 7);
  assert.equal(violet.writing.row, 6);
  assert.equal(lilith.thinking.row, 8);
  assert.equal(lilith.writing.row, 7);
  assert.equal(lilith.sleep.row, 6);
  for (const [animations, rows] of [[violet, 9], [lilith, 11]]) {
    for (const action of Object.values(animations)) {
      assert.ok(action.row >= 0 && action.row < rows);
      assert.ok(action.frames >= 4 && action.frames <= 8);
    }
  }
});

test('selection avoids repeats without excluding a single selected pet', () => {
  assert.equal(nextPetId(['violet', 'lilith.webp', 'violet'], 'violet', () => 0), 'lilith.webp');
  assert.equal(nextPetId(['violet'], 'violet'), 'violet');
  assert.equal(nextPetId([], 'violet'), null);
});

test('roaming rejects routes through controls, even when the destination is safe', () => {
  const bounds = { x: 0, y: 0, width: 390, height: 550 };
  const controls = [{ x: 140, y: 80, width: 50, height: 120 }];
  assert.ok(fits({ x: 280, y: 100 }, bounds, 70, controls));
  assert.equal(clearPath({ x: 20, y: 100 }, { x: 280, y: 100 }, bounds, 70, controls), false);
  assert.ok(clearPath({ x: 20, y: 300 }, { x: 280, y: 300 }, bounds, 70, controls));
  assert.equal(fits({ x: 350, y: 100 }, bounds, 70), false);
});

test('invalid drops snap to the nearest clear position or report no available space', () => {
  const bounds = { x: 0, y: 0, width: 390, height: 550 };
  const candidates = [{ x: 20, y: 20 }, { x: 160, y: 20 }, { x: 300, y: 20 }];
  const obstacles = [{ x: 0, y: 0, width: 120, height: 100 }];
  assert.deepEqual(safeDestination({ x: 30, y: 20 }, candidates, bounds, 70, obstacles), candidates[1]);
  assert.equal(safeDestination({ x: 0, y: 0 }, candidates, bounds, 70, [bounds]), null);
});

test('phone scrolling wins before the hold threshold; mouse dragging starts immediately', () => {
  const touch = { type: 'touch', x: 10, y: 10, at: 1000 };
  assert.equal(gestureAction(touch, 10, 40, 1200), 'scroll');
  assert.equal(gestureAction(touch, 10, 10, 1350), 'hold');
  assert.equal(gestureAction(touch, 10, 40, 1400), 'drag');
  assert.equal(gestureAction({ ...touch, type: 'mouse' }, 20, 10, 1001), 'drag');
});

test('request callbacks require both the current turn and current session', () => {
  const current = { id: 2, sessionId: 'story' };
  assert.equal(turnIsCurrent({ id: 1, sessionId: 'story' }, current, 'story'), false);
  assert.equal(turnIsCurrent(current, current, 'other'), false);
  assert.equal(turnIsCurrent(current, current, 'story'), true);
});

// A deterministic DOM/clock fixture exercises the real controller without network,
// Firebase, or browser credentials. Geometry helpers above cover route correctness.
async function harness({ mobile = false, reduced = false } = {}) {
  let now = 100000, nextId = 0;
  const frames = new Map(), timers = new Map(), ids = new Map(), assets = [], observers = [];
  const state = { settings: { petCharacterIds: [], petMovement: 'roam' }, sessionId: 'story', busy: false };
  class Element {
    constructor() {
      this.children = []; this.listeners = {}; this.hidden = false; this.dataset = {}; this.attributes = {};
      this.style = { values: {}, setProperty(k, v) { this.values[k] = v; }, getPropertyValue(k) { return this.values[k] ?? ''; }, removeProperty(k) { delete this.values[k]; } };
      this.classList = { values: new Set(), contains(k) { return this.values.has(k); }, add(k) { this.values.add(k); }, remove(k) { this.values.delete(k); }, toggle(k, value) { const on = value ?? !this.values.has(k); if (on) this.values.add(k); else this.values.delete(k); return on; } };
    }
    set id(value) { this._id = value; ids.set(value, this); }
    get id() { return this._id; }
    set className(value) { this.classList.values = new Set(value.split(' ')); }
    get className() { return [...this.classList.values].join(' '); }
    get parentElement() { return this.parentNode; }
    get firstElementChild() { return this.children[0]; }
    get offsetWidth() { return 190; }
    get offsetHeight() { return 190; }
    setAttribute(k, v) { this.attributes[k] = v; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(type, callback) { (this.listeners[type] ??= []).push(callback); }
    dispatchEvent(event) { for (const cb of this.listeners[event.type] ?? []) cb(event); }
    prepend(child) { child.remove(); this.children.unshift(child); child.parentNode = this; }
    append(...children) { for (const child of children) { child.remove(); this.children.push(child); child.parentNode = this; } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
    replaceChildren(...children) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...children); }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    closest() { if (this.hidden || this.classList.contains('hidden')) return this; return this.parentNode?.closest() ?? null; }
    getClientRects() { return this.closest() ? [] : [this.getBoundingClientRect()]; }
    getBoundingClientRect() {
      let x = 40, y = 100, width = 64, height = 64;
      if (this.classList.contains('pet-home-slot')) {
        const welcome = this.classList.contains('pet-welcome-slot');
        width = height = welcome ? (mobile ? 156 : 208) : 64;
        x = welcome ? 150 : 40; y = welcome ? 160 : 100;
      } else if (this.id === 'chat-pet') {
        width = height = Number.parseFloat(this.style.getPropertyValue('--pet-box')) || 64;
        const match = this.style.transform?.match(/translate3d\(([-\d.]+)px, ([-\d.]+)px/);
        if (match) { x = Number(match[1]); y = Number(match[2]); }
      } else if (this.rect) ({ x, y, width, height } = this.rect);
      return { x, y, left: x, top: y, width, height, right: x + width, bottom: y + height };
    }
    querySelectorAll() { return this.children; }
    querySelector(selector) { return this === welcome && selector === '.welcome-mark' ? welcomeMark : this.children[0] ?? null; }
    focus() { document.activeElement = this; }
    setPointerCapture() {} hasPointerCapture() { return false; } releasePointerCapture() {}
  }
  const document = new Element(); document.body = new Element(); document.hidden = false;
  const node = (id) => { const el = new Element(); el.id = id; return el; };
  const app = node('app'), chat = node('chat-tab'), list = node('message-list'), welcome = node('welcome');
  welcome.hidden = true;
  const welcomeMark = new Element(), logo = new Element(), label = new Element(), main = new Element();
  const composer = node('composer'); composer.rect = { x: 0, y: 600, width: mobile ? 390 : 1000, height: 150 };
  main.rect = { x: 0, y: 0, width: mobile ? 390 : 1000, height: 750 };
  list.rect = { x: 0, y: 70, width: mobile ? 390 : 1000, height: 530 };
  node('chat-input'); node('chat-pet'); node('top-menu').hidden = true; node('composer-popover').hidden = true;
  document.getElementById = (id) => ids.get(id) ?? null;
  document.createElement = () => new Element();
  document.querySelector = (selector) => selector === '.main' ? main : selector.includes('welcome-mark') ? welcomeMark : selector.includes('welcome-default') ? logo : null;
  document.querySelectorAll = (selector) => selector.includes('span:first-child') ? (welcome.hidden ? [label] : []) : [];
  const window = new Element(); window.innerWidth = mobile ? 390 : 1000; window.innerHeight = 750;
  window.matchMedia = (query) => ({ matches: query.includes('reduced') ? reduced : mobile, addEventListener() {} });
  window.setTimeout = (cb, ms) => { const id = ++nextId; timers.set(id, { cb, due: now + ms }); return id; };
  window.clearTimeout = (id) => timers.delete(id);
  class Clock extends Date { static now() { return now; } }
  class Image {
    set src(value) { assets.push(value); queueMicrotask(() => this.onload()); }
  }
  const context = vm.createContext({ state, window, document, Image, URL, Date: Clock, Math,
    performance: { now: () => now },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } },
    MutationObserver: class { constructor(callback) { observers.push(callback); } observe() {} },
    requestAnimationFrame(cb) { const id = ++nextId; frames.set(id, cb); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    fetch: async () => { throw new Error('Catalog fetched outside Settings'); },
  });
  const helpers = new vm.SourceTextModule(await readFile(new URL('../js/ui/pet-behavior.js', import.meta.url), 'utf8'), { context });
  const module = new vm.SourceTextModule(await readFile(new URL('../js/ui/pet-view.js', import.meta.url), 'utf8'), {
    context, initializeImportMeta(meta) { meta.url = new URL('../js/ui/pet-view.js', import.meta.url).href; },
  });
  await module.link((name) => name.includes('behavior') ? helpers : new vm.SyntheticModule(['state'], function () { this.setExport('state', state); }, { context }));
  await module.evaluate(); const pet = module.namespace; pet.initPetView();
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  function advance(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.cb(); }
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((cb) => cb(now));
  }
  return { pet, state, assets, ids, frames, timers, document, window, welcome, observers, advance, settle,
    async select(ids) { state.settings.petCharacterIds = ids; document.dispatchEvent({ type: 'settings-changed' }); await settle(); },
    suspend(value) { document.body.classList.toggle('settings-open', value); observers.forEach((cb) => cb()); },
  };
}

test('disabled pets do no asset loading or animation; selected sheets load without the catalog', async () => {
  const h = await harness();
  assert.equal(h.assets.length, 0); assert.equal(h.frames.size, 0);
  await h.select(['violet', 'lilith.webp']);
  assert.equal(h.assets.length, 2);
  assert.equal(h.ids.get('chat-pet').hidden, false);
  assert.equal(h.ids.get('chat-pet').style.getPropertyValue('--pet-size'), '56px');
  await h.select([]);
  assert.equal(h.frames.size, 0); assert.equal(h.ids.get('chat-pet').hidden, true);
});

test('the controller preserves work phases through reactions and ignores stale callbacks', async () => {
  const h = await harness(); await h.select(['lilith.webp']);
  const token = h.pet.startPetTurn(); h.state.busy = true;
  h.pet.updatePetPhase('writing', token);
  const root = h.ids.get('chat-pet');
  assert.equal(root.dataset.activity, 'writing');
  root.dispatchEvent({ type: 'click', detail: 0 });
  assert.ok(['wave', 'jump'].includes(root.dataset.activity));
  h.advance(2000);
  assert.equal(root.dataset.activity, 'writing');
  const next = h.pet.startPetTurn();
  h.pet.finishPetTurn('ready', token);
  assert.equal(root.dataset.activity, 'thinking');
  h.state.busy = false; h.pet.finishPetTurn('ready', next);
  h.pet.updatePetPhase('writing', next);
  assert.equal(root.dataset.activity, 'jump'); h.advance(1000);
  assert.equal(root.dataset.activity, 'idle');
  h.advance(60000); assert.equal(root.dataset.activity, 'yawn');
  h.advance(2000); assert.equal(root.dataset.activity, 'sleep');
  h.ids.get('chat-input').dispatchEvent({ type: 'input' });
  assert.equal(root.dataset.activity, 'curious');
});

test('Settings suspends all animation and reduced motion uses static enlarged poses', async () => {
  const h = await harness(); await h.select(['violet']);
  assert.ok(h.frames.size > 0);
  h.suspend(true); assert.equal(h.frames.size, 0); assert.equal(h.ids.get('chat-pet').hidden, true);
  h.suspend(false); assert.ok(h.frames.size > 0);
  const calm = await harness({ mobile: true, reduced: true }); await calm.select(['violet']);
  assert.equal(calm.frames.size, 0);
  calm.welcome.hidden = false; calm.pet.refreshPetPlacement();
  assert.equal(calm.ids.get('chat-pet').style.getPropertyValue('--pet-size'), '144px');
});

test('phone hold opens the menu, dragging resumes after ten seconds, and hiding can be restored', async () => {
  const h = await harness({ mobile: true }); await h.select(['violet']);
  const root = h.ids.get('chat-pet');
  const pointer = { pointerId: 1, pointerType: 'touch', button: 0, clientX: 50, clientY: 110 };
  root.dispatchEvent({ type: 'pointerdown', ...pointer }); h.advance(350);
  h.window.dispatchEvent({ type: 'pointerup', ...pointer });
  assert.equal(h.ids.get('pet-menu').hidden, false);
  h.ids.get('pet-menu').children.at(-1).dispatchEvent({ type: 'click' });
  assert.equal(root.hidden, true); assert.equal(h.frames.size, 0);
  h.document.dispatchEvent({ type: 'pet-restore' }); assert.equal(root.hidden, false);
  root.dispatchEvent({ type: 'pointerdown', ...pointer }); h.advance(350);
  h.window.dispatchEvent({ type: 'pointermove', ...pointer, clientX: 200, preventDefault() {} });
  h.window.dispatchEvent({ type: 'pointerup', ...pointer, clientX: 200 });
  assert.equal(root.style.getPropertyValue('--pet-size'), '64px');
  h.advance(9500); assert.notEqual(root.dataset.activity, 'left'); assert.notEqual(root.dataset.activity, 'right');
  h.advance(500); assert.ok(['left', 'right'].includes(root.dataset.activity));
});

test('a swipe starting on the floating pet scrolls messages instead of playing or dragging', async () => {
  const h = await harness({ mobile: true }); await h.select(['violet']);
  const root = h.ids.get('chat-pet'), list = h.ids.get('message-list');
  list.scrollTop = 100;
  const pointer = { pointerId: 2, pointerType: 'touch', button: 0, clientX: 50, clientY: 130 };
  root.dispatchEvent({ type: 'pointerdown', ...pointer }); h.advance(100);
  h.window.dispatchEvent({ type: 'pointermove', ...pointer, clientY: 100, preventDefault() {} });
  assert.equal(list.scrollTop, 130);
  h.advance(400);
  h.window.dispatchEvent({ type: 'pointermove', ...pointer, clientY: 80, preventDefault() {} });
  h.window.dispatchEvent({ type: 'pointerup', ...pointer, clientY: 80 });
  assert.equal(list.scrollTop, 150);
  assert.equal(h.ids.get('pet-menu').hidden, true);
  assert.equal(root.style.getPropertyValue('--pet-size'), '56px');
});

test('offscreen docked pets stop and scrolling them back into view restarts animation', async () => {
  const h = await harness(); await h.select(['violet']);
  const root = h.ids.get('chat-pet'), list = h.ids.get('message-list');
  list.rect.y = 180;
  h.window.dispatchEvent({ type: 'resize' }); h.advance(16);
  assert.equal(root.hidden, true); assert.equal(h.frames.size, 0);
  list.rect.y = 70;
  h.window.dispatchEvent({ type: 'resize' });
  assert.equal(root.hidden, false); assert.ok(h.frames.size > 0);
});

test('returning to a visible page after a minute wakes the pet with a greeting', async () => {
  const h = await harness(); await h.select(['lilith.webp']);
  h.document.hidden = true; h.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.frames.size, 0);
  h.advance(61000);
  h.document.hidden = false; h.document.dispatchEvent({ type: 'visibilitychange' });
  assert.equal(h.ids.get('chat-pet').dataset.activity, 'wave');
  assert.ok(h.frames.size > 0);
});

test('a newly loaded welcome pet greets once without repeated greetings on rerender', async () => {
  const h = await harness(); h.welcome.hidden = false; await h.select(['violet']);
  const root = h.ids.get('chat-pet');
  assert.equal(root.dataset.activity, 'wave');
  assert.equal(root.style.getPropertyValue('--pet-size'), '192px');
  h.advance(1000); assert.equal(root.dataset.activity, 'idle');
  h.pet.refreshPetPlacement(); assert.equal(root.dataset.activity, 'idle');
});
