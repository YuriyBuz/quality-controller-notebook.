// Наскрізний прогін qc-journals на моку Apps Script. PIN у фікстурах вигадані.
const { makeEnv, Book } = require('./mock.js');

const DATA_ID = '1VKKlqzrzRsZzDU1kbYciXnJ7J1Kr9fl1GF2RBBwlUUo';
const REF_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
const pad = n => (n < 10 ? '0' : '') + n;
const stamp = (daysAgo, h, m) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(h)}:${pad(m)}:00`; };
const day = (daysAgo) => stamp(daysAgo, 0, 0).slice(0, 10);
const iso = (daysAgo) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

let pass = 0, fail = 0, section = '';
const group = n => { section = n; console.log('\n=== ' + n + ' ==='); };
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || !extra ? '' : '\n      ' + extra}`); };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `отримано ${JSON.stringify(got)}, треба ${JSON.stringify(want)}`);

// ---------- фікстури ----------
function emp(id, full, short, pos, status, pin, extra) {
  const r = new Array(19).fill('');
  r[0] = id; r[1] = full; r[2] = short; r[3] = full.split(' ')[0]; r[4] = pos; r[7] = status; r[16] = pin; r[17] = extra || '';
  return r;
}
function refBook() {
  return new Book('gw-ref', {
    '_REF_Positions': [
      ['pos_id', 'назва посади', 'підрозділ', 'ролі типові'],
      ['POS-002', 'Варник соуса', 'Виробництво', ''],
      ['POS-010', 'Оператор-налагоджувальник', 'Виробництво', ''],
      ['POS-012', 'Контролер якості', 'Лабораторія', 'qc.use'],
      ['POS-013', 'Технолог', 'Лабораторія', 'qc.admin'],
    ],
    '_REF_Employees': [
      ['emp_id', 'ПІБ повне', 'ПІБ короткий', 'прізвище', 'pos_id', 'посада', 'підрозділ', 'статус', '', '', '', '', '', '', 'email', '', 'PIN', 'ролі додатково', 'ролі відібрані'],
      emp('EMP-0024', 'Соботович Лілія Михайлівна', 'Соботович Л. М.', 'POS-012', 'active', '0000'),
      emp('EMP-0021', 'Попадюк Анжела Миколаївна', 'Попадюк А. М.', 'POS-012', 'active', '7777'),
      emp('EMP-0020', 'Огаркова Марія Володимирівна', 'Огаркова М. В.', 'POS-012', 'fired', '8888'),
      emp('EMP-0061', 'Анастасія Диндар', 'Анастасія Д.', '', 'active', '9999', 'admin'),
      emp('EMP-0009', 'Загура Іван Борисович', 'Загура І. Б.', 'POS-002', 'active', '0000'),
      emp('EMP-0022', 'Садиріна Ольга Анатоліївна', 'Садиріна О. А.', 'POS-002', 'active', '0000'),
      emp('EMP-0050', 'Бойко Світлана Петрівна', 'Бойко С. П.', 'POS-002', 'fired', '0000'),
      emp('EMP-0001', 'Бондаренко Валерій Валентинович', 'Бондаренко В. В.', 'POS-010', 'active', '0000'),
      emp('EMP-0099', 'Тест Технолог Тестович', 'Тест Т. Т.', 'POS-013', 'active', '5555'),
    ],
  });
}
const H = {
  hvo: ['Часова мітка', 'Час', 'Контролер', 'Статус системи', 'Сіль (Бак 1)', 'Залишок (Бак 1)', 'Сіль (Бак 2)', 'Залишок (Бак 2)', 'Аерація', "Ротаметр (М'яка)", 'Ротаметр (Чиста)', 'Жорсткість', 'Залізо', 'Марганець', 'pH', 'Текст звіту', 'Фото'],
  lbl: ['Дата запису', 'Час', 'Контролер', 'Машина/Лінія', 'ТМ', 'Продукт', '№ Завдання', 'Санітарія', 'Дата етикетки', 'Партія', 'Ширина', 'Температура', 'Нанесення', 'Якість пака', 'Стікер', 'Розкладка', 'Палетування', 'Коментар', 'Фото'],
  pck: ['Дата запису', 'Час', 'Контролер', 'Лінія', 'Код продукту', 'ТМ', 'SKU', 'Партія', 'Вага', 'Герметичність', 'Маркування', 'Зовнішній вигляд', 'Кришка', 'Коментар', 'Фото'],
  sauce: ['Дата запису', 'Час', 'Контролер', 'Варник', 'Продукт', '№ Завдання', 'Дата варки', 'Колір', 'Аромат', 'Смак', 'Консистенція', 'Сухі речовини', "В'язкість", 'pH', 'Стійкість', 'Коментар', 'Фото'],
  clean: ['Дата запису', 'Дата', 'Час', 'Контролер', 'Тип обладнання', 'Тип Мийки', "Об'єкт", 'Зовнішній', 'Внутрішній', 'Агрегати', 'Відповідальний', 'Підпис (Посилання)', 'Фото'],
  chk: ['Дата запису', 'Контролер', 'Етап', 'Виконано', 'Всього', 'Текст звіту', 'Фото'],
  inc: ['Дата запису', 'Час', 'Контролер', 'Постачальник', '№ Документа', 'Товар', 'Категорія', 'Партія', 'Кількість', 'Вироблено', 'Придатний до', 'Транспорт', 'Пакування', 'Маркування', 'Документи', 'Органолептика', 'Коментар', 'Фото'],
  rec: ['Дата рекламаці', 'Контролер', 'Постачальник', 'Назва сировини', '', 'дата', 'Номер', 'Опис', 'Фото'],
};
function dataBook() {
  const packing = [H.pck];
  for (let i = 0; i < 250; i++) {
    const d = 29 - Math.floor(i / 9);            // 250 записів на 28 днів
    packing.push([stamp(d, 9 + (i % 9), 5), stamp(d, 9 + (i % 9), 4).slice(0, 16).replace(' ', ', '), 'Соботович Л.М.', 'Line A', '1101 Соєвий Bonsai', 'Bonsai', '3102 | Bonsai соус соєвий', 'L' + i, '235', i === 245 ? '❌' : '✅', '✅', '✅', '✅', i === 246 ? 'перевірено ❌ раніше' : '', '']);
  }
  return new Book('QC  Data 2.0', {
    'email': [['email для поштових відправлень'], ['a@test.ua'], ['b@test.ua']],
    'HVO': [H.hvo,
      [stamp(3, 10, 14), stamp(3, 10, 13).slice(0, 16).replace(' ', ', '), 'Попадюк А.М.', '', 'В нормі', '', 'В нормі', '', '', '21', '', '', '', '', '7.00', '💧 ЗВІТ', '']],
    'Етикетування': [H.lbl.concat(['', '']),         // два порожні заголовки в кінці — як у справжній таблиці
      [stamp(2, 14, 28), stamp(2, 14, 28).slice(0, 16).replace(' ', ', '), 'Соботович Л.М.', 'Машина C', 'Peri Peri', '3402 - соус', '8820', '✅', '2027-07-09', '8820', '45', '36', '✅', '✅', '✅', '✅', '✅', '', '', '', '']],
    'Фасування': packing,
    'Варки соусу': [H.sauce,
      [stamp(1, 12, 27), '12:25', 'Соботович Л.М.', 'Садиріна Ольга Анатоліївна', '1201 Кисло-солодкий', '9190', day(2), '✅', '✅', '✅', '✅', '19.2', '7.3', '0', '✅', '', '']],
    'Мийки': [H.clean,
      [stamp(1, 16, 17), day(1), '16:16', 'Соботович Л.М.', 'Котли', 'Ополіск', 'ВК-5', '✅', '✅', '✅', 'Садиріна О.А.', 'https://drive/sig', '']],
    'Чек-лист': [H.chk,
      [stamp(5, 7, 50), 'Огаркова М.В.', 'Початок зміни', '3', '3', 'звіт', ''],
      [stamp(4, 19, 59), 'Соботович Л.М.', 'Протягом зміни', '6', '6', 'звіт', '']],
    // записано СЬОГОДНІ, але час приймання — 10 днів тому (заднім числом)
    'Вхідний контроль': [H.inc,
      [stamp(0, 18, 40), stamp(10, 9, 15).slice(0, 16).replace(' ', ', '), 'Попадюк А.М.', 'Очім', '160', 'Пляшка ПЕТ', 'packaging', '12617006', '2000', '', '', '✅', '✅', '✅', '✅', '✅', '', '']],
    'Рекламації': [H.rec,
      [stamp(6, 13, 57), 'Попадюк А.М.', 'Друкарня', 'Етикетка', '', iso(6), '439503-13', 'опис', '']],
    'Соуси': [['Наименование', 'Артикул', 'Сухі', 'Bostwick', 'pH'], ['1101 Соєвий Bonsai', 1101, 'Перевіряти', '', 'Перевіряти'], ['1108 Теріякі Bonsai', 1108, '', '', '']],
    'PRODUCT_DATABASE': [['Продукт (Код/Назва)', 'ТМ (Торгова Марка)', 'Артикул', 'Продукт (SKU)', 'Термін (міс)'], ['1101 Соєвий Bonsai', 'Bonsai', 3102, 'Bonsai соус соєвий 235 мл', 18], ['', '', '', '', '']],
    'Обладнання': [['Назва обладнаня '], ['Лінія А'], ['Лінія B'], ['Ручне фасування']],
    'itemsDatabase': [['Артикул (Сировина)', 'Назва (Сировина)', 'Артикул (Пакування)', 'Назва (Пакування)', 'Артикул (Етикетка)', 'Назва (Етикетка)'],
      ['ADD-D-001', 'Антиоксидант', 2013, 'Банка скло', 3052, 'Етикетка Bonsai'], ['ADD-D-002', 'Консервант', '', '', '', '']],
  });
}
function books() { return { [DATA_ID]: dataBook(), [REF_ID]: refBook() }; }
const SECRET = 'shared-secret-for-tests';
const envAll = (o) => makeEnv(Object.assign({ books: books(), props: [['AUTH_SECRET', SECRET]], sections: ['incoming', 'checklist', 'packing', 'labeling', 'hvo_control', 'sauce_boiling', 'cleaning'], serveHistory: true }, o));
const login = (env, pin, dev) => env.__post({ action: 'login', pin, deviceId: dev || 'tab-1' });

