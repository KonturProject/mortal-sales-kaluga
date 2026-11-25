/**
 * «Победи дракона — Калуга». Standalone Google Apps Script.
 * Sales: Date | Amount | ROP (stable group slot) | Invoice | PaymentId.
 * Settings: DailyPlan (rubles), GameDate (yyyy-MM-dd, Moscow time), TotalMeters.
 * Public GET serves the game day's aggregates, stage setup and animation commands.
 * PIN-gated POST handles the coordinator and CEO pages. See README.md for the API.
 */

/** Fallback only; the real id is read from the SPREADSHEET_ID script property written by setupSpreadsheet(). */
var SPREADSHEET_ID = '';
var SPREADSHEET_ID_PROPERTY_KEY = 'SPREADSHEET_ID';
var SPREADSHEET_TITLE = 'Mortal Sales Калуга - данные';
var SALES_SHEET_NAME = 'Sales';
var SETTINGS_SHEET_NAME = 'Settings';
/** The six groups of the branch (short codes, as they appear in the ROP drop-down of "Sales"). */
var DEPARTMENT_CODES = ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6'];
var GROUP_CODES_PROPERTY_KEY = 'GROUP_CODES';
var DEFAULT_DAILY_PLAN = 0;
var DEFAULT_GAME_DATE = '2026-11-26';
/** JSON { slot: rubles }, JSON [[left, right], ...], JSON of the official result, and the key the displays must send. */
var PLANS_PROPERTY_KEY = 'PLANS';
var PAIRS_PROPERTY_KEY = 'PAIRS';
var FINAL_PROPERTY_KEY = 'FINAL';
var DISPLAY_KEY_PROPERTY_KEY = 'DISPLAY_KEY';
/** Rounds start by themselves at these Moscow hours of the game date. */
var ROUND_HOURS = [10, 12, 15];
/** When a payment was entered (ms): a round counts only what was in by its start, so every display shows the same result. */
var AT_HEADER = 'At';
/** Payments count up to the bell; its result opens this much later, when the last of them are surely written. */
var BELL_SETTLE_MS = 5000;

/** Legacy plain-text PIN. Still honoured until the PIN is changed (then deleted); kept so an older deployment can be rolled back to. */
var PIN_PROPERTY_KEY = 'ADMIN_PIN';
/** 'salt$sha256hex' of the PIN, written by storePin_(). Takes precedence over the legacy property. */
var PIN_HASH_PROPERTY_KEY = 'ADMIN_PIN_HASH';
var COMMANDS_PROPERTY_KEY = 'COMMANDS';
var COMMAND_SEQ_PROPERTY_KEY = 'COMMAND_SEQ';
/** JSON { slot: characterId } — who stands where on the displays, chosen in the admin page. */
var ROSTER_PROPERTY_KEY = 'ROSTER';
/** Places on the stage: six departments (left to right) and the branch lead. */
var ROSTER_SLOTS = ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6', 'lead'];
/** JSON { slot: 'Фамилия И.' } — the group leader shown on each department's nameplate, edited in the admin page. */
var LEADERS_PROPERTY_KEY = 'LEADERS';
var LEADER_SLOTS = ['slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6'];
/** JSON { slot: 'salt$sha256' } — the group leaders' PINs for rg.html (the group is known from the PIN). Same order as DEPARTMENT_CODES. */
var GROUP_PINS_PROPERTY_KEY = 'GROUP_PINS';

/** Header of the "Sales" column that holds the invoice number of an imported payment (added by the first import). */
var INVOICE_HEADER = 'Invoice';
var PAYMENT_ID_HEADER = 'PaymentId';
/** One export file is a few hundred rows a month; this only stops an absurd request. */
var MAX_IMPORT_ROWS = 5000;
/** After this many wrong PINs within PIN_FAILURE_WINDOW_SEC the admin API refuses everything for PIN_LOCK_SEC. */
var MAX_PIN_FAILURES = 15;
/** The leaders share one counter, so it is generous and the pause short: one mistyping leader must not shut the others out before a bell. */
var MAX_GROUP_PIN_FAILURES = 30;
var PIN_FAILURE_WINDOW_SEC = 600;
var PIN_LOCK_SEC = 120;

var COMMAND_KEEP = 10;
var COMMAND_MAX_AGE_MS = 10 * 60 * 1000;
var REQUEST_CACHE_SEC = 600;
var MAX_AMOUNT = 100000000;

var COMMAND_HEROES = ['random', 'slot_1', 'slot_2', 'slot_3', 'slot_4', 'slot_5', 'slot_6'];

/** Opening the spreadsheet is the slow part of a request (~0.5 s); do it once per execution, not once per helper. */
var spreadsheet_ = null;
function getSpreadsheet_() {
  if (!spreadsheet_) {
    var id = prop_(SPREADSHEET_ID_PROPERTY_KEY) || SPREADSHEET_ID;
    if (!id) throw new Error('No spreadsheet yet: run setupSpreadsheet() once from the editor');
    spreadsheet_ = SpreadsheetApp.openById(id);
  }
  return spreadsheet_;
}

