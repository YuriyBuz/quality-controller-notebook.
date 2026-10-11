// =========================================================================
//  Catalog.gs — довідники для випадаючих списків
//  Проєкт: Журнали QC (Цифровий блокнот)
//
//  ЦЕЙ ФАЙЛ ОДНАКОВИЙ У ВСІХ ТРЬОХ ПРОЄКТАХ.
//
//  Що змінилось проти попередньої версії:
//    • зник довідник employees — ім'я контролера тепер бере сервер
//      із підтвердженої сесії, вибирати зі списку більше нема чого;
//    • варники читаються з кадрового довідника gw-ref, а не з аркуша
//      «Персонал»: той розходиться з реальністю (Єрка В.А., який є
//      у «Мийках» як відповідальний, там немає взагалі);
//    • з'явився режим fields — довідник повертає об'єкти, а не рядки.
//      Без нього фасування й етикетування обслужити не можна: їм
//      потрібні ТМ, SKU, артикул і термін придатності окремими полями.
// =========================================================================

// -------------------------------------------------------------------------
//  НАЛАШТУВАННЯ
//
//  source       — 'sheet' (за замовчуванням) або 'directory' (gw-ref)
//  sheet        — назва вкладки в QC Data 2.0
//  nameColumn   — заголовок колонки з назвою (або номер колонки з 1)
//  codeColumn   — необов'язково: колонка з артикулом → «2013 Відро 1л»
//  whereColumn  — необов'язково: колонка-фільтр
//  whereValue   — необов'язково: брати лише рядки з цим значенням
//  fields       — необов'язково: {ключ: 'Заголовок'}. Якщо задано,
//                 довідник повертає масив об'єктів замість рядків.
//  sort         — true = за алфавітом. За замовчуванням порядок як у таблиці.
//  positions    — для source:'directory': які посади брати
// -------------------------------------------------------------------------
const CATALOG_CONFIG = {

  // Варники — для сторінки «Варки соусу». У журнал пишеться повне ПІБ,
  // саме так, як у наявних записах.
  cooks: {
    source: 'directory',
    positions: ['POS-002']            // Варник соуса
  },

  // Три довідники з однієї вкладки, парами колонок A/B, C/D, E/F
  raw: {
    sheet: 'itemsDatabase',
    codeColumn: 'Артикул (Сировина)',
    nameColumn: 'Назва (Сировина)'
  },
  packaging: {
    sheet: 'itemsDatabase',
    codeColumn: 'Артикул (Пакування)',
    nameColumn: 'Назва (Пакування)'
  },
  label: {
    sheet: 'itemsDatabase',
    codeColumn: 'Артикул (Етикетка)',
    nameColumn: 'Назва (Етикетка)'
  },

  // Соуси для «Варок». У «Наименование» код уже на початку рядка,
  // тому codeColumn його не дублює (перевірка name.indexOf(code) === 0).
  sauces: {
    sheet: 'Соуси',
    codeColumn: 'Артикул',
    nameColumn: 'Наименование'
  },

  // Лінії та машини. Заголовок у таблиці з одруківкою і хвостовим
  // пробілом — «Назва обладнаня ». Пошук колонки це переживає (trim),
  // але одруківку треба відтворити точно.
  equipment: {
    sheet: 'Обладнання',
    nameColumn: 'Назва обладнаня'
  },

  // Продукція — об'єктами: фасуванню й етикетуванню потрібні окремо
  // ТМ, SKU і термін придатності, щоб порахувати дату «придатний до».
  products: {
    sheet: 'PRODUCT_DATABASE',
    fields: {
      group:  'Продукт (Код/Назва)',
      tm:     'ТМ (Торгова Марка)',
      code:   'Артикул',
      sku:    'Продукт (SKU)',
      months: 'Термін (міс)'
    }
  },

  // Норми для «Варок»: той самий аркуш «Соуси», колонками ЗА НОМЕРОМ, бо
  // в заголовках «°Bх» трапляється то латинська, то кирилична «х», і пошук
  // за назвою на цьому ламається. Порядок колонок: назва, артикул, чотири
  // позначки «що перевіряти» (сухі, Bostwick, pH, центрифугування) — у
  // таблиці це слово «Перевіряти», клієнт приймає й «+»; далі межі від/до.
  sauceSpecs: {
    sheet: 'Соуси',
    fields: {
      name: 1, code: 2,
      dryReq: 3, boReq: 4, phReq: 5, stabReq: 6,
      dryMin: 7, dryMax: 8, boMin: 9, boMax: 10, phMin: 11, phMax: 12
    }
  },

  // Відповідальні за мийку ліній — з кадрового довідника: оператори-
  // налагоджувальники, механіки зміни, налагоджувальники. За котли
  // відповідають варники — це ключ cooks вище.
  lineStaff: {
    source: 'directory',
    positions: ['POS-010', 'POS-005', 'POS-006']
  },

  // Об'єкти мийки. Аркуша поки НЕМАЄ — зараз ці списки зашиті
  // в cleaning.html. Доки вкладки не буде, ключ просто не повернеться,
  // і сторінка працюватиме на вбудованому списку.
  washObjects: {
    sheet: 'Обʼєкти мийки',
    fields: {
      equipType: 'Тип обладнання',
      object:    "Об'єкт",
      washType:  'Тип мийки'
    }
  }
};

