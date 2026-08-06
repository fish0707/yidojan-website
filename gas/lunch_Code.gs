/**
 * 午餐訂單彙整系統 — Google Apps Script 後端
 *
 * 部署方式與 Sheet 欄位定義請見 gas/README.md
 *
 * 慣例（與現有 admin.html / liff_order.html / ipad_dashboard.html 相同）：
 *   GET  ?action=xxx&...          → doGet
 *   POST body = JSON {action:...} → doPost
 *   一律回傳 JSON，成功 {status:'success',...}，失敗 {status:'error', code, error}
 */

// ─── 常數 ─────────────────────────────────────────────────────────────────────
var SHEET_RESTAURANTS = 'Restaurants';
var SHEET_MENU_ITEMS  = 'MenuItems';
var SHEET_SESSIONS    = 'Sessions';
var SHEET_ORDERS      = 'Orders';

var HEADERS = {};
HEADERS[SHEET_RESTAURANTS] = ['restaurantId', 'name', 'phone', 'note', 'active', 'menuImageUrl'];
HEADERS[SHEET_MENU_ITEMS]  = ['itemId', 'restaurantId', 'name', 'price', 'category', 'available'];
HEADERS[SHEET_SESSIONS]    = ['sessionId', 'restaurantId', 'title', 'createdBy', 'createdAt', 'closeAt', 'status', 'rev'];
HEADERS[SHEET_ORDERS]      = ['orderId', 'sessionId', 'name', 'clientToken', 'itemsJson', 'total', 'note', 'createdAt', 'updatedAt', 'deleted'];

var LOCK_TIMEOUT_MS = 10000;
var MAX_ITEMS_PER_ORDER = 30;
var MAX_PRICE = 100000;

// ─── 菜單 DM 辨識 ─────────────────────────────────────────────────────────────
// API key 放在「專案設定 → 指令碼屬性」，key 名稱 GEMINI_API_KEY。
// 絕對不要寫在這裡，也不要寫進前端 —— repo 和網站都是公開的。
// 模型可用指令碼屬性 GEMINI_MODEL 覆蓋，Google 換名字時不用重貼程式碼、不用重新部署。
// 你的金鑰實際支援哪些模型，執行 authorizeAndSelfTest 就會列出來。
var GEMINI_MODEL_DEFAULT = 'gemini-2.5-flash';
var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
var MAX_IMAGE_BYTES = 6 * 1024 * 1024;   // 前端會先壓縮，這是保險
var MAX_PARSED_ITEMS = 120;

function geminiKey_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

function geminiModel_() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || GEMINI_MODEL_DEFAULT;
}

/**
 * Apps Script 是「用到哪些服務就要哪些權限」，而授權是在使用者第一次同意時定下來的。
 * 後來程式碼新增了 UrlFetchApp / DriveApp，舊的授權不涵蓋它們，呼叫就會被本機端擋下來
 * （錯誤訊息長得像「你沒有呼叫 UrlFetchApp.fetch 的權限」），根本沒送出去過。
 * 這裡把 GAS 的原始訊息翻成使用者知道該做什麼的話。
 */
function isAuthError_(message) {
  var m = String(message || '');
  return m.indexOf('script.external_request') !== -1
      || m.indexOf('auth/drive') !== -1
      || m.indexOf('PERMISSION_DENIED') !== -1
      || (m.indexOf('權限') !== -1 && m.indexOf('必要') !== -1)
      || m.indexOf('does not have permission') !== -1
      || m.indexOf('Authorization is required') !== -1;
}

var AUTH_HINT = '指令碼還沒取得對外連線／Drive 的權限。'
  + '請到 Apps Script 編輯器執行一次 authorizeAndSelfTest 完成授權，再重新部署。';

// ─── 入口 ─────────────────────────────────────────────────────────────────────
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  try {
    switch (action) {
      case 'getBootstrap':   return json(getBootstrap_(e.parameter));
      case 'getSession':     return json(getSession_(e.parameter));
      case 'poll':           return json(poll_(e.parameter));
      case 'getRestaurants': return json(getRestaurants_());
      case 'getSummary':     return json(getSummary_(e.parameter));
      case 'getHistory':     return json(getHistory_(e.parameter));
      case 'ping':           return json({ status: 'success', serverNow: Date.now() });
      default:               return json(err('UNKNOWN_ACTION', '不支援的 action：' + action));
    }
  } catch (ex) {
    return json(err('SERVER_ERROR', String(ex && ex.message ? ex.message : ex)));
  }
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (ex) {
    return json(err('BAD_JSON', '請求格式錯誤'));
  }

  var action = body.action || '';
  try {
    switch (action) {
      case 'createSession':   return json(withLock_(function () { return createSession_(body); }));
      case 'closeSession':    return json(withLock_(function () { return closeSession_(body); }));
      case 'extendSession':   return json(withLock_(function () { return extendSession_(body); }));
      case 'submitOrder':     return json(withLock_(function () { return submitOrder_(body); }));
      case 'updateOrder':     return json(withLock_(function () { return updateOrder_(body); }));
      case 'deleteOrder':     return json(withLock_(function () { return deleteOrder_(body); }));
      case 'upsertRestaurant':return json(withLock_(function () { return upsertRestaurant_(body); }));
      case 'upsertMenuItem':  return json(withLock_(function () { return upsertMenuItem_(body); }));
      case 'deleteMenuItem':  return json(withLock_(function () { return deleteMenuItem_(body); }));
      // 辨識要跑十幾秒，不能佔著全域鎖讓正在送單的人卡住；它也不寫試算表
      case 'parseMenuImage':  return json(parseMenuImage_(body));
      case 'applyParsedMenu': return json(withLock_(function () { return applyParsedMenu_(body); }));
      default:                return json(err('UNKNOWN_ACTION', '不支援的 action：' + action));
    }
  } catch (ex) {
    return json(err('SERVER_ERROR', String(ex && ex.message ? ex.message : ex)));
  }
}

