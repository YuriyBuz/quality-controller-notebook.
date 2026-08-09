/* =========================================================================
   QC CORE v2.0.0 — спільний модуль Цифрового блокнота QC
   ПП «Фудлайн Продакшн»

   Один файл на всі форми. Виправляє те, що раніше було скопійоване
   (і зламане) окремо в кожній сторінці:

   1. Відправка БЕЗ mode:'no-cors' — відповідь Apps Script читається,
      тому додаток реально знає, чи збереглися дані.
   2. Черга (outbox) в IndexedDB на випадок обриву звʼязку в цеху.
   3. Стиснення фото перед base64.
   4. Ідемпотентний recordId — захист від дублів при повторній відправці.

   Підключати тегом <script src="qc-core.js"> ПЕРЕД основним скриптом
   сторінки. (Закриваючий тег тут навмисно не написаний: літеральний
   рядок з ним усередині JS розриває <script> при вбудовуванні.)
   ========================================================================= */
(function (global) {
    'use strict';

    var cfg = {
        url:              '',
        token:            '',            // заповнити, коли на бекенді буде перевірка
        section:          'unknown',
        appVersion:       '2.1.0',
        sendTimeoutMs:    60000,         // Apps Script вміє «зависати»
        photoMaxWidth:    1600,
        photoQuality:     0.72,
        photoMaxCount:    6,
        payloadSoftLimit: 7 * 1024 * 1024,
        maxAttempts:      5,
        flushIntervalMs:  60000,
        showBadge:        true,
        catalog:          true          // false — вимкнути довідники на сторінці
    };

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
                b.textContent = '\u26D4 ' + stuck + ' \u043D\u0435 \u0432\u0456\u0434\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u043E';
            } else {
                b.style.background = '#fef3c7'; b.style.color = '#92400e'; b.style.borderColor = '#fcd34d';
                b.textContent = '\u23F3 \u0423 \u0447\u0435\u0440\u0437\u0456: ' + items.length + ' \u2014 \u043D\u0430\u0442\u0438\u0441\u043D\u0456\u0442\u044C';
            }
            b.title = 'Записи збережені на цьому пристрої і підуть автоматично. Не чистіть дані браузера.';
        }).catch(function () { /* IndexedDB недоступний */ });
    }

    /* ---------------------------------------------------------------
       ВІДПРАВКА
       Ключове: НЕМАЄ mode:'no-cors' і НЕМАЄ Content-Type.
       Браузер шле text/plain -> preflight не потрібен ->
       Apps Script віддає CORS-заголовки -> відповідь ЧИТАЄТЬСЯ.
       --------------------------------------------------------------- */
    function sendRecord(payload) {
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, cfg.sendTimeoutMs) : null;
        var opts = { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' };
        if (ctrl) opts.signal = ctrl.signal;

        return fetch(cfg.url, opts).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.text();
        }).then(function (text) {
            var json;
            try { json = JSON.parse(text); }
            catch (e) { throw new Error('Некоректна відповідь сервера'); }
            if (json.result !== 'success') {
                var err = new Error(json.error || 'Сервер відхилив запис');
                err.permanent = true;    // проблема в даних — повтор не допоможе
                throw err;
            }
            return json;
        }).finally(function () { if (timer) clearTimeout(timer); });
    }

    var flushing = false;

    function flush(silent) {
        if (flushing || !navigator.onLine) return Promise.resolve();
        flushing = true;
        var sent = 0, stuck = 0;

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
                        item.attempts  = err.permanent ? cfg.maxAttempts : (item.attempts || 0) + 1;
                        item.lastError = String(err.message || err);
                        return outbox.put(item).then(function () { return !err.permanent; });
                    });
                });
            }, Promise.resolve(false));
        }).catch(function () { /* IndexedDB недоступний */ })
          .then(function () {
            flushing = false;
            refreshBadge();
            if (sent && !silent)  toast('Відправлено з черги: ' + sent);
            if (stuck && !silent) toast(stuck + ' запис(ів) не вдалося відправити. Покажіть адміністратору.', true);
          });
    }

    /* ---------------------------------------------------------------
       ПІДГОТОВКА PAYLOAD
       --------------------------------------------------------------- */
    function stamp(payload) {
        payload.recordId    = payload.recordId || uid();
        payload.token       = cfg.token;
        payload.appVersion  = cfg.appVersion;
        payload.sectionKey  = cfg.section;
        payload.submittedAt = new Date().toISOString();
        return payload;
    }

    function checkSize(payload) {
        var bytes = JSON.stringify(payload).length;
        return { ok: bytes <= cfg.payloadSoftLimit, mb: (bytes / 1048576).toFixed(1) };
    }

    /* ---------------------------------------------------------------
       ВІДПРАВКА З ІНТЕРФЕЙСОМ
       ui = { status, actions, spinner, button, okText, onDone }
       Повертає 'sent' | 'queued' | 'rejected' | 'failed'
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

        showBusy();
        stamp(payload);

        var attempt = navigator.onLine
            ? sendRecord(payload)
            : Promise.reject(Object.assign(new Error('offline'), { offline: true }));

        return attempt.then(function () {
            setStatus(ui.okText || '\u2705 Записано на сервері', '#059669');
            setTimeout(function () { if (ui.onDone) ui.onDone('sent'); }, 1600);
            return 'sent';
        }).catch(function (err) {
            if (err.permanent) {
                // Сервер відповів, але відхилив дані — черга не допоможе.
                setStatus('\u274C Сервер відхилив запис: ' + err.message, '#ef4444');
                showIdle();
                return 'rejected';
            }
            return outbox.put({
                recordId: payload.recordId, payload: payload, attempts: 0, createdAt: Date.now()
            }).then(function () {
                setStatus('\uD83D\uDCE5 Немає звʼязку — збережено в чергу', '#059669');
                toast('Запис у черзі на цьому пристрої. Відправиться автоматично.', true);
                setTimeout(function () { if (ui.onDone) ui.onDone('queued'); }, 1600);
                return 'queued';
            }).catch(function () {
                setStatus('\u274C НЕ ЗБЕРЕЖЕНО! Не закривайте сторінку.', '#ef4444');
                showIdle();
                return 'failed';
            });
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

    /* Галерея з превʼю. Раніше кожна сторінка вбудовувала повний base64
       у HTML-атрибут onclick — для фото 5 МБ це 7 МБ у DOM на кожен знімок. */
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
                ? (files.length + ' / ' + max + ' \u0444\u043E\u0442\u043E \u00B7 ~' + (bytes() / 1048576).toFixed(1) + ' \u041C\u0411')
                : ('\u041C\u043E\u0436\u043D\u0430 \u0434\u043E\u0434\u0430\u0442\u0438 \u0434\u043E ' + max + ' \u0444\u043E\u0442\u043E');
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
                        btn.textContent = '\u2715';
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
       --------------------------------------------------------------- */
    var CAT_KEY  = 'qc_catalog_v1';
    var catData  = null;
    var catMeta  = { fetchedAt: 0, stale: true, source: 'none' };
    var catSubs  = [];
    var catBusy  = false;

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
        try { raw = JSON.parse(localStorage.getItem(CAT_KEY) || 'null'); } catch (e) { return false; }
        if (!raw || !raw.data) return false;
        catData = raw.data;
        catMeta = { fetchedAt: raw.fetchedAt || 0, stale: !catIsFresh(), source: 'cache' };
        return true;
    }

    function catSaveCache() {
        try { localStorage.setItem(CAT_KEY, JSON.stringify({ fetchedAt: catMeta.fetchedAt, data: catData })); }
        catch (e) { /* переповнення localStorage — не критично */ }
    }

    function catNotify() {
        catSubs.forEach(function (fn) { try { fn(catData, catInfo()); } catch (e) { console.error(e); } });
    }

    function catInfo() {
        return { fetchedAt: catMeta.fetchedAt, stale: catMeta.stale, source: catMeta.source, loading: catBusy };
    }

    function catFetch(manual) {
        if (catBusy) return Promise.resolve(catInfo());
        if (!navigator.onLine) {
            if (manual) toast('Немає звʼязку — довідники з кешу', true);
            return Promise.resolve(catInfo());
        }
        catBusy = true;
        catNotify();

        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 20000) : null;
        var opts = { method: 'POST', body: JSON.stringify({ action: 'getCatalog', token: cfg.token }), redirect: 'follow' };
        if (ctrl) opts.signal = ctrl.signal;

        return fetch(cfg.url, opts).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.text();
        }).then(function (t) {
            var j = JSON.parse(t);
            // Бекенд ще без обробника getCatalog — тихо лишаємось на кеші
            if (!j || !j.catalog) throw new Error('no-catalog-endpoint');
            catData = j.catalog;
            catMeta = { fetchedAt: Date.now(), stale: false, source: 'server' };
            catSaveCache();
            if (manual) toast('Довідники оновлено');
            return catInfo();
        }).catch(function (err) {
            catMeta.stale = true;
            if (manual) {
                toast(err.message === 'no-catalog-endpoint'
                    ? 'Сервер ще не віддає довідники — працюємо на вбудованому списку'
                    : 'Не вдалося оновити довідники', true);
            }
            return catInfo();
        }).finally(function () {
            if (timer) clearTimeout(timer);
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
        setInterval(function () { if (!catIsFresh() && !catBusy) catFetch(false); }, 5 * 60 * 1000);
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

        ensureBadge();
        refreshBadge();
        flush(true);
        if (cfg.catalog !== false) catalogInit();
        setInterval(function () { flush(true); }, cfg.flushIntervalMs);

        console.log('QC CORE ' + cfg.appVersion + ' | розділ: ' + cfg.section);
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
        refreshBadge: refreshBadge
    };

    global.QC = QC;
})(window);