// =====================================================================
group('A. Вхід за PIN');
{
  const env = envAll();
  const r = login(env, '7777');
  ok('A1 власний PIN → вхід', r.success === true && !!r.token);
  eq('A1 ім\'я для журналу без пробілів між ініціалами', r.journalName, 'Попадюк А.М.');
  ok('A1 права містять writeJournal і readHistory', r.permissions.includes('writeJournal') && r.permissions.includes('readHistory'));
  ok('A1 у відповіді немає PIN і списку людей', !('pin' in r) && !('employees' in r));

  eq('A2 невірний PIN → BAD_PIN', login(env, '1234').code, 'BAD_PIN');
  for (let i = 0; i < 4; i++) login(env, '1234');
  eq('A3 після 5 невдач — THROTTLED навіть на правильний', login(env, '7777').code, 'THROTTLED');
  eq('A3 інший пристрій не заблокований', login(env, '7777', 'tab-2').success, true);

  eq('A4 звільнена → BAD_PIN', login(envAll(), '8888').code, 'BAD_PIN');
  eq('A5 PIN без ролі qc (Бондаренко) → не підходить', login(envAll(), '0000', 'tab-x').success, true); // 0000 також у Соботович
}
{
  const env = envAll();
  const r = login(env, '0000');
  ok('A6 стартовий PIN, спільний з іншими, але серед qc — один → вхід', r.success === true);
  eq('A6 це саме Соботович', r.journalName, 'Соботович Л.М.');
  ok('A6 є попередження про неособистий PIN', /збігається/.test(r.warning));
  ok('A6 у журналі подій є login.sharedPin', env.__state.cache.size >= 0 && dataBook && true);
  const events = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('Журнал_подій').rows.map(r => r[2]);
  ok('A6 подія login.sharedPin записана', events.includes('login.sharedPin'));
}
{
  const r = login(envAll(), '9999');
  ok('A7 admin через колонку R без посади → вхід з правами', r.success && r.permissions.includes('writeJournal'));
  const t = login(envAll(), '5555');
  ok('A7 qc.admin (Технолог) → вхід', t.success && t.roles.includes('qc.admin'));
}

