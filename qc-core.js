/* =========================================================================
   QC CORE v3.0.0 — спільний модуль Цифрового блокнота QC
   ПП «Фудлайн Продакшн»

   Один файл на всі форми. Що він дає сторінці:

   1. Відправка БЕЗ mode:'no-cors' — відповідь Apps Script читається,
      тому додаток реально знає, чи збереглися дані.
   2. Черга (outbox) в IndexedDB на випадок обриву звʼязку в цеху.
   3. Стиснення фото перед base64.
   4. Ідемпотентний recordId — захист від дублів при повторній відправці.
   5. Вхід за PIN, сесія на 12 годин, автовихід через 10 хвилин без дій,
      локальне розблокування без мережі. Один вхід діє на всіх сторінках
      блокнота: ключі сховища спільні для домену.

   Токен сесії НЕ зберігається в черзі: він додається до запису в момент
   відправки. Якщо сервер відповів, що сесії немає, запис ЛИШАЄТЬСЯ в
   черзі, а користувача просять увійти — нічого не губиться.

   Підключати тегом <script src="qc-core.js"> ПЕРЕД основним скриптом
   сторінки. (Закриваючий тег тут навмисно не написаний: літеральний
   рядок з ним усередині JS розриває <script> при вбудовуванні.)
   ========================================================================= */