// ─── 共用工具 ─────────────────────────────────────────────────────────────────
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function err(code, message) {
  return { status: 'error', code: code, error: message };
}

/**
 * 所有寫入都必須包在這裡。
 * GAS 沒有交易，兩個人同時送單時 read → modify → write 會互相覆蓋，
 * ScriptLock 是唯一能避免資料遺失的方法。
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return err('BUSY', '系統忙碌中，請稍後再試一次');
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/** 取得工作表，不存在就依 HEADERS 建立；已存在但缺欄位就補上 */
function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) {
    s = ss_().insertSheet(name);
    s.appendRow(HEADERS[name]);
    s.setFrozenRows(1);
    return s;
  }
  ensureHeaders_(s, name);
  return s;
}

/**
 * 後來版本新增的欄位（例如 menuImageUrl），在已經建好的試算表上自動補到標題列尾端，
 * 使用者不用重建試算表或手動加欄位。只會補、不會動既有欄位的順序。
 */
function ensureHeaders_(s, name) {
  var want = HEADERS[name];
  if (s.getLastRow() === 0) {
    s.appendRow(want);
    s.setFrozenRows(1);
    return;
  }
  var width = Math.max(s.getLastColumn(), 1);
  var have = s.getRange(1, 1, 1, width).getValues()[0];

  var missing = [];
  for (var i = 0; i < want.length; i++) {
    if (have.indexOf(want[i]) === -1) missing.push(want[i]);
  }
  if (missing.length === 0) return;

  s.getRange(1, width + 1, 1, missing.length).setValues([missing]);
}

/** 讀整張表成物件陣列（含 _row 實際列號，供更新用） */
function readAll_(name) {
  var s = sheet_(name);
  var values = s.getDataRange().getValues();
  if (values.length < 2) return [];

  var header = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = { _row: i + 1 };
    for (var c = 0; c < header.length; c++) {
      obj[header[c]] = values[i][c];
    }
    rows.push(obj);
  }
  return rows;
}

/** 依 header 順序寫回單一列 */
function writeRow_(name, rowNumber, obj) {
  var s = sheet_(name);
  var header = HEADERS[name];
  var arr = header.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  s.getRange(rowNumber, 1, 1, header.length).setValues([arr]);
}

function appendRow_(name, obj) {
  var s = sheet_(name);
  var header = HEADERS[name];
  s.appendRow(header.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; }));
}

function uid_(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Sheet 讀出來可能是 Date 也可能是字串，統一成毫秒數字 */
function toMillis_(v) {
  if (v === '' || v === null || v === undefined) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

function truthy_(v) {
  if (typeof v === 'boolean') return v;
  var s = String(v).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

function toInt_(v, fallback) {
  var n = parseInt(v, 10);
  return isNaN(n) ? (fallback || 0) : n;
}

function clean_(s, maxLen) {
  return String(s === null || s === undefined ? '' : s).trim().slice(0, maxLen || 200);
}

// ─── Sessions ────────────────────────────────────────────────────────────────
function findSession_(sessionId) {
  var rows = readAll_(SHEET_SESSIONS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].sessionId) === String(sessionId)) return rows[i];
  }
  return null;
}

/** 目前仍在收單、或今天最新的一場 */
function findActiveSession_() {
  var rows = readAll_(SHEET_SESSIONS);
  var now = Date.now();
  var best = null;

  for (var i = 0; i < rows.length; i++) {
    var s = rows[i];
    if (s.status !== 'open') continue;
    if (toMillis_(s.closeAt) <= now) continue;
    if (!best || toMillis_(s.createdAt) > toMillis_(best.createdAt)) best = s;
  }
  if (best) return best;

  // 沒有收單中的，退而求其次回傳最近一場（讓大家還看得到彙整）
  for (var j = 0; j < rows.length; j++) {
    if (!best || toMillis_(rows[j].createdAt) > toMillis_(best.createdAt)) best = rows[j];
  }
  return best;
}

/** 場次是否還能收單（時間到就順手把 status 落地成 closed） */
function sessionOpen_(session) {
  if (!session) return false;
  if (session.status !== 'open') return false;
  if (toMillis_(session.closeAt) <= Date.now()) {
    session.status = 'closed';
    writeRow_(SHEET_SESSIONS, session._row, session);
    return false;
  }
  return true;
}

function bumpRev_(session) {
  session.rev = toInt_(session.rev, 0) + 1;
  writeRow_(SHEET_SESSIONS, session._row, session);
  return session.rev;
}

function sessionPayload_(session) {
  if (!session) return null;
  return {
    sessionId:    session.sessionId,
    restaurantId: session.restaurantId,
    title:        session.title,
    createdBy:    session.createdBy,
    createdAt:    toMillis_(session.createdAt),
    closeAt:      toMillis_(session.closeAt),
    status:       toMillis_(session.closeAt) <= Date.now() ? 'closed' : session.status,
    rev:          toInt_(session.rev, 0)
  };
}