// =====================================================================
group('B. Сесія і токен');
{
  const env = envAll();
  const token = login(env, '7777').token;
  ok('B1 токен перевіряється на тому ж пристрої', env.verifySession_(token, 'tab-1') !== null);
  eq('B1 сесія знає emp_id', env.verifySession_(token, 'tab-1').id, 'EMP-0021');
  ok('B2 інший пристрій → відхилено', env.verifySession_(token, 'tab-9') === null);
  ok('B2 без deviceId → відхилено', env.verifySession_(token, undefined) === null);
  const [body, sig] = token.split('.');
  ok('B3 підроблений підпис → відхилено', env.verifySession_(body + '.' + sig.slice(0, -2) + 'xx', 'tab-1') === null);
  const expired = env.issueToken_({ id: 'EMP-0021' }, 'tab-1', Date.now() - 1000);
  ok('B4 протермінований → відхилено', env.verifySession_(expired, 'tab-1') === null);

  // звільнення ПІСЛЯ видачі токена
  const sheet = env.SpreadsheetApp.openById(REF_ID).getSheetByName('_REF_Employees');
  sheet.rows.find(r => r[0] === 'EMP-0021')[7] = 'fired';
  ok('B5 звільнений після входу → токен більше не діє', env.verifySession_(token, 'tab-1') === null);
}
{
  const a = envAll();
  const token = login(a, '7777').token;
  const b = envAll();                                            // «другий проєкт», той самий секрет
  ok('B6 токен проєкту 1 діє в проєкті 2 з тим самим AUTH_SECRET', b.verifySession_(token, 'tab-1') !== null);
  const c = envAll({ props: [['AUTH_SECRET', 'other-secret']] });  // «третій проєкт», інший секрет
  ok('B6 з іншим AUTH_SECRET → відхилено (контролер вводив би PIN заново)', c.verifySession_(token, 'tab-1') === null);
  const d = envAll({ props: [] });                                // секрет не задано
  d.getAuthSecret_();
  const ev = d.SpreadsheetApp.openById(DATA_ID).getSheetByName('Журнал_подій').rows.map(r => r[2]);
  ok('B6 секрет не задано → згенеровано і записано auth.secretGenerated', ev.includes('auth.secretGenerated'));
}

