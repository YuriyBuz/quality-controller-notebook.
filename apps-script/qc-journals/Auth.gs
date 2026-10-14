// =========================================================================
//  Auth.gs — вхід за PIN, сесія, права
//  Проєкт: Журнали QC (Цифровий блокнот)
//
//  Перенесено з «Обліку миючих та дез. засобів» майже дослівно — той самий
//  механізм, той самий довідник. Відрізняється лише ROLE_PERMISSIONS:
//  там дії складу, тут — журнали.
//
//  ЦЕЙ ФАЙЛ ОДНАКОВИЙ У ВСІХ ТРЬОХ ПРОЄКТАХ.
// =========================================================================

/**
 * Джерело: аркуш «_REF_Employees» таблиці gw-ref (окремий файл).
 *   A emp_id | B ПІБ повне | C ПІБ короткий | E pos_id | H статус
 *   O email  | Q PIN       | R ролі додатково | S ролі відібрані
 * Ролі посади — «_REF_Positions», колонка D
 * (POS-012 Контролер якості → qc.use).
 *
 * У клієнт НІКОЛИ не потрапляють: PIN, список співробітників, чужі ролі.
 * Сервер відповідає лише про того, чий PIN збігся.
 */
const EMPLOYEES_SPREADSHEET_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
const EMPLOYEES_SHEET_NAME = '_REF_Employees';
const POSITIONS_SHEET_NAME = '_REF_Positions';

// Індекси колонок (0-based) в «_REF_Employees»
const EMP = { id: 0, fullName: 1, shortName: 2, posId: 4, status: 7, email: 14,
              pin: 16, extraRoles: 17, finalRoles: 18 };
const EMP_WIDTH = 19;                 // A..S
const POS = { id: 0, roles: 3 };      // A..D

const SESSION_TTL_MINUTES = 14 * 60;  // зміна 08:00–20:00 із запасом на ранній вхід
const MAX_PIN_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 300;

/**
 * Роль → дозволені дії. Перевіряється на сервері перед КОЖНИМ записом,
 * незалежно від того, що показує інтерфейс.
 *
 * Поки всі три ролі однакові: за постановкою записи ведуть контролери
 * з qc.use, інших ролей не планується. Розійдуться, коли з'явиться
 * скасування записів або окреме право на вивантаження історії.
 */
const ROLE_PERMISSIONS = {
  'qc.use':   ['writeJournal', 'readHistory'],
  'qc.admin': ['writeJournal', 'readHistory'],
  'admin':    ['writeJournal', 'readHistory']
};

// =========================================================================
//  ВХІД
// =========================================================================
function loginWithPin_(pin, deviceId) {
  const cache = CacheService.getScriptCache();
  const attemptsKey = 'pin_attempts_' + (deviceId || 'unknown');
  const attempts = Number(cache.get(attemptsKey) || 0);

  if (attempts >= MAX_PIN_ATTEMPTS) {
    logEvent_('access', 'login.throttled', {
      device: deviceId, details: 'спроб поспіль: ' + attempts });
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
    // Сам PIN не пишемо ніде — лише довжину і номер спроби
    logEvent_('access', 'login.badPin', {
      device: deviceId,
      details: 'довжина PIN: ' + value.length + ', спроба ' + (attempts + 1) });
    return loginFail_('BAD_PIN', 'Невірний PIN');
  }

  if (matches.length > 1) {
    logEvent_('access', 'login.pinNotUnique', {
      device: deviceId, details: 'збіг у ' + matches.length + ' співробітників' });
    // Не вгадуємо, хто саме — інакше запис пішов би від імені випадкової людини
    return loginFail_('PIN_NOT_UNIQUE',
      'Цей PIN закріплений за кількома співробітниками. Зверніться до адміністратора, ' +
      'щоб вам призначили власний PIN.');
  }

  cache.remove(attemptsKey);
  const employee = matches[0];

  // Збіг шукається лише серед тих, хто має роль у журналах, тож людина зі
  // стартовим PIN усе одно ввійде — решта власників того самого коду просто
  // не мають сюди доступу. Але тоді PIN не є особистим: його знають усі,
  // кому видали такий самий, і будь-хто з них може підписати запис цим
  // іменем. Не блокуємо (сьогодні ім'я взагалі обирається зі списку без
  // пароля), але лишаємо слід і кажемо про це вголос.
  const shared = countSharedPin_(employee);
  if (shared > 0) {
    logEvent_('access', 'login.sharedPin', {
      actor: employee.name, device: deviceId,
      details: 'той самий PIN ще в ' + shared + ' співробітників довідника' });
  }

  logEvent_('access', 'login.ok', {
    actor: employee.name, device: deviceId,
    details: 'ролі: ' + employee.roles.join(', ') });

  const expiresAt = Date.now() + SESSION_TTL_MINUTES * 60 * 1000;
  return {
    success: true,
    name: employee.name,
    shortName: employee.shortName,
    journalName: journalName_(employee.shortName, employee.name),
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

// =========================================================================
//  ТОКЕН СЕСІЇ — підписаний, без зберігання стану на сервері
// =========================================================================
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

/**
 * УВАГА ПРИ РОЗГОРТАННІ НА ТРИ АКАУНТИ.
 *
 * Якщо властивості AUTH_SECRET немає, функція згенерує свою — і в трьох
 * проєктів вийде три різні секрети. Токен, виданий першим, другий не
 * визнає, і контролер вводитиме PIN заново на кожному розділі.
 *
 * Тому ПЕРЕД першим запуском вписати в усі три проєкти однакове значення:
 *   ⚙ Настройки проекта → Свойства скрипта → AUTH_SECRET
 * Згенерувати можна функцією makeAuthSecret() нижче.
 *
 * Зміна значення розлогінює всіх — це і є «кнопка скидання» на випадок,
 * якщо з'явиться підозра, що токен витік.
 */
function getAuthSecret_() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    properties.setProperty('AUTH_SECRET', secret);
    logEvent_('error', 'auth.secretGenerated', {
      details: 'AUTH_SECRET не був заданий і згенерований автоматично. ' +
               'Якщо проєктів кілька — вписати однакове значення в усі.' });
  }
  return secret;
}

