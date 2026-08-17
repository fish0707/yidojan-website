/**
 * 台股當沖選股 — 盤中即時報價代理（Cloudflare Worker 版）
 *
 * 部署說明見同資料夾的 README.md。
 *
 * ── 為什麼需要這一支（實測結論，不是猜的）──
 *
 * 原本用 Google Apps Script 當代理，但盤中一直「連線失敗」。用 GitHub Actions
 * 從資料中心 IP 打同一支 API 實測，結果是：
 *
 *   • 不帶任何標頭、單一檔        → HTTP 200，拿到真實報價
 *   • 十二檔、管線符號編碼成 %7C  → HTTP 200（跟 GAS 一模一樣的寫法）
 *   • 每 3 秒連打 6 次             → 全部 200，沒有被限流
 *
 * 所以證交所擋的不是「資料中心 IP」也不是「請求寫法」，而是 Google Apps Script
 * 那段全球共用的 IP。改寫 GAS 的請求怎麼調都沒用，換一個出口才是解法。
 *
 * 同一次實測也確認：這支 API 的回應**沒有** Access-Control-Allow-Origin，
 * 所以瀏覽器沒辦法直接抓，代理層是必要的，不是多此一舉。
 *
 * 這支 Worker 回傳的 JSON 格式跟 GAS 版完全相同，前端只要換一個網址，
 * 其他程式碼一行都不用改。
 */

const QUOTE_API = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const MAX_CODES = 30;        // 一次查太多沒必要，篩選出的候選頂多十幾檔
const CACHE_SECONDS = 3;     // 同一組代號 3 秒內重複查就吃快取，少打證交所幾次

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS
    }
  });
}

function err(code, message) {
  return json({ status: 'error', code, error: message });
}

function numOrNull(v) {
  if (v == null || v === '' || v === '-') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * 證交所這支 API 認的是瀏覽器。雖然實測不帶標頭也會通，但帶著比較不容易
 * 哪天被歸類成爬蟲，成本也只是幾個字串。
 */
function upstreamHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  };
}

function parseQuotes(data) {
  const list = (data && data.msgArray) || [];
  return list.map((q) => ({
    code: q.c,
    name: q.n,
    // z 是最新成交價。開盤前或當下沒有成交時證交所會給 '-'，這裡回 null，
    // 由前端沿用上一筆已知價格——不要把「沒成交」當成價格是 0。
    price: numOrNull(q.z),
    open: numOrNull(q.o),
    high: numOrNull(q.h),
    low: numOrNull(q.l),
    prevClose: numOrNull(q.y),
    volume: numOrNull(q.v),
    time: q.tlong ? Number(q.tlong) : null
  }));
}

async function fetchUpstream(exch) {
  const url = `${QUOTE_API}?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0&_=${Date.now()}`;
  const res = await fetch(url, { headers: upstreamHeaders() });
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, body: text.slice(0, 200) };
  }
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch (e) {
    // 非交易時段或維護中有時會回 HTML
    return { ok: false, status: res.status, body: text.slice(0, 200), parseError: true };
  }
}

async function handleQuote(url, ctx) {
  let raw = (url.searchParams.get('codes') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!raw.length) return err('NO_CODES', '請帶入 codes 參數，例如 codes=tse_2317,tse_2609');
  if (raw.length > MAX_CODES) raw = raw.slice(0, MAX_CODES);

  const exch = raw
    .map((c) => (/^(tse|otc)_/.test(c) ? c : `tse_${c}`) + '.tw')
    .join('|');

  // Cloudflare 的快取要用一個「像網址」的 key
  const cacheKey = new Request(`https://quote-cache.invalid/?ex=${encodeURIComponent(exch)}`);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    body.cached = true;
    return json(body);
  }

  const up = await fetchUpstream(exch);
  if (!up.ok) {
    return err(
      up.parseError ? 'BAD_RESPONSE' : `HTTP_${up.status}`,
      up.parseError
        ? '證交所回應不是 JSON，可能是非交易時段或維護中'
        : `證交所回應異常（HTTP ${up.status}）`
    );
  }

  const result = { status: 'success', serverNow: Date.now(), quotes: parseQuotes(up.data) };
  const toCache = json(result);
  toCache.headers.set('Cache-Control', `max-age=${CACHE_SECONDS}`);
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return toCache;
}

/** 診斷：讓網頁上的「連線診斷」按鈕能問這支 Worker 到底通不通 */
async function handleDiag() {
  const tests = [];
  async function record(name, fn) {
    const t0 = Date.now();
    try {
      const r = await fn();
      tests.push({ name, ...r, ms: Date.now() - t0 });
    } catch (e) {
      tests.push({
        name, ok: false, httpCode: null, bytes: 0, ms: Date.now() - t0,
        note: `連線層失敗：${e && e.message ? e.message : e}`
      });
    }
  }

  const probe = async (label, exch) => {
    const res = await fetch(
      `${QUOTE_API}?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0&_=${Date.now()}`,
      { headers: upstreamHeaders() });
    const text = await res.text();
    const ok = res.status === 200 && text.indexOf('msgArray') !== -1;
    return {
      ok, httpCode: res.status, bytes: text.length,
      note: ok ? '成功，有拿到報價資料'
               : (res.status === 200 ? '連得到但回應裡沒有 msgArray' : `HTTP ${res.status}`)
    };
  };

  await record('單一檔', () => probe('單一檔', 'tse_2330.tw'));
  await record('多檔（正式查詢的寫法）', () => probe('多檔', 'tse_2330.tw|tse_2317.tw|tse_2884.tw'));

  const okCount = tests.filter((t) => t.ok).length;
  return json({
    status: 'success',
    source: 'cloudflare-worker',
    serverNow: Date.now(),
    summary: okCount === tests.length
      ? 'Worker 連得到證交所即時報價，可以正常使用'
      : (okCount > 0 ? 'Worker 部分成功，可能是暫時性問題' : 'Worker 連不到證交所即時報價'),
    okCount,
    tests
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return err('METHOD_NOT_ALLOWED', '只接受 GET');
    }

    const url = new URL(request.url);
    const action = url.searchParams.get('action') || 'quote';

    try {
      switch (action) {
        case 'quote': return await handleQuote(url, ctx);
        case 'diag':  return await handleDiag();
        case 'ping':  return json({ status: 'success', source: 'cloudflare-worker', serverNow: Date.now() });
        default:      return err('UNKNOWN_ACTION', `不支援的 action：${action}`);
      }
    } catch (e) {
      return err('SERVER_ERROR', String(e && e.message ? e.message : e));
    }
  }
};