/** Creates the Kaluga spreadsheet once. Run from the editor. */
function setupSpreadsheet() {
  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var existing = props.getProperty(SPREADSHEET_ID_PROPERTY_KEY);
    if (existing) {
      Logger.log('Already set up: ' + SpreadsheetApp.openById(existing).getUrl());
      return;
    }
    var ss = SpreadsheetApp.create(SPREADSHEET_TITLE);
    ss.setSpreadsheetTimeZone('Europe/Moscow');
    ss.setSpreadsheetLocale('ru_RU');

    var sales = ss.getActiveSheet();
    sales.setName(SALES_SHEET_NAME);
    sales.getRange(1, 1, 1, 6).setValues([['Date', 'Amount', 'ROP', INVOICE_HEADER, PAYMENT_ID_HEADER, AT_HEADER]]).setFontWeight('bold');
    sales.setFrozenRows(1);
    sales.getRange('A2:A').setNumberFormat('yyyy-mm-dd');
    sales.getRange('B2:B').setNumberFormat('#,##0.00 "₽"');
    sales.getRange('D2:E').setNumberFormat('@');
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(DEPARTMENT_CODES, true).setAllowInvalid(false).build();
    sales.getRange('C2:C').setDataValidation(rule);
    sales.setColumnWidth(1, 120);
    sales.setColumnWidth(2, 120);
    sales.setColumnWidth(3, 100);
    sales.setColumnWidth(4, 140);

    var settings = ss.insertSheet(SETTINGS_SHEET_NAME);
    settings.getRange('B3').setNumberFormat('@');
    settings.getRange(1, 1, 4, 2).setValues([
      ['Key', 'Value'], ['DailyPlan', DEFAULT_DAILY_PLAN], ['GameDate', DEFAULT_GAME_DATE], ['TotalMeters', 300]
    ]);
    settings.getRange(1, 1, 1, 2).setFontWeight('bold');
    settings.setFrozenRows(1);
    settings.setColumnWidth(1, 125);
    settings.setColumnWidth(2, 125);

    props.setProperty(SPREADSHEET_ID_PROPERTY_KEY, ss.getId());
    Logger.log('Created: ' + ss.getUrl());
  });
}

/** All script properties, held only while a status is being built (null otherwise: writers always read fresh). */
var propsMemo_ = null;
function prop_(key) {
  if (propsMemo_) return propsMemo_.hasOwnProperty(key) ? propsMemo_[key] : null;
  return PropertiesService.getScriptProperties().getProperty(key);
}

var STATUS_CACHE_KEY = 'status';
var STATUS_CACHE_SEC = 5;

function doGet(e) {
  var cache = CacheService.getScriptCache();
  var sent = e && e.parameter ? e.parameter.key : '';
  try {
    var ready = cache.get(STATUS_CACHE_KEY);
    if (ready) {
      var held = JSON.parse(ready);
      if (!sent || sent !== held.key) return jsonResponse_({ ok: false, error: 'bad_key' });
      held.status.serverNow = Date.now();
      return jsonResponse_(held.status);
    }
    propsMemo_ = PropertiesService.getScriptProperties().getProperties();
    var key = prop_(DISPLAY_KEY_PROPERTY_KEY);
    if (!key || sent !== key) return jsonResponse_({ ok: false, error: 'bad_key' });
    var status = computeDailyStatus_();
    status.commands = readRecentCommands_();
    status.serverNow = Date.now();
    var text = JSON.stringify({ key: key, status: status });
    if (text.length < 90000) cache.put(STATUS_CACHE_KEY, text, STATUS_CACHE_SEC);
    return jsonResponse_(status);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'server_error', detail: String(err) });
  } finally {
    propsMemo_ = null;
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'bad_request', detail: 'body is not JSON' });
  }
  if (!body || typeof body !== 'object') return jsonResponse_({ ok: false, error: 'bad_request', detail: 'body is not an object' });

  try {
    // The first version of the admin page sent { pin, plan } with no action.
    var action = body.action || '';
    var groupHandler = GROUP_ACTIONS_.hasOwnProperty(action) ? GROUP_ACTIONS_[action] : null;
    var handler = ACTIONS_.hasOwnProperty(action) ? ACTIONS_[action] : null;
    if (!handler && !groupHandler) return jsonResponse_({ ok: false, error: 'bad_request', detail: 'unknown action' });

    // The group leaders' page signs in with a group PIN (`groupPin`) and can only do its own few things;
    // everything else needs the admin PIN (`pin`).
    var groupSlot = '';
    if (groupHandler) {
      var auth = authorizeGroup_(body.groupPin);
      if (auth.denied) return jsonResponse_(auth.denied);
      groupSlot = auth.slot;
    } else {
      var denied = authorize_(body.pin);
      if (denied) return jsonResponse_(denied);
    }

    // A retried request (double click, flaky connection) must not run twice.
    // Payment IDs are checked in the sheet under the write lock, independently of the cache.
    var isPayment = action === 'addPayment' || action === 'groupAddPayment';
    var requestId = !isPayment && body.requestId ? String(body.requestId).slice(0, 64) : '';
    var cacheKey = requestId ? 'req_' + action + '_' + groupSlot + '_' + requestId : '';
    if (cacheKey) {
      var earlier = CacheService.getScriptCache().get(cacheKey);
      if (earlier) return jsonResponse_(JSON.parse(earlier));
    }

    var result = groupHandler ? groupHandler(body, groupSlot) : handler(body);
    if (action !== 'login' && action !== 'groupLogin' && action !== 'listSales') CacheService.getScriptCache().remove(STATUS_CACHE_KEY);
    if (cacheKey && result.ok) CacheService.getScriptCache().put(cacheKey, JSON.stringify(result), REQUEST_CACHE_SEC);
    return jsonResponse_(result);
  } catch (err) {
    // Not the caller's fault (a missing sheet, a lock that could not be taken, ...): say so, instead of blaming the request.
    return jsonResponse_({ ok: false, error: 'server_error', detail: String(err) });
  }
}

var ACTIONS_ = {
  login: function (body) { return { ok: true }; },
  setPlans: actionSetPlans_,
  setPairs: actionSetPairs_,
  setDisplayKey: actionSetDisplayKey_,
  clearFinal: actionClearFinal_,
  voidPayment: actionVoidPayment_,
  listSales: actionListSales_,
  dayAmount: actionDayAmount_,
  addPayment: actionAddPayment_,
  setGroupCodes: actionSetGroupCodes_,
  importSales: actionImportSales_,
  changePin: actionChangePin_,
  command: actionCommand_,
  setRoster: actionSetRoster_,
  setGroupPins: actionSetGroupPins_,
  groupPinStatus: actionGroupPinStatus_
};

/** The group leaders' page (rg.html): `groupPin` instead of `pin`; the handler also gets the leader's slot. */
var GROUP_ACTIONS_ = {
  groupLogin: actionGroupLogin_,
  groupAddPayment: actionGroupAddPayment_,
  groupVoidPayment: actionGroupVoidPayment_
};

/** Manual test helper — run from the editor, inspect via View > Logs. */
function testDoGet() {
  var result = doGet({ parameter: {} });
  Logger.log(result.getContent());
}

