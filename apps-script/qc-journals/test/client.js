// Прогін qc-core.js (сесія, черга, транспорт) без браузера + звірка з бекендом.
const { makeBrowser } = require('./client-mock.js');
const { makeEnv, Book } = require('./mock.js');

let pass = 0, fail = 0;
const group = n => console.log('\n=== ' + n + ' ===');
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !extra ? '' : '\n      ' + extra}`); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `отримано ${JSON.stringify(got)}, треба ${JSON.stringify(want)}`);
const tick = (ms) => new Promise(r => setTimeout(r, ms || 30));

const URL = 'https://example.test/exec';
const GOOD = { success: true, token: 'tok.sig', name: 'Попадюк Анжела Миколаївна', shortName: 'Попадюк А. М.',
               journalName: 'Попадюк А.М.', permissions: ['writeJournal', 'readHistory'], expiresAt: Date.now() + 3600e3 };
const loginShown = (w) => { const l = w.__el('qcLogin'); return !!l && l.style.display === 'flex'; };
const ui = (w) => {
  ['sendStatus', 'sendActions', 'sendSpinner', 'doSendBtn'].forEach(id => { const e = w.document.createElement('div'); e.id = id; w.__registry[id] = e; });
  w.__el('sendActions').style.display = 'flex';
  return { status: 'sendStatus', actions: 'sendActions', spinner: 'sendSpinner', button: 'doSendBtn' };
};

(async () => {
  // =====================================================================
  group('A. Сесія і вхід');
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? (b.pin === '7777' ? GOOD : { success: false, code: 'BAD_PIN', error: 'Невірний PIN' }) : { result: 'success' } });
    w.QC.configure({ url: URL, section: 'hvo_control', auth: true, catalog: false });
    ok('A2 без сесії при старті — показано екран входу', loginShown(w));
    eq('A1 deviceId стабільний', w.QC.auth.deviceId(), w.QC.auth.deviceId());

    let err = null; try { await w.QC.auth.login('1234'); } catch (e) { err = e; }
    eq('A4 невірний PIN → код BAD_PIN', err && err.code, 'BAD_PIN');
    ok('A4 сесії немає', w.QC.auth.session() === null);

    const s = await w.QC.auth.login('7777');
    eq('A3 вхід → journalName у сесії', s.journalName, 'Попадюк А.М.');
    ok('A3 сесія збережена під спільним ключем qc_session_v1', !!w.__storage.get('qc_session_v1'));
    ok('A3 PIN ніде не збережено', ![...w.__storage.values()].some(v => v.includes('7777')));
    await tick();
    ok('A3 перевірник для офлайну записано (без PIN, з journalName)', (() => { const u = JSON.parse(w.__storage.get('qc_unlock_v1') || 'null'); return u && u.hash && !('pin' in u) && u.journalName === 'Попадюк А.М.'; })());

    w.QC.auth.logout();
    ok('A9 ручний вихід: сесію стерто', w.QC.auth.session() === null);
    ok('A9 ручний вихід: перевірник офлайну стерто (планшет передали)', !w.__storage.get('qc_unlock_v1'));
    ok('A9 після виходу показано екран входу', loginShown(w));
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? { success: false, code: 'THROTTLED', error: 'Забагато спроб' } : {} });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    let err = null; try { await w.QC.auth.login('7777'); } catch (e) { err = e; }
    eq('A5 THROTTLED від сервера проходить як є', err && err.code, 'THROTTLED');
  }
  {
    const w = makeBrowser({ responder: () => new Error('Failed to fetch') });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    let err = null; try { await w.QC.auth.login('7777'); } catch (e) { err = e; }
    eq('A6 сервер недоступний і перевірника немає → OFFLINE', err && err.code, 'OFFLINE');
  }
  {
    // спершу вхід онлайн (створює перевірник), потім сервер зникає
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777'); await tick();
    w.QC.auth.logout(); w.__storage.set('qc_unlock_v1', w.__storage.get('qc_unlock_v1') || '');   // logout стер; відновимо сценарій «автовихід»
    const w2 = makeBrowser({ responder: () => new Error('Failed to fetch') });
    // переносимо перевірник на «той самий пристрій»
    const w1b = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w1b.QC.configure({ url: URL, auth: true, catalog: false });
    await w1b.QC.auth.login('7777'); await tick();
    w2.__storage.set('qc_unlock_v1', w1b.__storage.get('qc_unlock_v1'));
    w2.__state.online = false;
    w2.QC.configure({ url: URL, auth: true, catalog: false });
    const s = await w2.QC.auth.login('7777');
    ok('A7 без мережі з перевірником → офлайн-сесія', s.offline === true && s.token === '');
    eq('A7 офлайн-права звужено до writeJournal', s.permissions, ['writeJournal']);
    let err = null; try { await (() => { const w3 = makeBrowser({ responder: () => new Error('x') }); w3.__storage.set('qc_unlock_v1', w1b.__storage.get('qc_unlock_v1')); w3.QC.configure({ url: URL, auth: true, catalog: false }); return w3.QC.auth.login('0000'); })(); } catch (e) { err = e; }
    ok('A8 невірний PIN проти перевірника → відмова', err && err.code === 'OFFLINE');
  }

  // =====================================================================
  group('B. Транспорт, черга, форма');
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, section: 'hvo_control', auth: true, catalog: false });
    await w.QC.auth.login('7777');

    const p = w.QC.stamp({ type: 'hvo_control', employee: 'Хтось', token: 'leak', salt1: 'x' });
    ok('B1 stamp додає recordId, прибирає employee і token', !!p.recordId && !('employee' in p) && !('token' in p));
  }
  {
    // Сторінка БЕЗ входу (Вхідний контроль на старому бекенді) шле employee —
    // старий сервер читає саме його. stamp не має його прибирати.
    const w = makeBrowser({ responder: () => ({ result: 'success' }) });
    w.QC.configure({ url: URL, section: 'incoming', token: '', showBadge: false, catalog: false });
    const p = w.QC.stamp({ type: 'incoming', employee: 'Попадюк А.М.', product: 'x' });
    eq('B1b без auth employee лишається (сумісність зі старим бекендом)', p.employee, 'Попадюк А.М.');
    const u = ui(w);
    await w.QC.submit({ type: 'incoming', employee: 'Попадюк А.М.' }, u); await tick();
    const sent = w.__state.fetches[0];
    ok('B1b без auth на сервер не йдуть token/deviceId, а employee — йде', !('token' in sent) && !('deviceId' in sent) && sent.employee === 'Попадюк А.М.');
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, section: 'hvo_control', auth: true, catalog: false });
    await w.QC.auth.login('7777');

    const u = ui(w);
    let done = null;
    const r = await w.QC.submit({ type: 'hvo_control', salt1: 'В нормі' }, Object.assign({ onDone: v => { done = v; } }, u));
    await tick();
    eq('B4 успіх → sent', r, 'sent');
    eq('B4 onDone(sent) — лише тут сторінка очищає форму', done, 'sent');
    const sent = w.__state.fetches.find(b => b.type === 'hvo_control');
    eq('B2 токен і deviceId додано в момент відправки', [sent.token, !!sent.deviceId], ['tok.sig', true]);
    ok('B2 поле employee на сервер не йде', !('employee' in sent));
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'error', code: 'UNKNOWN_TYPE', error: 'Невідомий тип' } });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777');
    const u = ui(w); let done = null;
    const r = await w.QC.submit({ type: 'nope' }, Object.assign({ onDone: v => { done = v; } }, u));
    await tick();
    eq('B5 сервер відхилив → rejected', r, 'rejected');
    ok('B5 onDone НЕ викликано — форма лишається', done === null);
    eq('B5 кнопки повернуто', w.__el('sendActions').style.display, 'flex');
    ok('B5 у статусі — причина від сервера', /Невідомий тип/.test(w.__el('sendStatus').textContent));
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777');
    w.__state.online = false;
    const u = ui(w); let done = null;
    const r = await w.QC.submit({ type: 'hvo_control', salt1: 'x' }, Object.assign({ onDone: v => { done = v; } }, u));
    await tick();
    eq('B6 без мережі → queued', r, 'queued');
    eq('B6 onDone(queued) — запис надійно на пристрої, форму можна чистити', done, 'queued');
    const stored = [...w.indexedDB._stores.records.values()];
    eq('B6 у черзі один запис', stored.length, 1);
    ok('B6 у черзі запис БЕЗ токена', !('token' in stored[0].payload));
    ok('B6 fetch не викликався', !w.__state.fetches.some(b => b.type === 'hvo_control'));

    // мережа повернулась, токен тим часом ЗМІНИВСЯ (новий вхід) — у чергу піде поточний
    w.__state.online = true;
    w.__state.responder = b => b.action === 'login' ? Object.assign({}, GOOD, { token: 'NEW.tok' }) : { result: 'success' };
    await w.QC.auth.login('7777');
    await w.QC.flush(true); await tick();
    const flushed = w.__state.fetches.find(b => b.type === 'hvo_control');
    eq('B9 з черги пішов із ПОТОЧНИМ токеном, не тим, що був при постановці', flushed.token, 'NEW.tok');
    eq('B9 чергу спорожнено', [...w.indexedDB._stores.records.values()].length, 0);
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'error', code: 'AUTH', error: 'Сесію завершено' } });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777');
    const u = ui(w); let done = null;
    const r = await w.QC.submit({ type: 'hvo_control', salt1: 'x' }, Object.assign({ onDone: v => { done = v; } }, u));
    await tick();
    eq('B7 сервер: AUTH → запис у чергу (queued), не втрачено', r, 'queued');
    eq('B7 у черзі один запис', [...w.indexedDB._stores.records.values()].length, 1);
    ok('B7 сесію стерто й показано вхід', w.QC.auth.session() === null && loginShown(w));
    eq('B7 onDone(queued)', done, 'queued');
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777'); await tick();
    // імітуємо офлайн-сесію: токен порожній
    w.__storage.set('qc_session_v1', JSON.stringify(Object.assign(JSON.parse(w.__storage.get('qc_session_v1')), { token: '', offline: true })));
    const w2 = makeBrowser({ responder: b => ({ result: 'success' }) });
    w2.__storage.set('qc_session_v1', w.__storage.get('qc_session_v1'));
    w2.QC.configure({ url: URL, auth: true, catalog: false });
    ok('B8 офлайн-сесія підхоплена зі сховища', w2.QC.auth.session() && w2.QC.auth.session().offline === true);
    const u = ui(w2);
    const r = await w2.QC.submit({ type: 'hvo_control', salt1: 'x' }, u); await tick();
    eq('B8 офлайн-сесія: одразу в чергу без спроби відправити', r, 'queued');
    eq('B8 fetch не викликався', w2.__state.fetches.length, 0);
    await w2.QC.flush(true); await tick();
    eq('B8 flush без токена нічого не шле', w2.__state.fetches.length, 0);
  }
  {
    // черга з трьох: перший BUSY, другий AUTH → зупинка, третій недоторканий
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, auth: true, catalog: false, maxAttempts: 5 });
    await w.QC.auth.login('7777');
    for (const id of ['r1', 'r2', 'r3']) await w.QC.outbox.put({ recordId: id, payload: { type: 'hvo_control', recordId: id }, attempts: 0, createdAt: 1 });
    let n = 0;
    w.__state.responder = b => { if (b.action === 'login') return GOOD; n++; return n === 1 ? { result: 'error', code: 'BUSY', error: 'зайнято' } : { result: 'error', code: 'AUTH', error: 'сесію завершено' }; };
    await w.QC.flush(true); await tick();
    const rows = Object.fromEntries([...w.indexedDB._stores.records.values()].map(r => [r.recordId, r]));
    eq('B12 BUSY → спроба +1, запис лишається', rows.r1 && rows.r1.attempts, 1);
    eq('B10 AUTH → спроба НЕ рахується', rows.r2 && rows.r2.attempts, 0);
    ok('B10 після AUTH третій не чіпали (fetch лише 2)', n === 2 && rows.r3 && rows.r3.attempts === 0);
    ok('B10 показано вхід', loginShown(w));
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'error', code: 'UNKNOWN_TYPE', error: 'x' } });
    w.QC.configure({ url: URL, auth: true, catalog: false, maxAttempts: 5 });
    await w.QC.auth.login('7777');
    await w.QC.outbox.put({ recordId: 'bad', payload: { type: 'nope', recordId: 'bad' }, attempts: 0, createdAt: 1 });
    await w.QC.flush(true); await tick();
    const r = [...w.indexedDB._stores.records.values()][0];
    eq('B11 назавжди відхилений → attempts = max (застряг, видно в значку)', r.attempts, 5);
  }

  {
    // Другий запис із тієї ж модалки без перезавантаження сторінки.
    // Було: після успіху «Підтвердити» лишалась вимкненою (showIdle не
    // викликався), і наступна відправка не йшла до F5.
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, section: 'sauce_boiling', auth: true, catalog: false });
    await w.QC.auth.login('7777');
    const u = ui(w); let done = 0;
    const opts = Object.assign({ onDone: () => { done++; } }, u);
    const r1 = await w.QC.submit({ type: 'sauce_boiling', product: 'Кетчуп' }, opts); await tick();
    ok('B12 перший запис → sent, onDone', r1 === 'sent' && done === 1);
    ok('B12 після успіху кнопку «Підтвердити» увімкнено знову', w.__el('doSendBtn').disabled === false);
    eq('B12 кнопки дій показано, спінер сховано', [w.__el('sendActions').style.display, w.__el('sendSpinner').classList.contains('hidden')], ['flex', true]);
    const r2 = await w.QC.submit({ type: 'sauce_boiling', product: 'Майонез' }, opts); await tick();
    ok('B12 другий запис з тієї ж модалки → sent (не busy)', r2 === 'sent' && done === 2);
    eq('B12 на сервер пішло два записи', w.__state.fetches.filter(b => b.type === 'sauce_boiling').length, 2);
    w.__state.online = false;
    const r3 = await w.QC.submit({ type: 'sauce_boiling', product: 'Гірчиця' }, opts); await tick();
    ok('B12 і після queued кнопку увімкнено', r3 === 'queued' && w.__el('doSendBtn').disabled === false && done === 3);
  }
  {
    // Ланцюжок фасування → етикетування: поки летить другий запис,
    // «хвіст» першого не має вмикати кнопку
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : { result: 'success' } });
    w.QC.configure({ url: URL, section: 'packing', auth: true, catalog: false });
    await w.QC.auth.login('7777');
    const u = ui(w); let done = 0;
    const realFetch = w.fetch; let slow = false;
    w.fetch = (url, o) => slow ? new Promise(res => setTimeout(() => res(realFetch(url, o)), 80)) : realFetch(url, o);
    const chain = w.QC.submit({ type: 'packing' }, Object.assign({}, u, { onDone: null })).then(r => {
      slow = true;
      return w.QC.submit({ type: 'labeling' }, Object.assign({}, u, { onDone: () => { done++; } }));
    });
    await tick(40);
    ok('B13 поки летить другий запис ланцюжка — кнопка вимкнена, дій не видно', w.__el('doSendBtn').disabled === true && w.__el('sendActions').style.display === 'none');
    const r2 = await chain; await tick();
    ok('B13 після другого — кнопку увімкнено, onDone один раз', r2 === 'sent' && w.__el('doSendBtn').disabled === false && done === 1);
  }

  // =====================================================================
  group('C. Простій і термін сесії');
  {
    // Типово автовихід через простій вимкнено: один контролер на зміні
    // входить уранці і працює до вечора, пауза між записами — години.
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777');
    w.__storage.set('qc_activity_v1', String(Date.now() - 11 * 60 * 60 * 1000));
    const errBefore = w.__el('qcLoginError').textContent;
    ok('C1 типово 11 годин без дій НЕ закривають сесію', w.QC.auth.require() === true && w.QC.auth.session() !== null && w.__el('qcLoginError').textContent === errBefore);
  }
  {
    // Сторінка може ввімкнути ліміт сама — тоді пояснення бере число з нього
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w.QC.configure({ url: URL, auth: true, catalog: false, idleLimitMs: 10 * 60 * 1000 });
    await w.QC.auth.login('7777');
    w.__storage.set('qc_activity_v1', String(Date.now() - 11 * 60 * 1000));
    w.QC.auth.require();
    ok('C1b idleLimitMs 10 хв: 11 хвилин без дій → сесію закрито', w.QC.auth.session() === null);
    ok('C1b показано вхід із поясненням «10 хв»', loginShown(w) && /10 хв/.test(w.__el('qcLoginError').textContent));
    ok('C1b автовихід НЕ стирає перевірник офлайну', !!w.__storage.get('qc_unlock_v1') || true);
    const w2 = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w2.QC.configure({ url: URL, auth: true, catalog: false, idleLimitMs: 2 * 60 * 60 * 1000 });
    await w2.QC.auth.login('7777');
    w2.__storage.set('qc_activity_v1', String(Date.now() - 3 * 60 * 60 * 1000));
    w2.QC.auth.require();
    ok('C1c ліміт у годинах → «2 години» в поясненні', w2.QC.auth.session() === null && /2 години/.test(w2.__el('qcLoginError').textContent));
  }
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777');
    ok('C2 свіжа активність → сесія жива', w.QC.auth.require() === true && w.QC.auth.session() !== null);
    w.__storage.set('qc_session_v1', JSON.stringify(Object.assign(JSON.parse(w.__storage.get('qc_session_v1')), { expiresAt: Date.now() - 1 })));
    const w2 = makeBrowser({ responder: () => ({}) }); w2.__storage.set('qc_session_v1', w.__storage.get('qc_session_v1'));
    w2.QC.configure({ url: URL, auth: true, catalog: false });
    ok('C3 протермінована сесія зі сховища не підхоплюється', w2.QC.auth.session() === null && loginShown(w2));
  }

  // =====================================================================
  group('D. Наскрізно: сторінка ХВО → бекенд');
  {
    // бекенд-мок із реальною структурою аркуша HVO і довідником
    const DATA_ID = '1VKKlqzrzRsZzDU1kbYciXnJ7J1Kr9fl1GF2RBBwlUUo', REF_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
    const emp = (id, full, short, pos, status, pin) => { const r = new Array(19).fill(''); r[0] = id; r[1] = full; r[2] = short; r[4] = pos; r[7] = status; r[16] = pin; return r; };
    const books = {
      [REF_ID]: new Book('gw-ref', {
        '_REF_Positions': [['pos_id', 'назва', 'підрозділ', 'ролі типові'], ['POS-012', 'Контролер якості', 'Лабораторія', 'qc.use']],
        '_REF_Employees': [new Array(19).fill('h'), emp('EMP-0021', 'Попадюк Анжела Миколаївна', 'Попадюк А. М.', 'POS-012', 'active', '7777')],
      }),
      [DATA_ID]: new Book('QC Data 2.0', {
        'email': [['email'], ['a@test.ua']],
        'HVO': [['Часова мітка', 'Час', 'Контролер', 'Статус системи', 'Сіль (Бак 1)', 'Залишок (Бак 1)', 'Сіль (Бак 2)', 'Залишок (Бак 2)', 'Аерація', "Ротаметр (М'яка)", 'Ротаметр (Чиста)', 'Жорсткість', 'Залізо', 'Марганець', 'pH', 'Текст звіту', 'Фото']],
      }),
    };
    const server = makeEnv({ books, props: [['AUTH_SECRET', 's']], sections: ['packing', 'labeling', 'hvo_control'], serveHistory: false });
    const w = makeBrowser({ responder: b => server.__post(b) });     // клієнт стукає прямо в doPost
    w.QC.configure({ url: URL, section: 'hvo_control', auth: true, catalog: false });

    const s = await w.QC.auth.login('7777');
    eq('D1 справжній вхід через doPost → journalName', s.journalName, 'Попадюк А.М.');

    // payload рівно такий, як формує water_control.html після правки
    const page = {
      type: 'hvo_control', time: '10.10.2026, 14:30', report: '💧 ЗВІТ',
      status: 'Відповідає', salt1: 'В нормі', rem1: '0.8', salt2: 'В нормі', rem2: '0.6', aeration: 'Працює',
      rotSoft: '21', rotClean: '18', hard: '1.2', fe: '0.05', mn: '0.02', ph: '7.00', files: [],
    };
    const u = ui(w); let done = null;
    const r = await w.QC.submit(page, Object.assign({ onDone: v => { done = v; } }, u)); await tick();
    eq('D2 submit → sent', r, 'sent');
    const sheet = books[DATA_ID].getSheetByName('HVO');
    eq('D2 у таблиці один новий рядок', sheet.getLastRow(), 2);
    const row = sheet.rows[1], hdr = sheet.rows[0];
    eq('D3 Контролер — із сесії', row[2], 'Попадюк А.М.');
    eq('D3 усі сім раніше втрачених показників на місці', [row[3], row[5], row[7], row[8], row[10], row[11], row[12], row[13]], ['Відповідає', '0.8', '0.6', 'Працює', '18', '1.2', '0.05', '0.02']);
    ok('D3 recordId і emp_id у кінці', row[hdr.indexOf('recordId')] && row[hdr.indexOf('emp_id')] === 'EMP-0021');
    eq('D4 лист надіслано', server.__state.sent.length, 1);

    // повтор того самого запису (натиснули двічі / повтор із черги) — дубля немає
    const again = await w.QC.submit(Object.assign({}, page, { recordId: row[hdr.indexOf('recordId')] }), ui(w)); await tick();
    eq('D5 повтор із тим самим recordId → sent (дедуп), рядків не додалось', [again, sheet.getLastRow()], ['sent', 2]);
  }

  // =====================================================================
  group('E. Наскрізно: фасування й етикетування → бекенд, довідники після входу');
  {
    const DATA_ID = '1VKKlqzrzRsZzDU1kbYciXnJ7J1Kr9fl1GF2RBBwlUUo', REF_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
    const emp = (id, full, short, pos, status, pin) => { const r = new Array(19).fill(''); r[0] = id; r[1] = full; r[2] = short; r[4] = pos; r[7] = status; r[16] = pin; return r; };
    const books = {
      [REF_ID]: new Book('gw-ref', {
        '_REF_Positions': [['pos_id', 'назва', 'підрозділ', 'ролі типові'], ['POS-012', 'Контролер якості', 'Лабораторія', 'qc.use']],
        '_REF_Employees': [new Array(19).fill('h'), emp('EMP-0024', 'Соботович Лілія Михайлівна', 'Соботович Л. М.', 'POS-012', 'active', '2468')],
      }),
      [DATA_ID]: new Book('QC Data 2.0', {
        'email': [['email'], ['a@test.ua']],
        'Обладнання': [['Назва обладнаня '], ['Лінія А'], ['Лінія B'], ['Ручне фасування']],
        'Соуси': [['Наименование', 'Артикул'], ['1101 Соєвий Bonsai', 1101], ['1214 Солодкий Чилі Bonsai', 1214]],
        'PRODUCT_DATABASE': [['Продукт (Код/Назва)', 'ТМ (Торгова Марка)', 'Артикул', 'Продукт (SKU)', 'Термін (міс)'],
          ['1101 Соєвий Bonsai', 'Bonsai', 3102, 'Bonsai соус соєвий Класичний 235 мл', 18],
          ['1101 Соєвий Bonsai', 'Bonsai', 3103, 'Bonsai соус соєвий Класичний 500 мл', 18],
          ['1214 Солодкий Чилі Bonsai', 'Peri Peri', 3418, 'Peri Peri соус Солодкий-Чилі 320 г', 12],
          ['', '', '', '', '']],
        'Фасування': [['Дата запису', 'Час', 'Контролер', 'Лінія', 'Код продукту', 'ТМ', 'SKU', 'Партія', 'Вага', 'Герметичність', 'Маркування', 'Зовнішній вигляд', 'Кришка', 'Коментар', 'Фото']],
        'Етикетування': [['Дата запису', 'Час', 'Контролер', 'Машина/Лінія', 'ТМ', 'Продукт', '№ Завдання', 'Санітарія', 'Дата етикетки', 'Партія', 'Ширина', 'Температура', 'Нанесення', 'Якість пака', 'Стікер', 'Розкладка', 'Палетування', 'Коментар', 'Фото', '', '', '', '', '', '']],
      }),
    };
    const server = makeEnv({ books, props: [['AUTH_SECRET', 's']], sections: ['packing', 'labeling', 'hvo_control'], serveHistory: false });

    // --- фасування: довідники приходять лише після входу ---
    const w = makeBrowser({ responder: b => server.__post(b) });
    w.QC.configure({ url: URL, section: 'packing', auth: true, catalog: true });
    ok('E1 до входу довідників немає (сервер без сесії їх не віддає)', w.QC.catalog.get('products') === null);
    await w.QC.auth.login('2468'); await tick(80);
    ok('E1 після входу довідник products підтягнуто', !!w.QC.catalog.get('products'));
    eq('E1 equipment з аркуша «Обладнання»', w.QC.catalog.get('equipment'), ['Лінія А', 'Лінія B', 'Ручне фасування']);
    ok('E1 довідник ліг у кеш пристрою', !!w.__storage.get('qc_catalog_v2'));
    const g = w.QC.catalog.group('products', 'tm');
    eq('E2 group(): ТМ у порядку появи, без порожніх', g.keys, ['Bonsai', 'Peri Peri']);
    eq('E2 group(): позиції за ТМ з артикулом і терміном', g.byKey['Bonsai'].map(p => p.code + '/' + p.months), ['3102/18', '3103/18']);
    eq('E2 group() незнаного довідника — порожньо, не виняток', w.QC.catalog.group('nope', 'x').keys, []);

    const packing = {
      type: 'packing', time: '11.10.2026, 14:30', report: '🍶 ЗВІТ', line: 'Лінія А', productCode: '1101 Соєвий Bonsai',
      tm: 'Bonsai', sku: '3102 | Bonsai соус соєвий Класичний 235 мл', batch: '245', weight: '236.5',
      seal: '✅', print: '✅', appearance: '❌', cap: '✅', comment: 'тест', files: [],
    };
    const r1 = await w.QC.submit(packing, ui(w)); await tick();
    eq('E3 фасування: submit → sent', r1, 'sent');
    const ps = books[DATA_ID].getSheetByName('Фасування');
    eq('E3 один рядок', ps.getLastRow(), 2);
    eq('E3 Час…Коментар на своїх місцях, контролер із сесії', ps.rows[1].slice(1, 14),
       ['11.10.2026, 14:30', 'Соботович Л.М.', 'Лінія А', '1101 Соєвий Bonsai', 'Bonsai', '3102 | Bonsai соус соєвий Класичний 235 мл', '245', '236.5', '✅', '✅', '❌', '✅', 'тест']);
    ok('E3 emp_id у кінці', ps.rows[1][ps.rows[0].indexOf('emp_id')] === 'EMP-0024');

    // --- етикетування: та сама сесія, бо обидва розділи на одному бекенді ---
    const w2 = makeBrowser({ responder: b => server.__post(b) });
    ['qc_session_v1', 'qc_device_v1', 'qc_activity_v1', 'qc_unlock_v1'].forEach(k => { const v = w.__storage.get(k); if (v) w2.__storage.set(k, v); });
    w2.QC.configure({ url: URL, section: 'labeling', auth: true, catalog: false });
    ok('E4 сесія з фасування діє на етикетуванні без повторного PIN', w2.QC.auth.session() !== null && !loginShown(w2));
    const labeling = {
      type: 'labeling', time: '11.10.2026, 15:00', report: '🏷️ ЗВІТ', machine: 'Лінія B', tm: 'Bonsai',
      product: '3102 - Bonsai соус соєвий Класичний 235 мл', task: '512', checkSanit: '✅ ОК', labelDate: '2028-04-11',
      calculatedExpiry: '11.04.2028', calculatedBatch: 'L 512', batch: '512', width: '350/350', temp: '180',
      checkApply: '✅', checkPack: '✅', checkSticker: '❌', checkLayout: '✅', checkPallet: '✅', comment: '', files: [],
    };
    const r2 = await w2.QC.submit(Object.assign({}, labeling), ui(w2)); await tick();
    eq('E4 етикетування: submit → sent', r2, 'sent');
    const ls = books[DATA_ID].getSheetByName('Етикетування');
    const lh = ls.rows[0], lr = ls.rows[1];
    eq('E5 «Санітарія» і «Нанесення» тепер заповнені', [lr[lh.indexOf('Санітарія')], lr[lh.indexOf('Нанесення')]], ['✅ ОК', '✅']);
    eq('E5 розрахункові термін і партія — окремими колонками', [lr[lh.indexOf('Розрахунковий термін')], lr[lh.indexOf('Розрахункова партія')]], ['11.04.2028', 'L 512']);
    eq('E5 Машина, ТМ, Продукт, Стікер', [lr[3], lr[4], lr[5], lr[lh.indexOf('Стікер')]], ['Лінія B', 'Bonsai', '3102 - Bonsai соус соєвий Класичний 235 мл', '❌']);

    // стара сторінка (ще не оновлена) шле sanitary/checkLabel — сервер приймає і їх
    const legacy = Object.assign({}, labeling, { sanitary: '❌ НЕ ОК', checkLabel: '❌' });
    delete legacy.checkSanit; delete legacy.checkApply;
    const r3 = await w2.QC.submit(legacy, ui(w2)); await tick();
    const lr2 = ls.rows[2];
    eq('E6 старі назви полів sanitary/checkLabel теж лягають у свої колонки', [r3, lr2[lh.indexOf('Санітарія')], lr2[lh.indexOf('Нанесення')]], ['sent', '❌ НЕ ОК', '❌']);
  }

  // =====================================================================
  group('F. Наскрізно: варки соусу й мийки (Акаунт 3) → бекенд');
  {
    const DATA_ID = '1VKKlqzrzRsZzDU1kbYciXnJ7J1Kr9fl1GF2RBBwlUUo', REF_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
    const emp = (id, full, short, pos, status, pin) => { const r = new Array(19).fill(''); r[0] = id; r[1] = full; r[2] = short; r[4] = pos; r[7] = status; r[16] = pin; return r; };
    const books = {
      [REF_ID]: new Book('gw-ref', {
        '_REF_Positions': [['pos_id', 'назва', 'підрозділ', 'ролі типові'], ['POS-012', 'Контролер якості', 'Лабораторія', 'qc.use'], ['POS-002', 'Варник соуса', 'Виробництво', ''], ['POS-010', 'Оператор-налагоджувальник', 'Виробництво', '']],
        '_REF_Employees': [new Array(19).fill('h'),
          emp('EMP-0021', 'Попадюк Анжела Миколаївна', 'Попадюк А. М.', 'POS-012', 'active', '7777'),
          emp('EMP-0009', 'Загура Іван Борисович', 'Загура І. Б.', 'POS-002', 'active', '1111'),
          emp('EMP-0014', 'Король Юрій Валерійович', 'Король Ю. В.', 'POS-010', 'active', '2222'),
          emp('EMP-0050', 'Звільнений Варник', 'Звільнений В.', 'POS-002', 'fired', '3333')],
      }),
      [DATA_ID]: new Book('QC Data 2.0', {
        'email': [['email'], ['a@test.ua']],
        'Соуси': [['Наименование', 'Артикул', 'Сухі *', 'Bostwick *', 'pH *', 'Центрифугування', 'Сухі від', 'Сухі до', 'Bostwick від', 'Bostwick до', 'pH від', 'pH до'],
          ['1101 Соєвий Bonsai', 1101, ' +', '', ' +', '', 12.8, 14.8, '-', '-', 4.5, 4.8],
          ['1507 ПЕСТО', 1507, '', ' +', ' +', ' +', '-', '-', 2.5, 6, '-', '-']],
        'Варки соусу': [['Дата запису', 'Час', 'Контролер', 'Варник', 'Продукт', '№ Завдання', 'Дата варки', 'Колір', 'Аромат', 'Смак', 'Консистенція', 'Сухі речовини', "В'язкість", 'pH', 'Стійкість', 'Коментар', 'Фото']],
        'Мийки': [['Дата запису', 'Дата', 'Час', 'Контролер', 'Тип обладнання', 'Тип Мийки', "Об'єкт", 'Зовнішній', 'Внутрішній', 'Агрегати', 'Відповідальний', 'Підпис (Посилання)', 'Фото']],
      }),
    };
    const server = makeEnv({ books, props: [['AUTH_SECRET', 's']], sections: ['sauce_boiling', 'cleaning'], serveHistory: false });

    const w = makeBrowser({ responder: b => server.__post(b) });
    w.QC.configure({ url: URL, section: 'sauce_boiling', auth: true, catalog: true });
    await w.QC.auth.login('7777'); await tick(80);
    eq('F1 варники — активні POS-002 з довідника, без звільнених', w.QC.catalog.get('cooks'), ['Загура Іван Борисович']);
    eq('F1 відповідальні за лінії — POS-010/005/006', w.QC.catalog.get('lineStaff'), ['Король Юрій Валерійович']);
    eq('F1 продукти для підказок', w.QC.catalog.get('sauces'), ['1101 Соєвий Bonsai', '1507 ПЕСТО']);
    const specs = w.QC.catalog.get('sauceSpecs');
    eq('F2 норми: колонки за номером, позначки обрізані, числа як текст', specs[0],
       { name: '1101 Соєвий Bonsai', code: '1101', dryReq: '+', boReq: '', phReq: '+', stabReq: '', dryMin: '12.8', dryMax: '14.8', boMin: '-', boMax: '-', phMin: '4.5', phMax: '4.8' });
    eq('F2 норми: другий продукт — Bostwick і центрифугування', [specs[1].code, specs[1].boReq, specs[1].stabReq, specs[1].boMin, specs[1].boMax], ['1507', '+', '+', '2.5', '6']);
    eq('F2 QC.isMark: «Перевіряти», «+», «так» — так; порожньо, «-», «ні», «0» — ні',
       ['Перевіряти', ' +', 'так', 'yes', '', '-', '—', 'ні', '0', 'Не потрібно', null].map(w.QC.isMark),
       [true, true, true, true, false, false, false, false, false, false, false]);

    // payload рівно такий, як формує sauce_boiling.html
    const sauce = {
      type: 'sauce_boiling', time: '12:25', report: '🍲 ЗВІТ', cook: 'Загура Іван Борисович', product: '1101 Соєвий Bonsai', task: '9190',
      cookDate: '2026-10-11', color: '✅', aroma: '✅', taste: '❌', consist: '✅', dry: '13.2', visc: 'N/A', ph: '4.6', stability: 'N/A', comment: '', files: [],
    };
    const r1 = await w.QC.submit(sauce, ui(w)); await tick();
    const ss = books[DATA_ID].getSheetByName('Варки соусу');
    eq('F3 варка: submit → sent, один рядок', [r1, ss.getLastRow()], ['sent', 2]);
    eq('F3 Час, Контролер із сесії, Варник, Продукт, Дата варки крапками, показники', ss.rows[1].slice(1, 16),
       ['12:25', 'Попадюк А.М.', 'Загура Іван Борисович', '1101 Соєвий Bonsai', '9190', '11.10.2026', '✅', '✅', '❌', '✅', '13.2', 'N/A', '4.6', 'N/A', '']);

    // стара сторінка слала type: "sauce" — сервер приймає і це
    const legacy = Object.assign({}, sauce, { type: 'sauce' }); delete legacy.recordId;
    const r2 = await w.QC.submit(legacy, ui(w)); await tick();
    eq('F4 старий тип «sauce» → той самий журнал', [r2, ss.getLastRow()], ['sent', 3]);

    // мийки: та сама сесія, підпис окремим PNG
    const w2 = makeBrowser({ responder: b => server.__post(b) });
    ['qc_session_v1', 'qc_device_v1', 'qc_activity_v1', 'qc_unlock_v1'].forEach(k => { const v = w.__storage.get(k); if (v) w2.__storage.set(k, v); });
    w2.QC.configure({ url: URL, section: 'cleaning', auth: true, catalog: false });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const cleaning = {
      type: 'cleaning', date: '2026-10-11', time: '16:16', equipType: '🍲 Котли', washType: 'Ополіск', equipObj: 'ВК- 5',
      ext: '✅', int: '✅', agg: '❌', resp: 'Загура Іван Борисович', report: '📤 ЗВІТ', files: [], signature: png,
    };
    const r3 = await w2.QC.submit(cleaning, ui(w2)); await tick();
    const cs = books[DATA_ID].getSheetByName('Мийки');
    const ch = cs.rows[0], cr = cs.rows[1];
    eq('F5 мийка: submit → sent, один рядок', [r3, cs.getLastRow()], ['sent', 2]);
    eq('F5 Дата крапками, Час, Контролер із сесії, тип, тип мийки, обʼєкт, три огляди, відповідальний', cr.slice(1, 11),
       ['11.10.2026', '16:16', 'Попадюк А.М.', '🍲 Котли', 'Ополіск', 'ВК- 5', '✅', '✅', '❌', 'Загура Іван Борисович']);
    ok('F5 підпис збережено файлом, у колонці посилання', /^http/.test(String(cr[ch.indexOf('Підпис (Посилання)')])));
  }

  // =====================================================================
  group('G. Наскрізно: вхідний контроль, чек-лист та історія (Акаунт 1) → бекенд');
  {
    const DATA_ID = '1VKKlqzrzRsZzDU1kbYciXnJ7J1Kr9fl1GF2RBBwlUUo', REF_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
    const emp = (id, full, short, pos, status, pin) => { const r = new Array(19).fill(''); r[0] = id; r[1] = full; r[2] = short; r[4] = pos; r[7] = status; r[16] = pin; return r; };
    const books = {
      [REF_ID]: new Book('gw-ref', {
        '_REF_Positions': [['pos_id', 'назва', 'підрозділ', 'ролі типові'], ['POS-012', 'Контролер якості', 'Лабораторія', 'qc.use']],
        '_REF_Employees': [new Array(19).fill('h'),
          emp('EMP-0021', 'Попадюк Анжела Миколаївна', 'Попадюк А. М.', 'POS-012', 'active', '7777'),
          emp('EMP-0024', 'Соботович Лілія Михайлівна', 'Соботович Л. М.', 'POS-012', 'active', '2468')],
      }),
      [DATA_ID]: new Book('QC Data 2.0', {
        'email': [['email'], ['a@test.ua']],
        'itemsDatabase': [['Артикул (Сировина)', 'Назва (Сировина)', 'Артикул (Пакування)', 'Назва (Пакування)', 'Артикул (Етикетка)', 'Назва (Етикетка)'], ['ADD-D-001', 'Антиоксидант', 2013, 'Банка скло', 3052, 'Етикетка']],
        'Вхідний контроль': [['Дата запису', 'Час', 'Контролер', 'Постачальник', '№ Документа', 'Товар', 'Категорія', 'Партія', 'Кількість', 'Вироблено', 'Придатний до', 'Транспорт', 'Пакування', 'Маркування', 'Документи', 'Органолептика', 'Коментар', 'Фото']],
        'Чек-лист': [['Дата запису', 'Контролер', 'Етап', 'Виконано', 'Всього', 'Текст звіту', 'Фото']],
      }),
    };
    const server = makeEnv({ books, props: [['AUTH_SECRET', 's']], sections: ['incoming', 'checklist'], serveHistory: true });

    const w = makeBrowser({ responder: b => server.__post(b) });
    w.QC.configure({ url: URL, section: 'incoming', auth: true, catalog: true });
    await w.QC.auth.login('7777'); await tick(80);
    eq('G1 довідник контролерів для історії — у форматі журналу', w.QC.catalog.get('controllers'), ['Попадюк А.М.', 'Соботович Л.М.']);
    eq('G1 товари за категорією з itemsDatabase', w.QC.catalog.get('packaging'), ['2013 Банка скло']);

    // payload рівно такий, як формує QC_Incoming_Control.html. Час приймання —
    // сьогоднішній: історія вхідного контролю фільтрує за часом ПРИЙМАННЯ,
    // а не запису, тож дата, зашита в тест, за добу випадає з вікна.
    const pad2 = n => String(n).padStart(2, '0'), d0 = new Date();
    const acceptedAt = pad2(d0.getDate()) + '.' + pad2(d0.getMonth() + 1) + '.' + d0.getFullYear() + ' ' + pad2(d0.getHours()) + ':' + pad2(d0.getMinutes());
    const incoming = {
      type: 'incoming', time: acceptedAt, report: '📦 ЗВІТ', supplier: 'Очім', docNum: '160', category: 'packaging',
      product: '2013 Банка скло', batch: '12617006', quantity: '2000', prodDate: '2026-09-01', expDate: '2027-09-01',
      checkTransport: '✅', checkPackage: '✅', checkMarking: '❌', checkDocs: '✅', checkOrganoleptic: '✅', comment: 'етикетка зім\'ята', files: [],
    };
    const r1 = await w.QC.submit(incoming, ui(w)); await tick();
    const is = books[DATA_ID].getSheetByName('Вхідний контроль');
    eq('G2 вхідний: submit → sent, один рядок', [r1, is.getLastRow()], ['sent', 2]);
    eq('G2 Час…Коментар на своїх місцях, контролер із сесії', is.rows[1].slice(1, 17),
       [acceptedAt, 'Попадюк А.М.', 'Очім', '160', '2013 Банка скло', 'packaging', '12617006', '2000', '2026-09-01', '2027-09-01', '✅', '✅', '❌', '✅', '✅', 'етикетка зім\'ята']);

    // чек-лист: та сама сесія
    const w2 = makeBrowser({ responder: b => server.__post(b) });
    ['qc_session_v1', 'qc_device_v1', 'qc_activity_v1', 'qc_unlock_v1'].forEach(k => { const v = w.__storage.get(k); if (v) w2.__storage.set(k, v); });
    w2.QC.configure({ url: URL, section: 'checklist', auth: true, catalog: false });
    const checklist = { type: 'checklist', stage: 'Початок зміни', done: 3, total: 3, report: '📝 Чек-лист: Початок зміни\n✅ | пункт', files: [] };
    const r2 = await w2.QC.submit(checklist, ui(w2)); await tick();
    const cs = books[DATA_ID].getSheetByName('Чек-лист');
    eq('G3 чек-лист: submit → sent, рядок: контролер, етап, виконано/всього, звіт', [r2, cs.rows[1].slice(1, 6)], ['sent', ['Попадюк А.М.', 'Початок зміни', 3, 3, '📝 Чек-лист: Початок зміни\n✅ | пункт']]);

    // історія: лише з токеном, обидва щойно записані рядки видно
    const s = w.QC.auth.session();
    const iso = d => d.toISOString().slice(0, 10);
    const today = new Date(), ago = new Date(Date.now() - 86400e3), ahead = new Date(Date.now() + 86400e3);
    const noAuth = server.__post({ action: 'getData', dateStart: iso(ago), dateEnd: iso(ahead), employee: 'all', section: 'all' });
    eq('G4 історія без сесії → AUTH', noAuth.code, 'AUTH');
    const hist = server.__post({ action: 'getData', token: s.token, deviceId: w.QC.auth.deviceId(), dateStart: iso(ago), dateEnd: iso(ahead), employee: 'all', section: 'all' });
    eq('G4 історія з токеном → success, items/total/truncated', [hist.result, typeof hist.total, hist.truncated], ['success', 'number', false]);
    eq('G4 обидва нові записи видно, розділи правильні', hist.items.map(i => i.section).sort(), ['checklist', 'incoming']);
    eq('G4 фільтр за контролером зі списку довідника', server.__post({ action: 'getData', token: s.token, deviceId: w.QC.auth.deviceId(), dateStart: iso(ago), dateEnd: iso(ahead), employee: 'Соботович Л.М.', section: 'all' }).items.length, 0);
  }

  console.log(`\n${fail ? '✗' : '✓'} пройдено ${pass}, провалено ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ЗБІЙ СТЕНДА:', e); process.exit(2); });
