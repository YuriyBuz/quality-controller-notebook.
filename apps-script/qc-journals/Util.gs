// =========================================================================
//  Util.gs — налаштування, журнал подій, спільні дрібниці
//  Проєкт: Журнали QC (Цифровий блокнот)
//
//  ЦЕЙ ФАЙЛ ОДНАКОВИЙ У ВСІХ ТРЬОХ ПРОЄКТАХ.
//  Відрізняється лише SECTIONS унизу — перелік розділів, які обслуговує
//  конкретне розгортання. Решту не чіпати: розбіжність між копіями — це
//  рівно те, через що чотири розділи півроку працювали на старому коді.
// =========================================================================

const CODE_VERSION = '3.0.4';
const TIMEZONE = 'Europe/Kyiv';

// Таблиця з журналами. Звертаємось за ID, а не через getActiveSpreadsheet():
// до таблиці прив'язаний лише один із трьох проєктів, а код має бути
// ідентичним в усіх трьох.
const DATA_SPREADSHEET_ID = '1VKKlqzrzRsZzDU1kbYciXnJ7J1Kr9fl1GF2RBBwlUUo';

// Теки Drive для фото. Кожен акаунт, з якого розгортається проєкт,
// мусить мати доступ на редагування до тих тек, які використовує.
const FOLDERS = {
  INCOMING:  '1zy96Uzsk9IL-tfELvK8XIDP7Z9JRifG4',
  CHECKLIST: '181M0H7utmdm80xBoijtFnaD5NrE9tjgK',
  PACKING:   '1CCl1TLqtJR9HtpQRy4XuxvGrqGBBB0r2',
  LABELING:  '166LxiIEppdm-Scb9q3YQ63hSUzGQ7ALR',
  HVO:       '1jvrBMFDQ_q_uA9GY5jamChDleZHjjnnt',
  SAUCE:     '1x0J3xg8p0o6lSzKgT8uXdPk75qUjOUyL',
  CLEANING:  '1buIUCeuxy40BJF6RFUfcTuOXaqbIfIBZ',
  DEFAULT:   '1N7PYUNSdEFCxw3d7Alm7f9DpvRGHUAKi'
};

// Адреси беремо з аркуша «email» (колонка A, з рядка 2). Код чіпати не треба.
const EMAIL_SHEET = 'email';
const EMAIL_FALLBACK = 'Dyndarnastia@gmail.com,Buznitskiy7@gmail.com';
const EMAIL_CACHE_SEC = 3600;

const EVENT_SHEET = 'Журнал_подій';
const EVENT_TEXT_LIMIT = 500;

// Скільки останніх рядків переглядати, шукаючи recordId. Кеш ловить
// повтори в межах 6 годин; це — запобіжник для записів, що пролежали
// в черзі довше (ніч, вихідні).
const DEDUP_SCAN_ROWS = 2000;
const DEDUP_TTL_SEC = 21600;

// -------------------------------------------------------------------------
//  РОЗДІЛИ ЦЬОГО РОЗГОРТАННЯ — єдине, що різниться між трьома копіями
//
//  Акаунт 1: ['incoming', 'checklist']            + історія
//  Акаунт 2: ['packing', 'labeling', 'hvo_control']
//  Акаунт 3: ['sauce_boiling', 'cleaning']
//
//  SERVE_HISTORY — чи обслуговує цей проєкт запити getData з import_data.html.
//  Має бути true рівно в одного з трьох.
// -------------------------------------------------------------------------
const SECTIONS = ['incoming', 'checklist'];
const SERVE_HISTORY = true;

// =========================================================================
//  ДРІБНИЦІ
// =========================================================================
function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trimText_(value, limit) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  const max = limit || EVENT_TEXT_LIMIT;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function now_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'dd.MM.yyyy HH:mm:ss');
}

function dataSpreadsheet_() {
  return SpreadsheetApp.openById(DATA_SPREADSHEET_ID);
}

