/**
 * «Облік миючих та дезінфікуючих засобів» — серверна частина.
 *
 * Замінює попередній «Код.gs» повністю. Порядок розгортання — apps-script/README.md,
 * відкат — apps-script/ROLLBACK.md.
 *
 * Головна зміна проти попередньої версії: журнал операцій став джерелом правди.
 * Раніше залишок правився як «прочитав комірку — відняв — записав» без блокування,
 * тож двоє контролерів, що списують одночасно, затирали запис один одному.
 * Тепер уся операція йде під LockService, а залишок перераховується з журналу.
 *
 * Друга зміна: помилки більше не зникають. Попередня версія ловила будь-який
 * виняток у try/catch і віддавала HTTP 200, через що Apps Script показував
 * «Виконання завершено», а в таблицю не потрапляло нічого — саме так система
 * мовчки не писала з 21.08.2026. Тепер кожна помилка лишає слід у Cloud Logging
 * і в аркуші «Журнал_подій», а застосунок показує її текст на екрані.
 */

const CODE_VERSION = 'qc-detergents-2026-08-31-auth';

// ==========================================
// 0. АВТЕНТИФІКАЦІЯ ТА ПРАВА
// ==========================================
/**
 * Джерело: аркуш «_REF_Employees» таблиці gw-ref (окремий файл) — той самий
 * довідник, що й в «Обліку ЗІП».
 *   A emp_id | B ПІБ повне | C ПІБ короткий | E pos_id | H статус
 *   O email  | Q PIN       | R ролі додатково | S ролі відібрані
 * Ролі посади — «_REF_Positions», колонка D
 * (POS-012 Контролер якості → qc.use, POS-013 Технолог → qc.admin qc.use).
 *
 * У клієнт НІКОЛИ не потрапляють: PIN, список співробітників, чужі ролі.
 */
const EMPLOYEES_SPREADSHEET_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
const EMPLOYEES_SHEET_NAME = '_REF_Employees';
const POSITIONS_SHEET_NAME = '_REF_Positions';

// Індекси колонок (0-based) в «_REF_Employees»
const EMP = { id: 0, fullName: 1, shortName: 2, posId: 4, status: 7, email: 14,
              pin: 16, extraRoles: 17, finalRoles: 18 };
const EMP_WIDTH = 19;                 // A..S
const POS = { id: 0, roles: 3 };      // A..D

const SESSION_TTL_MINUTES = 12 * 60;  // одна зміна
const MAX_PIN_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 300;

/**
 * Роль → дозволені дії. Єдине джерело правди: цю ж таблицю використовує
 * і сервер (перед кожним записом), і клієнт (щоб ховати недоступні кнопки).
 *
 * У цьому застосунку всі три ролі поки однакові: контролери самі роблять
 * і видачу, і поповнення, і інвентаризацію — так вирішено при постановці.
 * Розійдуться вони, коли з'явиться скасування операцій: qc.admin зможе
 * скасовувати чужі, qc.use — лише власні.
 */
const ROLE_PERMISSIONS = {
  'qc.use':   ['registerUsage', 'registerRestock', 'registerInventory', 'setStorage', 'forceReport'],
  'qc.admin': ['registerUsage', 'registerRestock', 'registerInventory', 'setStorage', 'forceReport'],
  'admin':    ['registerUsage', 'registerRestock', 'registerInventory', 'setStorage', 'forceReport']
};

function loginWithPin_(pin, deviceId) {
  const cache = CacheService.getScriptCache();
  const attemptsKey = 'pin_attempts_' + (deviceId || 'unknown');
  const attempts = Number(cache.get(attemptsKey) || 0);
  if (attempts >= MAX_PIN_ATTEMPTS) {
    logEvent_('access', 'login.throttled', { device: deviceId,
      details: 'спроб поспіль: ' + attempts });
    return loginFail_('THROTTLED', 'Забагато спроб. Спробуйте за 5 хвилин.');
  }

  // PIN читається як текст: у довіднику є значення з провідним нулем і
  // нецифрові (наприклад «30VIKA08»). Числове поле зіпсувало б їх.
  const value = String(pin === null || pin === undefined ? '' : pin).trim();
  if (!value) return loginFail_('BAD_PIN', 'Введіть PIN');

  const matches = readEmployees_().filter(function (employee) {
    return employee.eligible && employee.pin === value;
  });

  if (matches.length === 0) {
    cache.put(attemptsKey, String(attempts + 1), ATTEMPT_WINDOW_SECONDS);
    Utilities.sleep(400);   // сповільнює перебір
    // Сам PIN не пишемо ніде — лише його довжину і номер спроби
    logEvent_('access', 'login.badPin', { device: deviceId,
      details: 'довжина PIN: ' + value.length + ', спроба ' + (attempts + 1) });
    return loginFail_('BAD_PIN', 'Невірний PIN');
  }
  if (matches.length > 1) {
    logEvent_('access', 'login.pinNotUnique', { device: deviceId,
      details: 'збіг у ' + matches.length + ' співробітників' });
    // Не вгадуємо, хто саме — інакше операція запишеться не на ту людину
    return loginFail_('PIN_NOT_UNIQUE',
      'Цей PIN закріплений за кількома співробітниками. Зверніться до адміністратора, ' +
      'щоб вам призначили власний PIN.');
  }

  cache.remove(attemptsKey);
  const employee = matches[0];

  // Збіг шукається лише серед тих, хто має роль у цьому застосунку, тож людина
  // зі стартовим PIN усе одно ввійде — решта власників того самого PIN просто
  // не мають доступу сюди. Але PIN тоді не є секретом: його знають усі, кому
  // його видали за замовчуванням, і будь-хто з них може ввійти під цим ім'ям.
  // Не блокуємо (сьогодні ім'я взагалі обирається зі списку без пароля),
  // але лишаємо слід і кажемо про це вголос.
  const shared = countSharedPin_(employee);
  if (shared > 0) {
    logEvent_('access', 'login.sharedPin', { actor: employee.name, device: deviceId,
      details: 'той самий PIN ще в ' + shared + ' співробітників довідника' });
  }

  logEvent_('access', 'login.ok', { actor: employee.name, device: deviceId,
    details: 'ролі: ' + employee.roles.join(', ') });
  const expiresAt = Date.now() + SESSION_TTL_MINUTES * 60 * 1000;
  return {
    success: true,
    name: employee.name,
    shortName: employee.shortName,
    roles: employee.roles,
    permissions: employee.permissions,
    token: issueToken_(employee, deviceId, expiresAt),
    expiresAt: expiresAt,
    warning: shared > 0
      ? 'Ваш PIN збігається з PIN ще ' + shared + ' співробітників у довіднику. ' +
        'Він не є особистим — попросіть призначити вам власний.'
      : ''
  };
}

/** Скільки ІНШИХ співробітників довідника мають той самий PIN (будь-яка роль і статус). */
function countSharedPin_(employee) {
  if (!employee.pin) return 0;
  return readEmployees_().filter(function (other) {
    return other.id !== employee.id && other.pin === employee.pin;
  }).length;
}

// --- Токен сесії: підписаний, без зберігання стану на сервері ---
function issueToken_(employee, deviceId, expiresAt) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify({
    id: employee.id, e: expiresAt, d: deviceId || ''
  }));
  return body + '.' + sign_(body);
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getAuthSecret_()));
}

function getAuthSecret_() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    properties.setProperty('AUTH_SECRET', secret);
  }
  return secret;
}

/**
 * Перевіряє токен і ЗАНОВО читає права з довідника: звільнення або зміна
 * ролі діють негайно, не чекаючи закінчення сесії.
 */
function verifySession_(token, deviceId) {
  if (!token || String(token).indexOf('.') === -1) return null;

  const parts = String(token).split('.');
  if (sign_(parts[0]) !== parts[1]) return null;

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    return null;
  }
  if (!payload.e || payload.e < Date.now()) return null;
  // Токен виданий конкретному пристрою; відсутність ідентифікатора вважаємо
  // розбіжністю, інакше прив'язку можна обійти, просто не надіславши параметр
  if (payload.d && payload.d !== deviceId) return null;

  const employee = findEmployee_(payload.id);
  if (!employee || !employee.eligible) return null;

  return {
    id: employee.id, name: employee.name, shortName: employee.shortName,
    roles: employee.roles, permissions: employee.permissions, expiresAt: payload.e
  };
}

