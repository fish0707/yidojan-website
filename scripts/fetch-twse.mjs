/**
 * 每日抓取台股收盤資料，存成 data/ 底下的靜態 JSON。
 *
 * 為什麼要有這支：證交所的 API 沒有對瀏覽器發 CORS 授權，網頁直接 fetch 一定失敗
 * （實測就是四個 Failed to fetch）。所以改由 GitHub Actions 在伺服器端抓，
 * 把結果 commit 進 repo，網頁再讀同網域的 JSON——同源就沒有 CORS 這回事。
 *
 * 順便解決了歷史資料的問題：MI_INDEX 這支給它任何一個過去日期，
 * 就回傳那天「全市場每一檔」的開高低收量，所以補 60 個交易日只要 60 個請求，
 * 不必一檔一檔去抓（那才是會被擋的做法）。
 *
 * 用法：
 *   node scripts/fetch-twse.mjs            # 補到設定的天數為止（只抓缺的）
 *   node scripts/fetch-twse.mjs --days 60  # 指定保留幾個交易日
 *   node scripts/fetch-twse.mjs --force    # 連已經有的日期也重抓
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = 'data';
const DAYS_DIR = path.join(DATA_DIR, 'days');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const KEEP_DAYS = Number(argValue('--days', 60));
const FORCE = args.includes('--force');

// 證交所對連續請求會限流，抓太快會開始回 429 或空資料。
// 60 天 × 1.2 秒大約一分半跑完，對排程來說完全可以接受。
const THROTTLE_MS = 1200;
const MAX_RETRY = 3;

// 當沖比重只有「最近幾天」對選股有意義，不必每一天都抓，省一半請求。
const DAYTRADE_RECENT_DAYS = 5;

const UA = 'Mozilla/5.0 (compatible; yidojan-daytrade-bot/1.0; +https://github.com/fish0707/yidojan-website)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = (...a) => console.log(...a);
const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn('⚠ ' + msg); };

// ─── HTTP ────────────────────────────────────────────────────────────────────

async function fetchJson(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let res;
      try {
        res = await fetch(url, {
          signal: ctrl.signal,
          headers: { 'User-Agent': UA, 'Accept': 'application/json,text/plain,*/*' }
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 || res.status === 503) {
        // 被限流就退避久一點再試，不要硬打
        const wait = 5000 * attempt;
        log(`   ${label} 被限流（HTTP ${res.status}），等 ${wait / 1000}s 後重試`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim()) return null;               // 假日就是空的，不算錯誤
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRY) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

// ─── 解析 ────────────────────────────────────────────────────────────────────

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/\s/g, '').trim();
  if (!s || s === '--' || s === '---' || s === 'X' || s === 'x') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * 證交所這幾年把回應格式改過：新版是 { tables: [{fields, data}] }，
 * 舊版是 { fields9: [...], data9: [...] }。兩種都收，才不會哪天又整個壞掉。
 */
function collectTables(json) {
  const tables = [];
  if (!json || typeof json !== 'object') return tables;
  if (Array.isArray(json.tables)) {
    for (const t of json.tables) {
      if (Array.isArray(t?.fields) && Array.isArray(t?.data)) tables.push({ fields: t.fields, data: t.data });
    }
  }
  for (let i = 1; i <= 9; i++) {
    if (Array.isArray(json['fields' + i]) && Array.isArray(json['data' + i])) {
      tables.push({ fields: json['fields' + i], data: json['data' + i] });
    }
  }
  if (Array.isArray(json.fields) && Array.isArray(json.data)) tables.push({ fields: json.fields, data: json.data });
  return tables;
}

// 用欄位名稱找欄位位置，不用寫死索引——證交所加一欄就會全部錯位
function colIndex(fields, ...names) {
  for (const name of names) {
    const i = fields.findIndex((f) => String(f).replace(/\s/g, '') === name);
    if (i >= 0) return i;
  }
  for (const name of names) {
    const i = fields.findIndex((f) => String(f).replace(/\s/g, '').includes(name));
    if (i >= 0) return i;
  }
  return -1;
}