const CATALOG_CACHE_KEY = 'qc_catalog_payload_v2';
// 10 хв. Кеш потрібен лише щоб кілька планшетів, які оновлюються
// одночасно, не читали аркуші по разу кожен.
const CATALOG_CACHE_SEC = 600;

// =========================================================================
//  ЗБІРКА
// =========================================================================
function findSheet_(book, name) {
  const direct = book.getSheetByName(name);
  if (direct) return direct;

  const target = String(name).trim().toLowerCase();
  const all = book.getSheets();
  for (let i = 0; i < all.length; i++) {
    if (all[i].getName().trim().toLowerCase() === target) return all[i];
  }
  return null;
}

function resolveColumn_(headers, ref) {
  if (ref === undefined || ref === null || ref === '') return -1;
  if (typeof ref === 'number') return ref - 1;

  const target = String(ref).trim().toLowerCase();
  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim().toLowerCase() === target) return i;
  }
  return -1;
}

function cellText_(value) {
  if (value === undefined || value === null) return '';
  // Числові артикули (2013, 3157) не мають ставати «2013.0»
  if (typeof value === 'number' && value === Math.floor(value)) return String(value);
  return String(value).trim();
}

function readCatalogList_(book, conf) {
  if (conf.source === 'directory') return readDirectoryList_(conf);

  const sheet = findSheet_(book, conf.sheet);
  if (!sheet) return null;              // вкладки немає — клієнт візьме свій список

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];

  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0];

  const whereIdx = resolveColumn_(headers, conf.whereColumn);
  const whereVal = conf.whereValue ? String(conf.whereValue).trim().toLowerCase() : null;

  // --- режим об'єктів ---
  if (conf.fields) {
    const map = {};
    let missing = 0;
    Object.keys(conf.fields).forEach(function (key) {
      map[key] = resolveColumn_(headers, conf.fields[key]);
      if (map[key] < 0) missing++;
    });
    if (missing === Object.keys(conf.fields).length) return [];   // жодної колонки не знайшли

    const items = [];
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      if (whereIdx >= 0 && whereVal !== null &&
          cellText_(row[whereIdx]).toLowerCase() !== whereVal) continue;

      const item = {};
      let empty = true;
      Object.keys(map).forEach(function (key) {
        const value = map[key] >= 0 ? cellText_(row[map[key]]) : '';
        item[key] = value;
        if (value) empty = false;
      });
      if (!empty) items.push(item);
    }
    return items;
  }

  // --- режим плоского списку ---
  let nameIdx = resolveColumn_(headers, conf.nameColumn);
  if (nameIdx < 0) nameIdx = 0;
  const codeIdx = resolveColumn_(headers, conf.codeColumn);

  const seen = {};
  const out = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    if (whereIdx >= 0 && whereVal !== null &&
        cellText_(row[whereIdx]).toLowerCase() !== whereVal) continue;

    const name = cellText_(row[nameIdx]);
    if (!name) continue;                // порожні клітинки у «широкій» вкладці — норма

    let entry = name;
    if (codeIdx >= 0) {
      const code = cellText_(row[codeIdx]);
      if (code && name.indexOf(code) !== 0) entry = code + ' ' + name;
    }

    if (seen[entry]) continue;
    seen[entry] = true;
    out.push(entry);
  }

  if (conf.sort) out.sort(function (a, b) { return a.localeCompare(b, 'uk'); });
  return out;
}