/** Перевірка прав перед КОЖНИМ записом — незалежно від того, що показує інтерфейс. */
function requirePermission_(request, action) {
  const session = requireSession_(request);
  if (session.permissions.indexOf(action) === -1) {
    logEvent_('access', 'access.denied', { actor: session.name, device: request.deviceId,
      details: 'дія: ' + action + ', ролі: ' + (session.roles || []).join(', ') });
    throw fail_('FORBIDDEN', 'Ваша роль не дозволяє цю дію: ' + action);
  }
  return session;
}

function requireSession_(request) {
  const session = verifySession_(request.token, request.deviceId);
  if (!session) throw fail_('AUTH', 'Сесію завершено. Увійдіть за PIN.');
  return session;
}

function loginFail_(code, message) {
  return { success: false, code: code, error: message };
}

// --- Читання довідника співробітників ---
function readEmployees_() {
  const ss = SpreadsheetApp.openById(EMPLOYEES_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(EMPLOYEES_SHEET_NAME);
  if (!sheet) throw fail_('NO_DIRECTORY', 'Аркуш «' + EMPLOYEES_SHEET_NAME + '» не знайдено');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const positionRoles = readPositionRoles_(ss);
  // getDisplayValues, а не getValues: інакше PIN «0501» стане числом 501
  return sheet.getRange(2, 1, lastRow - 1, EMP_WIDTH).getDisplayValues()
    .filter(function (row) { return String(row[EMP.id]).trim() !== ''; })
    .map(function (row) {
      const roles = resolveRoles_(row, positionRoles);
      const permissions = permissionsFor_(roles);
      return {
        id: String(row[EMP.id]).trim(),
        name: String(row[EMP.fullName]).trim(),
        shortName: String(row[EMP.shortName] || row[EMP.fullName]).trim(),
        status: String(row[EMP.status]).trim().toLowerCase(),
        email: String(row[EMP.email]).trim(),
        pin: String(row[EMP.pin]).trim(),
        roles: roles,
        permissions: permissions,
        eligible: String(row[EMP.status]).trim().toLowerCase() === 'active' && permissions.length > 0
      };
    });
}

function findEmployee_(id) {
  const wanted = String(id).trim();
  const found = readEmployees_().filter(function (employee) { return employee.id === wanted; });
  return found.length ? found[0] : null;
}

function readPositionRoles_(ss) {
  const sheet = ss.getSheetByName(POSITIONS_SHEET_NAME);
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getDisplayValues().forEach(function (row) {
    const id = String(row[POS.id]).trim();
    if (id) map[id] = splitRoles_(row[POS.roles]);
  });
  return map;
}

/** «ролі відібрані» (S) мають пріоритет; інакше — ролі посади плюс «ролі додатково» (R). */
function resolveRoles_(row, positionRoles) {
  const explicit = splitRoles_(row[EMP.finalRoles]);
  if (explicit.length) return explicit;
  return splitRoles_(positionRoles[String(row[EMP.posId]).trim()])
    .concat(splitRoles_(row[EMP.extraRoles]));
}

/** У довіднику ролі розділені то пробілом, то комою — приймаємо обидва варіанти. */
function splitRoles_(value) {
  if (Array.isArray(value)) return value.slice();
  return String(value || '').split(/[\s,;]+/).filter(function (role) { return role !== ''; });
}

function permissionsFor_(roles) {
  const allowed = {};
  roles.forEach(function (role) {
    (ROLE_PERMISSIONS[role] || []).forEach(function (permission) { allowed[permission] = true; });
  });
  return Object.keys(allowed);
}

/**
 * Хто зможе увійти і де PIN дублюються. Запускати з редактора ПЕРЕД запуском.
 * Самі PIN не друкуються — лише факт збігу.
 */
function auditPins() {
  const all = readEmployees_();
  const byPin = {};
  all.forEach(function (e) {
    if (!e.pin) return;
    (byPin[e.pin] = byPin[e.pin] || []).push(e);
  });

  const lines = [];
  all.filter(function (e) { return e.permissions.length > 0; }).forEach(function (e) {
    const sameEligible = (byPin[e.pin] || []).filter(function (x) { return x.eligible; });
    const sameAnyone = (byPin[e.pin] || []).length;
    let state;
    if (!e.eligible) state = '·  не активний — не увійде';
    else if (!e.pin) state = '❌ PIN не заповнено — не увійде';
    else if (sameEligible.length > 1) {
      state = '❌ PIN спільний ще з ' + (sameEligible.length - 1) +
              ' у цьому застосунку — не увійде (неможливо визначити, хто саме)';
    } else if (sameAnyone > 1) {
      // Увійде, бо решта власників цього PIN не мають ролі тут. Але PIN
      // не особистий: будь-хто з них може ввійти під цим ім'ям.
      state = '⚠️  увійде, але PIN не особистий — той самий ще в ' + (sameAnyone - 1) +
              ' співробітників довідника';
    } else state = '✅ увійде';
    lines.push('  ' + state + ' · ' + e.name + ' [' + e.roles.join(', ') + ']');
  });

  const report = 'Доступ до застосунку миючих засобів:\n' + lines.sort().join('\n') +
    '\n\nПозначка ⚠️ означає, що операції можна записати на цю людину, знаючи ' +
    'стартовий PIN. Призначте власний PIN у колонці Q аркуша «_REF_Employees».';
  console.log(report);
  return report;
}

/** Кому піде звіт: колонка O довідника в тих, чия роль дозволяє forceReport. */
function reportRecipients_() {
  try {
    return readEmployees_().filter(function (e) {
      return e.eligible && e.email && e.email.indexOf('@') !== -1 &&
             e.permissions.indexOf('forceReport') !== -1;
    });
  } catch (error) {
    logEvent_('error', 'directory.unreachable', { details: (error && error.message) || String(error) });
    return [];
  }
}

function auditRecipients() {
  const list = reportRecipients_();
  const report = list.length
    ? 'Звіт отримають ' + list.length + ' осіб (колонка O «_REF_Employees»):\n' +
      list.map(function (e) { return '  ' + e.name + ' — ' + e.email; }).join('\n')
    : 'У довіднику немає жодної адреси з правом на звіт. Використається аркуш «Користувачі».';
  console.log(report);
  return report;
}

// ==========================================
// КОНСТАНТИ
// ==========================================
const LOG_SHEET_NAME = 'Лог_використання';
const USERS_SHEET_NAME = 'Користувачі';
const EVENT_SHEET_NAME = 'Журнал_подій';

// Службові аркуші не є каталогом засобів: інакше журнал подій потрапив би
// і в список у застосунку, і в план закупки.
const SERVICE_SHEETS = [LOG_SHEET_NAME, USERS_SHEET_NAME, EVENT_SHEET_NAME,
                        'Контакти', 'Довідник', 'Зведення', 'Історія'];

const FIRST_DATA_ROW = 4;
const LOG_WIDTH = 11;    // A..K
const CAT_WIDTH = 15;    // A..N + O «Місце зберігання»
const STORAGE_COL = 15;  // O
const STORAGE_HEADER = 'Місце зберігання';
const HISTORY_LIMIT = 300;

// Миючі рахують у кілограмах: 0,03 кг — нормальна операція, а не описка.
// (У «Обліку ЗІП» цей самий перемикач стоїть false, бо запчастини рахують штуками.)
const ALLOW_FRACTIONAL_QUANTITY = true;

// Порожня комірка залишку означає «не інвентаризовано», а не «нуль на складі».
const SKIP_UNCOUNTED_POSITIONS = true;

// Залишок перераховується з журналу, а не інкрементується. Вимикати лише
// свідомо: без цього одночасні записи двох контролерів затирають один одного.
// Перед першим увімкненням запустіть auditStockDrift() — див. README, крок 5.
const RECOMPUTE_STOCK_FROM_LOG = true;

// Розбіжність між журналом і коміркою, більша за цю, потрапляє в «Журнал_подій».
const DRIFT_TOLERANCE = 0.001;

const OPERATIONS = {
  registerUsage:     { label: 'Видача',         prefix: '-', genitive: 'видачі',         direction: -1 },
  registerRestock:   { label: 'Поповнення',     prefix: '+', genitive: 'поповнення',     direction: 1 },
  registerInventory: { label: 'Інвентаризація', prefix: '=', genitive: 'інвентаризації', direction: 0 }
};

const CANCELLED_SUFFIX = ' (скасовано)';
const CANCEL_PREFIX = 'Скасування ';

// Використовується, доки в аркуші «Користувачі» немає жодної адреси.
const FALLBACK_EMAILS = 'Buznitskiy7@gmail.com, dyndarnastia@gmail.com';

// ==========================================
// 0. МЕНЮ В GOOGLE ТАБЛИЦІ
// ==========================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚙️ Меню засобів')
    .addItem('🧹 Очистити дані операцій (F–K)', 'clearUsageData')
    .addItem('📧 Відправити план закупки зараз', 'manualSendReport')
    .addSeparator()
    .addItem('📍 Створити колонку «Місце зберігання»', 'setupStorageColumn')
    .addItem('🔍 Звірити залишки з журналом', 'auditStockDrift')
    .addItem('🩺 Події за тиждень', 'auditEventsWeek')
    .addItem('🔑 Хто зможе увійти за PIN', 'auditPinsMenu')
    .addItem('📬 Кому піде звіт', 'auditRecipientsMenu')
    .addToUi();
}