/**
 * Ім'я контролера у тому вигляді, в якому воно вже є в журналах.
 * Довідник пише «Соботович Л. М.» (з пробілами між ініціалами), а в
 * 10 000+ наявних записів стоїть «Соботович Л.М.». Якщо почати писати
 * по-новому, історія розколеться навпіл і фільтр за контролером
 * бачитиме лише половину. Тому приводимо до наявного формату, а
 * однозначний зв'язок із довідником тримає окрема колонка emp_id.
 */
function journalName_(shortName, fullName) {
  const source = String(shortName || fullName || '').trim();
  return source.replace(/\.\s+/g, '.');
}

// =========================================================================
//  ЖУРНАЛ ПОДІЙ
//  У старій версії кожен збій глушився порожнім catch: лист не пішов,
//  фото не збереглося, і дізнатись про це було нізвідки. Тепер усе,
//  що пішло не так, лишає рядок тут.
// =========================================================================
function logEvent_(kind, event, fields) {
  const entry = Object.assign({ kind: kind, event: event }, fields || {});
  if (kind === 'error') console.error(event + ' | ' + trimText_(entry.details, 400));
  try {
    const sheet = ensureSheet_(dataSpreadsheet_(), EVENT_SHEET,
      ['Час', 'Вид', 'Подія', 'Хто', 'Пристрій', 'Розділ', 'Деталі', 'Версія']);
    sheet.appendRow([
      now_(), kind, event,
      trimText_(entry.actor, 120), trimText_(entry.device, 80),
      trimText_(entry.section, 40), trimText_(entry.details, EVENT_TEXT_LIMIT),
      CODE_VERSION
    ]);
  } catch (error) {
    // Якщо не пишеться навіть журнал — лишається Cloud Logging
    console.error('logEvent_ не зміг записати: ' + error);
  }
}

function ensureSheet_(book, name, headers) {
  let sheet = book.getSheetByName(name);
  if (sheet) return sheet;
  sheet = book.insertSheet(name);
  sheet.appendRow(headers);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e0f2f1');
  return sheet;
}

// =========================================================================
//  ФОТО
// =========================================================================
function createBlobs_(files, baseName) {
  if (!files || !Array.isArray(files) || files.length === 0) return [];
  const blobs = [];
  files.forEach(function (file, index) {
    try {
      if (!file || !file.data) return;
      let base64 = String(file.data);
      let contentType = 'image/jpeg';
      let extension = 'jpg';

      if (base64.indexOf('base64,') !== -1) {
        const parts = base64.split(',');
        if (parts[0].indexOf(':') !== -1 && parts[0].indexOf(';') !== -1) {
          contentType = parts[0].split(':')[1].split(';')[0];
        }
        base64 = parts[1];
      }
      if (contentType.indexOf('png') !== -1) extension = 'png';
      else if (contentType.indexOf('pdf') !== -1) extension = 'pdf';

      blobs.push(Utilities.newBlob(Utilities.base64Decode(base64), contentType,
        baseName + '_' + (index + 1) + '.' + extension));
    } catch (error) {
      logEvent_('error', 'photo.decodeFailed', { details: baseName + ': ' + error });
    }
  });
  return blobs;
}

function saveBlobs_(blobs, folderId) {
  if (!folderId || !blobs || blobs.length === 0) return '';
  const links = [];
  let folder;
  try {
    folder = DriveApp.getFolderById(folderId);
  } catch (error) {
    logEvent_('error', 'photo.folderDenied', { details: folderId + ': ' + error });
    // Текст лишається в колонці «Фото» — видно, що фото БУЛО, але не збереглось
    return 'ПОМИЛКА ДОСТУПУ ДО ТЕКИ';
  }
  blobs.forEach(function (blob) {
    try {
      links.push(folder.createFile(blob).getUrl());
    } catch (error) {
      logEvent_('error', 'photo.saveFailed', { details: blob.getName() + ': ' + error });
      links.push('ПОМИЛКА ЗБЕРЕЖЕННЯ');
    }
  });
  return links.join(',\n');
}

function fileBaseName_(prefix, objectName) {
  const safe = String(objectName || '')
    .replace(/[^a-zA-Z0-9а-яА-ЯіїєґІЇЄҐ_\- ]/g, '')
    .trim().substring(0, 25);
  return prefix + '_' + Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd_HH-mm') + '_' + safe;
}

