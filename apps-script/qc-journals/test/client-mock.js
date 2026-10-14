// Мінімальне середовище браузера для прогону qc-core.js без браузера:
// DOM-заглушки, localStorage, fetch, IndexedDB у пам'яті, crypto.subtle.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const nodeCrypto = require('crypto');

const CORE = path.join(__dirname, '..', '..', '..', 'qc-core.js');

function makeElement(tag, registry) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(), id: '', value: '', textContent: '', disabled: false,
    style: {}, children: [], attrs: {}, listeners: {}, _inner: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); }, remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); }, toggle(c, f) { f ? this.add(c) : this.remove(c); },
    },
    appendChild(c) { el.children.push(c); c.parent = el; if (c.id) registry[c.id] = c; return c; },
    remove() { if (el.parent) el.parent.children = el.parent.children.filter(x => x !== el); },
    setAttribute(k, v) { el.attrs[k] = v; if (k === 'id') { el.id = v; registry[v] = el; } },
    getAttribute(k) { return el.attrs[k]; },
    querySelector(sel) {
      const m = sel.match(/\[data-file-id="([^"]+)"\]/);
      if (m) return el.children.find(c => c.attrs['data-file-id'] === m[1]) || null;
      return null;
    },
    addEventListener(ev, fn) { (el.listeners[ev] = el.listeners[ev] || []).push(fn); },
    fire(ev, arg) { (el.listeners[ev] || []).forEach(fn => fn(arg || {})); if (ev === 'click' && el.onclick) el.onclick(arg || {}); },
    focus() {}, click() { el.fire('click'); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._inner; },
    set(html) {
      el._inner = html; el.children = [];
      // кожен id="..." у розмітці стає доступним через getElementById
      for (const m of String(html).matchAll(/id="([^"]+)"/g)) {
        const child = makeElement('div', registry); child.id = m[1]; registry[m[1]] = child; el.children.push(child);
      }
    },
  });
  Object.defineProperty(el, 'onclick', { get() { return el._onclick; }, set(f) { el._onclick = f; } });
  return el;
}

// --- IndexedDB у пам'яті: рівно той набір, яким користується qc-core ---
function makeIndexedDB() {
  const stores = {};
  const req = (fn) => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess && r.onsuccess({ target: r }); } catch (e) { r.error = e; r.onerror && r.onerror({ target: r }); } }); return r; };
  return {
    open(name) {
      const db = {
        objectStoreNames: { contains: (s) => !!stores[s] },
        createObjectStore(s) { stores[s] = new Map(); },
        transaction(s, mode) {
          const tx = {};
          tx.objectStore = () => ({
            put: (rec) => req(() => { stores[s].set(rec.recordId, JSON.parse(JSON.stringify(rec))); return rec.recordId; }),
            delete: (id) => req(() => { stores[s].delete(id); }),
            getAll: () => req(() => Array.from(stores[s].values())),
          });
          setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
          return tx;
        },
      };
      const r = {};
      queueMicrotask(() => { if (!stores['records']) { r.result = db; r.onupgradeneeded && r.onupgradeneeded(); } r.result = db; r.onsuccess && r.onsuccess(); });
      return r;
    },
    _stores: stores,
  };
}

function makeBrowser(opts) {
  opts = opts || {};
  const registry = {};
  const storage = new Map();
  const state = { fetches: [], fetchUrls: [], online: true, responder: opts.responder || (() => ({ result: 'success' })), toasts: [], timers: [] };

  const document = {
    body: makeElement('body', registry),
    createElement: (t) => makeElement(t, registry),
    getElementById: (id) => registry[id] || null,
    addEventListener() {}, visibilityState: 'visible',
  };
  const win = {
    document,
    localStorage: { getItem: k => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    navigator: { get onLine() { return state.online; } },
    indexedDB: makeIndexedDB(),
    crypto: {
      randomUUID: () => nodeCrypto.randomUUID(),
      getRandomValues: (arr) => { nodeCrypto.randomFillSync(arr); return arr; },
      subtle: {
        importKey: async (f, raw) => ({ raw }),
        deriveBits: async (algo, key, bits) => nodeCrypto.pbkdf2Sync(Buffer.from(key.raw), Buffer.from(algo.salt), algo.iterations, bits / 8, 'sha256'),
      },
    },
    fetch: async (url, o) => {
      const body = JSON.parse(o.body);
      state.fetches.push(body);
      state.fetchUrls.push(url);
      const res = state.responder(body);
      if (res instanceof Error) throw res;
      return { ok: true, text: async () => typeof res === 'string' ? res : JSON.stringify(res) };
    },
    addEventListener() {},
    setTimeout: (fn, ms) => { state.timers.push({ fn, ms }); return setTimeout(fn, 0); },
    clearTimeout, setInterval: () => 0, clearInterval() {},
    console: { log() {}, warn() {}, error() {} },
    TextEncoder, Uint8Array, Promise, Date, JSON, Math, Object, Array, String, Number, Error, Image: function () {}, FileReader: function () {},
    AbortController: undefined,
  };
  win.window = win;
  win.toastLog = state.toasts;
  // перехоплюємо toast через toast-container
  const tc = makeElement('div', registry); tc.id = 'toast-container'; registry['toast-container'] = tc;
  tc.appendChild = (c) => { state.toasts.push(c.textContent); return c; };

  vm.createContext(win);
  vm.runInContext(fs.readFileSync(CORE, 'utf8'), win, { filename: 'qc-core.js' });
  win.__state = state;
  win.__registry = registry;
  win.__storage = storage;
  win.__el = (id) => registry[id];
  return win;
}

module.exports = { makeBrowser };