function clearUsageData() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert('Увага!',
    'Очистити зелені стовпці (F–K) на ВСІХ аркушах засобів?\n' +
    '(Повна історія у вкладці «' + LOG_SHEET_NAME + '» залишиться цілою)',
    ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  forEachCatalogSheet(function (sheet) {
    const lastRow = Math.max(sheet.getLastRow(), FIRST_DATA_ROW);
    if (lastRow >= FIRST_DATA_ROW) {
      sheet.getRange(FIRST_DATA_ROW, 6, lastRow - FIRST_DATA_ROW + 1, 6).clearContent();
    }
  });
  logEvent_('tech', 'sheet.cleared', { details: 'очищено F–K на всіх аркушах засобів' });
  ui.alert('Готово', 'Дані про використання очищено.', ui.ButtonSet.OK);
}

function manualSendReport() {
  const sent = sendPurchasePlan(true);
  SpreadsheetApp.getUi().alert(sent ? 'Звіт надіслано' : 'Немає адрес для розсилки');
}

function auditEventsWeek() {
  SpreadsheetApp.getUi().alert(auditEvents(7));
}

function auditPinsMenu() {
  SpreadsheetApp.getUi().alert(auditPins());
}

function auditRecipientsMenu() {
  SpreadsheetApp.getUi().alert(auditRecipients());
}

// ==========================================
// 1. GET — читання
// ==========================================
function doGet(e) {
  try {
    const action = e && e.parameter ? e.parameter.action : '';
    const request = e && e.parameter
      ? { token: e.parameter.token, deviceId: e.parameter.device }
      : { token: '', deviceId: '' };

    // Діагностика розгортання: відкрити <URL>?action=ping у браузері.
    // Якщо version не збігається з CODE_VERSION у редакторі — розгорнуто старий
    // знімок коду, і жодна правка ще не діє.
    if (action === 'ping') {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      let writable = 'ні';
      try {
        // Найдешевша перевірка права на запис: службова властивість аркуша.
        setupEventSheet();
        writable = 'так';
      } catch (error) {
        writable = 'ні — ' + (error && error.message ? error.message : String(error));
      }
      // Довідник співробітників лежить в іншому файлі — на нього потрібен
      // окремий дозвіл Google. Якщо його немає, вхід за PIN не працюватиме.
      let directory = 'недоступний';
      try {
        directory = SpreadsheetApp.openById(EMPLOYEES_SPREADSHEET_ID)
          .getSheetByName(EMPLOYEES_SHEET_NAME) ? 'ok' : 'аркуш не знайдено';
      } catch (error) { directory = 'немає доступу'; }

      return json({
        success: true,
        version: CODE_VERSION,
        spreadsheet: ss ? ss.getName() : '(немає)',
        canWrite: writable,
        auth: typeof loginWithPin_ === 'function',
        employeesSheet: directory,
        timeZone: Session.getScriptTimeZone()
      });
    }

    if (action === 'getInventory') {
      const session = requireSession_(request);   // застосунок закритий без входу за PIN
      const people = readPeople();
      const categories = [];

      forEachCatalogSheet(function (sheet) {
        const values = readCatalog(sheet);
        const items = [];
        values.forEach(function (row, i) {
          if (!row[1] || String(row[1]).trim() === '') return;
          items.push({
            sheetName: sheet.getName(),
            row: i + FIRST_DATA_ROW,
            no: row[0] === '' || row[0] === null ? '-' : row[0],
            model: String(row[1]),
            equipment: String(row[2] || ''),
            minStock: toNumber(row[3]),
            currentStock: toNumber(row[4]),
            hasStock: String(row[4]).trim() !== '',   // порожньо ≠ нуль
            // Блок F..K потрібен застосунку для підказки FEFO (найстаріша партія)
            ops: String(row[5] || ''),
            qts: String(row[7] || ''),
            bats: String(row[8] || ''),
            supplierName: String(row[12] || ''),
            supplierPhone: String(row[13] || ''),
            storage: String(row[14] || '').trim()
          });
        });
        if (items.length) categories.push({ name: sheet.getName(), items: items });
      });

      return json({
        success: true,
        version: CODE_VERSION,
        categories: categories,
        controllers: people.controllers,
        employees: people.employees,
        // Права перечитуються щозавантаження: зміна ролі в довіднику діє одразу
        session: { name: session.name, shortName: session.shortName,
                   permissions: session.permissions, expiresAt: session.expiresAt }
      });
    }

    if (action === 'getHistory') {
      requireSession_(request);
      const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
      if (!logSheet || logSheet.getLastRow() < 2) return json({ success: true, history: [] });

      const data = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, LOG_WIDTH).getValues();
      // За конкретний день віддаємо все: інакше при активній зміні власні записи
      // контролера випадають за межу останніх HISTORY_LIMIT.
      const wantedDate = String((e.parameter && e.parameter.date) || '').trim();
      const limit = wantedDate ? Number.MAX_SAFE_INTEGER : HISTORY_LIMIT;
      const history = [];

      for (let i = data.length - 1; i >= 0 && history.length < limit; i--) {
        if (wantedDate && localDateKey_(data[i][1]) !== wantedDate) continue;
        const actionType = String(data[i][5]).trim();
        history.push({
          id: normalizeTimestamp_(data[i][0]),
          cancelled: actionType.indexOf(CANCELLED_SUFFIX) !== -1,
          isCancellation: actionType.indexOf(CANCEL_PREFIX) === 0,
          time: formatTime(data[i][0]),
          // Дата віддається як «РРРР-ММ-ДД» у поясі таблиці. Раніше сюди летів
          // об'єкт Date, JSON перетворював його на UTC, і «21.08» ставало
          // «2026-08-20T21:00:00Z» — фільтр «Мої за сьогодні» не знаходив нічого.
          date: localDateKey_(data[i][1]),
          sheetName: data[i][2],
          model: data[i][4],
          actionType: data[i][5],
          controller: data[i][6],
          location: data[i][7],
          batchInfo: data[i][8],
          quantity: data[i][9],
          usedBy: data[i][10]
        });
      }
      return json({ success: true, history: history });
    }

    if (action === 'forceReport') {
      // Роль замінила пароль: право на звіт визначає довідник, а не рядок у HTML
      requirePermission_(request, 'forceReport');
      const sent = sendPurchasePlan(true);
      if (!sent) {
        return json({ success: false, code: 'NO_RECIPIENTS',
          error: 'Немає адрес для розсилки: заповніть колонку C аркуша «' + USERS_SHEET_NAME + '».' });
      }
      return json({ success: true, message: 'План надіслано' });
    }

    return json({ success: false, code: 'UNKNOWN_ACTION', error: 'Невідома дія: ' + action });

  } catch (error) {
    logEvent_('error', 'doGet.failed', {
      details: (error && error.stack) || String(error),
      position: e && e.parameter ? String(e.parameter.action || '') : ''
    });
    return json({ success: false, code: (error && error.code) || 'ERROR',
                  error: (error && error.message) || String(error) });
  }
}

