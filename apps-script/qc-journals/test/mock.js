// Мок сервісів Apps Script для наскрізного прогону qc-journals без Google.
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const DIR = require('path').join(__dirname, '..') + '/';
const pad = n => (n < 10 ? '0' : '') + n;

// ---------- таблиці в пам'яті ----------
class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.rows[this.r - 1 + i] || [];
      const line = [];
      for (let j = 0; j < this.nc; j++) {
        const v = row[this.c - 1 + j];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  getDisplayValues() { return this.getValues().map(r => r.map(v => v === null || v === undefined ? '' : String(v))); }
  getValue() { return this.getValues()[0][0]; }
  setValue(v) {
    while (this.sheet.rows.length < this.r) this.sheet.rows.push([]);
    const row = this.sheet.rows[this.r - 1];
    while (row.length < this.c) row.push('');
    row[this.c - 1] = v;
    return this;
  }
  setFontWeight() { return this; }
  setBackground() { return this; }
}
class Sheet {
  constructor(name, rows) { this.name = name; this.rows = (rows || []).map(r => r.slice()); }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc); }
  appendRow(arr) { this.rows.push(arr.slice()); return this; }
  setFrozenRows() { return this; }
}
class Book {
  constructor(name, sheets) { this.name = name; this.sheets = {}; Object.keys(sheets || {}).forEach(k => { this.sheets[k] = new Sheet(k, sheets[k]); }); }
  getName() { return this.name; }
  getSheetByName(n) { return this.sheets[n] || null; }
  getSheets() { return Object.values(this.sheets); }
  insertSheet(n) { if (this.sheets[n]) throw new Error('A sheet with the name "' + n + '" already exists.'); this.sheets[n] = new Sheet(n, []); return this.sheets[n]; }
}

// ---------- створення контексту ----------
function makeEnv(opts) {
  opts = opts || {};
  const books = opts.books;
  const state = {
    cache: new Map(), props: new Map(opts.props || []), sent: [], files: [], logs: [],
    quota: opts.quota === undefined ? 100 : opts.quota,
    deniedFolders: new Set(opts.deniedFolders || []),
    lockOk: opts.lockOk === undefined ? true : opts.lockOk,
  };
  const toBytes = v => Array.isArray(v) ? Buffer.from(v.map(b => b & 0xff)) : Buffer.from(String(v), 'utf8');

  const sandbox = {
    console: { log: () => {}, error: (m) => state.logs.push('console.error: ' + m), warn: () => {} },
    Logger: { log: function () { state.logs.push(Array.from(arguments).join(' ')); } },
    Utilities: {
      formatDate: (d, tz, fmt) => {
        if (fmt === 'dd.MM.yyyy HH:mm:ss') return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        if (fmt === 'yyyy-MM-dd_HH-mm') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
        if (fmt === 'yyyy-MM-dd') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        return String(d);
      },
      getUuid: () => crypto.randomUUID(),
      base64Encode: v => toBytes(v).toString('base64'),
      base64EncodeWebSafe: v => toBytes(v).toString('base64url'),
      base64Decode: s => Array.from(Buffer.from(String(s), 'base64')),
      base64DecodeWebSafe: s => Array.from(Buffer.from(String(s), 'base64url')),
      computeHmacSha256Signature: (value, key) => Array.from(crypto.createHmac('sha256', String(key)).update(String(value)).digest()),
      newBlob: (bytes, type, name) => ({
        getDataAsString: () => toBytes(bytes).toString('utf8'),
        getName: () => name, getContentType: () => type, getBytes: () => bytes,
      }),
      sleep: () => {},
    },
    SpreadsheetApp: { openById: id => { if (!books[id]) throw new Error('You do not have permission to access the requested document: ' + id); return books[id]; } },
    CacheService: { getScriptCache: () => ({
      get: k => state.cache.has(k) ? state.cache.get(k) : null,
      put: (k, v) => { state.cache.set(k, String(v)); },
      remove: k => { state.cache.delete(k); },
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => state.props.has(k) ? state.props.get(k) : null,
      setProperty: (k, v) => { state.props.set(k, v); },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => state.lockOk, releaseLock: () => {} }) },
    MailApp: { getRemainingDailyQuota: () => state.quota, sendEmail: p => { state.sent.push(p); state.quota -= p.to.split(',').length; } },
    DriveApp: { getFolderById: id => {
      if (state.deniedFolders.has(id)) throw new Error('Access denied: DriveApp.');
      return { createFile: blob => { const n = state.files.push({ folder: id, name: blob.getName(), type: blob.getContentType() }); return { getUrl: () => 'https://drive.google.com/file/d/mock_' + n + '/view' }; } };
    } },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'test@example.com' }) },
    ContentService: {
      createTextOutput: s => ({ _s: s, setMimeType() { return this; }, getContent() { return this._s; } }),
      MimeType: { JSON: 'application/json' },
    },
  };
  vm.createContext(sandbox);

  for (const f of ['Util.gs', 'Auth.gs', 'Code.gs', 'Catalog.gs', 'History.gs']) {
    let src = fs.readFileSync(DIR + f, 'utf8');
    if (f === 'Util.gs') {
      if (opts.sections) src = src.replace(/^const SECTIONS = \[.*\];$/m, 'const SECTIONS = ' + JSON.stringify(opts.sections) + ';');
      if (opts.serveHistory !== undefined) src = src.replace(/^const SERVE_HISTORY = .*;$/m, 'const SERVE_HISTORY = ' + opts.serveHistory + ';');
    }
    vm.runInContext(src, sandbox, { filename: f });
  }
  sandbox.__state = state;
  sandbox.__post = payload => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent());
  return sandbox;
}

module.exports = { makeEnv, Book, Sheet };