/** 從 MI_INDEX 的回應裡找出「每日收盤行情」那張表並轉成個股列 */
function parseMiIndex(json) {
  for (const t of collectTables(json)) {
    const iCode = colIndex(t.fields, '證券代號');
    const iClose = colIndex(t.fields, '收盤價');
    if (iCode < 0 || iClose < 0) continue;

    const iName = colIndex(t.fields, '證券名稱');
    const iOpen = colIndex(t.fields, '開盤價');
    const iHigh = colIndex(t.fields, '最高價');
    const iLow = colIndex(t.fields, '最低價');
    const iVol = colIndex(t.fields, '成交股數');
    const iValue = colIndex(t.fields, '成交金額');
    const iSign = colIndex(t.fields, '漲跌(+/-)', '漲跌');
    const iDiff = colIndex(t.fields, '漲跌價差');

    const rows = [];
    for (const r of t.data) {
      const code = String(r[iCode] ?? '').trim();
      if (!/^\d{4}$/.test(code)) continue;          // 只留 4 碼普通股，濾掉 ETF/權證/特別股
      const close = num(r[iClose]);
      const high = num(r[iHigh]);
      const low = num(r[iLow]);
      if (!close || !high || !low) continue;         // 當天沒成交的就跳過

      // 漲跌是「符號欄 + 數值欄」兩欄拆開的，符號欄裡包的是 HTML（<p style=color:red>+</p>）
      let change = num(iDiff >= 0 ? r[iDiff] : null) || 0;
      if (iSign >= 0) {
        const sign = String(r[iSign] ?? '');
        if (sign.includes('-')) change = -Math.abs(change);
        else if (sign.includes('+')) change = Math.abs(change);
        else if (!sign.replace(/<[^>]*>/g, '').trim()) change = 0;
      }

      rows.push([
        code,
        String(r[iName] ?? code).trim(),
        num(iOpen >= 0 ? r[iOpen] : null) || close,
        high, low, close,
        num(iVol >= 0 ? r[iVol] : null) || 0,
        num(iValue >= 0 ? r[iValue] : null) || 0,
        change,
        null                                          // 當沖量，稍後才補
      ]);
    }
    if (rows.length > 100) return rows;               // 全市場至少上千檔，太少代表抓錯表
  }
  return null;
}

/** 當日沖銷交易標的：回傳 Map(代號 → 當沖成交股數) */
function parseDayTrade(json) {
  const map = new Map();
  for (const t of collectTables(json)) {
    const iCode = colIndex(t.fields, '證券代號', '股票代號');
    if (iCode < 0) continue;
    const iVol = colIndex(t.fields, '當日沖銷交易成交股數', '沖銷交易成交股數', '成交股數');
    if (iVol < 0) continue;
    for (const r of t.data) {
      const code = String(r[iCode] ?? '').trim();
      if (!/^\d{4}$/.test(code)) continue;
      const v = num(r[iVol]);
      if (v != null) map.set(code, v);
    }
    if (map.size) return map;
  }
  return map;
}

// ─── 日期 ────────────────────────────────────────────────────────────────────

const ymd = (d) => d.toISOString().slice(0, 10);
const compact = (s) => s.replace(/-/g, '');

/**
 * 台股收盤是 13:30，但資料上架有延遲，所以「今天」要到台北時間 15:00 之後才算數。
 * 排程本身跑在 UTC，這裡統一換算成台北時間再判斷。
 */
function latestPossibleTradingDay() {
  const nowTaipei = new Date(Date.now() + 8 * 3600 * 1000);
  const d = new Date(Date.UTC(nowTaipei.getUTCFullYear(), nowTaipei.getUTCMonth(), nowTaipei.getUTCDate()));
  if (nowTaipei.getUTCHours() < 15) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}