// ==========================================
// 2. POST — операції
// ==========================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error('Порожній запит: немає e.postData. Найчастіше — запит надіслано ' +
                      'без тіла або застосунок звертається не на ту адресу /exec.');
    }
    const payload = JSON.parse(e.postData.contents);

    // Вхід за PIN — єдина дія, доступна без сесії
    if (payload.action === 'login') {
      return json(loginWithPin_(payload.pin, payload.deviceId));
    }
    // Діагностика: приймаємо навіть без сесії — саме тоді, коли ламається вхід
    if (payload.action === 'logEvents') return json(logClientEvents_(payload));
    if (payload.action === 'setStorage') return json(setStorage_(payload));

    return json(registerOperation_(payload));

  } catch (error) {
    // Раніше цей catch мовчки віддавав success:false, застосунок його не читав
    // (mode:'no-cors'), а Apps Script показував «Виконання завершено».
    // Тепер причина завжди лишається в Cloud Logging і в «Журналі_подій».
    const details = (error && error.stack) || String(error);
    logEvent_('error', 'doPost.failed', {
      details: details + ' | payload: ' +
        trimText_(e && e.postData ? e.postData.contents : '(немає)', 300)
    });
    return json({ success: false, code: (error && error.code) || 'ERROR',
                  error: (error && error.message) || String(error) });
  }
}

/**
 * Видача / поповнення / інвентаризація.
 * Запис у журнал — джерело правди; залишок перераховується з журналу.
 */
function registerOperation_(payload) {
  const operation = OPERATIONS[payload.action];
  if (!operation) throw fail_('UNKNOWN_ACTION', 'Невідома операція: ' + payload.action);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(payload.sheetName);
  if (!sheet) throw fail_('BAD_TARGET', 'Аркуш не знайдено: ' + payload.sheetName);

  const quantity = toNumber(payload.quantity);
  const zeroAllowed = payload.action === 'registerInventory';
  if (!isFinite(quantity) || quantity < 0 || (quantity === 0 && !zeroAllowed)) {
    throw fail_('BAD_QUANTITY', 'Некоректна кількість: ' + payload.quantity);
  }
  if (!ALLOW_FRACTIONAL_QUANTITY && Math.floor(quantity) !== quantity) {
    throw fail_('BAD_QUANTITY', 'Кількість має бути цілим числом.');
  }

  const actor = resolveActor_(payload, payload.action);

  // Уся операція — під одним замком. Без нього двоє контролерів, що списують
  // ту саму позицію в ту саму хвилину, читають однаковий залишок і другий
  // затирає перший.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw fail_('BUSY', 'Сервер зайнятий іншим записом. Спробуйте ще раз за кілька секунд.');
  }
  try {
    // Номер рядка з клієнта міг застаріти — звіряємо позицію перед записом
    const position = resolvePosition_(sheet, payload);
    const log = readLog_();

    // Той самий запис міг прийти вдруге з офлайн-черги — повторно не застосовуємо
    const duplicate = findLogEntry_(log, payload.timestamp, {
      sheetName: payload.sheetName, model: payload.model, no: position.itemNo, actor: actor
    });
    if (duplicate) {
      return { success: true, duplicate: true, actor: actor,
               newStock: readStock_(sheet, position.row).value };
    }

    const stock = readStock_(sheet, position.row);
    let location = String(payload.location || '').trim() || '-';

    if (payload.action === 'registerUsage' && !stock.counted) {
      throw fail_('NOT_COUNTED',
        'Залишок цієї позиції не інвентаризовано. Спершу проведіть інвентаризацію — ' +
        'тоді видача матиме від чого відніматися.');
    }

    let discrepancy = null;
    if (payload.action === 'registerInventory') {
      const accounted = stock.counted
        ? computeStockFromLog_(log, payload.sheetName, payload.model, position.itemNo, stock.value)
        : null;
      discrepancy = {
        accounted: accounted,
        fact: quantity,
        delta: accounted === null ? null : round_(quantity - accounted)
      };
      const note = accounted === null
        ? 'Інвентаризація: облік — (не рахували), факт ' + quantity
        : 'Інвентаризація: облік ' + accounted + ', факт ' + quantity +
          ' (' + (discrepancy.delta > 0 ? '+' : '') + discrepancy.delta + ')';
      location = location === '-' ? note : location + ' · ' + note;
    }

    if (payload.action === 'registerUsage') {
      const available = computeStockFromLog_(log, payload.sheetName, payload.model,
                                             position.itemNo, stock.value);
      if (quantity > available) {
        const reason = String(payload.overdrawReason || '').trim();
        if (reason.length < 3) {
          return {
            success: false, code: 'OVERDRAW', available: available,
            error: available > 0
              ? 'На складі лише ' + available + ' кг, а ви списуєте ' + quantity + '.'
              : 'На складі 0 кг: зареєструйте поповнення або проведіть інвентаризацію.'
          };
        }
        location += ' (перевитрата: ' + reason + ')';
      }
    }

    const batchStr = buildBatchLabel_(payload);
    const usedBy = payload.action === 'registerUsage'
      ? (String(payload.usedBy || '').trim() || '-')
      : '-';

    const entry = [localStamp_(payload.timestamp), localDateKey_(payload.date), payload.sheetName,
      position.itemNo, payload.model, operation.label, actor, location, batchStr, quantity, usedBy];

    // Порядок має значення. Раніше рядок журналу писався ПЕРШИМ, і якщо далі
    // падав запис в аркуш-каталог, лишалась половина операції: у журналі є,
    // в аркуші немає. Повтор із черги знаходив рядок журналу, вважав операцію
    // дублем і повертався з «успіхом», так і не дописавши аркуш. Тому спершу —
    // в пам'ять і в аркуш, і лише наприкінці — в журнал.
    const pending = { row: 0, values: entry };
    log.rows.push(pending);

    const newVal = applyStock_(sheet, position.row, log, payload.sheetName, payload.model,
                               position.itemNo, stock, operation, quantity);

    appendOperation(sheet, position.row, [
      operation.label, formatDate(payload.date), operation.prefix + quantity,
      batchStr, location, usedBy
    ]);

    log.sheet.appendRow(entry);
    pending.row = log.sheet.getLastRow();

    // Сповіщення лише про перетин порогу — не лист після кожного списання.
    // Раніше sendPurchasePlan викликався на КОЖНІЙ видачі нижче мінімуму:
    // три адресати помножені на десяток операцій щодня.
    if (payload.action === 'registerUsage' || payload.action === 'registerInventory') {
      const info = readItemRow_(sheet, position.row);
      tryNotifyThreshold_({
        sheetName: payload.sheetName, model: payload.model,
        equipment: String(info[2] || '').trim() || '—',
        minStock: toNumber(info[3]), stock: newVal,
        supplier: String(info[12] || '').trim() || '—',
        phone: String(info[13] || '').trim() || '—',
        storage: String(info[14] || '').trim() || '—'
      });
    }

    return {
      success: true, newStock: newVal, actor: actor, discrepancy: discrepancy,
      row: position.row, moved: position.moved,
      warning: newVal < 0 ? 'Залишок від\'ємний — проведіть інвентаризацію цієї позиції.' : ''
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Хто зробив операцію. Ім'я береться з підтвердженої сесії, а не з того, що
 * надіслав клієнт: раніше будь-хто міг обрати будь-яке прізвище у списку,
 * і операція записувалась на чужу людину.
 */
function resolveActor_(payload, action) {
  const session = requirePermission_(payload, action || payload.action);
  return session.name;
}

/** «Партія: 26061121 (до 2026-12-30)» — рядок для журналу і для колонки I. */
function buildBatchLabel_(payload) {
  const batch = String(payload.batch || '').trim();
  const expDate = String(payload.expDate || '').trim();
  let text = '';
  if (batch) text += 'Партія: ' + batch + ' ';
  if (expDate) text += '(до ' + expDate + ')';
  text = text.trim();
  return text || '-';
}

// ==========================================
// 2.1 АДРЕСНЕ ЗБЕРІГАННЯ (колонка O)
// ==========================================
function setStorage_(payload) {
  const actor = resolveActor_(payload, 'setStorage');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(payload.sheetName);
  if (!sheet) throw fail_('BAD_TARGET', 'Аркуш не знайдено: ' + payload.sheetName);

  const storage = String(payload.storage || '').trim();
  if (storage.length > 60) throw fail_('BAD_TARGET', 'Задовга адреса зберігання (максимум 60 символів).');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw fail_('BUSY', 'Сервер зайнятий іншим записом. Спробуйте ще раз.');
  try {
    // Той самий захист, що й у записі операцій: номер рядка з клієнта міг
    // застаріти, і адреса лягла б на сусідній засіб.
    const position = resolvePosition_(sheet, payload);
    ensureStorageColumn_(sheet);
    const cell = sheet.getRange(position.row, STORAGE_COL);
    const previous = String(cell.getDisplayValue()).trim();
    if (previous === storage) return { success: true, storage: storage, unchanged: true };

    cell.setValue(storage);

    const now = new Date();
    setupLogSheet().appendRow([
      localStamp_(now), localDateKey_(now), payload.sheetName, position.itemNo, payload.model,
      'Зміна місця', actor,
      'Місце: ' + (previous || '—') + ' → ' + (storage || '—'), '-', 0, '-'
    ]);

    return { success: true, storage: storage, previous: previous, actor: actor,
             row: position.row, moved: position.moved };
  } finally {
    lock.releaseLock();
  }
}

/** Створює колонку O із заголовком, якщо її ще немає. Ідемпотентна. */
function ensureStorageColumn_(sheet) {
  if (sheet.getMaxColumns() < STORAGE_COL) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), STORAGE_COL - sheet.getMaxColumns());
  }
  if (String(sheet.getRange(3, STORAGE_COL).getDisplayValue()).trim() === STORAGE_HEADER) return;

  sheet.getRange(2, STORAGE_COL).setValue(STORAGE_HEADER);
  sheet.getRange(3, STORAGE_COL).setValue(STORAGE_HEADER);
  sheet.getRange(2, STORAGE_COL, 2, 1).merge()
    .setFontWeight('bold').setHorizontalAlignment('center')
    .setVerticalAlignment('middle').setWrap(true);
  sheet.setColumnWidth(STORAGE_COL, 150);
}

