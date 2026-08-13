/**
 * 台股當沖選股 — 盤中即時報價代理
 *
 * 部署方式請見 gas/daytrade_quote/README.md。這是獨立的 Apps Script 專案，
 * 跟飲料店（gas/appsscript.json）、午餐訂單（gas/lunch_Code.gs）的部署完全分開，
 * 不要共用網址。
 *
 * 為什麼需要這支：daytrade.html 想在盤中即時顯示報價，但瀏覽器直接打證交所
 * 的即時報價 API 會被 CORS 擋下來（跟收盤資料那批 API 一樣）。這支程式碼部署成
 * Apps Script 網頁應用程式後，由它代替瀏覽器在伺服器端呼叫證交所，瀏覽器改叫
 * 這支網址就不會有 CORS 問題——跟 gas/lunch_Code.gs 用同一招。
 *
 * 這個專案是唯讀的、不需要任何試算表：不用「新增試算表」，直接在
 * https://script.google.com/home 建一個獨立的 Apps Script 專案即可。
 *
 * 慣例（與 gas/lunch_Code.gs 相同）：
 *   GET ?action=xxx&...  → doGet，一律回傳 JSON，
 *   成功 {status:'success',...}，失敗 {status:'error', code, error}
 */

// ─── 常數 ─────────────────────────────────────────────────────────────────────

var QUOTE_API = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
var QUOTE_MAX_ATTEMPTS = 2;          // 這是即時輪詢，重試要快，拖久了資料就舊了
var QUOTE_MAX_CODES = 30;            // 一次查太多檔容易被證交所擋，篩選候選頂多十幾檔用不到這麼多
var QUOTE_CACHE_SECONDS = 3;         // 同一份代號清單 3 秒內重複查就吃快取，減少對證交所的請求次數

/**
 * Apps Script 是「用到哪些服務就要哪些權限」，授權是第一次同意時定下來的。
 * 這支只用到 UrlFetchApp（對外連線），沒有讀寫試算表或 Drive，權限範圍很單純。
 */
function isAuthError_(message) {
  var m = String(message || '');
  return m.indexOf('script.external_request') !== -1
      || m.indexOf('PERMISSION_DENIED') !== -1
      || (m.indexOf('權限') !== -1 && m.indexOf('必要') !== -1)
      || m.indexOf('does not have permission') !== -1
      || m.indexOf('Authorization is required') !== -1;
}

var AUTH_HINT = '指令碼還沒取得對外連線的權限。'
  + '請到 Apps Script 編輯器執行一次 authorizeAndSelfTest 完成授權，再重新部署。';

/**
 * 呼叫證交所即時報價，遇到伺服器端的暫時性故障就重試一次。
 * 只重試 5xx——429（被限流）重試只會更快被鎖，不重試，直接把錯誤丟回去讓
 * 前端這一輪跳過、等下一次輪詢。
 */
function fetchQuotesWithRetry_(url) {
  var last = null;
  for (var i = 0; i < QUOTE_MAX_ATTEMPTS; i++) {
    if (i > 0) Utilities.sleep(800);
    var res;
    try {
      res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; yidojan-daytrade-quote/1.0)' }
      });
    } catch (ex) {
      if (isAuthError_(ex.message)) return { authError: true };
      return { exception: ex.message };
    }
    last = { code: res.getResponseCode(), text: res.getContentText() };
    if (last.code < 500) return last;
  }
  return last;
}

function numOrNull_(v) {
  if (v == null || v === '' || v === '-') return null;
  var n = Number(String(v).replace(/,/g, ''));
  return isFinite(n) ? n : null;
}

/**
 * codes 參數格式：逗號分隔，每個可以是 "2317"（預設當上市 tse_）或已經帶好
 * 市場別的 "tse_2317" / "otc_2317"（前端知道每檔是上市還是上櫃，會直接帶好）。
 */