/** 往回列出 n 個「可能的」交易日（只跳過週末；國定假日靠實際抓不到資料來判斷） */
function candidateDays(n) {
  const out = [];
  const d = latestPossibleTradingDay();
  while (out.length < n) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(ymd(d));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function readIndex() {
  try {
    return JSON.parse(await readFile(path.join(DATA_DIR, 'index.json'), 'utf8'));
  } catch {
    return { days: [], holidays: [], updated: null };
  }
}

async function main() {
  await mkdir(DAYS_DIR, { recursive: true });
  const index = await readIndex();
  const holidays = new Set(index.holidays || []);

  const existing = new Set();
  try {
    for (const f of await readdir(DAYS_DIR)) {
      if (f.endsWith('.json')) existing.add(f.slice(0, -5));
    }
  } catch { /* 第一次跑還沒有這個資料夾 */ }

  const wanted = candidateDays(Math.round(KEEP_DAYS * 1.5));   // 多列一些，扣掉假日才夠 KEEP_DAYS 天
  const todo = wanted.filter((d) => FORCE || (!existing.has(d) && !holidays.has(d)));

  log(`目標保留 ${KEEP_DAYS} 個交易日；已有 ${existing.size} 天，已知假日 ${holidays.size} 天`);
  log(`這次要抓 ${todo.length} 天` + (todo.length ? `（${todo[0]} ~ ${todo[todo.length - 1]}）` : ''));

  let fetched = 0;
  const newHolidays = [];

  for (const date of todo) {
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${compact(date)}&type=ALLBUT0999&response=json`;
    try {
      const json = await fetchJson(url, date);
      const rows = json ? parseMiIndex(json) : null;
      if (!rows) {
        // 沒資料 = 假日或還沒上架。記進 holidays，下次就不會再白跑一趟。
        newHolidays.push(date);
        log(`   ${date} 無資料（假日或尚未上架）`);
      } else {
        await writeFile(
          path.join(DAYS_DIR, `${date}.json`),
          JSON.stringify({
            date,
            cols: ['code', 'name', 'open', 'high', 'low', 'close', 'volume', 'turnover', 'change', 'dayTradeVolume'],
            rows
          })
        );
        fetched++;
        log(`   ${date} ✓ ${rows.length} 檔`);
      }
    } catch (e) {
      warn(`${date} 抓取失敗：${e.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  // 重新盤點目前有哪些交易日，只留最近 KEEP_DAYS 天
  let days = [];
  for (const f of await readdir(DAYS_DIR)) {
    if (f.endsWith('.json')) days.push(f.slice(0, -5));
  }
  days.sort();
  const drop = days.slice(0, Math.max(0, days.length - KEEP_DAYS));
  for (const d of drop) {
    await unlink(path.join(DAYS_DIR, `${d}.json`));
    log(`   清掉過舊的 ${d}`);
  }
  days = days.slice(-KEEP_DAYS);

  if (!days.length) {
    warn('一天資料都沒有，不寫 index.json，避免把好的索引覆蓋掉');
    await writeSummary({ ok: false, days: 0 });
    process.exitCode = 1;
    return;
  }

  // 當沖比重只補最近幾天（選股只看得到最新一天，抓太多是浪費）
  const recent = days.slice(-DAYTRADE_RECENT_DAYS);
  for (const date of recent) {
    const file = path.join(DAYS_DIR, `${date}.json`);
    const day = JSON.parse(await readFile(file, 'utf8'));
    if (!FORCE && day.rows.some((r) => r[9] != null)) continue;   // 已經補過就不重抓
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/TWTB4U?date=${compact(date)}&selectType=All&response=json`;
    try {
      const dt = parseDayTrade(await fetchJson(url, date + ' 當沖'));
      if (dt.size) {
        for (const r of day.rows) {
          const v = dt.get(r[0]);
          if (v != null) r[9] = v;
        }
        await writeFile(file, JSON.stringify(day));
        log(`   ${date} 當沖資料 ✓ ${dt.size} 檔`);
      } else {
        warn(`${date} 當沖清單解析不到資料（當沖比重會顯示為未知）`);
      }
    } catch (e) {
      warn(`${date} 當沖清單抓取失敗：${e.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  // 處置股與暫停先賣後買只跟「最新狀態」有關，抓一份就好
  const meta = { updated: new Date().toISOString(), punish: [], noShortSell: [] };
  try {
    const j = await fetchJson('https://openapi.twse.com.tw/v1/announcement/punish', '處置股');
    if (Array.isArray(j)) {
      meta.punish = [...new Set(j.map((r) => String(r.Code ?? r['證券代號'] ?? '').trim()).filter((c) => /^\d{4}$/.test(c)))];
    }
  } catch (e) { warn(`處置股清單抓取失敗：${e.message}`); }
  await sleep(THROTTLE_MS);
  try {
    const j = await fetchJson('https://openapi.twse.com.tw/v1/exchangeReport/TWTBAU1', '暫停先賣後買');
    if (Array.isArray(j)) {
      meta.noShortSell = [...new Set(j.map((r) => String(r.Code ?? r['證券代號'] ?? '').trim()).filter((c) => /^\d{4}$/.test(c)))];
    }
  } catch (e) { warn(`暫停先賣後買清單抓取失敗：${e.message}`); }

  await writeFile(path.join(DATA_DIR, 'meta.json'), JSON.stringify(meta, null, 1));

  const allHolidays = [...new Set([...(index.holidays || []), ...newHolidays])].sort().slice(-200);
  await writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify({
    updated: new Date().toISOString(),
    latest: days[days.length - 1],
    days,
    holidays: allHolidays,
    warnings
  }, null, 1));

  log(`\n完成：這次新抓 ${fetched} 天，目前共 ${days.length} 個交易日（${days[0]} ~ ${days[days.length - 1]}）`);
  if (warnings.length) log(`有 ${warnings.length} 則警告`);
  await writeSummary({ ok: true, days: days.length, fetched, first: days[0], last: days[days.length - 1] });
}

// 把結果寫進 Actions 的執行摘要，之後排程壞掉時一眼看得出來是哪裡出事
async function writeSummary(info) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    '## 台股資料抓取',
    '',
    info.ok
      ? `- 目前共 **${info.days}** 個交易日（${info.first} ~ ${info.last}），這次新抓 ${info.fetched} 天`
      : '- **失敗**：沒有抓到任何資料',
    ''
  ];
  if (warnings.length) {
    lines.push('### 警告', '', ...warnings.map((w) => `- ${w}`), '');
  }
  await writeFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), { flag: 'a' });
}

main().catch((e) => {
  console.error('執行失敗：', e);
  process.exitCode = 1;
});