/** Одноразово додає колонку «Місце зберігання» на всі аркуші засобів. */
function setupStorageColumn() {
  const touched = [];
  forEachCatalogSheet(function (sheet) {
    ensureStorageColumn_(sheet);
    touched.push(sheet.getName());
  });
  const report = 'Колонку «' + STORAGE_HEADER + '» перевірено на аркушах: ' + touched.join(', ');
  console.log(report);
  return report;
}

// ==========================================
// 2.2 ЖУРНАЛ ЯК ДЖЕРЕЛО ПРАВДИ
// ==========================================
function readLog_() {
  const sheet = setupLogSheet();
  const lastRow = sheet.getLastRow();
  const rows = lastRow < 2 ? []
    : sheet.getRange(2, 1, lastRow - 1, LOG_WIDTH).getValues()
        .map(function (values, i) { return { row: i + 2, values: values }; });
  return { sheet: sheet, rows: rows };
}

/**
 * Шукає операцію в журналі. Самого часу мало: два пристрої теоретично можуть
 * створити операції з однаковою мілісекундою, і тоді друга була б помилково
 * визнана дублем. Тому за наявності match звіряємо ще позицію й автора.
 */
function findLogEntry_(log, timestamp, match) {
  const wanted = normalizeTimestamp_(timestamp);
  if (!wanted) return null;

  for (let i = log.rows.length - 1; i >= 0; i--) {
    const values = log.rows[i].values;
    if (normalizeTimestamp_(values[0]) !== wanted) continue;
    if (match) {
      if (match.sheetName && String(values[2]).trim() !== String(match.sheetName).trim()) continue;
      if (match.model && String(values[4]).trim() !== String(match.model).trim()) continue;
      if (match.no && String(values[3]).trim() && String(values[3]).trim() !== String(match.no).trim()) continue;
      if (match.actor && String(values[6]).trim() !== String(match.actor).trim()) continue;
    }
    return log.rows[i];
  }
  return null;
}

/**
 * Залишок із журналу: беремо останню інвентаризацію позиції і застосовуємо
 * все, що після неї. Скасовані операції та рядки «Зміна місця» пропускаються.
 * Якщо інвентаризації ще не було, спиратися нема на що — повертаємо fallback.
 *
 * Звіряння двоступеневе. Спершу строго за парою «№ + назва»: це єдиний спосіб
 * не сплутати дві позиції з однаковою назвою. Але № в таблиці змінюється, коли
 * вставляють рядок — Blanidas-C CH-Foam переїхав з №7 на №8, Бланідас-ЦФ з №9
 * на №10, а Blanidas-C CIP Mil записаний у журналі і як №8, і як №9. Строге
 * звіряння відкинуло б усю їхню історію, і залишок перестав би рахуватися з
 * журналу. Тому за відсутності строгого збігу пробуємо звірити за самою назвою.
 * Це безпечно: перед будь-яким записом resolvePosition_ вже переконався, що на
 * аркуші рівно один рядок із такою назвою (інакше — помилка AMBIGUOUS).
 */
function computeStockFromLog_(log, sheetName, model, itemNo, fallback) {
  const strict = accumulateStock_(log, sheetName, model, itemNo);
  if (strict.baseline !== null) return round_(strict.value);

  const loose = accumulateStock_(log, sheetName, model, '');
  if (loose.baseline !== null) return round_(loose.value);

  return fallback;
}

/** Прогін журналу по одній позиції. itemNo === '' — звіряти лише за назвою. */
function accumulateStock_(log, sheetName, model, itemNo) {
  const wantedSheet = String(sheetName).trim();
  const wantedModel = String(model).trim();
  const wantedNo = String(itemNo === null || itemNo === undefined ? '' : itemNo).trim();
  let baseline = null;
  let value = 0;

  log.rows.forEach(function (entry) {
    if (String(entry.values[2]).trim() !== wantedSheet) return;
    if (String(entry.values[4]).trim() !== wantedModel) return;
    // Старі рядки журналу могли лишитись без номера — такі зараховуємо назві,
    // щоб перерахунок не з'їхав на історичних даних
    const entryNo = String(entry.values[3] === null || entry.values[3] === undefined
                            ? '' : entry.values[3]).trim();
    if (wantedNo && entryNo && entryNo !== wantedNo) return;

    const label = String(entry.values[5]).trim();
    if (label.indexOf(CANCEL_PREFIX) === 0) return;
    if (label.indexOf(CANCELLED_SUFFIX) !== -1) return;

    const quantity = toNumber(entry.values[9]);
    if (label === OPERATIONS.registerInventory.label) { baseline = quantity; value = quantity; return; }
    if (baseline === null) return;
    if (label === OPERATIONS.registerUsage.label) value -= quantity;
    else if (label === OPERATIONS.registerRestock.label) value += quantity;
  });

  return { baseline: baseline, value: value };
}

/** Записує перерахований залишок у колонку E. */
function applyStock_(sheet, row, log, sheetName, model, itemNo, stock, operation, quantity) {
  const incremental = operation.direction === 0
    ? quantity
    : round_(stock.value + operation.direction * quantity);

  if (!RECOMPUTE_STOCK_FROM_LOG) {
    sheet.getRange(row, 5).setValue(incremental);
    return incremental;
  }

  const fromLog = computeStockFromLog_(log, sheetName, model, itemNo, null);
  const newVal = fromLog !== null ? fromLog : incremental;

  // Розбіжність між журналом і тим, що дав би простий інкремент, означає, що
  // комірку правили руками або частина операцій не дійшла. Мовчки затирати таке
  // не можна — лишаємо слід, за яким видно, що саме розійшлось.
  if (fromLog !== null && Math.abs(fromLog - incremental) > DRIFT_TOLERANCE) {
    logEvent_('tech', 'stock.drift', {
      position: sheetName + ' · ' + model,
      details: 'журнал ' + fromLog + ', комірка+операція ' + incremental +
               ' (різниця ' + round_(fromLog - incremental) + ')'
    });
  }

  sheet.getRange(row, 5).setValue(newVal);
  return newVal;
}

/** Порожня комірка означає «не інвентаризовано», а не нуль. */
function readStock_(sheet, row) {
  const raw = sheet.getRange(row, 5).getDisplayValue();
  return { counted: String(raw).trim() !== '', value: toNumber(raw) };
}

/**
 * Читає розбіжності між журналом і колонкою E по всіх позиціях.
 * Запускати з редактора ПЕРЕД першим розгортанням цієї версії: показує, де
 * перерахунок із журналу змінить залишок. Нічого не змінює.
 */