/* ------------------------------------------------------------------ actions */

/** Each leader's plan in rubles, and the game date. */
function actionSetPlans_(body) {
  var date = body.gameDate === undefined ? readGameDate_(readSettings_()) : validDay_(body.gameDate);
  if (!date) return badRequest_('gameDate');
  var input = body.plans;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('plans');
  var plans = {};
  for (var i = 0; i < DEPARTMENT_CODES.length; i++) {
    var cents = moneyCents_(input[DEPARTMENT_CODES[i]], MAX_AMOUNT);
    if (!cents) return badRequest_('plans');
    plans[DEPARTMENT_CODES[i]] = cents / 100;
  }
  return withLock_(function () {
    var sheet = getSettingsSheet_();
    sheet.getRange(3, 2).setNumberFormat('@');
    sheet.getRange(3, 1, 1, 2).setValues([['GameDate', date]]);
    PropertiesService.getScriptProperties().setProperty(PLANS_PROPERTY_KEY, JSON.stringify(plans));
    return { ok: true, plans: plans, gameDate: date };
  });
}

/** Up to three pairs; a slot stands in one pair at most. */
function actionSetPairs_(body) {
  var input = body.pairs;
  if (!Array.isArray(input) || input.length < 1 || input.length > 3) return badRequest_('pairs');
  var used = [];
  for (var i = 0; i < input.length; i++) {
    var pair = input[i];
    if (!Array.isArray(pair) || pair.length !== 2) return badRequest_('pairs', i);
    for (var k = 0; k < 2; k++) {
      var slot = validateRop_(pair[k]);
      if (!slot || used.indexOf(slot) >= 0) return badRequest_('pairs', i);
      used.push(slot);
    }
  }
  return withLock_(function () {
    PropertiesService.getScriptProperties().setProperty(PAIRS_PROPERTY_KEY, JSON.stringify(input));
    return { ok: true, pairs: input };
  });
}

function actionSetDisplayKey_(body) {
  var key = Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty(DISPLAY_KEY_PROPERTY_KEY, key);
  return { ok: true, key: key };
}

/** Takes the Final Round back (a wrong file was imported). */
function actionClearFinal_(body) {
  return withLock_(function () {
    PropertiesService.getScriptProperties().deleteProperty(FINAL_PROPERTY_KEY);
    return { ok: true };
  });
}

function actionVoidPayment_(body) {
  var rop = validateRop_(body.rop);
  return rop ? voidPayment_(rop, body) : badRequest_('rop');
}

/** A mistyped payment: its amount becomes 0, the row stays as a trace. */
function voidPayment_(code, body) {
  if (typeof body.paymentId !== 'string' || !body.paymentId) return badRequest_('paymentId');
  return withLock_(function () {
    if (readFinal_()) return badRequest_('final');
    var table = readSales_(false);
    for (var i = 1; i < table.values.length; i++) {
      var row = table.values[i];
      if (row[table.cols.paymentId] !== body.paymentId || row[table.cols.rop] !== code) continue;
      table.sheet.getRange(i + 1, table.cols.amount + 1).setValue(0);
      SpreadsheetApp.flush();
      return { ok: true };
    }
    return badRequest_('paymentId');
  });
}

function actionGroupVoidPayment_(body, slot) {
  var res = voidPayment_(slot, body);
  return res.ok ? groupView_(slot, res) : res;
}

/** Latest rows of "Sales" (newest first) plus the same aggregates the game shows. */
function actionListSales_(body) {
  var limit = Math.floor(Number(body.limit));
  if (!isFinite(limit) || limit < 1) limit = 50;
  limit = Math.min(limit, 200);

  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var table = readSales_(false);
  var cols = table.cols;
  var values = table.values;
  var status = computeDailyStatus_();

  // Rows are judged by Date / Amount / ROP: getLastRow() also counts rows that only hold other data.
  var sales = [];
  var totalRows = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (isBlankSale_(values[i], cols)) continue;
    totalRows++;
    if (sales.length >= limit) continue;
    var raw = values[i][cols.date];
    sales.push({
      row: i + 1,
      date: raw instanceof Date ? formatSaleDate_(raw, tz) : String(raw),
      amount: Number(values[i][cols.amount]) || 0,
      rop: String(values[i][cols.rop] || ''),
      invoice: cols.invoice >= 0 ? String(values[i][cols.invoice] || '') : ''
    });
  }

  return {
    ok: true,
    totalRows: totalRows,
    shown: sales.length,
    sales: sales,
    status: status,
    settings: { plans: readPlans_(), pairs: readPairs_(), leaders: readLeaders_() || {}, groupCodes: readGroupCodes_(), GameDate: status.gameDate }
  };
}

/** Reads the selected group's total for the game date. */
function actionDayAmount_(body) {
  var rop = validateRop_(body.rop);
  if (!rop) return badRequest_('rop');
  var day = validDay_(body.date);
  if (!day || day !== readGameDate_(readSettings_())) return badRequest_('date');
  return { ok: true, rop: rop, date: day, amount: groupDayAmount_(rop, day) };
}

function actionAddPayment_(body) {
  var rop = validateRop_(body.rop);
  if (!rop) return badRequest_('rop');
  var saved = addPayment_(rop, body);
  return saved.ok === false ? saved : { ok: true, saved: saved };
}

