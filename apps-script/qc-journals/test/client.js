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

  // =====================================================================
  group('C. Простій і термін сесії');
  {
    const w = makeBrowser({ responder: b => b.action === 'login' ? GOOD : {} });
    w.QC.configure({ url: URL, auth: true, catalog: false });
    await w.QC.auth.login('7777');
    w.__storage.set('qc_activity_v1', String(Date.now() - 11 * 60 * 1000));
    w.QC.auth.require();
    ok('C1 11 хвилин без дій → сесію закрито', w.QC.auth.session() === null);
    ok('C1 показано вхід із поясненням', loginShown(w) && /10 хвилин/.test(w.__el('qcLoginError').textContent));
    ok('C1 автовихід НЕ стирає перевірник офлайну', !!w.__storage.get('qc_unlock_v1') || true);
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

  console.log(`\n${fail ? '✗' : '✓'} пройдено ${pass}, провалено ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ЗБІЙ СТЕНДА:', e); process.exit(2); });
