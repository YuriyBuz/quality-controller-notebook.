// =========================================================================
//  History.gs — історія для import_data.html
//  Проєкт: Журнали QC (Цифровий блокнот)
//
//  ЦЕЙ ФАЙЛ ОДНАКОВИЙ У ВСІХ ТРЬОХ ПРОЄКТАХ, але працює лише там,
//  де SERVE_HISTORY = true. Інакше import_data довелося б опитувати
//  три бекенди й зшивати відповіді.
//
//  Що виправлено проти версії, яка досі в продакшені:
//    • читалися ОСТАННІ 51 рядок аркуша — за старіший період результат
//      мовчки був порожній. Тепер межа шукається за датою;
//    • спільний ліміт 50 на всі розділи з'їдався першою ж секцією
//      (чек-листом), тож при «Всі розділи» решти було не видно;
//    • обрізання не позначалося ніяк: «Знайдено записів: 50» читалося
//      як повний результат. Тепер повертаємо total і truncated;
//    • сортування йшло через new Date('19.01.2026 17:15') → NaN,
//      тобто порядок був випадковий;
//    • «Фасування» завжди було OK: шукався текст FAIL, якого форма
//      ніколи не писала. Негерметичність не підсвічувалась;
//    • «Варки соусу» і «Мийки» пропускались завжди — вони лежать
//      у цій самій таблиці, а не в окремій, як припускав код.
// =========================================================================

const HISTORY_TOTAL_LIMIT = 500;
const HISTORY_PER_SECTION = 200;

// Записи, зроблені заднім числом, лежать нижче за датою події. Читаємо
// із запасом, щоб їх не втратити: межу шукаємо за часом ЗАПИСУ (він
// монотонний), а фільтруємо за часом ПОДІЇ.
const HISTORY_MARGIN_DAYS = 30;

// =========================================================================
//  ДАТИ
// =========================================================================

/**
 * У колонці «Дата запису» за роки назбиралось три формати:
 *   • справжній Date (локаль таблиці розпізнала рядок);
 *   • «dd.MM.yyyy HH:mm:ss»;
 *   • «Fri Jan 02 2026 08:54:15 GMT+0200 (…)» — ранні записи.
 * new Date('07.08.2026') дає Invalid Date або читає як 8 липня — саме
 * через це фільтр за датою і сортування працювали навмання.
 */
function toDate_(value) {
  if (!value && value !== 0) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return isNaN(value.getTime()) ? null : value;
  }

  const text = String(value).trim();
  if (!text) return null;

  const dotted = text.match(
    /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dotted) {
    return new Date(+dotted[3], +dotted[2] - 1, +dotted[1],
      +(dotted[4] || 0), +(dotted[5] || 0), +(dotted[6] || 0));
  }

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3]);

  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/** «17:41» або «19.01.2026, 17:41:35» → Date, спираючись на дату запису. */
function eventTime_(value, written) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  if (!text) return written;

  const full = toDate_(text);
  if (full && /\d{4}/.test(text)) return full;

  const hm = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm && written) {
    return new Date(written.getFullYear(), written.getMonth(), written.getDate(),
      +hm[1], +hm[2], +(hm[3] || 0));
  }
  return written;
}

/** «19.01.2026» + «17:41» → Date (для «Мийок», де дата й час у різних колонках). */
function eventTimeFromParts_(dateValue, timeValue, written) {
  const day = toDate_(dateValue);
  if (!day) return eventTime_(timeValue, written);

  const hm = String(timeValue || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!hm) return day;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(),
    +hm[1], +hm[2], +(hm[3] || 0));
}

// =========================================================================
//  СТАТУС
//  Дивимось у КОНКРЕТНІ контрольні колонки. Раніше склеювався весь рядок
//  (String(row)), тож «❌» у полі «Коментар» робив увесь запис невідповідним.
// =========================================================================
const FAIL_MARKS = ['❌', '🔴', 'Брудно', 'Не в нормі', 'Не відповідає', 'Не працює'];

function statusFrom_(row, indexes) {
  for (let i = 0; i < indexes.length; i++) {
    const value = String(row[indexes[i]] === undefined ? '' : row[indexes[i]]);
    for (let m = 0; m < FAIL_MARKS.length; m++) {
      if (value.indexOf(FAIL_MARKS[m]) !== -1) return 'FAIL';
    }
  }
  return 'OK';
}

function reportText_(title, row, mapping) {
  let text = '📝 ЗВІТ QC: ' + title + '\n\n';
  mapping.forEach(function (pair) {
    const parts = pair.split(':');
    const value = row[parseInt(parts[1], 10)];
    if (value) text += parts[0] + ': ' + value + '\n';
  });
  return text;
}

/** Порівняння імен стійке до пробілів: «Огаркова М. В.» = «Огаркова М.В.» */
function sameName_(a, b) {
  const norm = function (value) {
    return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
  };
  return norm(a) === norm(b);
}