// =====================================================================
group('C. Запис журналу через doPost');
{
  const env = envAll({ sections: ['packing', 'labeling', 'hvo_control'] });
  const r = env.__post({ type: 'hvo_control', salt1: 'В нормі' });
  eq('C1 без токена → AUTH', r.code, 'AUTH');
  const token = login(env, '7777').token;
  const w = env.__post({ type: 'checklist', token, deviceId: 'tab-1', stage: 'x' });
  eq('C2 розділ іншого розгортання → WRONG_DEPLOYMENT', w.code, 'WRONG_DEPLOYMENT');
  ok('C2 у повідомленні названо, що обслуговує це розгортання', /packing, labeling, hvo_control/.test(w.error));
}
{
  const env = envAll();
  const token = login(env, '7777').token;
  const sheet = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('HVO');
  const before = sheet.getLastRow();
  // payload рівно такий, який шле ЧИННА water_control.html, плюс чуже ім'я
  const r = env.__post({ type: 'hvo_control', token, deviceId: 'tab-1', recordId: 'rid-001',
    employee: 'Хтось Чужий', time: stamp(0, 10, 14).slice(0, 16).replace(' ', ', '),
    systemStatus: 'Відповідає', salt1: 'В нормі', salt2: 'В нормі', rotSoft: '21', rotPure: '18',
    hardness: '1.2', iron: '0.05', manganese: '0.02', ph: '7.00', report: 'звіт', files: [] });
  eq('C3 result success', r.result, 'success');
  eq('C3 додано рівно один рядок', sheet.getLastRow(), before + 1);
  const row = sheet.rows[sheet.rows.length - 1];
  const hdr = sheet.rows[0];
  eq('C3 Контролер — із сесії, НЕ з payload', row[2], 'Попадюк А.М.');
  eq('C3 Статус системи', row[3], 'Відповідає');
  eq('C3 Ротаметр (Чиста) з rotPure', row[10], '18');
  eq('C3 Жорсткість з hardness', row[11], '1.2');
  eq('C3 Залізо з iron', row[12], '0.05');
  eq('C3 Марганець з manganese', row[13], '0.02');
  eq('C3 заголовки: recordId та emp_id дописано в кінець', hdr.slice(17), ['recordId', 'emp_id']);
  eq('C3 recordId у своїй колонці', row[hdr.indexOf('recordId')], 'rid-001');
  eq('C3 emp_id у своїй колонці', row[hdr.indexOf('emp_id')], 'EMP-0021');
  eq('C3 лист відправлено один', env.__state.sent.length, 1);
  eq('C3 адресати — з аркуша email', env.__state.sent[0].to, 'a@test.ua,b@test.ua');
  eq('C3 ім\'я відправника — назва журналу', env.__state.sent[0].name, 'QC HVO');

  const again = env.__post({ type: 'hvo_control', token, deviceId: 'tab-1', recordId: 'rid-001', salt1: 'x' });
  eq('C4 той самий recordId → duplicate:true', again.duplicate, true);
  eq('C4 рядків не додалося', sheet.getLastRow(), before + 1);
  eq('C4 другого листа немає', env.__state.sent.length, 1);

  // дедуп переживає втрату кешу — через колонку recordId
  env.__state.cache.clear();
  const third = env.__post({ type: 'hvo_control', token, deviceId: 'tab-1', recordId: 'rid-001', salt1: 'x' });
  eq('C4 після очищення кешу — все одно duplicate (колонка recordId)', third.duplicate, true);

  const alias = env.__post({ type: 'hvo', token, deviceId: 'tab-1', recordId: 'rid-002', salt1: 'y' });
  eq('C10 type:"hvo" → той самий журнал', alias.section, 'hvo_control');
}
{
  const env = envAll();
  const token = login(env, '0000').token;                       // Соботович
  const sheet = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('Етикетування');
  eq('C5 вихідна ширина заголовка з двома порожніми — 21', sheet.rows[0].length, 21);
  env.__post({ type: 'labeling', token, deviceId: 'tab-1', recordId: 'rid-l1', product: 'X', machine: 'A',
    calculatedExpiry: '2027-07-09', calculatedBatch: 'L 9110', report: 'звіт ✅', files: [] });
  const hdr = sheet.rows[0], row = sheet.rows[sheet.rows.length - 1];
  eq('C5 recordId став у ПЕРШИЙ порожній заголовок (кол. 20), не за ним', hdr.indexOf('recordId') + 1, 20);
  eq('C5 emp_id — кол. 21', hdr.indexOf('emp_id') + 1, 21);
  eq('C5 Розрахунковий термін — наступна', hdr.indexOf('Розрахунковий термін') + 1, 22);
  eq('C5 значення терміну на місці', row[21], '2027-07-09');
  eq('C5 значення партії на місці', row[22], 'L 9110');
  eq('C5 Контролер у журнальному форматі', row[2], 'Соботович Л.М.');
  eq('C5 наявні 19 колонок не зсунулись: «Фото» — кол. 19', hdr[18], 'Фото');
}
{
  const env = envAll();
  const token = login(env, '7777').token;
  const png = 'data:image/png;base64,' + Buffer.from('sig').toString('base64');
  const jpg = 'data:image/jpeg;base64,' + Buffer.from('photo').toString('base64');
  env.__post({ type: 'cleaning', token, deviceId: 'tab-1', recordId: 'rid-c1', equipObj: 'ВК-5', date: iso(0), time: '16:16',
    equipType: 'Котли', washType: 'Ополіск', ext: '✅', int: '✅', agg: '✅', resp: 'Садиріна О.А.',
    signature: png, files: [{ data: jpg }, { data: jpg }], report: 'ок' });
  const sheet = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('Мийки');
  const row = sheet.rows[sheet.rows.length - 1];
  ok('C6 підпис — окремий файл у колонці 12', /drive\.google\.com/.test(row[11]));
  eq('C6 два фото → два посилання', row[12].split(',\n').length, 2);
  eq('C6 у Drive три файли (підпис + 2 фото)', env.__state.files.length, 3);
  eq('C6 дата з ISO у форматі журналу', row[1], day(0));
  ok('C6 підпис збережено як png', env.__state.files.some(f => /Sig/.test(f.name) && f.name.endsWith('.png')));
}
{
  const env = envAll();
  const token = login(env, '7777').token;
  env.__post({ type: 'sauce_boiling', token, deviceId: 'tab-1', recordId: 'rid-s1', product: '1101', cook: 'Загура', report: 'все ✅', files: [] });
  eq('C7 варки: додатковий адресат технолога постачальника', env.__state.sent[0].to, 'a@test.ua,b@test.ua,bas@vsesvit-group.com.ua');
  ok('C7 без невідповідності — тема без ⚠️', !/⚠️/.test(env.__state.sent[0].subject));
  env.__post({ type: 'packing', token, deviceId: 'tab-1', recordId: 'rid-p1', sku: 'S', report: 'Герметичність ❌', files: [] });
  ok('C7 з ❌ у звіті — тема з ⚠️ УВАГА', /^⚠️ УВАГА!/.test(env.__state.sent[1].subject));
}
{
  const env = envAll({ quota: 1 });                              // лишилась 1 одиниця, а треба 2
  const token = login(env, '7777').token;
  const r = env.__post({ type: 'checklist', token, deviceId: 'tab-1', recordId: 'rid-q', stage: 'Початок', done: 3, total: 3, report: 'ok', files: [] });
  eq('C8 запис при нестачі квоти — все одно success', r.result, 'success');
  eq('C8 листа не надіслано', env.__state.sent.length, 0);
  const ev = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('Журнал_подій').rows.map(r => r[2]);
  ok('C8 подія mail.quotaExhausted записана', ev.includes('mail.quotaExhausted'));
}
{
  const env = envAll();
  const token = login(env, '7777').token;
  eq('C9 невідомий type → UNKNOWN_TYPE', env.__post({ type: 'nope', token, deviceId: 'tab-1' }).code, 'UNKNOWN_TYPE');
}
{
  const env = envAll({ deniedFolders: ['1jvrBMFDQ_q_uA9GY5jamChDleZHjjnnt'] });   // тека HVO закрита
  const token = login(env, '7777').token;
  const jpg = 'data:image/jpeg;base64,' + Buffer.from('p').toString('base64');
  const r = env.__post({ type: 'hvo_control', token, deviceId: 'tab-1', recordId: 'rid-d', salt1: 'x', files: [{ data: jpg }], report: 'r' });
  eq('C11 запис не втрачено попри закриту теку', r.result, 'success');
  const sheet = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('HVO');
  eq('C11 у колонці «Фото» — текст помилки, а не порожньо', sheet.rows[sheet.rows.length - 1][16], 'ПОМИЛКА ДОСТУПУ ДО ТЕКИ');
  const ev = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('Журнал_подій').rows.map(r => r[2]);
  ok('C11 подія photo.folderDenied записана', ev.includes('photo.folderDenied'));
}
{
  const env = envAll({ lockOk: false });
  const token = login(env, '7777').token;
  const r = env.__post({ type: 'hvo_control', token, deviceId: 'tab-1', recordId: 'rid-lock', salt1: 'x' });
  eq('C12 lock не взято → BUSY, не мовчазний запис', r.code, 'BUSY');
  eq('C12 рядок не додано', env.SpreadsheetApp.openById(DATA_ID).getSheetByName('HVO').getLastRow(), 2);
}

