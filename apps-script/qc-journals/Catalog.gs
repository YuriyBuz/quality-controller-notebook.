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

  // Контролери для фільтра історії — у тому вигляді, в якому ім'я пишеться
  // в журнал («Соботович Л.М.»): активні контролери якості й технологи.
  controllers: {
    source: 'directory',
    positions: ['POS-012', 'POS-013'],
    format: 'journal'
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

  // Специфікації на продукт для product_specifications.html: ТМ → SKU →
  // непрозорий ключ. Посилання на Drive у браузер НЕ йде: PDF віддає сервер
  // дією getSpec лише за чинною сесією і лише для файлів із цього аркуша
  // (див. блок «Специфікації» нижче). Тека SPEC на Drive закрита.
  specs: {
    sheet: SPEC_SHEET,
    fields: { tm: 'Назва ТМ', sku: 'Назва SKU', link: 'Посилання на drive' },
    map: specPublic_
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
    .map(function (row) {
      // format:'journal' — «Прізвище І.Б.», як у колонці «Контролер»; інакше повне ПІБ
      return conf.format === 'journal'
        ? journalName_(row[EMP.shortName], row[EMP.fullName])
        : String(row[EMP.fullName]).trim();
    })
    .filter(function (name) { return name !== ''; });
}

function buildCatalog_() {
  const book = dataSpreadsheet_();
  const result = {};
  Object.keys(CATALOG_CONFIG).forEach(function (key) {
    try {
      let list = readCatalogList_(book, CATALOG_CONFIG[key]);
      // map — що з рядка показати клієнту (напр. ключ замість посилання)
      if (list && CATALOG_CONFIG[key].map) list = list.map(CATALOG_CONFIG[key].map).filter(function (x) { return !!x; });
      if (list !== null) result[key] = list;
    } catch (error) {
      logEvent_('error', 'catalog.failed', { details: key + ': ' + error });
    }
  });
  return result;
}

// =========================================================================
//  СПЕЦИФІКАЦІЇ НА ПРОДУКТ
//
//  Файли лежать у закритій теці SPEC. Сторінка отримує не посилання, а
//  непрозорий ключ (HMAC від id файлу на AUTH_SECRET). PDF віддає сервер
//  (getSpec) лише за чинною сесією і лише для файлів, перелічених в аркуші —
//  тож через цю дію не витягти нічого іншого з Drive акаунта. Кожен
//  перегляд пишеться в Журнал_подій: хто, коли, який SKU.
// =========================================================================
function driveFileId_(link) {
  const s = String(link || '').trim();
  const m = /\/d\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}

function specKey_(fileId) {
  if (!fileId) return '';
  // computeHmacSha256Signature віддає байти зі знаком (-128..127)
  return Utilities.computeHmacSha256Signature('spec:' + fileId, getAuthSecret_())
    .slice(0, 10)
    .map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); })
    .join('');
}

function specPublic_(item) {
  const id = driveFileId_(item.link);
  if (!id) return null;
  return { tm: item.tm, sku: item.sku, key: specKey_(id) };
}

/** Усі рядки аркуша специфікацій за ключами — перелік дозволеного для getSpec. */
function specIndex_() {
  const list = readCatalogList_(dataSpreadsheet_(), {
    sheet: SPEC_SHEET,
    fields: { tm: 'Назва ТМ', sku: 'Назва SKU', link: 'Посилання на drive' }
  }) || [];
  const index = {};
  list.forEach(function (item) {
    const id = driveFileId_(item.link);
    if (id) index[specKey_(id)] = { id: id, tm: item.tm, sku: item.sku };
  });
  return index;
}

function handleGetSpec_(data, session) {
  const key = String(data.key || '').trim();
  const entry = key ? specIndex_()[key] : null;
  if (!entry) throw fail_('NOT_FOUND', 'Такої специфікації в переліку немає.');

  let file;
  try {
    file = DriveApp.getFileById(entry.id);
  } catch (error) {
    logEvent_('error', 'spec.unavailable', {
      actor: session.name, device: data.deviceId, section: 'specifications',
      details: entry.sku + ': ' + error });
    throw fail_('SPEC_UNAVAILABLE',
      'Файл специфікації недоступний для сервера. Перевірте, що акаунт розгортання має доступ до теки SPEC.');
  }

  const blob = file.getBlob();
  const bytes = blob.getBytes();
  if (bytes.length > SPEC_MAX_BYTES) {
    throw fail_('TOO_LARGE', 'Файл завеликий (' + Math.round(bytes.length / 1048576) + ' МБ). ' +
      'Стисніть PDF до ' + Math.round(SPEC_MAX_BYTES / 1048576) + ' МБ.');
  }

  logEvent_('access', 'spec.view', {
    actor: session.name, device: data.deviceId, section: 'specifications', details: entry.sku });

  return {
    result: 'success',
    tm: entry.tm,
    sku: entry.sku,
    mimeType: blob.getContentType() || 'application/pdf',
    size: bytes.length,
    data: Utilities.base64Encode(bytes)
  };
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