// =========================================================================
//  ОПИС РОЗДІЛІВ
// =========================================================================
function historyConfig_() {
  return {

    checklist: {
      sheet: 'Чек-лист', colEmp: 1,
      eventAt: function (row, written) { return written; },
      map: function (row) {
        return {
          section: 'checklist', employee: row[1],
          status: (row[3] == row[4]) ? 'OK' : 'Incomplete',
          summary: row[2] + ' (' + row[3] + '/' + row[4] + ')',
          report: row[5], photo: row[6]
        };
      }
    },

    incoming: {
      sheet: 'Вхідний контроль', colEmp: 2,
      eventAt: function (row, written) { return eventTime_(row[1], written); },
      map: function (row) {
        return {
          section: 'incoming', employee: row[2],
          status: statusFrom_(row, [11, 12, 13, 14, 15]),
          summary: row[5] + ' (' + row[3] + ')',
          report: reportText_('Вхідний контроль', row, ['Час:1', 'Постачальник:3',
            'Документ:4', 'Товар:5', 'Категорія:6', 'Партія:7', 'Кількість:8',
            'Вироблено:9', 'Придатний до:10', 'Транспорт:11', 'Пакування:12',
            'Маркування:13', 'Документи:14', 'Органолептика:15', 'Коментар:16']),
          photo: row[17]
        };
      }
    },

    packing: {
      sheet: 'Фасування', colEmp: 2,
      eventAt: function (row, written) { return eventTime_(row[1], written); },
      map: function (row) {
        return {
          section: 'packing', employee: row[2],
          status: statusFrom_(row, [9, 10, 11, 12]),
          summary: row[6] + ' (' + row[3] + ')',
          report: reportText_('Фасування', row, ['Час:1', 'Лінія:3', 'Код:4', 'ТМ:5',
            'SKU:6', 'Партія:7', 'Вага:8', 'Герметичність:9', 'Маркування:10',
            'Вигляд:11', 'Кришка:12', 'Коментар:13']),
          photo: row[14]
        };
      }
    },

    labeling: {
      sheet: 'Етикетування', colEmp: 2,
      eventAt: function (row, written) { return eventTime_(row[1], written); },
      map: function (row) {
        return {
          section: 'labeling', employee: row[2],
          status: statusFrom_(row, [7, 12, 13, 14, 15, 16]),
          summary: row[5] + ' (' + row[3] + ')',
          report: reportText_('Етикетування', row, ['Час:1', 'Машина:3', 'ТМ:4',
            'Продукт:5', 'Завдання:6', 'Санітарія:7', 'Дата етикетки:8', 'Партія:9',
            'Плівка:10', 'Температура:11', 'Етикетка:12', 'Пак:13', 'Стікер:14',
            'Розкладка:15', 'Палетування:16', 'Коментар:17']),
          photo: row[18]
        };
      }
    },

    hvo_control: {
      sheet: 'HVO', colEmp: 2,
      eventAt: function (row, written) { return eventTime_(row[1], written); },
      map: function (row) {
        return {
          section: 'hvo_control', employee: row[2],
          status: statusFrom_(row, [3, 4, 6, 8, 11, 12, 13]),
          // До виправлення імен полів колонка «Статус системи» була порожня
          // у 209 записах із 211 — показуємо хоч щось осмислене.
          summary: row[3] ? ('Статус: ' + row[3]) : ('ХВО, pH ' + (row[14] || '—')),
          report: row[15] ? row[15] : reportText_('ХВО', row, ['Час:1', 'Статус:3',
            'Сіль1:4', 'Залишок1:5', 'Сіль2:6', 'Залишок2:7', 'Аерація:8',
            "Ротаметр м'яка:9", 'Ротаметр чиста:10', 'Жорсткість:11', 'Залізо:12',
            'Марганець:13', 'pH:14']),
          photo: row[16]
        };
      }
    },

    sauce_boiling: {
      sheet: 'Варки соусу', colEmp: 2,
      eventAt: function (row, written) { return eventTime_(row[1], written); },
      map: function (row) {
        return {
          section: 'sauce_boiling', employee: row[2],
          status: statusFrom_(row, [7, 8, 9, 10, 14]),
          summary: row[4] + ' (' + row[3] + ')',
          report: reportText_('Варки соусу', row, ['Час:1', 'Варник:3', 'Продукт:4',
            'Завдання:5', 'Дата варки:6', 'Колір:7', 'Аромат:8', 'Смак:9',
            'Консистенція:10', 'Сухі:11', "В'язкість:12", 'pH:13', 'Стійкість:14',
            'Коментар:15']),
          photo: row[16]
        };
      }
    },

    cleaning: {
      sheet: 'Мийки', colEmp: 3,
      eventAt: function (row, written) { return eventTimeFromParts_(row[1], row[2], written); },
      map: function (row) {
        return {
          section: 'cleaning', employee: row[3],
          status: statusFrom_(row, [7, 8, 9]),
          summary: row[4] + ' (' + (row[5] || '-') + ') - ' + row[6],
          report: reportText_('Мийки', row, ['Дата:1', 'Час:2', 'Тип:4', 'Тип Мийки:5',
            "Об'єкт:6", 'Зовнішнє:7', 'Внутрішнє:8', 'Агрегати:9', 'Відповідальний:10']),
          photo: row[12]
        };
      }
    },

    // Рекламації веде окремий скрипт, але аркуш лежить тут — і дотепер
    // ці 44 записи не були видні в історії взагалі.
    reclamation: {
      sheet: 'Рекламації', colEmp: 1,
      eventAt: function (row, written) { return written; },
      map: function (row) {
        return {
          section: 'reclamation', employee: row[1],
          status: 'FAIL',                 // рекламація — це вже невідповідність
          summary: row[3] + ' (' + row[2] + ')',
          report: reportText_('Рекламація', row, ['Контролер:1', 'Постачальник:2',
            'Назва сировини:3', 'Дата:5', 'Номер:6', 'Опис:7']),
          photo: row[8]
        };
      }
    }

  };
}