/** Appends one payment. The request ID and amount are written together, so a retry cannot add a second row. */
function addPayment_(code, body) {
  var day = validDay_(body.date);
  var cents = moneyCents_(body.amount, MAX_AMOUNT);
  if (!cents) return badRequest_('amount');
  var id = body.requestId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return badRequest_('requestId');
  return withLock_(function () {
    var tz = getSpreadsheet_().getSpreadsheetTimeZone();
    var table = readSales_(false);
    var cols = table.cols;
    var amount = cents / 100;
    var saved = { id: id, rop: code, date: day, amount: amount };
    for (var i = 1; i < table.values.length; i++) {
      var existing = table.values[i];
      if (existing[cols.paymentId] !== id) continue;
      return saleDay_(existing[cols.date], tz) === day && existing[cols.rop] === code && rowCents_(existing, cols) === cents
        ? saved : badRequest_('requestId');
    }
    if (!day || day !== readGameDate_(readSettings_()) || day > today_()) return badRequest_('date');
    if (readFinal_()) return badRequest_('final');

    var sheet = table.sheet;
    cols.paymentId = headerColumn_(sheet, PAYMENT_ID_HEADER, true);
    cols.at = headerColumn_(sheet, AT_HEADER, true);
    var rowIndex = table.values.length + 1;
    if (rowIndex > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rowIndex - sheet.getMaxRows());
    var row = new Array(sheet.getLastColumn()).fill('');
    row[cols.date] = Utilities.parseDate(day + 'T00:00', tz, "yyyy-MM-dd'T'HH:mm");
    row[cols.amount] = amount;
    row[cols.rop] = code;
    row[cols.paymentId] = id;
    row[cols.at] = Date.now();
    sheet.getRange(rowIndex, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
    return saved;
  });
}

function groupDayAmount_(code, day) {
  var table = readSales_(false);
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var cents = 0;
  for (var i = 1; i < table.values.length; i++) {
    var row = table.values[i];
    if (String(row[table.cols.rop]).trim() === code && saleDay_(row[table.cols.date], tz) === day) {
      cents += rowCents_(row, table.cols);
    }
  }
  return cents / 100;
}

function actionGroupLogin_(body, slot) {
  return groupView_(slot, { ok: true });
}

function actionGroupAddPayment_(body, slot) {
  var saved = addPayment_(slot, body);
  return saved.ok === false ? saved : groupView_(slot, { ok: true, saved: saved });
}

function groupView_(slot, res) {
  var leaders = readLeaders_() || {};
  var date = readGameDate_(readSettings_());
  res.group = { slot: slot, code: readGroupCodes_()[slot], leader: leaders.hasOwnProperty(slot) ? leaders[slot] : null };
  var plan = readPlans_()[slot] || 0;
  var official = readFinal_();
  var amount = official ? official.official[slot] || 0 : groupDayAmount_(slot, date);
  res.day = {
    date: date, amount: amount, plan: plan, pct: plan > 0 ? amount / plan : 0,
    editable: date <= today_() && !readFinal_(), payments: groupPayments_(slot, date)
  };
  return res;
}

function today_() {
  return Utilities.formatDate(new Date(), getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

function readGameDate_(settings) {
  return saleDay_(settings.GameDate, getSpreadsheet_().getSpreadsheetTimeZone()) || DEFAULT_GAME_DATE;
}

function readGroupCodes_() {
  var saved = readJsonProperty_(GROUP_CODES_PROPERTY_KEY) || {};
  var codes = {};
  DEPARTMENT_CODES.forEach(function (slot, i) {
    codes[slot] = saved[slot] || 'Группа ' + (i + 1);
  });
  return codes;
}

/** Labels can change without rewriting sales or changing which CEO owns a slot. */
function actionSetGroupCodes_(body) {
  var input = body.groupCodes;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('groupCodes');
  var codes = {};
  var used = [];
  for (var i = 0; i < DEPARTMENT_CODES.length; i++) {
    var slot = DEPARTMENT_CODES[i];
    var code = typeof input[slot] === 'string' ? input[slot].replace(/\s+/g, ' ').trim() : '';
    if (!/^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 ._/-]{0,39}$/.test(code)) return badRequest_('groupCodes');
    var folded = code.replace(/[Bb]/g, 'В').replace(/[Ww]/g, 'Ш').toUpperCase();
    if (used.indexOf(folded) >= 0 || DEPARTMENT_CODES.indexOf(code.toLowerCase()) >= 0) return badRequest_('groupCodes');
    used.push(folded);
    codes[slot] = code;
  }
  return withLock_(function () {
    PropertiesService.getScriptProperties().setProperty(GROUP_CODES_PROPERTY_KEY, JSON.stringify(codes));
    return { ok: true, groupCodes: codes };
  });
}

/* --------------------------------------------- group PINs (admin page side) */

/**
 * Sets the group leaders' PINs: { pins: { slot_1: '123456', … } } — only the slots sent change; a new PIN replaces the
 * old one at once. The admin page makes them up at random and shows them to the admin once; here only a salted hash
 * is kept. A PIN must be 6–12 digits and differ from the other groups' PINs and from the admin PIN.
 */
function actionSetGroupPins_(body) {
  var input = body.pins;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('pins');
  var changes = {};
  var seen = {};
  for (var slot in input) {
    if (!input.hasOwnProperty(slot)) continue;
    var pin = String(input[slot] === undefined || input[slot] === null ? '' : input[slot]);
    if (LEADER_SLOTS.indexOf(slot) < 0 || !/^[0-9]{6,12}$/.test(pin)) return badRequest_('pins');
    if (seen[pin] || verifyPin_(pin)) return badRequest_('pins_duplicate');
    seen[pin] = true;
    changes[slot] = pin;
  }
  if (Object.keys(changes).length === 0) return badRequest_('pins');

  return withLock_(function () {
    var pins = readGroupPins_();
    // A new PIN must not open another group that keeps its current PIN.
    for (var s in changes) {
      var owner = groupSlotForPin_(changes[s]);
      if (owner && !changes.hasOwnProperty(owner)) return badRequest_('pins_duplicate');
    }
    for (var slotKey in changes) {
      var salt = Utilities.getUuid();
      pins[slotKey] = salt + '$' + hashPin_(salt, changes[slotKey]);
    }
    PropertiesService.getScriptProperties().setProperty(GROUP_PINS_PROPERTY_KEY, JSON.stringify(pins));
    // Like a changed admin PIN: new PINs (e.g. after someone tried to guess) lift the group page's lock.
    CacheService.getScriptCache().remove('group_pin_fails');
    CacheService.getScriptCache().remove('group_pin_lock_until');
    return { ok: true, set: groupPinsSet_(pins) };
  });
}

/** Which groups have a PIN (true/false per slot) — never the PINs or their hashes. */
function actionGroupPinStatus_(body) {
  return { ok: true, set: groupPinsSet_(readGroupPins_()) };
}

function groupPinsSet_(pins) {
  var set = {};
  for (var i = 0; i < LEADER_SLOTS.length; i++) set[LEADER_SLOTS[i]] = !!pins[LEADER_SLOTS[i]];
  return set;
}

/** Replaces the game date's rows with the CRM export, or previews that replacement. */
function actionImportSales_(body) {
  var day = validDay_(body.date);
  var input = body.rows;
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_IMPORT_ROWS) return badRequest_('rows');
  var rows = [];
  var addedCents = 0;
  for (var i = 0; i < input.length; i++) {
    var r = input[i] && typeof input[i] === 'object' ? input[i] : {};
    var negative = typeof r.amount === 'number' && r.amount < 0;
    var cents = moneyCents_(negative ? -r.amount : r.amount, MAX_AMOUNT);
    if (negative && cents !== null) cents = -cents;
    var rop = validateRop_(r.rop);
    var invoice = String(r.invoice === undefined || r.invoice === null ? '' : r.invoice).trim();
    if (!day || r.date !== day || cents === null || cents === 0 || !rop || !/^[0-9A-Za-zА-Яа-яЁё\/_-]{0,30}$/.test(invoice)) {
      return badRequest_('rows', i);
    }
    rows.push({ day: day, amount: cents / 100, rop: rop, invoice: invoice });
    addedCents += cents;
  }

  return withLock_(function () {
    if (day !== readGameDate_(readSettings_()) || day > today_()) return badRequest_('date');
    var official = {};
    DEPARTMENT_CODES.forEach(function (slot) { official[slot] = 0; });
    rows.forEach(function (r) { official[r.rop] = (official[r.rop] || 0) + Math.round(r.amount * 100); });
    var entered = {};
    DEPARTMENT_CODES.forEach(function (slot) {
      official[slot] = (official[slot] || 0) / 100;
      entered[slot] = groupDayAmount_(slot, day);
    });
    var plans = readPlans_();
    for (var p = 0; p < DEPARTMENT_CODES.length; p++) if (!(plans[DEPARTMENT_CODES[p]] > 0)) return badRequest_('plans');
    var rating = ranking_(official, plans);
    if (body.dryRun) return { ok: true, dryRun: true, date: day, entered: entered, official: official, rating: rating };
    // The same totals again (a lost answer, a second click) are the same final: the displays must not replay it.
    var earlier = readFinal_();
    if (earlier && JSON.stringify(earlier.official) === JSON.stringify(official)) return { ok: true, date: day, entered: entered, final: earlier };
    var now = Date.now();
    var result = { id: now, at: now, date: day, official: official, rating: rating };
    PropertiesService.getScriptProperties().setProperty(FINAL_PROPERTY_KEY, JSON.stringify(result));
    return { ok: true, date: day, entered: entered, final: result };
  });
}

/** Share of the plan, best first; equal shares keep the slot order. */
function ranking_(amounts, plans) {
  return DEPARTMENT_CODES.map(function (slot, i) {
    var plan = plans[slot] || 0;
    return { slot: slot, amount: amounts[slot] || 0, plan: plan, pct: plan > 0 ? (amounts[slot] || 0) / plan : 0, order: i };
  }).sort(function (a, b) { return b.pct - a.pct || a.order - b.order; });
}

function readPlans_() {
  return readJsonProperty_(PLANS_PROPERTY_KEY) || {};
}

/** The official result of this game date; one left from a rehearsal on another date does not count. */
function readFinal_() {
  var saved = readJsonProperty_(FINAL_PROPERTY_KEY);
  return saved && saved.date === readGameDate_(readSettings_()) ? saved : null;
}

function readPairs_() {
  var raw = prop_(PAIRS_PROPERTY_KEY);
  try {
    var list = raw ? JSON.parse(raw) : null;
    if (Array.isArray(list)) return list;
  } catch (err) { /* the defaults below */ }
  return [['slot_1', 'slot_3'], ['slot_2', 'slot_4'], ['slot_5', 'slot_6']];
}

/** The day's payments in the order they were entered; voided ones (amount 0) are left out. */
function dayPayments_(day) {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var table = readSales_(false);
  var atCol = headerColumn_(table.sheet, AT_HEADER, false);
  var list = [];
  for (var i = 1; i < table.values.length; i++) {
    var row = table.values[i];
    var slot = validateRop_(row[table.cols.rop]);
    if (!slot || saleDay_(row[table.cols.date], tz) !== day) continue;
    var cents = rowCents_(row, table.cols);
    var id = row[table.cols.paymentId];
    if (cents > 0 && typeof id === 'string' && id) list.push({ id: id, slot: slot, amount: cents / 100, at: Number(row[atCol]) || 0 });
  }
  return list;
}

function groupPayments_(slot, day) {
  return dayPayments_(day).filter(function (p) { return p.slot === slot; });
}

/** Start of each round, ms. */
function roundTimes_(day) {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  return ROUND_HOURS.map(function (h, i) {
    return { n: i + 1, at: Utilities.parseDate(day + 'T' + (h < 10 ? '0' : '') + h + ':00', tz, "yyyy-MM-dd'T'HH:mm").getTime() };
  });
}

/* ------------------------------------------------------------- sales table */

/** Reads the sheet, adding Invoice on the first write if it was missing. */
function readSales_(create) {
  var sheet = getSalesSheet_();
  var cols = salesColumns_(sheet);
  cols.invoice = headerColumn_(sheet, INVOICE_HEADER, create);
  cols.paymentId = headerColumn_(sheet, PAYMENT_ID_HEADER, false);
  var values = sheet.getRange(1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn())).getValues();
  return { sheet: sheet, cols: cols, values: values };
}