function createSession_(body) {
  var restaurantId = clean_(body.restaurantId, 64);
  var closeAt      = toMillis_(body.closeAt);
  if (!restaurantId) return err('BAD_INPUT', '請選擇餐廳');
  if (!closeAt)      return err('BAD_INPUT', '請設定截止時間');
  if (closeAt <= Date.now()) return err('BAD_INPUT', '截止時間必須晚於現在');

  var restaurant = findRestaurant_(restaurantId);
  if (!restaurant) return err('NOT_FOUND', '找不到這間餐廳');

  // 同時只允許一場收單中，避免大家點到不同場
  var rows = readAll_(SHEET_SESSIONS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status === 'open' && toMillis_(rows[i].closeAt) > Date.now()) {
      return err('ALREADY_OPEN', '目前已有一場收單中：' + rows[i].title);
    }
  }

  var session = {
    sessionId:    uid_('s'),
    restaurantId: restaurantId,
    title:        clean_(body.title, 100) || (restaurant.name + ' 午餐'),
    createdBy:    clean_(body.createdBy, 50),
    createdAt:    Date.now(),
    closeAt:      closeAt,
    status:       'open',
    rev:          1
  };
  appendRow_(SHEET_SESSIONS, session);

  return {
    status:    'success',
    serverNow: Date.now(),
    session:   sessionPayload_(session)
  };
}

function closeSession_(body) {
  var session = findSession_(clean_(body.sessionId, 64));
  if (!session) return err('NOT_FOUND', '找不到這場訂單');

  session.status = 'closed';
  session.rev = toInt_(session.rev, 0) + 1;
  writeRow_(SHEET_SESSIONS, session._row, session);

  return { status: 'success', serverNow: Date.now(), session: sessionPayload_(session) };
}

function extendSession_(body) {
  var session = findSession_(clean_(body.sessionId, 64));
  if (!session) return err('NOT_FOUND', '找不到這場訂單');

  var minutes = toInt_(body.minutes, 10);
  if (minutes <= 0 || minutes > 180) return err('BAD_INPUT', '延長時間需介於 1～180 分鐘');

  // 已經截止的話從「現在」起算，否則從原截止時間往後推
  var base = Math.max(toMillis_(session.closeAt), Date.now());
  session.closeAt = base + minutes * 60000;
  session.status  = 'open';
  session.rev     = toInt_(session.rev, 0) + 1;
  writeRow_(SHEET_SESSIONS, session._row, session);

  return { status: 'success', serverNow: Date.now(), session: sessionPayload_(session) };
}

// ─── Restaurants / MenuItems ─────────────────────────────────────────────────
function findRestaurant_(restaurantId) {
  var rows = readAll_(SHEET_RESTAURANTS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].restaurantId) === String(restaurantId)) return rows[i];
  }
  return null;
}

function restaurantPayload_(r) {
  if (!r) return null;
  return {
    restaurantId: r.restaurantId,
    name:         r.name,
    phone:        r.phone,
    note:         r.note,
    active:       truthy_(r.active),
    menuImageUrl: r.menuImageUrl || ''
  };
}

function menuPayload_(restaurantId, includeUnavailable) {
  var rows = readAll_(SHEET_MENU_ITEMS);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var m = rows[i];
    if (restaurantId && String(m.restaurantId) !== String(restaurantId)) continue;
    if (!includeUnavailable && !truthy_(m.available)) continue;
    out.push({
      itemId:       m.itemId,
      restaurantId: m.restaurantId,
      name:         m.name,
      price:        toInt_(m.price, 0),
      category:     m.category || '',
      available:    truthy_(m.available)
    });
  }
  return out;
}

function getRestaurants_() {
  var rows = readAll_(SHEET_RESTAURANTS);
  var list = rows.map(function (r) {
    var p = restaurantPayload_(r);
    p.menu = menuPayload_(r.restaurantId, true);
    return p;
  });
  return { status: 'success', serverNow: Date.now(), restaurants: list };
}

function upsertRestaurant_(body) {
  var name = clean_(body.name, 60);
  if (!name) return err('BAD_INPUT', '請輸入餐廳名稱');

  var id = clean_(body.restaurantId, 64);
  var existing = id ? findRestaurant_(id) : null;

  if (existing) {
    existing.name   = name;
    existing.phone  = clean_(body.phone, 30);
    existing.note   = clean_(body.note, 200);
    existing.active = body.active === undefined ? truthy_(existing.active) : !!body.active;
    if (body.menuImageUrl !== undefined) existing.menuImageUrl = clean_(body.menuImageUrl, 300);
    writeRow_(SHEET_RESTAURANTS, existing._row, existing);
    return { status: 'success', restaurant: restaurantPayload_(existing) };
  }

  var r = {
    restaurantId: uid_('r'),
    name:         name,
    phone:        clean_(body.phone, 30),
    note:         clean_(body.note, 200),
    active:       body.active === undefined ? true : !!body.active,
    menuImageUrl: clean_(body.menuImageUrl, 300)
  };
  appendRow_(SHEET_RESTAURANTS, r);
  return { status: 'success', restaurant: restaurantPayload_(r) };
}

function upsertMenuItem_(body) {
  var restaurantId = clean_(body.restaurantId, 64);
  var name  = clean_(body.name, 60);
  var price = toInt_(body.price, -1);

  if (!restaurantId) return err('BAD_INPUT', '缺少餐廳');
  if (!name)         return err('BAD_INPUT', '請輸入品項名稱');
  if (price < 0 || price > MAX_PRICE) return err('BAD_INPUT', '價格不正確');

  var id = clean_(body.itemId, 64);
  if (id) {
    var rows = readAll_(SHEET_MENU_ITEMS);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].itemId) === id) {
        var m = rows[i];
        m.name      = name;
        m.price     = price;
        m.category  = clean_(body.category, 40);
        m.available = body.available === undefined ? truthy_(m.available) : !!body.available;
        writeRow_(SHEET_MENU_ITEMS, m._row, m);
        return { status: 'success', menu: menuPayload_(restaurantId, true) };
      }
    }
  }

  appendRow_(SHEET_MENU_ITEMS, {
    itemId:       uid_('m'),
    restaurantId: restaurantId,
    name:         name,
    price:        price,
    category:     clean_(body.category, 40),
    available:    body.available === undefined ? true : !!body.available
  });
  return { status: 'success', menu: menuPayload_(restaurantId, true) };
}