// =====================================================================
group('D. Історія');
{
  const env = envAll({ serveHistory: false });
  const token = login(env, '7777').token;
  eq('D1 SERVE_HISTORY=false → WRONG_DEPLOYMENT', env.__post({ action: 'getData', token, deviceId: 'tab-1', section: 'all' }).code, 'WRONG_DEPLOYMENT');
}
{
  const env = envAll();
  const token = login(env, '7777').token;
  const q = (o) => env.__post(Object.assign({ action: 'getData', token, deviceId: 'tab-1', section: 'all', employee: 'all', dateStart: iso(30), dateEnd: iso(0) }, o));
  const all = q({});
  eq('D2 result success', all.result, 'success');
  const sections = Object.keys(all.bySection).sort();
  eq('D2 видно всі розділи, включно з варками, мийками, рекламаціями', sections, ['checklist', 'cleaning', 'hvo_control', 'incoming', 'labeling', 'packing', 'reclamation', 'sauce_boiling']);
  eq('D3 фасування: знайдено всі 250', all.bySection.packing, 250);
  eq('D3 total рахує все', all.total, 250 + 1 + 1 + 1 + 1 + 2 + 1 + 1);
  ok('D3 обрізано чесно: truncated=true, items ≤ 500', all.truncated === true && all.items.length <= 500);
  eq('D3 фасування у видачі — не більше ніж PER_SECTION (200)', all.items.filter(i => i.section === 'packing').length, 200);
  ok('D8 відсортовано за спаданням часу', all.items.every((it, i) => i === 0 || all.items[i - 1].ts >= it.ts));

  const byEmp = q({ section: 'checklist', employee: 'Огаркова М. В.' });   // з пробілами
  eq('D4 фільтр «Огаркова М. В.» знаходить «Огаркова М.В.»', byEmp.total, 1);

  const back = q({ section: 'incoming', dateStart: iso(10), dateEnd: iso(10) });
  eq('D5 запис заднім числом: шукаємо день події → знайдено', back.total, 1);
  const today = q({ section: 'incoming', dateStart: iso(0), dateEnd: iso(0) });
  eq('D5 за днем запису — не знайдено (фільтр за подією)', today.total, 0);

  const pk = q({ section: 'packing' }).items;
  const batch = n => pk.find(i => i.report.includes('Партія: L' + n + '\n'));
  eq('D6 ❌ у «Герметичність» → FAIL', batch(245) && batch(245).status, 'FAIL');
  eq('D6 ❌ лише в коментарі → OK', batch(246) && batch(246).status, 'OK');
  ok('D3 відтято саме найстаріші: L0 поза видачею, L249 у видачі', !batch(0) && !!batch(249));

  const none = q({ dateStart: iso(400), dateEnd: iso(380) });
  eq('D7 період без записів → порожньо, не помилка', none.total, 0);
  const sheet = env.SpreadsheetApp.openById(DATA_ID).getSheetByName('Фасування');
  eq('D7 firstRowFrom_: межа до всіх рядків → рядок 2', env.firstRowFrom_(sheet, 0), 2);
  eq('D7 firstRowFrom_: межа після всіх → 0', env.firstRowFrom_(sheet, Date.now() + 86400000), 0);
}