/** Запустити з редактора один раз, значення скопіювати в усі три проєкти. */
function makeAuthSecret() {
  Logger.log(Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
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
    payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
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
    id: employee.id,
    name: employee.name,
    shortName: employee.shortName,
    journalName: journalName_(employee.shortName, employee.name),
    roles: employee.roles,
    permissions: employee.permissions,
    expiresAt: payload.e
  };
}

/** Перевірка прав перед КОЖНИМ записом — незалежно від того, що показує інтерфейс. */
function requirePermission_(request, action) {
  const session = requireSession_(request);
  if (session.permissions.indexOf(action) === -1) {
    logEvent_('access', 'access.denied', {
      actor: session.name, device: request.deviceId,
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

// =========================================================================
//  ЧИТАННЯ ДОВІДНИКА
// =========================================================================
function readEmployees_() {
  const book = SpreadsheetApp.openById(EMPLOYEES_SPREADSHEET_ID);
  const sheet = book.getSheetByName(EMPLOYEES_SHEET_NAME);
  if (!sheet) throw fail_('NO_DIRECTORY', 'Аркуш «' + EMPLOYEES_SHEET_NAME + '» не знайдено');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const positionRoles = readPositionRoles_(book);

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
        eligible: String(row[EMP.status]).trim().toLowerCase() === 'active' &&
                  permissions.length > 0
      };
    });
}

function findEmployee_(id) {
  const wanted = String(id).trim();
  const found = readEmployees_().filter(function (employee) { return employee.id === wanted; });
  return found.length ? found[0] : null;
}

function readPositionRoles_(book) {
  const sheet = book.getSheetByName(POSITIONS_SHEET_NAME);
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

// =========================================================================
//  ДІАГНОСТИКА — запускати з редактора, дивитись «Журнал виконання»
// =========================================================================

/**
 * Чому довідник співробітників не читається.
 *
 * «You do not have permission to access the requested document» означає
 * одне з трьох, і Google навмисне не каже, яке саме:
 *   1) в ID довідника друкарська помилка (там є подвійне підкреслення);
 *   2) скрипт авторизовано лише на активну таблицю (spreadsheets.currentonly);
 *   3) скрипт виконується від акаунта, якому довідник не відкрито —
 *      найімовірніше саме це при розгортанні на другий і третій акаунти.
 */
function diagDirectory() {
  const id = EMPLOYEES_SPREADSHEET_ID;
  Logger.log('ID довідника: [%s], довжина %s (має бути 44)', id, id.length);
  Logger.log('Виконується від: %s', Session.getEffectiveUser().getEmail());
  try {
    const book = SpreadsheetApp.openById(id);
    Logger.log('Відкрито: «%s»', book.getName());
    const sheet = book.getSheetByName(EMPLOYEES_SHEET_NAME);
    Logger.log(sheet
      ? 'Аркуш «' + EMPLOYEES_SHEET_NAME + '»: рядків ' + sheet.getLastRow()
      : 'Аркуш «' + EMPLOYEES_SHEET_NAME + '» НЕ знайдено — перевірте назву');
  } catch (error) {
    Logger.log('НЕ ВІДКРИВАЄТЬСЯ: %s', error);
    return;
  }

  const eligible = readEmployees_().filter(function (e) { return e.eligible; });
  Logger.log('Доступ до журналів мають: %s', eligible.length);
  eligible.forEach(function (e) {
    Logger.log('  %s (%s) — ролі: %s — у журнал пишеться «%s»',
      e.name, e.id, e.roles.join(', '), journalName_(e.shortName, e.name));
  });
}

/**
 * Перевірка унікальності PIN серед тих, хто має доступ до журналів.
 * PIN показується замаскованим. Якщо одне значення в кількох — вхід
 * для них буде відхилено, і це треба виправити ДО запуску.
 */
function auditPins() {
  const all = readEmployees_();
  const eligible = all.filter(function (e) { return e.eligible; });
  Logger.log('Співробітників із доступом до журналів: %s', eligible.length);

  eligible.forEach(function (e) {
    const shared = all.filter(function (other) {
      return other.id !== e.id && other.pin && other.pin === e.pin;
    });
    const mask = e.pin ? e.pin.charAt(0) + '***' : '(порожній)';
    if (!e.pin) {
      Logger.log('  ✗ %s — PIN не заданий, увійти не зможе', e.name);
    } else if (shared.length) {
      Logger.log('  ⚠ %s — PIN %s збігається ще з %s співробітниками довідника',
        e.name, mask, shared.length);
    } else {
      Logger.log('  ✓ %s — PIN %s власний', e.name, mask);
    }
  });
}