function deleteMenuItem_(body) {
  var id = clean_(body.itemId, 64);
  if (!id) return err('BAD_INPUT', '缺少品項 ID');

  var s = sheet_(SHEET_MENU_ITEMS);
  var rows = readAll_(SHEET_MENU_ITEMS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].itemId) === id) {
      s.deleteRow(rows[i]._row);
      return { status: 'success' };
    }
  }
  return err('NOT_FOUND', '找不到這個品項');
}

// ─── Orders ──────────────────────────────────────────────────────────────────
function orderPayload_(o) {
  var items = [];
  try { items = JSON.parse(o.itemsJson || '[]'); } catch (ex) { items = []; }
  return {
    orderId:   o.orderId,
    sessionId: o.sessionId,
    name:      o.name,
    items:     items,
    total:     toInt_(o.total, 0),
    note:      o.note || '',
    createdAt: toMillis_(o.createdAt),
    updatedAt: toMillis_(o.updatedAt)
  };
}

function ordersOf_(sessionId) {
  var rows = readAll_(SHEET_ORDERS);
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].sessionId) !== String(sessionId)) continue;
    if (truthy_(rows[i].deleted)) continue;
    out.push(orderPayload_(rows[i]));
  }
  out.sort(function (a, b) { return a.createdAt - b.createdAt; });
  return out;
}

/**
 * 正規化並驗算品項。
 * 金額一律由後端重算，不信任前端送來的 total。
 */
function normalizeItems_(rawItems) {
  if (!rawItems || !rawItems.length) return { error: '請至少點一個品項' };
  if (rawItems.length > MAX_ITEMS_PER_ORDER) return { error: '單筆訂單品項過多' };

  var items = [];
  var total = 0;
  for (var i = 0; i < rawItems.length; i++) {
    var it = rawItems[i] || {};
    var name  = clean_(it.name, 60);
    var price = toInt_(it.price, -1);
    var qty   = toInt_(it.qty, 0);

    if (!name) return { error: '品項名稱不可空白' };
    if (price < 0 || price > MAX_PRICE) return { error: '「' + name + '」的價格不正確' };
    if (qty < 1 || qty > 99) return { error: '「' + name + '」的數量不正確' };

    items.push({ name: name, price: price, qty: qty, note: clean_(it.note, 100) });
    total += price * qty;
  }
  return { items: items, total: total };
}

function submitOrder_(body) {
  var session = findSession_(clean_(body.sessionId, 64));
  if (!session) return err('NOT_FOUND', '找不到這場訂單');
  if (!sessionOpen_(session)) return err('CLOSED', '已經停止收單囉');

  var name  = clean_(body.name, 30);
  var token = clean_(body.clientToken, 64);
  if (!name)  return err('BAD_INPUT', '請填寫你的名字');
  if (!token) return err('BAD_INPUT', '缺少識別碼，請重新整理頁面');

  var norm = normalizeItems_(body.items);
  if (norm.error) return err('BAD_INPUT', norm.error);

  var now = Date.now();
  var order = {
    orderId:     uid_('o'),
    sessionId:   session.sessionId,
    name:        name,
    clientToken: token,
    itemsJson:   JSON.stringify(norm.items),
    total:       norm.total,
    note:        clean_(body.note, 200),
    createdAt:   now,
    updatedAt:   now,
    deleted:     false
  };
  appendRow_(SHEET_ORDERS, order);
  var rev = bumpRev_(session);

  return {
    status:    'success',
    serverNow: Date.now(),
    rev:       rev,
    order:     orderPayload_(order),
    orders:    ordersOf_(session.sessionId)
  };
}

function findOrderRow_(orderId) {
  var rows = readAll_(SHEET_ORDERS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].orderId) === String(orderId)) return rows[i];
  }
  return null;
}

/** 訂單擁有者（同 clientToken）或主揪（isAdmin）才能異動 */
function canModify_(row, body) {
  if (body.isAdmin === true) return true;
  var token = clean_(body.clientToken, 64);
  return !!token && String(row.clientToken) === token;
}

function updateOrder_(body) {
  var row = findOrderRow_(clean_(body.orderId, 64));
  if (!row || truthy_(row.deleted)) return err('NOT_FOUND', '找不到這筆訂單');

  var session = findSession_(row.sessionId);
  if (!sessionOpen_(session) && body.isAdmin !== true) return err('CLOSED', '已經停止收單，無法修改');
  if (!canModify_(row, body)) return err('FORBIDDEN', '這不是你的訂單，無法修改');

  var norm = normalizeItems_(body.items);
  if (norm.error) return err('BAD_INPUT', norm.error);

  row.name      = clean_(body.name, 30) || row.name;
  row.itemsJson = JSON.stringify(norm.items);
  row.total     = norm.total;
  row.note      = clean_(body.note, 200);
  row.updatedAt = Date.now();
  writeRow_(SHEET_ORDERS, row._row, row);
  var rev = bumpRev_(session);

  return {
    status:    'success',
    serverNow: Date.now(),
    rev:       rev,
    order:     orderPayload_(row),
    orders:    ordersOf_(session.sessionId)
  };
}

function deleteOrder_(body) {
  var row = findOrderRow_(clean_(body.orderId, 64));
  if (!row || truthy_(row.deleted)) return err('NOT_FOUND', '找不到這筆訂單');

  var session = findSession_(row.sessionId);
  if (!sessionOpen_(session) && body.isAdmin !== true) return err('CLOSED', '已經停止收單，無法刪除');
  if (!canModify_(row, body)) return err('FORBIDDEN', '這不是你的訂單，無法刪除');

  row.deleted   = true;          // 軟刪除，保留稽核痕跡
  row.updatedAt = Date.now();
  writeRow_(SHEET_ORDERS, row._row, row);
  var rev = bumpRev_(session);

  return {
    status:    'success',
    serverNow: Date.now(),
    rev:       rev,
    orders:    ordersOf_(session.sessionId)
  };
}

