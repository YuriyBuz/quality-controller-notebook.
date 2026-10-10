const S = require('./harness.js');
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      отримано: ${got}\n      треба:    ${want}`}`);
};

console.log('=== Імʼя контролера у форматі журналу ===');
eq('з пробілами → без', S.journalName_('Соботович Л. М.'), 'Соботович Л.М.');
eq('вже без пробілів', S.journalName_('Попадюк А.М.'), 'Попадюк А.М.');
eq('повне ПІБ не чіпаємо', S.journalName_('', 'Садиріна Ольга Анатоліївна'), 'Садиріна Ольга Анатоліївна');

console.log('\n=== Порівняння імен у фільтрі історії ===');
eq('пробіли ігноруються', S.sameName_('Огаркова М. В.', 'Огаркова М.В.'), 'true');
eq('різні люди', S.sameName_('Попадюк А.М.', 'Соботович Л.М.'), 'false');

console.log('\n=== Три історичні формати дати ===');
const f = d => d ? `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}` : 'null';
eq('dd.MM.yyyy HH:mm:ss', f(S.toDate_('23.01.2026 18:40:11')), '2026-1-23 18:40');
eq('з комою (колонка Час)', f(S.toDate_('19.01.2026, 17:15:45')), '2026-1-19 17:15');
eq('ранній JS toString', f(S.toDate_('Fri Jan 02 2026 08:54:15 GMT+0200')), '2026-1-2 8:54');
eq('справжній Date', f(S.toDate_(new Date(2026, 4, 4, 19, 59))), '2026-5-4 19:59');
eq('порожнє', S.toDate_(''), 'null');

console.log('\n=== Час події ===');
const written = new Date(2026, 0, 19, 17, 15, 45);
eq('HH:mm + дата запису', f(S.eventTime_('17:41', written)), '2026-1-19 17:41');
eq('повна дата-час', f(S.eventTime_('19.01.2026, 17:14:39', written)), '2026-1-19 17:14');
eq('порожньо → час запису', f(S.eventTime_('', written)), '2026-1-19 17:15');
eq('Мийки: дата+час окремо', f(S.eventTimeFromParts_('09.02.2026', '16:16', written)), '2026-2-9 16:16');

console.log('\n=== Статус тільки з контрольних колонок ===');
eq('❌ у контрольній → FAIL', S.statusFrom_(['','','','✅','❌'], [3,4]), 'FAIL');
eq('❌ лише в коментарі → OK', S.statusFrom_(['','','','✅','✅','коментар ❌'], [3,4]), 'OK');
eq('Брудно → FAIL', S.statusFrom_(['','Брудно'], [1]), 'FAIL');

console.log('\n=== Дата з форми у формат журналу ===');
eq('ISO → крапки', S.isoToDotted_('2026-01-23'), '23.01.2026');
eq('вже крапки', S.isoToDotted_('23.01.2026'), '23.01.2026');

console.log('\n=== ХВО: сім полів, що не доходили до колонок ===');
// Payload рівно такий, який шле ЧИННА сторінка water_control.html
const hvo = {
  time: '09.10.2026, 10:14:09', systemStatus: 'Відповідає',
  salt1: 'В нормі', salt2: 'В нормі', rotSoft: '21', rotPure: '18',
  hardness: '1.2', iron: '0.05', manganese: '0.02', ph: '7.00',
  report: 'текст звіту'
};
const row = S.journals_().hvo_control.row(hvo, 'Попадюк А.М.', '');
const cols = ['Часова мітка','Час','Контролер','Статус системи','Сіль (Бак 1)','Залишок (Бак 1)',
  'Сіль (Бак 2)','Залишок (Бак 2)','Аерація',"Ротаметр (М'яка)",'Ротаметр (Чиста)',
  'Жорсткість','Залізо','Марганець','pH','Текст звіту','Фото'];
cols.forEach((c, i) => console.log(`     ${String(i).padStart(2)} ${c.padEnd(18)} = ${JSON.stringify(row[i])}`));
eq('Статус системи заповнено', row[3], 'Відповідає');
eq('Ротаметр (Чиста) заповнено', row[10], '18');
eq('Жорсткість заповнено', row[11], '1.2');
eq('Залізо заповнено', row[12], '0.05');
eq('Марганець заповнено', row[13], '0.02');
eq('довжина рядка = колонок', row.length, cols.length);

console.log(`\n${fail ? '✗' : '✓'} пройдено ${pass}, провалено ${fail}`);
process.exit(fail ? 1 : 0);
