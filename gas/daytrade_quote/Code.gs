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

// 證交所的即時報價頁面自己就是帶著這些標頭在打的。原本只送一個自訂的 User-Agent，
// 對這種有防爬的端點來說等於自報身分說「我是機器人」。
var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
var MIS_REFERER = 'https://mis.twse.com.tw/stock/fibest.jsp';

function quoteHeaders_() {
  return {
    'User-Agent': BROWSER_UA,
    'Referer': MIS_REFERER,
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  };
}

/**
 * 呼叫證交所即時報價。
 *
 * 注意 muteHttpExceptions: true 的意思——HTTP 錯誤碼（403、429）不會拋例外，
 * 會正常回傳讓我們讀狀態碼。所以只要進到 catch，就代表是「連線層」失敗
 * （對方拒絕連線／重設連線／DNS／TLS），根本沒拿到任何 HTTP 回應。
 * 這兩種的處理與訊息都要分開，不然使用者只看到一句「失敗」無從判斷。
 *
 * 已實測的事實（從 GitHub Actions 的資料中心 IP 打同一支 API）：
 * 不帶任何標頭、十二檔、跟這裡一樣的 %7C 編碼，全部回 HTTP 200 拿到真實報價，
 * 連續請求也沒被限流。所以證交所擋的不是「資料中心 IP」或「請求寫法」，
 * 而是 Google Apps Script 那段共用 IP。標頭留著沒有壞處，但別期待它能解決問題。
 *
 * 連線層的例外原本一遇到就直接放棄，但實測是間歇性失敗（使用者那邊曾成功過一次），
 * 所以連線失敗也要重試，不是只重試 5xx。
 */
function fetchQuotesWithRetry_(url) {
  var last = null;
  for (var i = 0; i < QUOTE_MAX_ATTEMPTS; i++) {
    if (i > 0) Utilities.sleep(800 * i);
    var res;
    try {
      res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: quoteHeaders_()
      });
    } catch (ex) {
      if (isAuthError_(ex.message)) return { authError: true };
      last = { exception: ex.message };
      continue;                         // 間歇性的連線失敗，值得再試一次
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
      case 'diag':  return json(runDiagnostics_());
      case 'ping':  return json({ status: 'success', serverNow: Date.now() });
      default:      return json(err('UNKNOWN_ACTION', '不支援的 action：' + action));
    }
  } catch (ex) {
    return json(err('SERVER_ERROR', String(ex && ex.message ? ex.message : ex)));
  }
}

// ─── 診斷 ─────────────────────────────────────────────────────────────────────

/**
 * 逐一嘗試各種寫法，回報哪一種真的通。
 *
 * 這支存在的理由：實測顯示 GAS 打 mis.twse.com.tw 是「間歇性」在連線層失敗，
 * 但那只是推論，不能靠猜。與其一次改一個地方然後叫使用者盤中再試一次，
 * 不如一次把所有變體都跑過，直接看哪個成立。
 */
function runDiagnostics_() {
  var API = QUOTE_API;
  var tests = [];

  function record(name, fn) {
    var t0 = Date.now();
    try {
      var res = fn();
      var text = res.getContentText();
      var code = res.getResponseCode();
      var ok = code === 200 && text.indexOf('msgArray') !== -1;
      tests.push({
        name: name, ok: ok, httpCode: code, bytes: text.length,
        ms: Date.now() - t0,
        note: ok ? '成功，有拿到報價資料'
                 : (code === 200 ? '連得到但回應裡沒有 msgArray（可能被導去別的頁面）'
                                 : 'HTTP ' + code)
      });
    } catch (ex) {
      tests.push({
        name: name, ok: false, httpCode: null, bytes: 0, ms: Date.now() - t0,
        note: '連線層失敗（沒拿到任何 HTTP 回應）：' + String(ex && ex.message ? ex.message : ex)
      });
    }
  }

  record('1. 陽春：無標頭、單一檔', function () {
    return UrlFetchApp.fetch(API + '?ex_ch=tse_2330.tw&json=1&delay=0', { muteHttpExceptions: true });
  });

  record('2. 帶瀏覽器標頭', function () {
    return UrlFetchApp.fetch(API + '?ex_ch=tse_2330.tw&json=1&delay=0',
      { muteHttpExceptions: true, headers: quoteHeaders_() });
  });

  record('3. 多檔・管線符號編碼成 %7C（= 正式查詢的寫法）', function () {
    return UrlFetchApp.fetch(
      API + '?ex_ch=' + encodeURIComponent('tse_2330.tw|tse_2317.tw|tse_2884.tw') + '&json=1&delay=0',
      { muteHttpExceptions: true, headers: quoteHeaders_() });
  });

  record('4. 多檔・管線符號不編碼', function () {
    return UrlFetchApp.fetch(API + '?ex_ch=tse_2330.tw|tse_2317.tw|tse_2884.tw&json=1&delay=0',
      { muteHttpExceptions: true, headers: quoteHeaders_() });
  });

  // 對照組。這支從 GAS 打得通（處置股清單就是這樣抓的），用來區分
  // 「整台機器連不到證交所」與「只有 mis 這台被擋」。
  record('5. 對照組：openapi.twse.com.tw', function () {
    return UrlFetchApp.fetch('https://openapi.twse.com.tw/v1/exchangeReport/TWTBAU1',
      { muteHttpExceptions: true });
  });

  var quoteTests = tests.filter(function (t) { return t.name.indexOf('對照組') === -1; });
  var quoteOk = quoteTests.filter(function (t) { return t.ok; }).length;
  var controlOk = tests.filter(function (t) {
    return t.name.indexOf('對照組') !== -1 && t.ok;
  }).length > 0;

  var summary;
  if (quoteOk > 0) {
    summary = '即時報價可以從這個 GAS 取得（' + quoteOk + '/' + quoteTests.length + ' 種寫法成功）';
  } else if (controlOk) {
    // 這正是實際遇到的情況：證交所別台連得到，只有即時報價這台連不到，
    // 而同樣的請求從 GitHub 的資料中心 IP 打卻完全正常。
    summary = '證交所其他主機連得到，但即時報價這台完全連不到'
      + '——是 Google Apps Script 的 IP 被擋，改寫請求沒有用，要換一個代理（Cloudflare Worker）。';
  } else {
    summary = '這個 GAS 連證交所任何一台都連不到，先確認對外連線授權有沒有完成。';
  }

  return {
    status: 'success',
    serverNow: Date.now(),
    summary: summary,
    okCount: tests.filter(function (t) { return t.ok; }).length,
    tests: tests
  };
}

/** 在 Apps Script 編輯器直接執行這支，看下方執行紀錄 */
function diagnoseQuoteSources() {
  var r = runDiagnostics_();
  var lines = ['=== 即時報價來源診斷 ===', r.summary, ''];
  r.tests.forEach(function (t) {
    lines.push((t.ok ? '✅ ' : '❌ ') + t.name + '　' + t.note + '（' + t.ms + 'ms）');
  });
  var out = lines.join('\n');
  Logger.log(out);
  return out;
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