// ─── 查詢 ─────────────────────────────────────────────────────────────────────
function buildSessionView_(session) {
  if (!session) {
    return { status: 'success', serverNow: Date.now(), session: null, orders: [], restaurant: null, menu: [] };
  }
  sessionOpen_(session); // 順手把逾時的場次落地成 closed
  var restaurant = findRestaurant_(session.restaurantId);
  return {
    status:     'success',
    serverNow:  Date.now(),
    session:    sessionPayload_(session),
    restaurant: restaurantPayload_(restaurant),
    menu:       menuPayload_(session.restaurantId, false),
    orders:     ordersOf_(session.sessionId)
  };
}

function getBootstrap_(params) {
  var sessionId = clean_(params.sessionId, 64);
  var session = sessionId ? findSession_(sessionId) : findActiveSession_();
  return buildSessionView_(session);
}

function getSession_(params) {
  var session = findSession_(clean_(params.sessionId, 64));
  if (!session) return err('NOT_FOUND', '找不到這場訂單');
  return buildSessionView_(session);
}

/** 輕量輪詢：rev 沒變就不回傳訂單，省流量也讓前端知道不用重繪 */
function poll_(params) {
  var session = findSession_(clean_(params.sessionId, 64));
  if (!session) return err('NOT_FOUND', '找不到這場訂單');

  sessionOpen_(session);
  var rev       = toInt_(session.rev, 0);
  var clientRev = toInt_(params.rev, -1);
  var payload   = sessionPayload_(session);

  if (clientRev === rev) {
    return { status: 'success', serverNow: Date.now(), rev: rev, changed: false, session: payload };
  }
  return {
    status:    'success',
    serverNow: Date.now(),
    rev:       rev,
    changed:   true,
    session:   payload,
    orders:    ordersOf_(session.sessionId)
  };
}

/**
 * 兩種彙總視角：
 *   byItem   → 給店家點餐用（品項 × 數量）
 *   byPerson → 給收錢對帳用（每人應付）
 */
function getSummary_(params) {
  var session = findSession_(clean_(params.sessionId, 64));
  if (!session) return err('NOT_FOUND', '找不到這場訂單');

  var orders = ordersOf_(session.sessionId);
  var itemMap = {};
  var byPerson = [];
  var grandTotal = 0;
  var totalQty = 0;

  for (var i = 0; i < orders.length; i++) {
    var o = orders[i];
    grandTotal += o.total;
    byPerson.push({ name: o.name, items: o.items, total: o.total, note: o.note, orderId: o.orderId });

    for (var j = 0; j < o.items.length; j++) {
      var it = o.items[j];
      // 同名但不同備註要分開列，店家才知道哪一份要客製
      var key = it.name + '||' + it.price + '||' + (it.note || '');
      if (!itemMap[key]) {
        itemMap[key] = { name: it.name, price: it.price, note: it.note || '', qty: 0, subtotal: 0, who: [] };
      }
      itemMap[key].qty      += it.qty;
      itemMap[key].subtotal += it.price * it.qty;
      itemMap[key].who.push(o.name);
      totalQty += it.qty;
    }
  }

  var byItem = Object.keys(itemMap).map(function (k) { return itemMap[k]; });
  byItem.sort(function (a, b) {
    if (b.qty !== a.qty) return b.qty - a.qty;
    return a.name < b.name ? -1 : 1;
  });

  return {
    status:      'success',
    serverNow:   Date.now(),
    session:     sessionPayload_(session),
    restaurant:  restaurantPayload_(findRestaurant_(session.restaurantId)),
    byItem:      byItem,
    byPerson:    byPerson,
    grandTotal:  grandTotal,
    totalQty:    totalQty,
    peopleCount: byPerson.length
  };
}

function getHistory_(params) {
  var limit = Math.min(toInt_(params.limit, 20), 100);
  var sessions = readAll_(SHEET_SESSIONS);
  sessions.sort(function (a, b) { return toMillis_(b.createdAt) - toMillis_(a.createdAt); });
  sessions = sessions.slice(0, limit);

  var allOrders = readAll_(SHEET_ORDERS);
  var statsBySession = {};
  var spendByPerson = {};
  var countByRestaurant = {};

  for (var i = 0; i < allOrders.length; i++) {
    var o = allOrders[i];
    if (truthy_(o.deleted)) continue;
    var sid = String(o.sessionId);
    if (!statsBySession[sid]) statsBySession[sid] = { count: 0, total: 0 };
    statsBySession[sid].count += 1;
    statsBySession[sid].total += toInt_(o.total, 0);

    var who = String(o.name);
    spendByPerson[who] = (spendByPerson[who] || 0) + toInt_(o.total, 0);
  }

  var list = sessions.map(function (s) {
    var st = statsBySession[String(s.sessionId)] || { count: 0, total: 0 };
    var r = findRestaurant_(s.restaurantId);
    var rname = r ? r.name : '(已刪除的餐廳)';
    countByRestaurant[rname] = (countByRestaurant[rname] || 0) + 1;
    var p = sessionPayload_(s);
    p.restaurantName = rname;
    p.orderCount = st.count;
    p.total = st.total;
    return p;
  });

  var topRestaurants = Object.keys(countByRestaurant)
    .map(function (k) { return { name: k, times: countByRestaurant[k] }; })
    .sort(function (a, b) { return b.times - a.times; });

  var topSpenders = Object.keys(spendByPerson)
    .map(function (k) { return { name: k, total: spendByPerson[k] }; })
    .sort(function (a, b) { return b.total - a.total; });

  return {
    status:         'success',
    serverNow:      Date.now(),
    sessions:       list,
    topRestaurants: topRestaurants,
    topSpenders:    topSpenders
  };
}