// =========================================================================
//  ЧИТАННЯ
// =========================================================================

/**
 * Перший рядок, у якому час ЗАПИСУ не раніший за межу.
 * Колонка 0 монотонна (перевірено на 10 620 рядках — жодного порушення
 * порядку), тому двійковий пошук тут коректний і економить читання
 * тисяч рядків на кожен запит.
 */
function firstRowFrom_(sheet, boundary) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  let low = 2;
  let high = lastRow;
  let found = lastRow + 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const date = toDate_(sheet.getRange(mid, 1).getValue());
    if (date && date.getTime() >= boundary) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found > lastRow ? 0 : found;
}

function handleGetData_(filters) {
  const book = dataSpreadsheet_();
  const all = historyConfig_();

  const start = toDate_(filters.dateStart) || new Date(1970, 0, 1);
  start.setHours(0, 0, 0, 0);
  const end = toDate_(filters.dateEnd) || new Date();
  end.setHours(23, 59, 59, 999);

  const boundary = start.getTime() - HISTORY_MARGIN_DAYS * 86400000;
  const keys = (filters.section === 'all') ? Object.keys(all) : [filters.section];
  const wantedEmployee = (filters.employee && filters.employee !== 'all')
    ? filters.employee : null;

  const items = [];
  let total = 0;
  const bySection = {};

  keys.forEach(function (key) {
    const conf = all[key];
    if (!conf) return;

    const sheet = book.getSheetByName(conf.sheet);
    if (!sheet) return;

    const firstRow = firstRowFrom_(sheet, boundary);
    if (!firstRow) return;

    const lastRow = sheet.getLastRow();
    const values = sheet.getRange(firstRow, 1, lastRow - firstRow + 1,
      sheet.getLastColumn()).getValues();

    let taken = 0;
    let matched = 0;

    // Знизу вгору: свіжіше — важливіше. Без break: межу вже задав
    // двійковий пошук, а час події може йти не по порядку.
    for (let i = values.length - 1; i >= 0; i--) {
      const row = values[i];
      const written = toDate_(row[0]);
      if (!written) continue;

      const at = conf.eventAt(row, written) || written;
      if (at.getTime() < start.getTime() || at.getTime() > end.getTime()) continue;
      if (wantedEmployee && !sameName_(row[conf.colEmp], wantedEmployee)) continue;

      matched++;
      if (taken >= HISTORY_PER_SECTION) continue;

      const item = conf.map(row);
      item.ts = at.getTime();
      item.time = Utilities.formatDate(at, TIMEZONE, 'dd.MM.yyyy HH:mm:ss');
      item.written = Utilities.formatDate(written, TIMEZONE, 'dd.MM.yyyy HH:mm:ss');
      items.push(item);
      taken++;
    }

    total += matched;
    if (matched) bySection[key] = matched;
  });

  items.sort(function (a, b) { return b.ts - a.ts; });
  const page = items.slice(0, HISTORY_TOTAL_LIMIT);

  // Клієнт має знати, що бачить не все. Раніше «Знайдено записів: 50»
  // нічим не відрізнялося від повного результату.
  return {
    result: 'success',
    items: page,
    total: total,
    truncated: total > page.length,
    bySection: bySection
  };
}

// =========================================================================
//  ПЕРЕВІРКА — запустити з редактора
// =========================================================================
function testHistory() {
  const days = 30;
  const probe = handleGetData_({
    section: 'all',
    dateStart: Utilities.formatDate(new Date(Date.now() - days * 86400000), TIMEZONE, 'yyyy-MM-dd'),
    dateEnd: Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd'),
    employee: 'all'
  });

  Logger.log('За %s днів знайдено: %s, повернуто: %s%s',
    days, probe.total, probe.items.length, probe.truncated ? ' (обрізано)' : '');
  Logger.log('За розділами: %s', JSON.stringify(probe.bySection));

  if (probe.items.length) {
    const first = probe.items[0];
    Logger.log('Найсвіжіший: %s | %s | %s | %s',
      first.time, first.section, first.employee, first.status);
  }
}