function auditStockDrift() {
  const log = readLog_();
  const lines = [];
  forEachCatalogSheet(function (sheet) {
    const values = readCatalog(sheet);
    values.forEach(function (row, i) {
      const model = String(row[1] || '').trim();
      if (!model) return;
      const itemNo = String(row[0] === null || row[0] === undefined ? '' : row[0]).trim();
      const cell = toNumber(row[4]);
      const fromLog = computeStockFromLog_(log, sheet.getName(), model, itemNo, null);
      if (fromLog === null) {
        lines.push('— ' + sheet.getName() + ' · ' + model + ': інвентаризації в журналі немає, ' +
                   'залишок лишиться як у таблиці (' + cell + ')');
        return;
      }
      // Окремо показуємо позиції, чий № у таблиці розійшовся з журналом:
      // залишок рахується, але звіряння йде за назвою, а не за парою «№ + назва»
      if (accumulateStock_(log, sheet.getName(), model, itemNo).baseline === null) {
        const journalNos = {};
        log.rows.forEach(function (entry) {
          if (String(entry.values[2]).trim() !== sheet.getName()) return;
          if (String(entry.values[4]).trim() !== model) return;
          const no = String(entry.values[3] === null || entry.values[3] === undefined
                             ? '' : entry.values[3]).trim();
          if (no) journalNos[no] = true;
        });
        lines.push('~ ' + sheet.getName() + ' · ' + model + ': у таблиці №' + itemNo +
                   ', у журналі №' + Object.keys(journalNos).join(', ') +
                   ' — звіряння за назвою');
      }
      if (Math.abs(fromLog - cell) > DRIFT_TOLERANCE) {
        lines.push('! ' + sheet.getName() + ' · №' + itemNo + ' ' + model +
                   ': таблиця ' + cell + ' → журнал ' + fromLog +
                   ' (різниця ' + round_(fromLog - cell) + ')');
      }
    });
  });

  const report = lines.length
    ? 'Розбіжності таблиця / журнал:\n' + lines.join('\n') +
      '\n\nЩо робити: для позицій із «!» проведіть інвентаризацію в застосунку — ' +
      'вона задасть нову точку відліку, і журнал зійдеться з таблицею.'
    : 'Розбіжностей немає: журнал і колонка «Поточний залишок» збігаються.';
  console.log(report);
  return report;
}

// ==========================================
// 2.3 ЯК УПІЗНАЄТЬСЯ ПОЗИЦІЯ
// ==========================================
/**
 * Усі рядки аркуша з такою назвою. Назва не завжди унікальна, тому позицію
 * визначає пара «№ + назва», а не сама лише назва.
 */
function findPositionRows_(sheet, model, itemNo) {
  const lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return [];

  const values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 2).getDisplayValues();
  const wantedModel = String(model).trim();
  const wantedNo = String(itemNo === null || itemNo === undefined ? '' : itemNo).trim();
  const exact = [];
  const byModel = [];

  values.forEach(function (row, i) {
    if (String(row[1]).trim() !== wantedModel) return;
    const found = { row: i + FIRST_DATA_ROW, itemNo: String(row[0]).trim() };
    byModel.push(found);
    if (wantedNo && found.itemNo === wantedNo) exact.push(found);
  });

  return exact.length ? exact : byModel;
}

/**
 * Номер рядка приходить із клієнта і міг застаріти: рядок вставили, аркуш
 * пересортували, запис пролежав ніч в офлайн-черзі. Писати за таким номером
 * наосліп означає списати сусідній засіб, тому спершу звіряємо, що в рядку
 * стоїть та сама позиція, і лише потім шукаємо її заново.
 */
function resolvePosition_(sheet, payload) {
  const wantedModel = String(payload.model || '').trim();
  if (!wantedModel) throw fail_('BAD_TARGET', 'Не вказано позицію.');
  const wantedNo = String(payload.no === null || payload.no === undefined ? '' : payload.no).trim();

  const row = Number(payload.row);
  if (isFinite(row) && row >= FIRST_DATA_ROW && row <= sheet.getLastRow()) {
    const values = sheet.getRange(row, 1, 1, 2).getDisplayValues()[0];
    const sameModel = String(values[1]).trim() === wantedModel;
    const sameNo = !wantedNo || String(values[0]).trim() === wantedNo;
    if (sameModel && sameNo) {
      return { row: row, itemNo: String(values[0]).trim(), moved: false };
    }
  }

  const matches = findPositionRows_(sheet, wantedModel, wantedNo);
  if (matches.length === 0) {
    throw fail_('BAD_TARGET', 'Позицію «' + wantedModel + '» не знайдено на аркуші «' +
      sheet.getName() + '». Можливо, її видалили або перейменували — оновіть базу в застосунку.');
  }
  if (matches.length > 1) {
    throw fail_('AMBIGUOUS', 'На аркуші «' + sheet.getName() + '» кілька рядків із назвою «' +
      wantedModel + '» (№ ' + matches.map(function (m) { return m.itemNo || '?'; }).join(', ') +
      '). Оновіть базу в застосунку й виберіть позицію заново.');
  }

  // Не помилка, а відновлення: рядок знайшли й запис пішов куди треба
  logEvent_('tech', 'position.moved', {
    details: 'рядок ' + payload.row + ' → ' + matches[0].row,
    position: sheet.getName() + ' · ' + wantedModel
  });
  return { row: matches[0].row, itemNo: matches[0].itemNo, moved: true };
}

/** Дописує операцію в колонки F..K через кому з переносом рядка. */
function appendOperation(sheet, row, values) {
  if (sheet.getMaxColumns() < 11) {
    throw fail_('BAD_TARGET', 'Аркуш «' + sheet.getName() + '» має лише ' +
      sheet.getMaxColumns() + ' колонок — блок операцій (F..K) нікуди писати.');
  }
  const range = sheet.getRange(row, 6, 1, 6);
  const old = range.getDisplayValues()[0];
  range.setValues([values.map(function (value, i) {
    const previous = String(old[i] || '').trim();
    const next = previous ? previous + ',\n' + value : String(value);
    // Апостроф не дає таблиці перетворити перелік дат, кількостей і партій
    // на власний формат (G, H, I)
    return (i === 1 || i === 2 || i === 3) ? "'" + next : next;
  })]);
}

// ==========================================
// 3. ПЛАН ЗАКУПКИ
// ==========================================
function tryNotifyThreshold_(item) {
  try {
    maybeNotifyThreshold_(item);
  } catch (error) {
    // Пошта не має права зробити успішну операцію невдалою: квота MailApp
    // вичерпується мовчки, а списання вже записане.
    logEvent_('error', 'mail.thresholdFailed', {
      details: (error && error.message) || String(error),
      position: item.sheetName + ' · ' + item.model
    });
  }
}

/** Один лист на позицію на день — замість листа після кожного списання. */
function maybeNotifyThreshold_(item) {
  if (!(item.stock <= item.minStock)) return;

  const properties = PropertiesService.getScriptProperties();
  const today = today_();
  let notices = {};
  try { notices = JSON.parse(properties.getProperty('thresholdNotices') || '{}'); } catch (e) { notices = {}; }

  // Лишаємо тільки сьогоднішні позначки — сховище не росте
  Object.keys(notices).forEach(function (key) { if (notices[key] !== today) delete notices[key]; });

  const key = item.sheetName + '_' + item.model;
  if (notices[key] === today) return;

  const emails = getNotificationEmails();
  if (!emails) return;

  MailApp.sendEmail({
    to: emails,
    subject: '⚠️ Засоби: ' + item.model + ' на межі (' + item.stock + ' з ' + item.minStock + ' кг)',
    htmlBody: "<div style='font-family:sans-serif; color:#1e293b;'>" +
      '<h3>' + item.model + ' — залишок на рівні мінімуму або нижче</h3>' +
      "<table border='1' cellpadding='6' style='border-collapse:collapse; border-color:#cbd5e1;'>" +
      '<tr><td>Категорія</td><td><b>' + item.sheetName + '</b></td></tr>' +
      '<tr><td>Призначення</td><td>' + item.equipment + '</td></tr>' +
      '<tr><td>📍 Місце зберігання</td><td>' + item.storage + '</td></tr>' +
      '<tr><td>Мінімум, кг</td><td>' + item.minStock + '</td></tr>' +
      "<tr><td>Залишок, кг</td><td style='color:#b91c1c;'><b>" + item.stock + '</b></td></tr>' +
      '<tr><td>Постачальник</td><td>' + item.supplier + ' · ' + item.phone + '</td></tr></table>' +
      "<p style='color:#64748b; font-size:12px;'>Повний план закупки — кнопкою «Відправити план» у застосунку.</p></div>"
  });

  // Позначку ставимо лише після справжнього надсилання: при вичерпаній квоті
  // попередження не має губитись на цілий день.
  notices[key] = today;
  properties.setProperty('thresholdNotices', JSON.stringify(notices));
}