// ─── 菜單 DM 辨識 ─────────────────────────────────────────────────────────────

/**
 * 把一張菜單 DM 丟給 Gemini，要它吐出結構化的品項清單。
 *
 * 刻意「不」寫進試算表，也「不」包在 withLock_ 裡：
 * 這支要跑十幾秒，佔著全域鎖會讓正在送單的同事全部卡住。
 * 真正落地是使用者在確認畫面按下去之後的 applyParsedMenu。
 */
function parseMenuImage_(body) {
  var key = geminiKey_();
  if (!key) {
    return err('NO_API_KEY', '還沒設定 GEMINI_API_KEY，請到「專案設定 → 指令碼屬性」新增');
  }
  var model = geminiModel_();

  var base64 = String(body.base64Data || '');
  var mime   = clean_(body.mimeType, 60) || 'image/jpeg';
  if (!base64) return err('BAD_INPUT', '沒有收到圖片');
  // base64 每 4 個字元代表 3 bytes
  if (base64.length * 3 / 4 > MAX_IMAGE_BYTES) return err('TOO_LARGE', '圖片太大，請重拍或裁切後再試');
  if (mime.indexOf('image/') !== 0) return err('BAD_INPUT', '只接受圖片檔');

  var prompt = [
    '這是一張台灣餐廳的菜單 DM 或價目表照片。請讀出上面所有可以點的餐點品項與價格。',
    '',
    '規則：',
    '1. 價格一律用新台幣整數，不要小數點、不要 $ 或「元」。',
    '2. 同一個品項若有大小份、冷熱、套餐等不同價格，拆成多筆，把差異寫進品項名稱，',
    '   例如「牛肉麵(大)」「牛肉麵(小)」「紅茶(冰)」。',
    '3. 只抓真的可以點的餐點。店名、地址、電話、營業時間、外送說明、',
    '   「加飯免費」這類附註都不要當成品項。',
    '4. 看不清楚價格的品項就不要收錄，不要猜。',
    '5. category 只能是：主餐、飲料、配菜、湯品、甜點、其他。判斷不出來就填「其他」。',
    '6. restaurantName 與 phone 如果 DM 上沒有就留空字串。',
    '7. 品項名稱用圖片上的原文，不要翻譯、不要自己改寫。'
  ].join('\n');

  var payload = {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mime, data: base64 } }
      ]
    }],
    generationConfig: {
      temperature: 0,          // 抄字不需要創意
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          restaurantName: { type: 'STRING' },
          phone:          { type: 'STRING' },
          items: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name:     { type: 'STRING' },
                price:    { type: 'INTEGER' },
                category: { type: 'STRING', enum: ['主餐', '飲料', '配菜', '湯品', '甜點', '其他'] }
              },
              required: ['name', 'price', 'category']
            }
          }
        },
        required: ['restaurantName', 'phone', 'items']
      }
    }
  };

  var url = GEMINI_API_BASE + '/' + model + ':generateContent?key=' + encodeURIComponent(key);
  var res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (ex) {
    // 授權不足會在這裡爆，而且請求根本沒送出去 —— 不要讓使用者誤以為是額度或計費問題
    if (isAuthError_(ex.message)) return err('NEED_AUTH', AUTH_HINT);
    return err('UPSTREAM', '呼叫辨識服務失敗：' + ex.message);
  }

  var code = res.getResponseCode();
  var text = res.getContentText();

  if (code === 429) return err('RATE_LIMIT', '辨識額度用完了（每分鐘或每日上限），等一下或明天再試');
  if (code === 403 || (code === 400 && text.indexOf('API_KEY_INVALID') !== -1)) {
    return err('BAD_API_KEY', 'GEMINI_API_KEY 無效或未啟用，請重新產生一組並更新指令碼屬性');
  }
  if (code === 404 || text.indexOf('is not found') !== -1 || text.indexOf('NOT_FOUND') !== -1) {
    return err('BAD_MODEL', '模型「' + model + '」不存在或你的金鑰無法使用。'
      + '請在 Apps Script 執行 authorizeAndSelfTest 看可用模型清單，'
      + '再用指令碼屬性 GEMINI_MODEL 指定其中一個。');
  }
  if (code !== 200) return err('UPSTREAM', '辨識服務回傳錯誤（' + code + '）：' + text.slice(0, 300));

  var parsed;
  try {
    var envelope = JSON.parse(text);
    var cand = envelope.candidates && envelope.candidates[0];
    if (!cand) return err('NO_RESULT', '辨識服務沒有回傳結果，請換一張清楚一點的照片');
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      return err('NO_RESULT', '辨識中斷（' + cand.finishReason + '），請換一張照片再試');
    }
    parsed = JSON.parse(cand.content.parts[0].text);
  } catch (ex) {
    return err('BAD_RESULT', '看不懂辨識結果，請換一張照片再試');
  }

  // 後端自己再過濾一次，不信任模型的輸出
  var items = [];
  var raw = parsed.items || [];
  for (var i = 0; i < raw.length && items.length < MAX_PARSED_ITEMS; i++) {
    var name  = clean_(raw[i].name, 60);
    var price = toInt_(raw[i].price, -1);
    if (!name) continue;
    if (price < 0 || price > MAX_PRICE) continue;
    items.push({ name: name, price: price, category: clean_(raw[i].category, 40) || '其他' });
  }

  if (items.length === 0) {
    return err('NO_ITEMS', '這張圖沒有辨識到任何品項，請確認拍的是菜單，並讓文字清楚一點');
  }

  return {
    status:         'success',
    serverNow:      Date.now(),
    restaurantName: clean_(parsed.restaurantName, 60),
    phone:          clean_(parsed.phone, 30),
    items:          items
  };
}