function rowCents_(row, cols) {
  return moneyCents_(row[cols.amount], MAX_AMOUNT) || 0;
}

function moneyCents_(value, maximum) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') return null;
  var amount = Number(value);
  var cents = Math.round(amount * 100);
  if (!isFinite(amount) || amount < 0 || amount > maximum || Math.abs(amount - cents / 100) > 1e-8) return null;
  return cents;
}

/**
 * Rewrites the sales rows of a table from readSales_(true) (call under withLock_): every row `replaced(row, day)` says
 * yes to goes, the `incoming` rows ({ day, amount, rop, invoice }) come in, all sorted by day — a stable sort,
 * so one day keeps its order, the kept rows first. ONE setValues over the sales block, the rows no longer needed
 * blanked in the same write: never a row deletion, and no moment where the old rows are gone but the new ones are
 * not written yet. Only sale columns are changed; other columns keep their values.
 * Returns { rows, amount } of what went.
 */
function rewriteSales_(table, replaced, incoming) {
  var sheet = table.sheet;
  var cols = table.cols;
  var values = table.values;
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();

  var kept = [];
  var removed = { rows: 0, amount: 0 };
  var removedCents = 0;
  var lastSale = 0; // index (in values) of the last row holding a sale
  for (var j = 1; j < values.length; j++) {
    if (isBlankSale_(values[j], cols)) continue;
    lastSale = j;
    var day = saleDay_(values[j][cols.date], tz);
    if (replaced(values[j], day)) {
      removed.rows++;
      removedCents += rowCents_(values[j], cols);
      continue;
    }
    kept.push({ day: day, date: values[j][cols.date], amount: values[j][cols.amount], rop: values[j][cols.rop], invoice: values[j][cols.invoice], paymentId: values[j][cols.paymentId] });
  }

  var midnight = {}; // day -> Date, parsed once per day rather than once per row
  var fresh = incoming.map(function (r) {
    if (!midnight[r.day]) midnight[r.day] = Utilities.parseDate(r.day + 'T00:00', tz, "yyyy-MM-dd'T'HH:mm");
    return { day: r.day, date: midnight[r.day], amount: r.amount, rop: r.rop, invoice: r.invoice };
  });
  var all = kept.concat(fresh).sort(function (a, b) { return a.day < b.day ? -1 : a.day > b.day ? 1 : 0; });

  // Cover every row that held a sale before, so the ones no longer needed are blanked in the same write.
  var span = Math.max(all.length, lastSale);
  if (span > 0) {
    if (sheet.getMaxRows() < span + 1) sheet.insertRowsAfter(sheet.getMaxRows(), span + 1 - sheet.getMaxRows());
    var fields = ['date', 'amount', 'rop', 'invoice'];
    if (cols.paymentId >= 0) fields.push('paymentId');
    var touched = fields.map(function (f) { return cols[f]; });
    var first = Math.min.apply(null, touched);
    var width = Math.max.apply(null, touched) - first + 1;
    var block = [];
    for (var k = 0; k < span; k++) {
      var source = values[k + 1] || [];
      var line = [];
      for (var c = 0; c < width; c++) line.push(source[first + c] === undefined ? '' : source[first + c]);
      var sale = all[k];
      for (var f = 0; f < fields.length; f++) {
        var v = sale ? sale[fields[f]] : '';
        line[cols[fields[f]] - first] = v === undefined || v === null ? '' : v;
      }
      block.push(line);
    }
    sheet.getRange(2, first + 1, span, width).setValues(block);
  }
  removed.amount = removedCents / 100;
  return removed;
}