/** Повний план закупки. Викликається вручну — кнопкою або з меню. */
function sendPurchasePlan(isManual) {
  const targetEmails = getNotificationEmails();
  if (!targetEmails) return false;

  const usage30 = collectUsage30_();
  const rows = [];

  forEachCatalogSheet(function (sheet) {
    readCatalog(sheet).forEach(function (row) {
      const model = String(row[1] || '').trim();
      if (!model) return;

      const counted = String(row[4]).trim() !== '';
      if (SKIP_UNCOUNTED_POSITIONS && !counted) return;

      const minStock = toNumber(row[3]);
      const currentStock = toNumber(row[4]);
      if (currentStock > minStock) return;

      const key = sheet.getName() + '_' + model;
      const used30 = usage30[key] || 0;
      let recommend = Math.max(minStock - currentStock, used30);
      if (recommend === 0) recommend = 1;

      rows.push({
        sheetName: sheet.getName(), model: model,
        equipment: String(row[2] || '').trim() || '—',
        minStock: minStock, currentStock: currentStock, used30: used30,
        recommend: recommend,
        storage: String(row[14] || '').trim() || '—',
        supplier: String(row[12] || '').trim() || '—',
        phone: String(row[13] || '').trim() || '—'
      });
    });
  });

  if (!rows.length) {
    if (!isManual) return false;
    MailApp.sendEmail({
      to: targetEmails,
      subject: '✅ Миючі засоби: план закупки порожній',
      body: 'Усі засоби в межах норми (вище мінімальних залишків). Закупівля не потрібна.'
    });
    return true;
  }

  let html = "<h2 style='color:#1e293b; font-family:sans-serif;'>" +
    'План закупки миючих та дез. засобів (залишок ≤ мінімуму)</h2>' +
    "<table border='1' cellpadding='8' style='border-collapse:collapse; font-family:sans-serif;" +
    " width:100%; border-color:#cbd5e1;'>" +
    "<tr style='background-color:#f1f5f9; color:#0f172a;'>" +
    '<th>Категорія</th><th>Назва засобу</th><th>Де використовується</th><th>📍 Місце</th>' +
    '<th>Мін. запас, кг</th>' + "<th style='color:#b91c1c;'>Залишок, кг</th>" +
    '<th>Витрата за 30 днів</th><th>Рекомендовано замовити</th>' +
    '<th>Постачальник</th><th>Телефон</th></tr>';

  rows.forEach(function (item) {
    html += '<tr>' +
      td(item.sheetName) + td('<strong>' + item.model + '</strong>') + td(item.equipment) +
      td(item.storage) + td(item.minStock, 'center') +
      td('<b>' + item.currentStock.toFixed(2) + '</b>', 'center', 'color:#b91c1c;') +
      td(item.used30.toFixed(2) + ' кг', 'center') +
      td('<b>' + item.recommend.toFixed(2) + ' кг</b>', 'center', 'color:#0891b2;') +
      td(item.supplier) + td(item.phone) + '</tr>';
  });

  html += '</table>' +
    "<br><p style='font-size:12px; color:#64748b; font-family:sans-serif;'>" +
    'Звіт згенеровано системою «Облік миючих засобів», версія ' + CODE_VERSION + '.</p>';

  MailApp.sendEmail({
    to: targetEmails,
    subject: '🚨 УВАГА! План закупки миючих засобів (потрібне поповнення)',
    htmlBody: html
  });
  return true;
}

/** Витрата кожної позиції за 30 днів — за ДАТОЮ ОПЕРАЦІЇ, не за часом запису. */
function collectUsage30_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const usage = {};
  if (!sheet || sheet.getLastRow() < 2) return usage;

  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, LOG_WIDTH).getValues();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fromKey = Utilities.formatDate(from, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  data.forEach(function (row) {
    const label = String(row[5]).trim();
    if (label !== OPERATIONS.registerUsage.label) return;
    const dayKey = localDateKey_(row[1]) || localDateKey_(row[0]);
    if (!dayKey || dayKey < fromKey) return;
    const key = String(row[2]).trim() + '_' + String(row[4]).trim();
    usage[key] = round_((usage[key] || 0) + toNumber(row[9]));
  });
  return usage;
}

// ==========================================
// 4. ЖУРНАЛ ПОДІЙ
// ==========================================
/**
 * Окремий аркуш, навмисно НЕ «Лог_використання». Причина технічна: readLog_()
 * читає журнал операцій цілком на кожному записі, бо залишок рахується з нього.
 * Якби події лежали там само, кожна видача платила б швидкістю за кожну
 * зафіксовану помилку.
 */
const EVENT_WIDTH = 10;                 // A..J
const EVENT_RETENTION_DAYS = 180;
const EVENT_RATE_PER_MINUTE = 30;
const EVENT_BATCH_LIMIT = 25;
const EVENT_TEXT_LIMIT = 500;
const CLIENT_EVENT_KINDS = ['tech', 'error', 'abandoned'];
const EVENT_KIND_LABELS = { tech: 'Техніка', error: 'Помилка', abandoned: 'Незавершена' };

function setupEventSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(EVENT_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(EVENT_SHEET_NAME);
    sheet.appendRow(['Час запису', 'Дата', 'Час', 'Тип', 'Подія', 'Хто',
                     'Пристрій', 'Позиція', 'Деталі', 'Версія']);
    sheet.getRange(1, 1, 1, EVENT_WIDTH).setFontWeight('bold').setBackground('#fff2cc');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(9, 320);
  }
  return sheet;
}

function trimText_(value, limit) {
  const text = String(value === null || value === undefined ? '' : value).trim();
  const max = limit || EVENT_TEXT_LIMIT;
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Пристрій у журналі — вісім символів: досить, щоб відрізнити, і не досить, щоб підставити. */
function shortDevice_(deviceId) {
  return String(deviceId || '').slice(0, 8);
}

function eventRow_(entry) {
  const when = entry.timestamp ? new Date(entry.timestamp) : new Date();
  const stamp = isNaN(when.getTime()) ? new Date() : when;
  return [
    stamp.toISOString(),
    Utilities.formatDate(stamp, Session.getScriptTimeZone(), 'dd.MM.yyyy'),
    Utilities.formatDate(stamp, Session.getScriptTimeZone(), 'HH:mm:ss'),
    EVENT_KIND_LABELS[entry.kind] || entry.kind,
    trimText_(entry.event, 60),
    trimText_(entry.actor, 120),
    shortDevice_(entry.device),
    trimText_(entry.position, 120),
    trimText_(entry.details),
    trimText_(entry.version || CODE_VERSION, 40)
  ];
}

/**
 * Запис подій. Ніколи не кидає помилку і ніколи не бере замок операцій:
 * діагностика не має права зламати або сповільнити списання.
 */
function logEvents_(entries) {
  if (!entries || !entries.length) return 0;
  try {
    const rows = entries.map(eventRow_);
    const sheet = setupEventSheet();
    const lock = LockService.getDocumentLock();
    if (lock && !lock.tryLock(5000)) {
      entries.forEach(function (entry) { console.log('event(skipped): ' + entry.event); });
      return 0;
    }
    try {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, EVENT_WIDTH).setValues(rows);
    } finally {
      if (lock) lock.releaseLock();
    }
    return rows.length;
  } catch (error) {
    // Журнал подій — не критичний шлях: якщо не записалось, лишаємо слід
    // у Cloud Logging (Apps Script → Виконання).
    console.error('logEvents_ failed: ' + (error && error.message));
    return 0;
  }
}

function logEvent_(kind, event, fields) {
  const entry = Object.assign({ kind: kind, event: event, version: CODE_VERSION }, fields || {});
  if (kind === 'error') console.error(event + ' ' + trimText_(entry.details, 400));
  return logEvents_([entry]);
}