// =========================================================================
//  ПОШТА
//  Лист на кожну подію — так вирішено при постановці.
//  Квота Apps Script рахує АДРЕСАТІВ, а не листи: лист на дві адреси
//  коштує дві одиниці зі 100 на добу (gmail.com) чи з 1500 (Workspace).
//  Саме тому розділи рознесені на три акаунти.
// =========================================================================
function recipients_() {
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get('qc_email_list');
    if (hit) return hit;
  } catch (error) { /* кеш недоступний — прочитаємо аркуш */ }

  let list = '';
  try {
    const sheet = dataSpreadsheet_().getSheetByName(EMAIL_SHEET);
    if (sheet && sheet.getLastRow() > 1) {
      list = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
        .map(function (row) { return String(row[0]).trim(); })
        .filter(function (value) { return value.indexOf('@') > 0; })
        .join(',');
    }
  } catch (error) {
    logEvent_('error', 'mail.recipientsFailed', { details: String(error) });
  }

  if (!list) list = EMAIL_FALLBACK;
  try { cache.put('qc_email_list', list, EMAIL_CACHE_SEC); } catch (error) { /* не критично */ }
  return list;
}

function clearEmailCache() {
  CacheService.getScriptCache().remove('qc_email_list');
  Logger.log('Кеш адрес очищено. Наступний лист прочитає аркуш «%s» заново.', EMAIL_SHEET);
}

function sendMail_(subject, body, attachments, section, extraRecipients, senderLabel) {
  let targets = recipients_();
  if (extraRecipients) targets += ',' + extraRecipients;

  const list = targets.split(',')
    .map(function (value) { return value.trim(); })
    .filter(function (value) { return value.indexOf('@') > 0; });

  if (list.length === 0) {
    logEvent_('error', 'mail.noRecipients', { section: section, details: subject });
    return;
  }

  // Квота перевіряється ПЕРЕД кожним листом, а не раз на добу: вона
  // може скінчитись посеред зміни, і тоді важливо знати, що саме не пішло.
  const remaining = MailApp.getRemainingDailyQuota();
  if (remaining < list.length) {
    logEvent_('error', 'mail.quotaExhausted', {
      section: section,
      details: 'лишилось адресатів: ' + remaining + ', потрібно ' + list.length + '. Тема: ' + subject
    });
    return;
  }

  if (body && /❌|🔴|⚠️|УВАГА|Невідповідність/.test(body) && subject.indexOf('⚠️') === -1) {
    subject = '⚠️ УВАГА! ' + subject;
  }

  const params = {
    to: list.join(','),
    subject: subject,
    body: body || '(без тексту)',
    name: 'QC ' + (senderLabel || 'Блокнот')
  };
  if (attachments && attachments.length) params.attachments = attachments;

  try {
    MailApp.sendEmail(params);
  } catch (error) {
    logEvent_('error', 'mail.sendFailed', { section: section, details: subject + ': ' + error });
  }
}

// =========================================================================
//  ЗАХИСТ ВІД ДУБЛІВ
//  Черга на пристрої повторює відправку, якщо відповідь не дійшла. Без
//  цієї перевірки повтор дав би другий рядок і другий лист.
//  Кеш — швидкий шлях; колонка recordId — запобіжник, що переживає
//  і перезапуск, і витіснення кешу.
// =========================================================================
function alreadyWritten_(sheet, recordId, colRecordId) {
  if (!recordId) return false;

  try {
    if (CacheService.getScriptCache().get('rid_' + recordId) !== null) return true;
  } catch (error) { /* кеш недоступний — лишається скан */ }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || colRecordId < 1) return false;

  const firstRow = Math.max(2, lastRow - DEDUP_SCAN_ROWS + 1);
  const values = sheet.getRange(firstRow, colRecordId, lastRow - firstRow + 1, 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).trim() === recordId) return true;
  }
  return false;
}

function markWritten_(recordId) {
  if (!recordId) return;
  try { CacheService.getScriptCache().put('rid_' + recordId, '1', DEDUP_TTL_SEC); }
  catch (error) { /* не критично: лишається колонка recordId */ }
}