/** Повні ПІБ активних співробітників заданих посад — із кадрового довідника. */
function readDirectoryList_(conf) {
  const wanted = conf.positions || [];
  const book = SpreadsheetApp.openById(EMPLOYEES_SPREADSHEET_ID);
  const sheet = book.getSheetByName(EMPLOYEES_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;

  return sheet.getRange(2, 1, sheet.getLastRow() - 1, EMP_WIDTH).getDisplayValues()
    .filter(function (row) {
      return String(row[EMP.status]).trim().toLowerCase() === 'active' &&
             wanted.indexOf(String(row[EMP.posId]).trim()) !== -1;
    })
    .map(function (row) { return String(row[EMP.fullName]).trim(); })
    .filter(function (name) { return name !== ''; });
}

function buildCatalog_() {
  const book = dataSpreadsheet_();
  const result = {};
  Object.keys(CATALOG_CONFIG).forEach(function (key) {
    try {
      const list = readCatalogList_(book, CATALOG_CONFIG[key]);
      if (list !== null) result[key] = list;
    } catch (error) {
      logEvent_('error', 'catalog.failed', { details: key + ': ' + error });
    }
  });
  return result;
}

// =========================================================================
//  ОБРОБНИК ЗАПИТУ
// =========================================================================
function handleGetCatalog_(data) {
  const cache = CacheService.getScriptCache();

  if (!(data && data.force)) {
    try {
      const hit = cache.get(CATALOG_CACHE_KEY);
      if (hit) return JSON.parse(hit);
    } catch (error) { /* зіпсований кеш — читаємо заново */ }
  }

  const payload = {
    result: 'success',
    updatedAt: new Date().toISOString(),
    catalog: buildCatalog_()
  };

  try {
    cache.put(CATALOG_CACHE_KEY, JSON.stringify(payload), CATALOG_CACHE_SEC);
  } catch (error) {
    // Понад 100 КБ у кеш не влізе. Не біда: читатимемо аркуші щоразу,
    // просто трохи повільніше.
    logEvent_('info', 'catalog.tooBigForCache', { details: String(error) });
  }

  return payload;
}

function clearCatalogCache() {
  CacheService.getScriptCache().remove(CATALOG_CACHE_KEY);
  Logger.log('Кеш довідників очищено. Наступний запит прочитає таблицю заново.');
}

// =========================================================================
//  ДІАГНОСТИКА — запускати, якщо структура таблиці змінилась
// =========================================================================
function debugCatalog() {
  const book = dataSpreadsheet_();
  Logger.log('Таблиця: «%s»', book.getName());
  book.getSheets().forEach(function (sheet) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    const headers = (lastRow >= 1 && lastCol >= 1)
      ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    Logger.log('— «%s»: рядків %s, заголовки %s',
      sheet.getName(), Math.max(0, lastRow - 1), JSON.stringify(headers));
  });

  Logger.log('');
  Logger.log('=== РЕЗУЛЬТАТ ЗБІРКИ ===');
  const catalog = buildCatalog_();
  Object.keys(CATALOG_CONFIG).forEach(function (key) {
    if (!catalog[key]) {
      Logger.log('  %s: ДЖЕРЕЛА НЕМАЄ (%s)', key,
        CATALOG_CONFIG[key].sheet || 'довідник gw-ref');
      return;
    }
    Logger.log('  %s: %s позицій. Перші дві: %s',
      key, catalog[key].length, JSON.stringify(catalog[key].slice(0, 2)));
  });

  const size = JSON.stringify(catalog).length;
  Logger.log('');
  Logger.log('Розмір відповіді: %s Б (ліміт кешу — 102 400 Б)', size);
}