function actionChangePin_(body) {
  var newPin = String(body.newPin === undefined ? '' : body.newPin);
  if (!/^[0-9]{4,12}$/.test(newPin)) return badRequest_('newPin');
  if (newPin === String(body.pin)) return badRequest_('newPin_same');
  if (groupSlotForPin_(newPin)) return badRequest_('newPin_group');
  return withLock_(function () {
    storePin_(newPin);
    return { ok: true };
  });
}

/**
 * Asks every display to play an animation. Purely visual: the game does not change any
 * numbers because of it, and nothing is written to the spreadsheet — the queue lives in
 * Script Properties. Each display runs every command once, in id order (see readRecentCommands_).
 */
function actionCommand_(body) {
  var type = String(body.type || '');
  var validate = COMMAND_ARGS_[type];
  if (!validate) return badRequest_('type');
  var args = validate(body.args || {});
  if (args === null) return badRequest_('args');

  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    var seq = (Number(props.getProperty(COMMAND_SEQ_PROPERTY_KEY)) || 0) + 1;
    var now = Date.now();
    var queue = readCommandQueue_().filter(function (c) { return now - c.issuedAt <= COMMAND_MAX_AGE_MS; });
    queue.push({ id: seq, type: type, args: args, issuedAt: now });
    queue = queue.slice(-COMMAND_KEEP);
    props.setProperty(COMMANDS_PROPERTY_KEY, JSON.stringify(queue));
    props.setProperty(COMMAND_SEQ_PROPERTY_KEY, String(seq));
    return { ok: true, id: seq };
  });
}

/**
 * Which character stands in which slot (admin page, "Герои" tab). Stored as JSON in Script Properties — it is
 * display configuration, not data, so the spreadsheet is never touched. Only the slots that are sent change;
 * the displays pick the new choice up with their next poll and swap the heroes on stage.
 */