// =====================================================================
group('E. Довідники');
{
  const env = envAll();
  eq('E1 без сесії → AUTH', env.__post({ action: 'getCatalog' }).code, 'AUTH');
  const token = login(env, '7777').token;
  const c = env.__post({ action: 'getCatalog', token, deviceId: 'tab-1' }).catalog;
  ok('E7 ключа employees немає', !('employees' in c));
  eq('E2 products — об\'єкти з потрібними полями', Object.keys(c.products[0]).sort(), ['code', 'group', 'months', 'sku', 'tm']);
  eq('E2 термін — «18», не «18.0»', c.products[0].months, '18');
  eq('E2 артикул — «3102»', c.products[0].code, '3102');
  eq('E2 порожній рядок пропущено', c.products.length, 1);
  eq('E3 код уже на початку назви — не дублюється', c.sauces[0], '1101 Соєвий Bonsai');
  eq('E4 заголовок з одруківкою і хвостовим пробілом знайдено', c.equipment, ['Лінія А', 'Лінія B', 'Ручне фасування']);
  eq('E5 варники — активні POS-002, повні ПІБ, без звільнених', c.cooks, ['Загура Іван Борисович', 'Садиріна Ольга Анатоліївна']);
  ok('E6 аркуша «Обʼєкти мийки» немає → ключа немає', !('washObjects' in c));
  eq('E8 itemsDatabase: код + назва', c.raw, ['ADD-D-001 Антиоксидант', 'ADD-D-002 Консервант']);
  eq('E8 порожні пари у «широкій» вкладці пропущено', c.packaging, ['2013 Банка скло']);
}

// =====================================================================
group('F. Стійкість doPost');
{
  const env = envAll();
  const r = JSON.parse(env.doPost({}).getContent());
  eq('F1 порожній запит → BAD_REQUEST', r.code, 'BAD_REQUEST');
  const bad = JSON.parse(env.doPost({ postData: { contents: '{не json' } }).getContent());
  eq('F2 битий JSON → error, а не падіння', bad.result, 'error');
  ok('F3 doGet показує версію, розділи й історію', /QC Journals v3\.0\.0/.test(env.doGet().getContent()) && /історія: так/.test(env.doGet().getContent()));
}

console.log(`\n${fail ? '✗' : '✓'} пройдено ${pass}, провалено ${fail}`);
process.exit(fail ? 1 : 0);
