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
HEADERS[SHEET_RESTAURANTS] = ['restaurantId', 'name', 'phone', 'note', 'active'];
HEADERS[SHEET_MENU_ITEMS]  = ['itemId', 'restaurantId', 'name', 'price', 'category', 'available'];
HEADERS[SHEET_SESSIONS]    = ['sessionId', 'restaurantId', 'title', 'createdBy', 'createdAt', 'closeAt', 'status', 'rev'];
HEADERS[SHEET_ORDERS]      = ['orderId', 'sessionId', 'name', 'clientToken', 'itemsJson', 'total', 'note', 'createdAt', 'updatedAt', 'deleted'];

var LOCK_TIMEOUT_MS = 10000;
var MAX_ITEMS_PER_ORDER = 30;
var MAX_PRICE = 100000;

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

/** 取得工作表，不存在就依 HEADERS 建立 */
function sheet_(name) {
  var s = ss_().getSheetByName(name);
  if (!s) {
    s = ss_().insertSheet(name);
    s.appendRow(HEADERS[name]);
    s.setFrozenRows(1);
  }
  return s;
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
    active:       truthy_(r.active)
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
    writeRow_(SHEET_RESTAURANTS, existing._row, existing);
    return { status: 'success', restaurant: restaurantPayload_(existing) };
  }

  var r = {
    restaurantId: uid_('r'),
    name:         name,
    phone:        clean_(body.phone, 30),
    note:         clean_(body.note, 200),
    active:       body.active === undefined ? true : !!body.active
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