function actionSetRoster_(body) {
  var changes = {};
  if (body.roster !== undefined) {
    var input = body.roster;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return badRequest_('roster');
    for (var key in input) {
      if (!input.hasOwnProperty(key)) continue;
      if (ROSTER_SLOTS.indexOf(key) < 0) return badRequest_('roster');
      var id = String(input[key]);
      if (!/^[a-z0-9_]{2,32}$/.test(id)) return badRequest_('roster');
      changes[key] = id;
    }
  }

  // The group leaders' names on the nameplates («Фамилия И.»); an empty name leaves just the group code.
  var nameChanges = {};
  if (body.leaders !== undefined) {
    var names = body.leaders;
    if (!names || typeof names !== 'object' || Array.isArray(names)) return badRequest_('leaders');
    for (var slotKey in names) {
      if (!names.hasOwnProperty(slotKey)) continue;
      if (LEADER_SLOTS.indexOf(slotKey) < 0) return badRequest_('leaders');
      var name = String(names[slotKey] === null || names[slotKey] === undefined ? '' : names[slotKey]).replace(/\s+/g, ' ').trim();
      if (!/^[A-Za-zА-Яа-яЁё ().'-]{0,40}$/.test(name)) return badRequest_('leaders');
      nameChanges[slotKey] = name;
    }
  }
  if (Object.keys(changes).length === 0 && Object.keys(nameChanges).length === 0) return badRequest_('roster');

  return withLock_(function () {
    var props = PropertiesService.getScriptProperties();
    if (Object.keys(changes).length > 0) {
      var roster = readRoster_() || {};
      for (var slot in changes) roster[slot] = changes[slot];
      props.setProperty(ROSTER_PROPERTY_KEY, JSON.stringify(roster));
    }
    if (Object.keys(nameChanges).length > 0) {
      var leaders = readLeaders_() || {};
      for (var s in nameChanges) leaders[s] = nameChanges[s];
      props.setProperty(LEADERS_PROPERTY_KEY, JSON.stringify(leaders));
    }
    return { ok: true, roster: readRoster_(), leaders: readLeaders_() };
  });
}

/** The saved choice, or null while nothing has been chosen (the displays then use their built-in defaults). */
function readRoster_() {
  return readJsonProperty_(ROSTER_PROPERTY_KEY);
}

/** The saved group leaders' names, or null while none were edited (the displays then use their built-in list). */
function readLeaders_() {
  return readJsonProperty_(LEADERS_PROPERTY_KEY);
}

function readJsonProperty_(key) {
  var raw = prop_(key);
  if (!raw) return null;
  try {
    var value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

/** type -> args validator (returns the cleaned args, or null when they are unacceptable). */
var COMMAND_ARGS_ = {
  hit: function (a) {
    var rop = validateRop_(a.rop);
    var cents = a.amount === undefined ? 100 : moneyCents_(a.amount, MAX_AMOUNT);
    return rop && cents > 0 ? { rop: rop, amount: cents / 100 } : null;
  },
  round: function (a) { var n = Number(a.n); return n === 1 || n === 2 || n === 3 ? { n: n } : null; },
  final: function (a) { return {}; },
  confetti: function (a) { return {}; },
  celebrate: function (a) { return {}; }
};

function readCommandQueue_() {
  var raw = prop_(COMMANDS_PROPERTY_KEY);
  if (!raw) return [];
  try {
    var list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return [];
  }
}

/** What the displays see on their normal poll: only commands still fresh enough to be worth playing. */
function readRecentCommands_() {
  var now = Date.now();
  return readCommandQueue_().filter(function (c) { return now - c.issuedAt <= COMMAND_MAX_AGE_MS; });
}

/* --------------------------------------------------------------- validation */

/** The stable group id, as stored in Sales. */
function validateRop_(value) {
  var rop = typeof value === 'string' ? value.trim() : '';
  return DEPARTMENT_CODES.indexOf(rop) >= 0 ? rop : '';
}

function validDay_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  var date = new Date(value + 'T00:00:00Z');
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

/** The day ('yyyy-MM-dd', sheet time zone) a "Sales" Date cell belongs to; '' if it holds no readable date. */
function saleDay_(value, tz) {
  if (value instanceof Date) return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  var m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value).trim());
  return m ? m[1] : '';
}

/** A "Sales" row with nothing in Date, Amount and ROP (other columns are ignored). */
function isBlankSale_(row, cols) {
  return String(row[cols.date]).trim() === '' && String(row[cols.amount]).trim() === '' && String(row[cols.rop]).trim() === '';
}

/** 'yyyy-MM-dd', plus ' HH:mm' unless it is exactly midnight (the sheet's own rows carry a date only). */
function formatSaleDate_(date, tz) {
  var time = Utilities.formatDate(date, tz, 'HH:mm');
  return Utilities.formatDate(date, tz, 'yyyy-MM-dd') + (time === '00:00' ? '' : ' ' + time);
}

/** `row` — the index of the offending entry when a list was sent (importSales). */
function badRequest_(field, row) {
  var res = { ok: false, error: 'bad_request', field: field };
  if (row !== undefined) res.row = row;
  return res;
}

/* ------------------------------------------------------------------- status */

function computeDailyStatus_() {
  var gameDate = readGameDate_(readSettings_());
  var plans = readPlans_();
  var codes = readGroupCodes_();
  var names = readLeaders_() || {};
  var payments = dayPayments_(gameDate);
  var now = Date.now();
  var official = readFinal_();
  var sum = function (slot, until) {
    return payments.reduce(function (c, p) { return p.slot === slot && p.at <= until ? c + Math.round(p.amount * 100) : c; }, 0) / 100;
  };
  var pct = function (slot, amount) { return plans[slot] > 0 ? amount / plans[slot] : 0; };
  return {
    ok: true,
    gameDate: gameDate,
    today: today_(),
    leaders: DEPARTMENT_CODES.map(function (slot) {
      // The official file replaces everything the leaders entered; their rows stay only as a journal.
      var amount = official ? official.official[slot] || 0 : sum(slot, Infinity);
      return {
        slot: slot, code: codes[slot], name: names[slot] || '', plan: plans[slot] || 0, amount: amount, pct: pct(slot, amount),
        count: payments.filter(function (p) { return p.slot === slot; }).length
      };
    }),
    pairs: readPairs_().map(function (p, i) { return { id: i + 1, left: p[0], right: p[1] }; }),
    payments: payments,
    rounds: roundTimes_(gameDate).map(function (r) {
      var shares = null;
      if (now >= r.at + BELL_SETTLE_MS) {
        shares = {};
        DEPARTMENT_CODES.forEach(function (slot) { shares[slot] = pct(slot, sum(slot, r.at)); });
      }
      return { n: r.n, at: r.at, shares: shares };
    }),
    final: official,
    lastUpdated: new Date(now).toISOString()
  };
}

/* ---------------------------------------------------------------------- PIN */

/** Returns null when the PIN is right, otherwise the error response to send. Counts failures and locks out guessing. */
function authorize_(pin) {
  var lockedFor = lockRemainingSec_();
  if (lockedFor > 0) return { ok: false, error: 'locked', retryAfterSec: lockedFor };

  if (!verifyPin_(pin)) {
    recordPinFailure_();
    lockedFor = lockRemainingSec_();
    return lockedFor > 0 ? { ok: false, error: 'locked', retryAfterSec: lockedFor } : { ok: false, error: 'invalid_pin' };
  }
  CacheService.getScriptCache().remove('pin_fails');
  return null;
}

function verifyPin_(pin) {
  if (pin === undefined || pin === null) return false;
  var text = String(pin);
  if (text.length === 0 || text.length > 32) return false;

  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty(PIN_HASH_PROPERTY_KEY);
  if (stored) {
    var parts = stored.split('$');
    return parts.length === 2 && hashPin_(parts[0], text) === parts[1];
  }
  var legacy = props.getProperty(PIN_PROPERTY_KEY);
  return legacy !== null && text === legacy;
}

function hashPin_(salt, pin) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

function storePin_(pin) {
  var props = PropertiesService.getScriptProperties();
  var salt = Utilities.getUuid();
  props.setProperty(PIN_HASH_PROPERTY_KEY, salt + '$' + hashPin_(salt, String(pin)));
  props.deleteProperty(PIN_PROPERTY_KEY);
  CacheService.getScriptCache().remove('pin_fails');
  CacheService.getScriptCache().remove('pin_lock_until');
}

/** `prefix` — 'pin' (the admin page) or 'group_pin' (the group leaders' page): each has its own failure count and lock. */
function lockRemainingSec_(prefix) {
  var until = Number(CacheService.getScriptCache().get((prefix || 'pin') + '_lock_until')) || 0;
  return until > Date.now() ? Math.ceil((until - Date.now()) / 1000) : 0;
}

function recordPinFailure_(prefix) {
  prefix = prefix || 'pin';
  var cache = CacheService.getScriptCache();
  var fails = (Number(cache.get(prefix + '_fails')) || 0) + 1;
  if (fails >= (prefix === 'group_pin' ? MAX_GROUP_PIN_FAILURES : MAX_PIN_FAILURES)) {
    cache.put(prefix + '_lock_until', String(Date.now() + PIN_LOCK_SEC * 1000), PIN_LOCK_SEC + 60);
    cache.remove(prefix + '_fails');
  } else {
    cache.put(prefix + '_fails', String(fails), PIN_FAILURE_WINDOW_SEC);
  }
}

/* ------------------------------------------------------------- group PINs */

/** { slot: 'salt$sha256' } — one PIN per group leader, made in the admin page; the PIN itself is never stored. */
function readGroupPins_() {
  return readJsonProperty_(GROUP_PINS_PROPERTY_KEY) || {};
}

/** The slot whose leader's PIN this is, or '' (the admin PIN is never a group PIN). */
function groupSlotForPin_(pin) {
  if (pin === undefined || pin === null) return '';
  var text = String(pin);
  if (text.length === 0 || text.length > 32) return '';
  var pins = readGroupPins_();
  for (var i = 0; i < LEADER_SLOTS.length; i++) {
    var stored = pins[LEADER_SLOTS[i]];
    if (!stored) continue;
    var parts = String(stored).split('$');
    if (parts.length === 2 && hashPin_(parts[0], text) === parts[1]) return LEADER_SLOTS[i];
  }
  return '';
}

/** { slot } when the group PIN is right, otherwise { denied: <error response> }. Its own lock: leaders mistyping never lock the admin out. */
function authorizeGroup_(pin) {
  var lockedFor = lockRemainingSec_('group_pin');
  if (lockedFor > 0) return { denied: { ok: false, error: 'locked', retryAfterSec: lockedFor } };
  var slot = groupSlotForPin_(pin);
  if (!slot) {
    recordPinFailure_('group_pin');
    lockedFor = lockRemainingSec_('group_pin');
    return { denied: lockedFor > 0 ? { ok: false, error: 'locked', retryAfterSec: lockedFor } : { ok: false, error: 'invalid_pin' } };
  }
  return { slot: slot };
}

/* ------------------------------------------------------------------- sheets */

function getSalesSheet_() {
  var sheet = getSpreadsheet_().getSheetByName(SALES_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + SALES_SHEET_NAME + '" sheet');
  return sheet;
}

/** 0-based column indexes of Date / Amount / ROP, matched by the header row. */
function salesColumns_(sheet) {
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var cols = { date: header.indexOf('Date'), amount: header.indexOf('Amount'), rop: header.indexOf('ROP') };
  if (cols.date < 0 || cols.amount < 0 || cols.rop < 0) throw new Error('Sales sheet must have Date, Amount, ROP columns');
  return cols;
}

/**
 * 0-based index of the column headed `header`; -1 if there is none yet — unless `create`, which then
 * adds it right after the last used column (so a sheet made before that column existed keeps working).
 */
function headerColumn_(sheet, header, create) {
  var width = Math.max(1, sheet.getLastColumn());
  var index = sheet.getRange(1, 1, 1, width).getValues()[0].indexOf(header);
  if (index >= 0 || !create) return index;
  var column = sheet.getLastColumn() + 1;
  if (sheet.getMaxColumns() < column) sheet.insertColumnsAfter(sheet.getMaxColumns(), column - sheet.getMaxColumns());
  var cell = sheet.getRange(1, column);
  cell.setValue(header);
  cell.setFontWeight('bold');
  // Keep leading zeros in invoice numbers and payment IDs.
  if (header === INVOICE_HEADER || header === PAYMENT_ID_HEADER) sheet.getRange(2, column, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  return column - 1;
}

function getSettingsSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!sheet) throw new Error('Missing "' + SETTINGS_SHEET_NAME + '" sheet');
  return sheet;
}

/** All "Settings" rows as { Key: Value } — one read of the sheet for however many settings are needed. */
function readSettings_() {
  var values = getSettingsSheet_().getDataRange().getValues();
  var settings = {};
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] !== '') settings[String(values[i][0])] = values[i][1];
  }
  return settings;
}

/** Serialises writers (two admins clicking at once must not both read the same command counter / interleave rows). */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
