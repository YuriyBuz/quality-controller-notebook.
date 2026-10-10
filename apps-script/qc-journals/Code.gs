// =========================================================================
//  Code.gs — точки входу і запис журналів
//  Проєкт: Журнали QC (Цифровий блокнот)
//
//  ЦЕЙ ФАЙЛ ОДНАКОВИЙ У ВСІХ ТРЬОХ ПРОЄКТАХ.
//  Що обслуговує конкретне розгортання — задано в Util.gs (SECTIONS).
//
//  Порядок наявних колонок у журналах НЕ ЗМІНЕНО: 10 000+ старих записів
//  і import_data.html читають їх за номером. Нові колонки (recordId,
//  emp_id) дописуються В КІНЕЦЬ і створюються самі при першому запису.
// =========================================================================

// -------------------------------------------------------------------------
//  ТОЧКИ ВХОДУ
// -------------------------------------------------------------------------

/**
 * Відкрити /exec у браузері — і видно, яка версія РЕАЛЬНО розгорнута за
 * цією адресою. Саме так з'ясувалося, що чотири розділи півроку ходили
 * в старий код, хоча новий був написаний і розгорнутий поруч.
 */
function doGet() {
  return ContentService.createTextOutput(
    'QC Journals v' + CODE_VERSION + ' | ' + now_() + '\n' +
    'розділи: ' + SECTIONS.join(', ') + '\n' +
    'історія: ' + (SERVE_HISTORY ? 'так' : 'ні')
  );
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw fail_('BAD_REQUEST',
        'Порожній запит: немає e.postData. Найчастіше — звернення не на ту адресу /exec.');
    }

    // e.postData.contents уже UTF-8. Трюк decodeURIComponent(escape(...)),
    // який був у старій версії, для кирилиці завжди кидав URIError.
    const data = JSON.parse(e.postData.contents);

    // Вхід — єдина дія, доступна без сесії
    if (data.action === 'login') {
      return json(loginWithPin_(data.pin, data.deviceId));
    }

    if (data.action === 'getCatalog') {
      requireSession_(data);
      return json(handleGetCatalog_(data));
    }

    if (data.action === 'getData') {
      if (!SERVE_HISTORY) {
        throw fail_('WRONG_DEPLOYMENT',
          'Це розгортання не обслуговує історію. Перевірте адресу в import_data.html.');
      }
      requirePermission_(data, 'readHistory');
      return json(handleGetData_(data));
    }

    return json(writeJournal_(data));

  } catch (error) {
    // Протермінована сесія — не збій, а звичайний перебіг зміни.
    // Якщо класти її поруч із помилками, справжні збої тонуть у шумі.
    const code = (error && error.code) || 'ERROR';
    logEvent_(code === 'AUTH' || code === 'FORBIDDEN' ? 'access' : 'error', 'doPost.failed', {
      details: ((error && error.stack) || String(error)) + ' | запит: ' +
               trimText_(e && e.postData ? e.postData.contents : '(немає)', 300)
    });
    return json({
      result: 'error',
      code: code,
      error: (error && error.message) || String(error)
    });
  }
}

// =========================================================================
//  ОПИС ЖУРНАЛІВ
//
//  headers — наявні колонки, один в один як у таблиці. Потрібні лише щоб
//  створити аркуш, якщо його раптом немає; у наявних аркушах не чіпаються.
//  row()   — значення для цих колонок у тому самому порядку.
//  extra   — додаткові колонки ПІСЛЯ recordId та emp_id.
// =========================================================================