function getQuotes_(params) {
  var raw = String((params && params.codes) || '').split(',')
    .map(function (s) { return s.trim(); })
    .filter(Boolean);

  if (!raw.length) return err('NO_CODES', '請帶入 codes 參數，例如 codes=tse_2317,tse_2609');
  if (raw.length > QUOTE_MAX_CODES) raw = raw.slice(0, QUOTE_MAX_CODES);

  var exch = raw.map(function (c) {
    return (/^(tse|otc)_/.test(c) ? c : ('tse_' + c)) + '.tw';
  }).join('|');

  var cache = CacheService.getScriptCache();
  var cacheKey = 'q:' + exch;
  var cached = cache.get(cacheKey);
  if (cached) {
    var cachedObj = JSON.parse(cached);
    cachedObj.cached = true;
    return cachedObj;
  }

  var url = QUOTE_API + '?ex_ch=' + encodeURIComponent(exch) + '&json=1&delay=0&_=' + Date.now();
  var res = fetchQuotesWithRetry_(url);

  if (res.authError) return err('AUTH_ERROR', AUTH_HINT);
  if (res.exception) return err('FETCH_FAILED', '連線失敗：' + res.exception);
  if (!res.code || res.code >= 400) return err('HTTP_' + res.code, '證交所回應異常（HTTP ' + res.code + '），可能是暫時被限流');

  var data;
  try {
    data = JSON.parse(res.text);
  } catch (ex) {
    return err('BAD_RESPONSE', '證交所回應不是 JSON，可能是非交易時段或維護中');
  }

  var list = (data && data.msgArray) || [];
  var quotes = list.map(function (q) {
    return {
      code: q.c,
      name: q.n,
      // z 是最新成交價，開盤前或今天還沒成交時是 '-'，這種情況回 null，
      // 前端要沿用上一筆已知價格，不要把 null 當成「跌到 0」處理。
      price: numOrNull_(q.z),
      open: numOrNull_(q.o),
      high: numOrNull_(q.h),
      low: numOrNull_(q.l),
      prevClose: numOrNull_(q.y),
      volume: numOrNull_(q.v),
      time: q.tlong ? Number(q.tlong) : null
    };
  });

  var result = { status: 'success', serverNow: Date.now(), quotes: quotes };
  cache.put(cacheKey, JSON.stringify(result), QUOTE_CACHE_SECONDS);
  return result;
}

// ─── 入口 ─────────────────────────────────────────────────────────────────────

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'quote';
  try {
    switch (action) {
      case 'quote': return json(getQuotes_(e.parameter));
      case 'ping':  return json({ status: 'success', serverNow: Date.now() });
      default:      return json(err('UNKNOWN_ACTION', '不支援的 action：' + action));
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

// ─── 自我檢測 ─────────────────────────────────────────────────────────────────

/**
 * 部署前後都應該跑一次：確認對外連線的授權有生效、證交所查得到資料。
 * 執行完看編輯器下方的「執行紀錄」。
 */
function authorizeAndSelfTest() {
  var log = [];
  function say(s) { log.push(s); Logger.log(s); }

  say('=== 即時報價代理 自我檢測 ===');

  try {
    UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });
    say('✅ 對外連線：已授權（script.external_request）');
  } catch (ex) {
    say('❌ 對外連線：' + ex.message);
    say('   → 這就是「你沒有呼叫 UrlFetchApp.fetch 的權限」的來源。');
    say('   → 如果剛剛沒有跳出同意畫面，請重新整理編輯器再執行一次這支函式。');
    return log.join('\n');
  }

  var probe = getQuotes_({ codes: '2330' });
  if (probe.status === 'success' && probe.quotes && probe.quotes.length) {
    var p = probe.quotes[0];
    say('✅ 證交所即時報價：正常（測試查了台積電 2330，' +
      (p.price == null ? '目前尚無成交價（非交易時段是正常的）' : '目前成交價 ' + p.price) + '）');
  } else {
    say('❌ 證交所即時報價：' + (probe.error || '沒有回傳任何資料'));
    say('   → 完全查不到可能是證交所暫時擋掉了這個 IP 或改了回應格式，過幾分鐘再試一次。');
  }

  say('=== 檢測結束 ===');
  say('沒有 ❌ 的話，請到「部署 → 管理部署作業 → 編輯 → 版本選新版本 → 部署」再回網頁測試。');
  return log.join('\n');
}