/**
 * Приймання подій від планшета. Обмеження навмисні: не більше EVENT_BATCH_LIMIT
 * за запит і не більше EVENT_RATE_PER_MINUTE на пристрій за хвилину.
 */
function logClientEvents_(payload) {
  const device = String(payload.deviceId || '');
  const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, EVENT_BATCH_LIMIT) : [];
  if (!entries.length) return { success: true, accepted: 0 };

  const cache = CacheService.getScriptCache();
  const key = 'ev_rate_' + (shortDevice_(device) || 'unknown');
  const used = Number(cache.get(key) || 0);
  if (used >= EVENT_RATE_PER_MINUTE) return { success: true, accepted: 0, throttled: true };

  const allowed = entries
    .filter(function (entry) { return CLIENT_EVENT_KINDS.indexOf(entry.kind) !== -1; })
    .slice(0, EVENT_RATE_PER_MINUTE - used)
    .map(function (entry) {
      return {
        kind: entry.kind, event: entry.event, timestamp: entry.timestamp,
        actor: trimText_(entry.actor, 120), device: device,
        position: entry.position, details: entry.details, version: entry.version
      };
    });

  const written = logEvents_(allowed);
  cache.put(key, String(used + allowed.length), 60);
  return { success: true, accepted: written };
}

/** Прибирання старих подій. Викликати раз на місяць або з тригера. */
function pruneEvents_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVENT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return 0;

  const edge = new Date();
  edge.setDate(edge.getDate() - EVENT_RETENTION_DAYS);
  const stamps = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues();

  let cut = 0;
  for (let i = 0; i < stamps.length; i++) {
    const when = new Date(stamps[i][0]);
    if (isNaN(when.getTime()) || when >= edge) break;
    cut++;
  }
  if (cut > 0) sheet.deleteRows(2, cut);
  return cut;
}

/** Зведення подій за N днів. Запускати з редактора. */
function auditEvents(days) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EVENT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return 'Журнал подій порожній.';

  const edge = new Date();
  edge.setDate(edge.getDate() - (days || 7));
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, EVENT_WIDTH).getValues();

  const counts = {};
  const errors = [];
  data.forEach(function (row) {
    const when = new Date(row[0]);
    if (isNaN(when.getTime()) || when < edge) return;
    const label = String(row[3]) + ' · ' + String(row[4]);
    counts[label] = (counts[label] || 0) + 1;
    if (String(row[3]) === EVENT_KIND_LABELS.error) {
      errors.push(row[1] + ' ' + row[2] + ' — ' + row[4] + ': ' + trimText_(row[8], 160));
    }
  });

  const lines = Object.keys(counts).sort().map(function (key) { return '  ' + key + ' × ' + counts[key]; });
  const report = 'Події за ' + (days || 7) + ' днів:\n' + (lines.join('\n') || '  (порожньо)') +
    (errors.length ? '\n\nОстанні помилки:\n' + errors.slice(-15).join('\n') : '\n\nПомилок немає.');
  console.log(report);
  return report;
}

// ==========================================
// 5. ДРІБНІ ПОМІЧНИКИ
// ==========================================
function setupLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Час запису', 'Дата використання', 'Категорія', '№', 'Назва', 'Вид операції',
      'Хто видав', 'Де використано', 'Партія', 'Кількість', 'Ким було використано']);
    sheet.getRange(1, 1, 1, LOG_WIDTH).setFontWeight('bold').setBackground('#c9daf8');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readPeople() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET_NAME);
  const people = { controllers: [], employees: [], emails: [] };
  if (!sheet || sheet.getLastRow() < 2) return people;

  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(function (row) {
    const controller = String(row[0] || '').trim();
    const employee = String(row[1] || '').trim();
    const email = String(row[2] || '').trim();
    if (controller) people.controllers.push(controller);
    if (employee) people.employees.push(employee);
    if (email && email.indexOf('@') !== -1) people.emails.push(email);
  });
  return people;
}

/**
 * Кому йде звіт. Основне джерело — колонка O «email» довідника
 * «_REF_Employees»: беруться активні співробітники, чия роль дозволяє звіт.
 * Дав людині роль — вона почала отримувати листи.
 * Аркуш «Користувачі» лишається запасним джерелом.
 */
function getNotificationEmails() {
  const fromDirectory = reportRecipients_().map(function (person) { return person.email; });
  const fromSheet = readPeople().emails;
  const all = {};
  fromDirectory.concat(fromSheet).forEach(function (email) {
    const value = String(email).trim();
    if (value && value.indexOf('@') !== -1) all[value.toLowerCase()] = value;
  });
  const list = Object.keys(all).map(function (key) { return all[key]; });
  return list.length ? list.join(',') : FALLBACK_EMAILS;
}

function forEachCatalogSheet(callback) {
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach(function (sheet) {
    if (SERVICE_SHEETS.indexOf(sheet.getName()) !== -1) return;
    if (sheet.getLastRow() < FIRST_DATA_ROW) return;
    callback(sheet);
  });
}

/** Один рядок позиції, доповнений до CAT_WIDTH. */
function readItemRow_(sheet, row) {
  const width = Math.min(CAT_WIDTH, sheet.getMaxColumns());
  const values = sheet.getRange(row, 1, 1, width).getDisplayValues()[0];
  while (values.length < CAT_WIDTH) values.push('');
  return values;
}

/** Рядки позицій, доповнені до CAT_WIDTH, якщо колонки O ще немає. */
function readCatalog(sheet) {
  const width = Math.min(CAT_WIDTH, sheet.getMaxColumns());
  const values = sheet.getRange(FIRST_DATA_ROW, 1, sheet.getLastRow() - FIRST_DATA_ROW + 1, width).getValues();
  return values.map(function (row) {
    while (row.length < CAT_WIDTH) row.push('');
    return row;
  });
}

/** Кількості в таблиці бувають із комою: «0,05» — це 0.05, а не NaN. */
function toNumber(value) {
  if (value === '' || value === '-' || value === null || value === undefined) return 0;
  if (typeof value === 'number') return isFinite(value) ? value : 0;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function round_(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

/** «2026-08-21» → «21.08.26» для блоку F..K. */
function formatDate(isoDate) {
  const key = localDateKey_(isoDate);
  if (!key) return String(isoDate == null ? '' : isoDate);
  const parts = key.split('-');
  return parts[2] + '.' + parts[1] + '.' + parts[0].substring(2);
}

/**
 * Канонічний день «РРРР-ММ-ДД» у поясі таблиці.
 * Приймає і рядок «2026-08-21», і об'єкт Date із таблиці, і «21.08.26».
 * Саме тут ховалась помилка «Мої за сьогодні»: колонка B зберігається як
 * справжня дата, JSON віддавав її в UTC, і день з'їжджав на один назад.
 */
function localDateKey_(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? ''
      : Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const text = String(value).trim();
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return match[1] + '-' + match[2] + '-' + match[3];
  match = text.match(/^(\d{2})\.(\d{2})\.(\d{2,4})/);
  if (match) {
    const year = match[3].length === 2 ? '20' + match[3] : match[3];
    return year + '-' + match[2] + '-' + match[1];
  }
  const parsed = new Date(text);
  return isNaN(parsed.getTime()) ? text
    : Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/**
 * Канонічний вигляд мітки часу для порівнянь. Один і той самий момент може
 * лежати в таблиці як «+03:00», прилетіти з клієнта як «Z», а зі старих рядків
 * прийти об'єктом Date — дедуплікація має впізнати всі три.
 */
function normalizeTimestamp_(value) {
  if (value instanceof Date) return value.toISOString();
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const date = new Date(text);
  return isNaN(date.getTime()) ? text : date.toISOString();
}

/**
 * Те саме, але для очей: у таблицю пишемо час у часовому поясі таблиці.
 * Раніше там стояв UTC із «Z», тож о 19:32 за Києвом у журналі бачили 16:32.
 * Мілісекунди лишаються — саме вони роблять мітку ідентифікатором операції.
 */
function localStamp_(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value == null ? '' : value).trim();
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ss.SSSXXX");
}

function formatTime(value) {
  const date = new Date(value);
  return isNaN(date.getTime()) ? ''
    : Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function td(value, align, extra) {
  const style = (align ? 'text-align:' + align + ';' : '') + (extra || '');
  return "<td style='" + style + "'>" + value + '</td>';
}

/** Помилка з кодом: код доїжджає до застосунку і вирішує, чи повторювати запит. */
function fail_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