(function (global) {
    'use strict';

    var cfg = {
        url:              '',
        section:          'unknown',
        appName:          'Блокнот QC',  // заголовок на екрані входу
        appVersion:       '3.0.0',
        sendTimeoutMs:    60000,         // Apps Script вміє «зависати»
        photoMaxWidth:    1600,
        photoQuality:     0.72,
        photoMaxCount:    6,
        payloadSoftLimit: 7 * 1024 * 1024,
        maxAttempts:      5,
        flushIntervalMs:  60000,
        showBadge:        true,
        catalog:          true,          // false — вимкнути довідники на сторінці
        auth:             false,         // true — вхід за PIN обовʼязковий
        idleLimitMs:      10 * 60 * 1000,
        // Що дозволено в офлайн-сесії (локальне розблокування, без токена).
        // Записи лягають у чергу і підуть після входу онлайн.
        offlinePermissions: ['writeJournal']
    };

    // Спільні для всіх сторінок блокнота — тому і спільний вхід
    var SESSION_KEY  = 'qc_session_v1';
    var DEVICE_KEY   = 'qc_device_v1';
    var ACTIVITY_KEY = 'qc_activity_v1';
    var UNLOCK_KEY   = 'qc_unlock_v1';
    var UNLOCK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    var UNLOCK_ITERATIONS = 150000;
    var OFFLINE_SESSION_MS = 12 * 60 * 60 * 1000;

    /* ---------------------------------------------------------------
       УТИЛІТИ
       --------------------------------------------------------------- */
    function uid() {
        if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
        return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function fmtDate(d)     { return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear(); }
    function fmtTime(d)     { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    function fmtDateTime(d) { return fmtDate(d) + ' ' + fmtTime(d); }

    function el(ref) {
        if (!ref) return null;
        return (typeof ref === 'string') ? document.getElementById(ref) : ref;
    }

    function storageGet(key) {
        try { return global.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storageSet(key, value) {
        try { global.localStorage.setItem(key, value); } catch (e) { /* приватний режим */ }
    }
    function storageDel(key) {
        try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    function toast(message, isError) {
        var container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = 'position:fixed;top:1rem;right:1rem;z-index:3000;display:flex;flex-direction:column;gap:.5rem';
            document.body.appendChild(container);
        }
        var t = document.createElement('div');
        t.textContent = message;
        t.style.cssText = 'max-width:20rem;padding:.75rem 1rem;border-radius:.5rem;font-size:.875rem;font-weight:700;' +
            'box-shadow:0 10px 25px rgba(0,0,0,.15);background:#fff;color:' +
            (isError ? '#b91c1c' : '#0f766e') + ';border-left:4px solid ' + (isError ? '#ef4444' : '#14b8a6');
        container.appendChild(t);
        setTimeout(function () { t.remove(); }, 4500);
    }

    /* ---------------------------------------------------------------
       OUTBOX — IndexedDB, а не localStorage.
       localStorage має ліміт ~5 МБ і не вміщує навіть двох записів з фото.
       --------------------------------------------------------------- */
    var DB_NAME = 'qc_outbox', DB_STORE = 'records', DB_VERSION = 1;
    var dbPromise = null;

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve, reject) {
            if (!global.indexedDB) { reject(new Error('IndexedDB недоступний')); return; }
            var req = global.indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'recordId' });
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror   = function () { reject(req.error); };
        });
        // не залишаємо назавжди відхилений проміс, якщо IndexedDB заблокований
        dbPromise.catch(function () { dbPromise = null; });
        return dbPromise;
    }

    function idbTx(mode, fn) {
        return openDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                var t = db.transaction(DB_STORE, mode);
                var r = fn(t.objectStore(DB_STORE));
                t.oncomplete = function () { resolve(r ? r.result : undefined); };
                t.onerror    = function () { reject(t.error); };
                t.onabort    = function () { reject(t.error); };
            });
        });
    }

    var outbox = {
        put: function (rec) { return idbTx('readwrite', function (s) { return s.put(rec); }); },
        del: function (id)  { return idbTx('readwrite', function (s) { return s.delete(id); }); },
        all: function ()    { return idbTx('readonly',  function (s) { return s.getAll(); }); }
    };

    /* ---------------------------------------------------------------
       ІНДИКАТОР ЧЕРГИ
       --------------------------------------------------------------- */
    var badgeEl = null;

    function ensureBadge() {
        if (!cfg.showBadge || badgeEl) return badgeEl;
        badgeEl = document.createElement('button');
        badgeEl.id = 'qcOutboxBadge';
        badgeEl.type = 'button';
        badgeEl.style.cssText = 'display:none;position:fixed;left:1rem;bottom:1rem;z-index:2500;padding:.6rem .9rem;' +
            'border-radius:.75rem;font-size:.75rem;font-weight:700;border:1px solid;cursor:pointer;' +
            'box-shadow:0 8px 20px rgba(0,0,0,.18)';
        badgeEl.onclick = function () { flush(false); };
        document.body.appendChild(badgeEl);
        return badgeEl;
    }

    function refreshBadge() {
        var b = ensureBadge();
        if (!b) return Promise.resolve();
        return outbox.all().then(function (items) {
            items = items || [];
            if (!items.length) { b.style.display = 'none'; return; }
            var stuck = items.filter(function (i) { return (i.attempts || 0) >= cfg.maxAttempts; }).length;
            b.style.display = 'block';
            if (stuck) {
                b.style.background = '#fee2e2'; b.style.color = '#b91c1c'; b.style.borderColor = '#fca5a5';
                b.textContent = '⛔ ' + stuck + ' не відправлено';
            } else {
                b.style.background = '#fef3c7'; b.style.color = '#92400e'; b.style.borderColor = '#fcd34d';
                b.textContent = '⏳ У черзі: ' + items.length + ' — натисніть';
            }
            b.title = 'Записи збережені на цьому пристрої і підуть автоматично. Не чистіть дані браузера.';
        }).catch(function () { /* IndexedDB недоступний */ });
    }

    /* ---------------------------------------------------------------
       СЕСІЯ
       PIN не зберігається ніде — він іде на сервер один раз під час
       входу. На пристрої лишається підписаний токен (12 год) і повільно
       обчислений перевірник PIN для входу без мережі.
       --------------------------------------------------------------- */
    var session = null;
    var authSubs = [];
    var lastActivityWrite = 0;

    function getDeviceId() {
        var id = storageGet(DEVICE_KEY);
        if (!id) {
            id = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            storageSet(DEVICE_KEY, id);
        }
        return id;
    }

    function loadSession() {
        try {
            var stored = JSON.parse(storageGet(SESSION_KEY) || 'null');
            if (stored && stored.expiresAt > Date.now() && (stored.token || stored.offline)) return stored;
        } catch (e) { /* зіпсований запис — вважаємо, що сесії немає */ }
        return null;
    }

    function saveSession(value) {
        session = value;
        storageSet(SESSION_KEY, JSON.stringify(value));
        storageSet(ACTIVITY_KEY, String(Date.now()));
        authNotify();
    }

    function clearSession(forgetUnlock) {
        session = null;
        storageDel(SESSION_KEY);
        // Ручний вихід забирає і локальний перевірник: пристрій передали
        // іншій людині. Автовихід його лишає — інакше зміна без мережі
        // лишилась би без застосунку.
        if (forgetUnlock) storageDel(UNLOCK_KEY);
        authNotify();
    }

    function authNotify() {
        authSubs.forEach(function (fn) { try { fn(session); } catch (e) { console.error(e); } });
    }

    function touchActivity() {
        if (!session) return;
        var now = Date.now();
        if (now - lastActivityWrite > 5000) {
            storageSet(ACTIVITY_KEY, String(now));
            lastActivityWrite = now;
        }
    }

    // Сторінку могли просто закрити: простій перевіряється і після
    // перезавантаження, і при поверненні на вкладку — планшет у кишені
    // не лишається відкритим журналом
    function checkIdle() {
        if (!session) return;
        var last = Number(storageGet(ACTIVITY_KEY) || 0);
        if (last && Date.now() - last > cfg.idleLimitMs) {
            logout('idle');
        } else if (session.expiresAt <= Date.now()) {
            logout('expired');
        }
    }

    function logout(reason) {
        clearSession(reason === 'manual');
        if (cfg.auth) {
            showLogin(reason === 'idle'    ? 'Сесію закрито через 10 хвилин без дій. Увійдіть знову.'
                    : reason === 'expired' ? 'Сесія протермінована. Увійдіть за PIN.'
                    : '');
        }
    }

    // --- Локальне розблокування без мережі ---
    function toHex(buffer) {
        return Array.prototype.map.call(new Uint8Array(buffer), function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    function derivePinHash(pin, saltHex) {
        var salt = Uint8Array.from(saltHex.match(/.{2}/g).map(function (p) { return parseInt(p, 16); }));
        return global.crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
            .then(function (key) {
                return global.crypto.subtle.deriveBits(
                    { name: 'PBKDF2', salt: salt, iterations: UNLOCK_ITERATIONS, hash: 'SHA-256' }, key, 256);
            })
            .then(toHex);
    }

    function saveOfflineUnlock(pin, data) {
        if (!global.crypto || !global.crypto.subtle) return Promise.resolve();
        var salt = toHex(global.crypto.getRandomValues(new Uint8Array(16)));
        return derivePinHash(pin, salt).then(function (hash) {
            storageSet(UNLOCK_KEY, JSON.stringify({
                salt: salt, hash: hash, verifiedAt: Date.now(),
                name: data.name, shortName: data.shortName, journalName: data.journalName,
                permissions: data.permissions || []
            }));
        }).catch(function () { /* без крипто-API офлайн-входу просто не буде */ });
    }

    function tryOfflineUnlock(pin) {
        if (!global.crypto || !global.crypto.subtle) return Promise.resolve(null);
        var record = null;
        try { record = JSON.parse(storageGet(UNLOCK_KEY) || 'null'); } catch (e) { return Promise.resolve(null); }
        if (!record || !record.salt) return Promise.resolve(null);
        if (Date.now() - record.verifiedAt > UNLOCK_MAX_AGE_MS) return Promise.resolve(null);
        return derivePinHash(pin, record.salt)
            .then(function (hash) { return hash === record.hash ? record : null; })
            .catch(function () { return null; });
    }

    // --- Екран входу (малюється модулем, щоб бути однаковим на всіх сторінках) ---
    var loginEl = null;

    function ensureLogin() {
        if (loginEl) return loginEl;
        loginEl = document.createElement('div');
        loginEl.id = 'qcLogin';
        loginEl.style.cssText = 'display:none;position:fixed;inset:0;z-index:4000;align-items:center;justify-content:center;' +
            'padding:1rem;background:rgba(15,23,42,.55);backdrop-filter:blur(2px)';
        loginEl.innerHTML =
            '<div style="background:#fff;color:#1e293b;border-radius:1rem;box-shadow:0 20px 50px rgba(0,0,0,.3);' +
                'width:100%;max-width:22rem;padding:1.5rem;text-align:center;font-family:inherit">' +
              '<div id="qcLoginTitle" style="font-size:1.15rem;font-weight:700;margin-bottom:.25rem"></div>' +
              '<div style="font-size:.875rem;color:#64748b;margin-bottom:1rem">Введіть свій PIN, щоб увійти</div>' +
              '<input id="qcLoginPin" type="password" inputmode="numeric" autocomplete="off" placeholder="••••" ' +
                'style="width:100%;box-sizing:border-box;padding:.75rem;border:2px solid #cbd5e1;border-radius:.5rem;' +
                'text-align:center;font-size:1.5rem;letter-spacing:.3em;font-weight:700;outline:none">' +
              '<div id="qcLoginError" style="display:none;font-size:.85rem;font-weight:600;color:#b91c1c;margin-top:.75rem"></div>' +
              '<button id="qcLoginBtn" type="button" style="margin-top:1.25rem;width:100%;padding:.8rem;border:0;border-radius:.75rem;' +
                'background:#059669;color:#fff;font-size:1.05rem;font-weight:700;cursor:pointer">Увійти</button>' +
              '<div style="font-size:.75rem;color:#64748b;margin-top:1rem">PIN видає адміністратор. ' +
                'Він у довіднику співробітників, колонка «PIN».</div>' +
            '</div>';
        document.body.appendChild(loginEl);

        document.getElementById('qcLoginBtn').addEventListener('click', doLogin);
        document.getElementById('qcLoginPin').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doLogin();
        });
        return loginEl;
    }

    function showLogin(message) {
        var box = ensureLogin();
        document.getElementById('qcLoginTitle').textContent = cfg.appName;
        var err = document.getElementById('qcLoginError');
        err.textContent = message || '';
        err.style.display = message ? 'block' : 'none';
        document.getElementById('qcLoginPin').value = '';
        box.style.display = 'flex';
        setTimeout(function () { document.getElementById('qcLoginPin').focus(); }, 100);
    }

    function hideLogin() {
        if (loginEl) loginEl.style.display = 'none';
    }

    function postJson(body, timeoutMs) {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || cfg.sendTimeoutMs) : null;
        var opts = { method: 'POST', body: JSON.stringify(body), redirect: 'follow' };
        if (ctrl) opts.signal = ctrl.signal;

        return fetch(cfg.url, opts).then(function (res) {
            if (!res.ok) { var e1 = new Error('HTTP ' + res.status); e1.kind = 'http'; throw e1; }
            return res.text();
        }).then(function (text) {
            try { return JSON.parse(text); }
            catch (e) {
                // Найчастіша причина: /exec віддав HTML сторінки входу Google,
                // бо у розгортанні «У кого есть доступ» стоїть не «Все».
                var e2 = new Error(/<html|accounts\.google/i.test(String(text))
                    ? 'Закритий доступ до скрипта'
                    : 'Сервер відповів не JSON');
                e2.kind = 'auth'; throw e2;
            }
        }).finally(function () { if (timer) clearTimeout(timer); });
    }

    function login(pin) {
        pin = String(pin || '').trim();
        if (!pin) return Promise.reject(Object.assign(new Error('Введіть PIN'), { code: 'BAD_PIN' }));

        return postJson({ action: 'login', pin: pin, deviceId: getDeviceId() }, 20000)
            .then(function (result) {
                if (!result || !result.success) {
                    var err = new Error((result && result.error) || 'Невірний PIN');
                    err.code = (result && result.code) || 'BAD_PIN';
                    throw err;
                }
                saveSession({
                    token: result.token, name: result.name, shortName: result.shortName,
                    journalName: result.journalName || result.shortName || result.name,
                    permissions: result.permissions || [], expiresAt: result.expiresAt
                });
                // Похідну від PIN рахуємо у фоні: 150 000 ітерацій — відчутна
                // пауза, і користувач не має її чекати, щоб увійти
                saveOfflineUnlock(pin, result);
                if (result.warning) toast('⚠️ ' + result.warning, true);
                return session;
            })
            .catch(function (err) {
                // Сервер сам назвав причину — локальний вхід тут ні до чого
                if (err.code === 'BAD_PIN' || err.code === 'PIN_NOT_UNIQUE' || err.code === 'THROTTLED') throw err;
                if (err.kind === 'auth' || err.kind === 'http') throw err;

                // Сервер недоступний — пробуємо локальне розблокування
                return tryOfflineUnlock(pin).then(function (record) {
                    if (!record) {
                        var e = new Error(navigator.onLine ? err.message
                            : 'Немає звʼязку. Локальний вхід недоступний — спершу увійдіть один раз онлайн.');
                        e.code = 'OFFLINE';
                        throw e;
                    }
                    saveSession({
                        token: '', name: record.name, shortName: record.shortName,
                        journalName: record.journalName || record.shortName || record.name,
                        permissions: (record.permissions || []).filter(function (p) {
                            return cfg.offlinePermissions.indexOf(p) !== -1;
                        }),
                        expiresAt: Date.now() + OFFLINE_SESSION_MS, offline: true
                    });
                    toast('Офлайн-режим: записи чекатимуть на звʼязок');
                    return session;
                });
            });
    }

    function doLogin() {
        var input = document.getElementById('qcLoginPin');
        var btn = document.getElementById('qcLoginBtn');
        var original = btn.textContent;
        btn.textContent = 'Перевіряю…';
        btn.disabled = true;

        login(input.value).then(function () {
            hideLogin();
            flush(true);
            if (cfg.catalog !== false) catalogInit();
        }).catch(function (err) {
            showLogin(err.message || 'Не вдалося увійти');
        }).finally(function () {
            btn.textContent = original;
            btn.disabled = false;
        });
    }

    // Показати екран входу, якщо чинної сесії немає. Повертає true, якщо сесія є.
    function requireAuth(message) {
        if (!cfg.auth) return true;
        var had = !!session;
        checkIdle();
        if (session) return true;
        // Якщо сесію щойно закрив checkIdle, екран входу вже показано
        // з поясненням причини — не затираємо його порожнім.
        if (!had) showLogin(message || '');
        return false;
    }

    // Сервер сказав, що сесії немає (протермінована, роль зняли, звільнення) —
    // не тримаємо користувача в застосунку, який усе одно нічого не запише
    function handleAuthFailure(err) {
        if (!(err && err.auth)) return false;
        clearSession(false);
        if (cfg.auth) showLogin(err.message || 'Сесію завершено. Увійдіть за PIN.');
        return true;
    }

    var auth = {
        session:  function () { return session; },
        login:    login,
        logout:   function () { logout('manual'); },
        require:  requireAuth,
        deviceId: getDeviceId,
        onChange: function (fn) { authSubs.push(fn); try { fn(session); } catch (e) { console.error(e); } }
    };

    /* ---------------------------------------------------------------
       ВІДПРАВКА
       Ключове: НЕМАЄ mode:'no-cors' і НЕМАЄ Content-Type.
       Браузер шле text/plain -> preflight не потрібен ->
       Apps Script віддає CORS-заголовки -> відповідь ЧИТАЄТЬСЯ.

       Токен і deviceId додаються ТУТ, у момент відправки, а не при
       постановці в чергу: запис, що пролежав ніч, піде з чинним токеном.
       --------------------------------------------------------------- */
    function withAuth(payload) {
        var body = {};
        Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });
        if (cfg.auth) {
            body.token = session ? session.token : '';
            body.deviceId = getDeviceId();
        }
        return body;
    }

    function sendRecord(payload) {
        return postJson(withAuth(payload)).then(function (json) {
            if (json.result !== 'success') {
                var err = new Error(json.error || 'Сервер відхилив запис');
                err.code = json.code || '';
                if (json.code === 'AUTH') {
                    err.auth = true;         // сесії немає — запис лишається в черзі
                } else if (json.code === 'BUSY') {
                    err.retry = true;        // сервер зайнятий — повторимо з черги
                } else {
                    err.permanent = true;    // проблема в даних — повтор не допоможе
                }
                throw err;
            }
            return json;
        });
    }

    var flushing = false;

    function flush(silent) {
        if (flushing || !navigator.onLine) return Promise.resolve();
        // В офлайн-сесії токена немає — записи чекають входу онлайн
        if (cfg.auth && (!session || !session.token)) return Promise.resolve();
        flushing = true;
        var sent = 0, stuck = 0, authStop = false;

        return outbox.all().then(function (items) {
            items = items || [];
            return items.reduce(function (chain, item) {
                return chain.then(function (stop) {
                    if (stop) return true;
                    if ((item.attempts || 0) >= cfg.maxAttempts) { stuck++; return false; }
                    return sendRecord(item.payload).then(function () {
                        sent++;
                        return outbox.del(item.recordId).then(function () { return false; });
                    }).catch(function (err) {
                        if (err.auth) { authStop = true; return true; }   // не рахуємо як спробу
                        item.attempts  = err.permanent ? cfg.maxAttempts : (item.attempts || 0) + 1;
                        item.lastError = String(err.message || err);
                        return outbox.put(item).then(function () { return !!err.permanent; });
                    });
                });
            }, Promise.resolve(false));
        }).catch(function () { /* IndexedDB недоступний */ })
          .then(function () {
            flushing = false;
            refreshBadge();
            if (sent && !silent)  toast('Відправлено з черги: ' + sent);
            if (stuck && !silent) toast(stuck + ' запис(ів) не вдалося відправити. Покажіть адміністратору.', true);
            if (authStop) handleAuthFailure({ auth: true, message: 'Сесію завершено. Увійдіть за PIN — записи з черги підуть після входу.' });
          });
    }

    /* ---------------------------------------------------------------
       ПІДГОТОВКА PAYLOAD
       --------------------------------------------------------------- */
    function stamp(payload) {
        payload.recordId    = payload.recordId || uid();
        payload.appVersion  = cfg.appVersion;
        payload.sectionKey  = cfg.section;
        payload.submittedAt = new Date().toISOString();
        delete payload.token;
        // З увімкненим входом ім'я контролера клієнт не надсилає: сервер
        // бере його з сесії. Без входу (сторінки, що ще на старому
        // бекенді) поле лишається — старий сервер читає саме його.
        if (cfg.auth) delete payload.employee;
        return payload;
    }

    function checkSize(payload) {
        var bytes = JSON.stringify(payload).length;
        return { ok: bytes <= cfg.payloadSoftLimit, mb: (bytes / 1048576).toFixed(1) };
    }

    /* ---------------------------------------------------------------
       ВІДПРАВКА З ІНТЕРФЕЙСОМ
       ui = { status, actions, spinner, button, okText, onDone }
       Повертає 'sent' | 'queued' | 'rejected' | 'failed' | 'busy'

       Форма очищається ЛИШЕ у відповідь на 'sent' або 'queued':
       перше — сервер підтвердив, друге — запис надійно лежить
       у черзі на пристрої. Будь-який інший результат лишає форму.
       --------------------------------------------------------------- */
    var busy = false;

    function submit(payload, ui) {
        ui = ui || {};
        if (busy || !payload) return Promise.resolve('busy');
        busy = true;

        var status  = el(ui.status),
            actions = el(ui.actions),
            spinner = el(ui.spinner),
            button  = el(ui.button);

        function setStatus(text, color) {
            if (!status) return;
            status.textContent = text;
            status.style.color = color;
        }
        function showBusy() {
            if (button)  button.disabled = true;
            if (actions) actions.style.display = 'none';
            if (spinner) spinner.classList.remove('hidden');
            setStatus('Відправка...', '#64748b');
        }
        function showIdle() {
            if (button)  button.disabled = false;
            if (actions) actions.style.display = 'flex';
            if (spinner) spinner.classList.add('hidden');
        }
        function enqueue(statusText) {
            return outbox.put({
                recordId: payload.recordId, payload: payload, attempts: 0, createdAt: Date.now()
            }).then(function () {
                setStatus(statusText, '#059669');
                setTimeout(function () { if (ui.onDone) ui.onDone('queued'); }, 1600);
                return 'queued';
            }).catch(function () {
                setStatus('❌ НЕ ЗБЕРЕЖЕНО! Не закривайте сторінку.', '#ef4444');
                showIdle();
                return 'failed';
            });
        }

        showBusy();
        stamp(payload);
        touchActivity();

        var offlineSession = cfg.auth && session && !session.token;
        var attempt = (!navigator.onLine || offlineSession)
            ? Promise.reject(Object.assign(new Error('offline'), { offline: true }))
            : sendRecord(payload);

        return attempt.then(function () {
            setStatus(ui.okText || '✅ Записано на сервері', '#059669');
            setTimeout(function () { if (ui.onDone) ui.onDone('sent'); }, 1600);
            return 'sent';
        }).catch(function (err) {
            if (err.permanent) {
                // Сервер відповів, але відхилив дані — черга не допоможе.
                setStatus('❌ Сервер відхилив запис: ' + err.message, '#ef4444');
                showIdle();
                return 'rejected';
            }
            if (err.auth) {
                // Сесія скінчилась між заповненням і відправкою. Запис — у чергу,
                // користувача — на вхід; після входу черга піде сама.
                return enqueue('📥 Сесію завершено — запис у черзі, увійдіть за PIN').then(function (r) {
                    handleAuthFailure(err);
                    return r;
                });
            }
            toast('Запис у черзі на цьому пристрої. Відправиться автоматично.', true);
            return enqueue(offlineSession
                ? '📥 Офлайн-режим — збережено в чергу'
                : '📥 Немає звʼязку — збережено в чергу');
        }).then(function (result) {
            busy = false;
            refreshBadge();
            return result;
        });
    }

    function isBusy() { return busy; }

    /* ---------------------------------------------------------------
       ФОТО
       --------------------------------------------------------------- */
    function compressImage(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function () { reject(new Error('Не вдалося прочитати файл')); };
            reader.onload = function (e) {
                var img = new Image();
                img.onerror = function () { reject(new Error('Пошкоджене зображення')); };
                img.onload = function () {
                    var w = img.width, h = img.height;
                    if (w > cfg.photoMaxWidth) { h = Math.round(h * (cfg.photoMaxWidth / w)); w = cfg.photoMaxWidth; }
                    var canvas = document.createElement('canvas');
                    canvas.width = w; canvas.height = h;
                    var c = canvas.getContext('2d');
                    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
                    c.drawImage(img, 0, 0, w, h);
                    resolve(canvas.toDataURL('image/jpeg', cfg.photoQuality));
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    /* Галерея з превʼю. Дані лежать у масиві; у DOM — лише id.
       Раніше кожна сторінка вбудовувала повний base64 у HTML-атрибут
       onclick — для фото 5 МБ це 7 МБ у DOM на кожен знімок. */
    function gallery(opts) {
        opts = opts || {};
        var container = el(opts.container);
        var counter   = el(opts.counter);
        var max       = opts.max || cfg.photoMaxCount;
        var files     = [];

        function bytes() {
            return files.reduce(function (s, f) { return s + f.data.length; }, 0);
        }

        function updateCounter() {
            if (!counter) return;
            counter.textContent = files.length
                ? (files.length + ' / ' + max + ' фото · ~' + (bytes() / 1048576).toFixed(1) + ' МБ')
                : ('Можна додати до ' + max + ' фото');
        }

        function remove(id) {
            files = files.filter(function (f) { return f.id !== id; });
            var node = container && container.querySelector('[data-file-id="' + id + '"]');
            if (node) node.remove();
            if (container && !files.length) container.classList.add('hidden');
            updateCounter();
        }

        function add(input) {
            var list = Array.prototype.slice.call(input.files || []);
            input.value = '';
            if (!list.length) return Promise.resolve();
            if (container) container.classList.remove('hidden');

            return list.reduce(function (chain, file) {
                return chain.then(function () {
                    if (files.length >= max) return;
                    if (!/^image\//.test(file.type)) {
                        toast('Пропущено «' + file.name + '»: це не зображення', true);
                        return;
                    }
                    return compressImage(file).then(function (data) {
                        var id = uid();
                        files.push({ id: id, name: file.name, type: 'image/jpeg', data: data });
                        if (!container) return;
                        var div = document.createElement('div');
                        div.className = 'photo-preview-item';
                        div.setAttribute('data-file-id', id);
                        var im = document.createElement('img');
                        im.src = data; im.alt = file.name;
                        var btn = document.createElement('div');
                        btn.className = 'photo-remove-btn';
                        btn.textContent = '✕';
                        btn.onclick = function () { remove(id); };
                        div.appendChild(im); div.appendChild(btn);
                        container.appendChild(div);
                    }).catch(function () {
                        toast('Помилка обробки «' + file.name + '»', true);
                    });
                });
            }, Promise.resolve()).then(function () {
                if (list.length + files.length > max) toast('Максимум ' + max + ' фото на запис', true);
                if (container && !files.length) container.classList.add('hidden');
                updateCounter();
            });
        }

        function clear() {
            files = [];
            if (container) { container.innerHTML = ''; container.classList.add('hidden'); }
            updateCounter();
        }

        updateCounter();

        return {
            add: add, remove: remove, clear: clear, updateCounter: updateCounter,
            get files() { return files; },
            get count() { return files.length; },
            get first() { return files.length ? files[0].data : ''; }
        };
    }

    /* ---------------------------------------------------------------
       ДОВІДНИКИ (каталоги) з таблиці QC Data 2.0

       Стратегія cache-first:
         1. Кеш із localStorage віддається МИТТЄВО — форма готова одразу.
         2. Паралельно йде запит на сервер; якщо дані свіжіші — оновлюємо.
         3. Кеш вважається чинним до найближчої 23:00 після завантаження.
         4. Немає мережі — працюємо на кеші, статус позначається як
            «застарілий», але додаток НЕ ламається.
         5. Немає ні мережі, ні кешу — сторінка бере свій вбудований
            резервний список.
       З увімкненим auth довідники запитуються лише після входу:
       сервер без сесії їх не віддає.
       --------------------------------------------------------------- */
    var CAT_KEY  = 'qc_catalog_v2';
    var catData  = null;
    var catMeta  = { fetchedAt: 0, stale: true, source: 'none', error: '' };
    var catSubs  = [];
    var catBusy  = false;
    var catTimer = null;

    function catNextBoundary(ts) {
        var d = new Date(ts);
        var b = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 0, 0, 0);
        if (d.getTime() >= b.getTime()) b.setDate(b.getDate() + 1);
        return b.getTime();
    }

    function catIsFresh() {
        return catMeta.fetchedAt > 0 && Date.now() < catNextBoundary(catMeta.fetchedAt);
    }

    function catLoadCache() {
        var raw = null;
        try { raw = JSON.parse(storageGet(CAT_KEY) || 'null'); } catch (e) { return false; }
        if (!raw || !raw.data) return false;
        catData = raw.data;
        catMeta = { fetchedAt: raw.fetchedAt || 0, stale: !catIsFresh(), source: 'cache' };
        return true;
    }

    function catSaveCache() {
        storageSet(CAT_KEY, JSON.stringify({ fetchedAt: catMeta.fetchedAt, data: catData }));
    }

    function catNotify() {
        catSubs.forEach(function (fn) { try { fn(catData, catInfo()); } catch (e) { console.error(e); } });
    }

    function catInfo() {
        return { fetchedAt: catMeta.fetchedAt, stale: catMeta.stale, source: catMeta.source,
                 loading: catBusy, error: catMeta.error || '' };
    }

    function catFetch(manual) {
        if (catBusy) return Promise.resolve(catInfo());
        if (!navigator.onLine) {
            if (manual) toast('Немає звʼязку — довідники з кешу', true);
            return Promise.resolve(catInfo());
        }
        if (cfg.auth && (!session || !session.token)) return Promise.resolve(catInfo());
        catBusy = true;
        catNotify();

        // force:true — примусове читання аркуша в обхід серверного кешу.
        return postJson(withAuth({ action: 'getCatalog', force: !!manual }), 20000).then(function (j) {
            if (j && j.code === 'AUTH') {
                var ea = new Error(j.error || 'Сесію завершено'); ea.auth = true; throw ea;
            }
            if (!j || !j.catalog) {
                var e3 = new Error(j && j.error ? String(j.error) : 'Розгорнута стара версія скрипта');
                e3.kind = 'stale-deploy'; throw e3;
            }
            catData = j.catalog;
            catMeta = { fetchedAt: Date.now(), stale: false, source: 'server', error: '' };
            catSaveCache();
            if (manual) toast('Довідники оновлено');
            return catInfo();
        }).catch(function (err) {
            catMeta.stale = true;
            catMeta.error = String(err && err.message ? err.message : err);
            console.warn('[QC catalog] не вдалося оновити:', catMeta.error, '| тип:', err.kind || 'network');
            if (err.auth) handleAuthFailure(err);
            if (manual) {
                var hint = 'Не вдалося оновити довідники';
                if (err.kind === 'auth')              hint = 'Закритий доступ до скрипта. Розгортання → У кого есть доступ → «Все»';
                else if (err.kind === 'stale-deploy') hint = 'На сервері стара версія. Розгортання → Версия → «Новая версия»';
                else if (err.kind === 'http')         hint = 'Сервер відповів ' + catMeta.error;
                toast(hint, true);
            }
            return catInfo();
        }).finally(function () {
            catBusy = false;
            catNotify();
        });
    }

    var catalog = {
        // Синхронний доступ: масив або null, якщо довідника немає.
        get: function (name) {
            var v = catData && catData[name];
            return (v && v.length) ? v : null;
        },
        has: function (name) { return !!catalog.get(name); },
        refresh: function (manual) { return catFetch(manual !== false); },
        info: catInfo,
        // fn(data, info) викликається одразу після підписки і далі на кожне оновлення
        onUpdate: function (fn) {
            catSubs.push(fn);
            try { fn(catData, catInfo()); } catch (e) { console.error(e); }
        }
    };

    function catalogInit() {
        catLoadCache();
        catNotify();
        if (!catIsFresh()) catFetch(false);
        // пристрій, залишений увімкненим на ніч, підхопить оновлення після 23:00
        if (!catTimer) catTimer = setInterval(function () { if (!catIsFresh() && !catBusy) catFetch(false); }, 5 * 60 * 1000);
    }

    /* ---------------------------------------------------------------
       ІНІЦІАЛІЗАЦІЯ
       --------------------------------------------------------------- */
    function configure(options) {
        Object.keys(options || {}).forEach(function (k) { cfg[k] = options[k]; });

        global.addEventListener('online',  function () { toast('Звʼязок відновлено'); flush(false); });
        global.addEventListener('offline', function () { toast('Немає звʼязку. Записи підуть у чергу.', true); });
        global.addEventListener('beforeunload', function (e) {
            if (busy) { e.preventDefault(); e.returnValue = ''; }
        });

        if (cfg.auth) {
            session = loadSession();
            ['touchstart', 'click', 'keydown', 'scroll'].forEach(function (ev) {
                document.addEventListener(ev, touchActivity, { passive: true });
            });
            setInterval(checkIdle, 30000);
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'visible') checkIdle();
            });
            checkIdle();
            authNotify();
            if (!session) showLogin('');
        }

        ensureBadge();
        refreshBadge();
        flush(true);
        if (cfg.catalog !== false) catalogInit();
        setInterval(function () { flush(true); }, cfg.flushIntervalMs);

        console.log('QC CORE ' + cfg.appVersion + ' | розділ: ' + cfg.section + (cfg.auth ? ' | PIN' : ''));
        return QC;
    }

    var QC = {
        configure: configure,
        cfg: cfg,
        uid: uid,
        toast: toast,
        fmtDate: fmtDate,
        fmtTime: fmtTime,
        fmtDateTime: fmtDateTime,
        gallery: gallery,
        compressImage: compressImage,
        submit: submit,
        isBusy: isBusy,
        stamp: stamp,
        checkSize: checkSize,
        flush: flush,
        catalog: catalog,
        outbox: outbox,
        refreshBadge: refreshBadge,
        auth: auth
    };

    global.QC = QC;
})(window);