/** Перше непорожнє з кількох можливих імен поля. */
function pick_(data, names) {
  for (let i = 0; i < names.length; i++) {
    const value = data[names[i]];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

function journals_() {
  return {

    incoming: {
      sheet: 'Вхідний контроль',
      folder: FOLDERS.INCOMING,
      filePrefix: 'Incoming',
      fileName: function (d) { return d.product; },
      subject: function (d) { return 'QC Вхідний: ' + d.product; },
      headers: ['Дата запису', 'Час', 'Контролер', 'Постачальник', '№ Документа', 'Товар',
                'Категорія', 'Партія', 'Кількість', 'Вироблено', 'Придатний до', 'Транспорт',
                'Пакування', 'Маркування', 'Документи', 'Органолептика', 'Коментар', 'Фото'],
      row: function (d, who, photos) {
        return [now_(), d.time, who, d.supplier, d.docNum, d.product, d.category, d.batch,
                d.quantity, d.prodDate, d.expDate, d.checkTransport, d.checkPackage,
                d.checkMarking, d.checkDocs, d.checkOrganoleptic, d.comment, photos];
      }
    },

    checklist: {
      sheet: 'Чек-лист',
      folder: FOLDERS.CHECKLIST,
      filePrefix: 'Checklist',
      fileName: function (d) { return d.stage; },
      subject: function (d) { return 'QC Чек-лист: ' + d.stage; },
      headers: ['Дата запису', 'Контролер', 'Етап', 'Виконано', 'Всього', 'Текст звіту', 'Фото'],
      row: function (d, who, photos) {
        return [now_(), who, d.stage, d.done, d.total, d.report, photos];
      }
    },

    packing: {
      sheet: 'Фасування',
      folder: FOLDERS.PACKING,
      filePrefix: 'Packing',
      fileName: function (d) { return d.sku; },
      subject: function (d) { return 'QC Фасування: ' + d.sku; },
      headers: ['Дата запису', 'Час', 'Контролер', 'Лінія', 'Код продукту', 'ТМ', 'SKU',
                'Партія', 'Вага', 'Герметичність', 'Маркування', 'Зовнішній вигляд',
                'Кришка', 'Коментар', 'Фото'],
      row: function (d, who, photos) {
        return [now_(), d.time, who, d.line, d.productCode, d.tm, d.sku, d.batch, d.weight,
                d.seal, d.print, d.appearance, d.cap, d.comment, photos];
      }
    },

    labeling: {
      sheet: 'Етикетування',
      folder: FOLDERS.LABELING,
      filePrefix: 'Label',
      fileName: function (d) { return d.product; },
      subject: function (d) { return 'QC Етикетка: ' + d.product; },
      headers: ['Дата запису', 'Час', 'Контролер', 'Машина/Лінія', 'ТМ', 'Продукт',
                '№ Завдання', 'Санітарія', 'Дата етикетки', 'Партія', 'Ширина', 'Температура',
                'Нанесення', 'Якість пака', 'Стікер', 'Розкладка', 'Палетування',
                'Коментар', 'Фото'],
      row: function (d, who, photos) {
        return [now_(), d.time, who, d.machine, d.tm, d.product, d.task, d.checkSanit,
                d.labelDate, d.batch, d.width, d.temp, d.checkApply, d.checkPack,
                d.checkSticker, d.checkLayout, d.checkPallet, d.comment, photos];
      },
      // Розрахунковий термін придатності й партію форма рахує, показує
      // контролеру і дотепер нікуди не писала — вони жили лише в тексті
      // звіту. Саме звірка розрахованого з фактичним на етикетці і є
      // змістом цього контролю, тож зберігаємо їх окремими колонками.
      extra: ['Розрахунковий термін', 'Розрахункова партія'],
      extraRow: function (d) { return [d.calculatedExpiry || '', d.calculatedBatch || '']; }
    },

    hvo_control: {
      sheet: 'HVO',
      folder: FOLDERS.HVO,
      filePrefix: 'HVO',
      fileName: function () { return 'System'; },
      subject: function () { return 'QC Звіт: ХВО'; },
      headers: ['Часова мітка', 'Час', 'Контролер', 'Статус системи', 'Сіль (Бак 1)',
                'Залишок (Бак 1)', 'Сіль (Бак 2)', 'Залишок (Бак 2)', 'Аерація',
                "Ротаметр (М'яка)", 'Ротаметр (Чиста)', 'Жорсткість', 'Залізо',
                'Марганець', 'pH', 'Текст звіту', 'Фото'],
      // Форма надсилала systemStatus, rotPure, hardness, iron, manganese, а
      // сервер читав status, rotClean, hard, fe, mn. Імена не збіглися, і сім
      // показників із 211 записів ніколи не потрапили у свої колонки —
      // заповненими лишались тільки ті чотири, де назви випадково збіглися.
      // Приймаємо обидва варіанти: на планшетах може лишатись стара сторінка.
      row: function (d, who, photos) {
        return [now_(), d.time, who,
                pick_(d, ['status', 'systemStatus']),
                pick_(d, ['salt1']),
                pick_(d, ['rem1', 'remain1', 'saltRemain1']),
                pick_(d, ['salt2']),
                pick_(d, ['rem2', 'remain2', 'saltRemain2']),
                pick_(d, ['aeration']),
                pick_(d, ['rotSoft']),
                pick_(d, ['rotClean', 'rotPure']),
                pick_(d, ['hard', 'hardness']),
                pick_(d, ['fe', 'iron']),
                pick_(d, ['mn', 'manganese']),
                pick_(d, ['ph']),
                d.report, photos];
      }
    },

    sauce_boiling: {
      sheet: 'Варки соусу',
      folder: FOLDERS.SAUCE,
      filePrefix: 'Sauce',
      fileName: function (d) { return d.product; },
      subject: function (d) { return 'QC Варка: ' + d.product; },
      // Варки додатково йдуть технологу постачальника сировини
      mailExtra: 'bas@vsesvit-group.com.ua',
      headers: ['Дата запису', 'Час', 'Контролер', 'Варник', 'Продукт', '№ Завдання',
                'Дата варки', 'Колір', 'Аромат', 'Смак', 'Консистенція', 'Сухі речовини',
                "В'язкість", 'pH', 'Стійкість', 'Коментар', 'Фото'],
      row: function (d, who, photos) {
        return [now_(), d.time, who, d.cook, d.product, d.task, isoToDotted_(d.cookDate),
                d.color, d.aroma, d.taste, d.consist, d.dry, d.visc, d.ph, d.stability,
                d.comment, photos];
      }
    },

    cleaning: {
      sheet: 'Мийки',
      folder: FOLDERS.CLEANING,
      filePrefix: 'Clean',
      fileName: function (d) { return d.equipObj; },
      subject: function (d) { return 'QC Мийка: ' + d.equipObj; },
      headers: ['Дата запису', 'Дата', 'Час', 'Контролер', 'Тип обладнання', 'Тип Мийки',
                "Об'єкт", 'Зовнішній', 'Внутрішній', 'Агрегати', 'Відповідальний',
                'Підпис (Посилання)', 'Фото'],
      row: function (d, who, photos, signature) {
        return [now_(), isoToDotted_(d.date), d.time, who, d.equipType, d.washType,
                d.equipObj, d.ext, d.int, d.agg, d.resp, signature, photos];
      },
      // Підпис зберігається окремим файлом ще до основного запису
      signature: true
    }

  };
}

/** «2026-01-23» → «23.01.2026». Решту лишаємо як є. */
function isoToDotted_(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match[3] + '.' + match[2] + '.' + match[1] : text;
}

// =========================================================================
//  ЗАПИС
// =========================================================================
function writeJournal_(data) {
  const type = String(data.type || '').trim();
  const config = journals_()[type === 'hvo' ? 'hvo_control' : type];

  if (!config) {
    throw fail_('UNKNOWN_TYPE', 'Невідомий тип запису: ' + (type || '(порожній)'));
  }

  const key = (type === 'hvo') ? 'hvo_control' : type;
  if (SECTIONS.indexOf(key) === -1) {
    // Сторінка звертається не туди. Краще сказати прямо, ніж мовчки
    // записати в чужий журнал або проковтнути.
    throw fail_('WRONG_DEPLOYMENT',
      'Розділ «' + key + '» обслуговує інше розгортання. ' +
      'Це відповідає за: ' + SECTIONS.join(', ') + '.');
  }

  const session = requirePermission_(data, 'writeJournal');

  const lock = LockService.getScriptLock();
  // Результат перевіряємо: у старій версії tryLock викликався без перевірки,
  // і при таймауті код виконувався все одно — два одночасні записи могли
  // затерти один одного.
  if (!lock.tryLock(30000)) {
    throw fail_('BUSY', 'Сервер зайнятий іншим записом. Спробуйте ще раз.');
  }

  try {
    const book = dataSpreadsheet_();
    const sheet = ensureSheet_(book, config.sheet, config.headers);

    const colRecordId = ensureColumn_(sheet, 'recordId');
    const colEmpId = ensureColumn_(sheet, 'emp_id');
    const extraCols = (config.extra || []).map(function (name) {
      return ensureColumn_(sheet, name);
    });

    const recordId = String(data.recordId || '').trim();
    if (alreadyWritten_(sheet, recordId, colRecordId)) {
      // Відповідаємо success, щоб клієнт прибрав запис із черги
      logEvent_('info', 'write.duplicate', {
        actor: session.name, section: key, details: 'recordId ' + recordId });
      return { result: 'success', duplicate: true };
    }

    // Ім'я бере сервер із підтвердженої сесії. Клієнт його не надсилає
    // взагалі — тому підписати запис чужим іменем неможливо.
    const who = session.journalName;

    const baseName = fileBaseName_(config.filePrefix, config.fileName(data));
    const blobs = createBlobs_(normalizeFiles_(data), baseName);
    const photos = saveBlobs_(blobs, config.folder);

    let signature = '';
    if (config.signature && data.signature && String(data.signature).indexOf('data:') === 0) {
      const sigBlobs = createBlobs_([{ data: data.signature }],
        fileBaseName_(config.filePrefix + '_Sig', config.fileName(data)));
      signature = saveBlobs_(sigBlobs, config.folder);
    }

    const base = config.row(data, who, photos, signature);

    const row = base.slice();
    const width = Math.max(colRecordId, colEmpId,
      extraCols.length ? Math.max.apply(null, extraCols) : 0);
    while (row.length < width) row.push('');
    row[colRecordId - 1] = recordId;
    row[colEmpId - 1] = session.id;
    if (config.extraRow) {
      config.extraRow(data).forEach(function (value, i) {
        if (extraCols[i]) row[extraCols[i] - 1] = value;
      });
    }

    sheet.appendRow(row);
    markWritten_(recordId);

    logEvent_('info', 'write.ok', {
      actor: session.name, device: data.deviceId, section: key,
      details: 'фото: ' + blobs.length + (recordId ? ', recordId ' + recordId : '') });

    sendMail_(config.subject(data), data.report, blobs, key, config.mailExtra);

    return { result: 'success', section: key, employee: who };

  } finally {
    lock.releaseLock();
  }
}

/**
 * Форми історично слали і files (масив), і photo (перше фото ще раз).
 * Беремо files; photo лишається запасним варіантом для старих сторінок.
 */
function normalizeFiles_(data) {
  if (data.files && Array.isArray(data.files) && data.files.length) return data.files;
  if (data.photo && String(data.photo).indexOf('data:') === 0) return [{ data: data.photo }];
  return [];
}

/**
 * Номер колонки за заголовком; якщо немає — дописує її в кінець.
 * Шукаємо саме за назвою, а не за кількістю колонок: у «Етикетуванні»
 * після «Фото» лишилися порожні колонки, і рахунок дав би не те місце.
 */
function ensureColumn_(sheet, name) {
  const lastCol = Math.max(1, sheet.getLastColumn());
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];

  for (let i = 0; i < headers.length; i++) {
    if (String(headers[i]).trim() === name) return i + 1;
  }

  let end = headers.length;
  while (end > 0 && String(headers[end - 1]).trim() === '') end--;

  const col = end + 1;
  sheet.getRange(1, col).setValue(name).setFontWeight('bold').setBackground('#e0f2f1');
  return col;
}

// =========================================================================
//  ПЕРЕВІРКА ПІСЛЯ ВСТАНОВЛЕННЯ — запустити з редактора
// =========================================================================
function selfTest() {
  Logger.log('Версія: %s', CODE_VERSION);
  Logger.log('Виконується від: %s', Session.getEffectiveUser().getEmail());
  Logger.log('Розділи цього розгортання: %s', SECTIONS.join(', '));
  Logger.log('Обслуговує історію: %s', SERVE_HISTORY ? 'так' : 'ні');

  const secret = PropertiesService.getScriptProperties().getProperty('AUTH_SECRET');
  Logger.log('AUTH_SECRET: %s', secret
    ? 'задано, ' + secret.length + ' символів (звірте, що однаковий у всіх трьох проєктах)'
    : '⚠ НЕ ЗАДАНО — буде згенеровано своє, і вхід не працюватиме між проєктами');

  Logger.log('Отримувачі листів: %s', recipients_());
  Logger.log('Залишок поштової квоти: %s адресатів', MailApp.getRemainingDailyQuota());

  try {
    const book = dataSpreadsheet_();
    Logger.log('Таблиця: «%s»', book.getName());
    const all = journals_();
    SECTIONS.forEach(function (key) {
      const sheet = book.getSheetByName(all[key].sheet);
      Logger.log('  %s → «%s»: %s', key, all[key].sheet,
        sheet ? (sheet.getLastRow() - 1) + ' записів' : '⚠ АРКУША НЕМАЄ');
    });
  } catch (error) {
    Logger.log('⚠ Таблиця не відкривається: %s', error);
  }

  const catalog = (typeof buildCatalog_ === 'function') ? buildCatalog_() : null;
  if (!catalog) {
    Logger.log('⚠ Catalog.gs не знайдено — довідники не працюватимуть');
  } else {
    Object.keys(catalog).forEach(function (key) {
      Logger.log('  довідник %s: %s позицій', key, catalog[key].length);
    });
  }
}