/** 把確認過的品項寫進試算表；replace 會清掉這間餐廳原本的菜單 */
function applyParsedMenu_(body) {
  var mode = body.mode === 'append' ? 'append' : 'replace';

  var rawItems = body.items || [];
  if (!rawItems.length) return err('BAD_INPUT', '沒有要套用的品項');
  if (rawItems.length > MAX_PARSED_ITEMS) return err('BAD_INPUT', '品項數量過多');

  var items = [];
  for (var i = 0; i < rawItems.length; i++) {
    var name  = clean_(rawItems[i].name, 60);
    var price = toInt_(rawItems[i].price, -1);
    if (!name) return err('BAD_INPUT', '有品項的名稱是空的');
    if (price < 0 || price > MAX_PRICE) return err('BAD_INPUT', '「' + name + '」的價格不正確');
    items.push({ name: name, price: price, category: clean_(rawItems[i].category, 40) });
  }

  // 餐廳：有帶 restaurantId 就更新，沒有就新開一間
  var restaurant;
  var rid = clean_(body.restaurantId, 64);
  if (rid) {
    restaurant = findRestaurant_(rid);
    if (!restaurant) return err('NOT_FOUND', '找不到這間餐廳');
    if (body.name)  restaurant.name  = clean_(body.name, 60);
    if (body.phone !== undefined) restaurant.phone = clean_(body.phone, 30);
  } else {
    var newName = clean_(body.name, 60);
    if (!newName) return err('BAD_INPUT', '請輸入餐廳名稱');
    restaurant = {
      restaurantId: uid_('r'),
      name:         newName,
      phone:        clean_(body.phone, 30),
      note:         clean_(body.note, 200),
      active:       true,
      menuImageUrl: ''
    };
    appendRow_(SHEET_RESTAURANTS, restaurant);
    restaurant = findRestaurant_(restaurant.restaurantId);
  }

  // 原始 DM 存到 Drive，點餐頁可以點開來對照
  var imageWarning = '';
  if (body.base64Data) {
    var saved = saveMenuImage_(body.base64Data, body.mimeType, restaurant.name);
    if (saved.url) restaurant.menuImageUrl = saved.url;
    else imageWarning = saved.error;
  }
  writeRow_(SHEET_RESTAURANTS, restaurant._row, restaurant);

  // replace：先把舊品項整批刪掉（由下往上刪，避免列號位移）
  if (mode === 'replace') {
    var s = sheet_(SHEET_MENU_ITEMS);
    var rows = readAll_(SHEET_MENU_ITEMS);
    for (var j = rows.length - 1; j >= 0; j--) {
      if (String(rows[j].restaurantId) === String(restaurant.restaurantId)) s.deleteRow(rows[j]._row);
    }
  }

  for (var k = 0; k < items.length; k++) {
    appendRow_(SHEET_MENU_ITEMS, {
      itemId:       uid_('m'),
      restaurantId: restaurant.restaurantId,
      name:         items[k].name,
      price:        items[k].price,
      category:     items[k].category,
      available:    true
    });
  }

  return {
    status:       'success',
    serverNow:    Date.now(),
    restaurant:   restaurantPayload_(restaurant),
    menu:         menuPayload_(restaurant.restaurantId, true),
    imageWarning: imageWarning      // 菜單有進去、但原圖沒存成功時給前端提示用
  };
}

/**
 * 存 DM 原圖到 Drive 並開放「知道連結的人可讀」。
 * 回傳 {url} 或 {error}——存圖失敗不該讓整個套用失敗，菜單本身才是重點，
 * 但也不能靜默吞掉，否則使用者會以為功能壞了卻查不到原因。
 */
function saveMenuImage_(base64Data, mimeType, restaurantName) {
  try {
    var mime = clean_(mimeType, 60) || 'image/jpeg';
    var ext  = mime.split('/')[1] || 'jpg';
    var blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mime,
      '菜單_' + (restaurantName || 'DM') + '_' + new Date().getTime() + '.' + ext
    );

    var folders = DriveApp.getFoldersByName('午餐菜單DM');
    var folder  = folders.hasNext() ? folders.next() : DriveApp.createFolder('午餐菜單DM');
    var file    = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    return { url: 'https://drive.google.com/file/d/' + file.getId() + '/view' };
  } catch (ex) {
    Logger.log('saveMenuImage_ 失敗：' + ex.message);
    return { error: isAuthError_(ex.message) ? AUTH_HINT : ('存圖失敗：' + ex.message) };
  }
}

// ─── 授權與自我檢測 ───────────────────────────────────────────────────────────

/**
 * 在 Apps Script 編輯器裡執行這一支（不是從網頁呼叫）。它做兩件事：
 *
 * 1. 實際碰一次 DriveApp 與 UrlFetchApp，逼出涵蓋新權限的同意畫面。
 *    新增用到的 Google 服務之後一定要重跑一次，否則網頁端會出現
 *    「你沒有呼叫 UrlFetchApp.fetch 的權限」。
 * 2. 檢查 GEMINI_API_KEY、列出你的金鑰實際可用的模型、並實跑一次辨識。
 *
 * 結果會印在下方的「執行紀錄」。
 */
function authorizeAndSelfTest() {
  var log = [];
  function say(s) { log.push(s); Logger.log(s); }

  say('=== 午餐訂單系統 自我檢測 ===');

  // ── 1. 試算表 ──
  try {
    var names = ss_().getSheets().map(function (s) { return s.getName(); });
    say('✅ 試算表：可存取（工作表：' + names.join('、') + '）');
  } catch (ex) {
    say('❌ 試算表：' + ex.message);
  }

  // ── 2. Drive（存 DM 原圖用）──
  try {
    DriveApp.getRootFolder().getName();
    say('✅ Drive：已授權，可以儲存菜單原圖');
  } catch (ex) {
    say('❌ Drive：' + ex.message);
    say('   → 這一步失敗的話，辨識還是能用，只是不會保留 DM 原圖');
  }

  // ── 3. 對外連線 ──
  try {
    UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });
    say('✅ 對外連線：已授權（script.external_request）');
  } catch (ex) {
    say('❌ 對外連線：' + ex.message);
    say('   → 這就是「你沒有呼叫 UrlFetchApp.fetch 的權限」的來源。');
    say('   → 如果剛剛沒有跳出同意畫面，請重新整理編輯器再執行一次這支函式。');
    return log.join('\n');
  }

  // ── 4. API key ──
  var key = geminiKey_();
  if (!key) {
    say('❌ 還沒設定 GEMINI_API_KEY');
    say('   → 到「專案設定 → 指令碼屬性」新增，值從 https://aistudio.google.com/apikey 取得');
    return log.join('\n');
  }
  say('✅ GEMINI_API_KEY：已設定（結尾 …' + key.slice(-4) + '）');

  // ── 5. 這把金鑰實際能用哪些模型 ──
  var model = geminiModel_();
  say('目前設定的模型：' + model);

  var models = listAvailableModels_(key);
  if (models.error) {
    say('❌ 取得模型清單失敗：' + models.error);
    if (models.code === 403 || models.code === 400) {
      say('   → 金鑰可能無效、或這個 Google 專案沒有啟用 Generative Language API');
    }
    return log.join('\n');
  }

  say('✅ 你的金鑰可用的模型（' + models.list.length + ' 個）：');
  models.list.forEach(function (m) { say('     ' + m); });

  if (models.list.indexOf(model) === -1) {
    say('⚠️  目前設定的「' + model + '」不在上面的清單裡，辨識會失敗。');
    var suggest = pickFlashModel_(models.list);
    if (suggest) {
      say('   → 建議改用：' + suggest);
      say('   → 到「專案設定 → 指令碼屬性」新增 GEMINI_MODEL = ' + suggest + '（不用重新部署）');
    }
    return log.join('\n');
  }

  // ── 6. 實跑一次辨識 ──
  // 1x1 的白色 PNG，只是要確認整條路通不通
  var tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  var probe = parseMenuImage_({ base64Data: tiny, mimeType: 'image/png' });

  if (probe.status === 'success') {
    say('✅ 辨識管線正常（測試圖沒有品項是預期的）');
  } else if (probe.code === 'NO_ITEMS') {
    // 1x1 空白圖讀不到品項才是對的 —— 代表請求有送到、也有正常回應
    say('✅ 辨識管線正常（測試圖是空白的，讀不到品項屬預期結果）');
  } else {
    say('❌ 辨識失敗：[' + probe.code + '] ' + probe.error);
  }

  say('=== 檢測結束 ===');
  say('若上面全是 ✅，請到「部署 → 管理部署作業 → 編輯 → 版本選新版本 → 部署」再回網頁測試。');
  return log.join('\n');
}

/** 問 Google 這把金鑰能用哪些支援 generateContent 的模型 */
function listAvailableModels_(key) {
  var url = GEMINI_API_BASE + '?key=' + encodeURIComponent(key) + '&pageSize=200';
  var res;
  try {
    res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  } catch (ex) {
    return { error: isAuthError_(ex.message) ? AUTH_HINT : ex.message };
  }

  var code = res.getResponseCode();
  if (code !== 200) return { error: 'HTTP ' + code + ' ' + res.getContentText().slice(0, 200), code: code };

  var list = [];
  try {
    var data = JSON.parse(res.getContentText());
    (data.models || []).forEach(function (m) {
      var methods = m.supportedGenerationMethods || [];
      if (methods.indexOf('generateContent') === -1) return;
      list.push(String(m.name).replace(/^models\//, ''));
    });
  } catch (ex) {
    return { error: '看不懂模型清單的格式' };
  }
  return { list: list };
}

/** 從可用清單裡挑一個適合的 flash 模型（便宜、快、免費方案通常留著它） */
function pickFlashModel_(list) {
  var flash = list.filter(function (n) {
    return n.indexOf('flash') !== -1
        && n.indexOf('thinking') === -1
        && n.indexOf('image') === -1
        && n.indexOf('tts') === -1
        && n.indexOf('live') === -1;
  });
  if (!flash.length) return list[0] || '';

  // preview / exp 的版本會被下架，優先挑穩定版；再來挑名字最「新」的
  var stable = flash.filter(function (n) {
    return n.indexOf('preview') === -1 && n.indexOf('exp') === -1;
  });
  var pool = stable.length ? stable : flash;
  pool.sort();
  return pool[pool.length - 1];
}

// ─── 首次安裝：建立四張工作表與範例資料 ───────────────────────────────────────
function setupSheets() {
  [SHEET_RESTAURANTS, SHEET_MENU_ITEMS, SHEET_SESSIONS, SHEET_ORDERS].forEach(function (n) { sheet_(n); });

  if (readAll_(SHEET_RESTAURANTS).length === 0) {
    var rid = uid_('r');
    appendRow_(SHEET_RESTAURANTS, {
      restaurantId: rid, name: '範例便當店', phone: '02-1234-5678', note: '滿 10 個免運', active: true
    });
    [['排骨飯', 90], ['雞腿飯', 100], ['魚排飯', 95], ['素食便當', 80]].forEach(function (pair) {
      appendRow_(SHEET_MENU_ITEMS, {
        itemId: uid_('m'), restaurantId: rid, name: pair[0], price: pair[1], category: '主餐', available: true
      });
    });
  }
  return '完成';
}
