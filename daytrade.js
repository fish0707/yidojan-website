/**
 * 台股當沖選股 — 流動性掃蕩 + 趨勢追蹤
 *
 * 策略移植自一套原本用在 XAU/USD 的當沖規則：
 *   1. 30 EMA 定方向（價格在均線上只找多、下只找空）
 *   2. 自動支撐壓力（Left/Right Bars = 1，抓細部轉折）
 *   3. 等「流動性掃蕩」——先破線、收盤又收回，那根 K 棒才算數
 *   4. 進場 = 確認 K 棒高點；停損 = 掃蕩最低點；目標 = 1:1 等距
 *
 * 這支檔案只負責計算與資料，畫面在 daytrade.html。
 * 所有純函式都放在最前面，方便用 node 直接跑自我測試（檔尾有 module.exports）。
 */

// ─── 台股價格檔位 ────────────────────────────────────────────────────────────
//
// 證交所的升降單位是分段的，價位一定要對齊，不然算出來的進場價根本掛不進去。
// 未滿 10 → 0.01；10~未滿 50 → 0.05；50~未滿 100 → 0.1；
// 100~未滿 500 → 0.5；500~未滿 1000 → 1；1000 以上 → 5

function tickSize(price) {
  const p = Math.abs(price);
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}

// 浮點數在這裡會咬人（0.1 + 0.2 那類），所以先換算成「幾個檔位」再取整回來。
function roundToTick(price, dir) {
  const tick = tickSize(price);
  const n = price / tick;
  let k;
  // 三個方向都要加 epsilon。少了它，50.15/0.1 會算出 501.49999999999994，
  // 明明是剛好半檔卻被無聲地往下捨——四捨五入的結果會隨浮點誤差飄。
  if (dir === 'up') k = Math.ceil(n - 1e-9);
  else if (dir === 'down') k = Math.floor(n + 1e-9);
  else k = Math.round(n + 1e-9);
  return Number((k * tick).toFixed(4));
}

function addTicks(price, ticks) {
  return roundToTick(price + ticks * tickSize(price), ticks >= 0 ? 'up' : 'down');
}

// ─── 指標 ────────────────────────────────────────────────────────────────────

// 標準 EMA。資料不足 period 時不硬湊，改用手上全部天數當種子並回報實際天數，
// 由呼叫端決定要不要在畫面上標「歷史天數不足」。
function ema(values, period) {
  if (!values || !values.length) return [];
  const n = Math.min(period, values.length);
  const alpha = 2 / (n + 1);
  const out = new Array(values.length).fill(null);
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i];
  seed /= n;
  out[n - 1] = seed;
  for (let i = n; i < values.length; i++) {
    out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
  }
  return out;
}

// Wilder ATR。當沖要的是「這檔平常一天能跑多遠」，用來反推合理的停損距離。
function atr(bars, period) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - pc),
      Math.abs(bars[i].low - pc)
    ));
  }
  const n = Math.min(period, trs.length);
  let value = trs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < trs.length; i++) value = (value * (n - 1) + trs[i]) / n;
  return value;
}

/**
 * 支撐壓力：Left/Right Bars = 1 的分形轉折點（對應原策略把預設 15 改成 1）。
 * 高點高於左右各 1 根 → 壓力；低點低於左右各 1 根 → 支撐。
 *
 * 原策略的 Volume Threshold 20 在日線上沒有完全對應的東西，這裡用
 * 「該轉折當日成交量 ≥ 近 20 日均量」當近似，符合的標記 strong。
 */
function pivots(bars, left, right) {
  left = left == null ? 1 : left;
  right = right == null ? 1 : right;
  const highs = [];
  const lows = [];
  if (!bars || bars.length < left + right + 1) return { highs, lows };

  const avgVol = [];
  for (let i = 0; i < bars.length; i++) {
    const from = Math.max(0, i - 19);
    const slice = bars.slice(from, i + 1);
    avgVol[i] = slice.reduce((a, b) => a + (b.volume || 0), 0) / slice.length;
  }

  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    const strong = (bars[i].volume || 0) >= (avgVol[i] || 0);
    if (isHigh) highs.push({ index: i, price: bars[i].high, date: bars[i].date, strong });
    if (isLow) lows.push({ index: i, price: bars[i].low, date: bars[i].date, strong });
  }
  return { highs, lows };
}

// ─── 成本與部位 ──────────────────────────────────────────────────────────────
//
// 這段是整套策略在台股的生死線。原策略用 1:1 的風險報酬比換高勝率，
// 但台股當沖來回要付兩次手續費 + 一次減半證交稅，1:1 扣完成本後可能所剩無幾。
// 所以每一檔都要把「損益兩平價差」算出來擺在旁邊。

const FEE_RATE = 0.001425;   // 券商手續費
const TAX_RATE = 0.0015;     // 現股當沖證交稅（一般賣出是 0.003，當沖減半）

/**
 * 一趟來回的手續費與證交稅。
 *
 * side 影響的是「證交稅課在哪一腳」：稅只課賣出，做多是賣在 exit、做空是先賣在 entry。
 * 不分方向一律用 exit 當稅基的話，做空的稅會算錯（金額不大，但這是算錢的地方）。
 * 沒帶 side 時維持舊行為（等同做多），避免呼叫端漏帶就靜默算錯。
 */
function tradeCost(entry, exit, lots, opts, side) {
  const shares = lots * 1000;
  // 預設無折扣，跟 DEFAULT_SETTINGS 一致。這裡若留 0.6 而設定是 1.0，
  // 漏帶 opts 的呼叫端會靜默用比較便宜的成本算，把獲利算得比實際好看。
  const discount = opts && opts.feeDiscount != null ? opts.feeDiscount : 1.0;
  const minFee = opts && opts.minFee != null ? opts.minFee : 20;
  const rawBuy = entry * shares * FEE_RATE * discount;
  const rawSell = exit * shares * FEE_RATE * discount;
  const buyFee = Math.max(Math.round(rawBuy), shares > 0 ? minFee : 0);
  const sellFee = Math.max(Math.round(rawSell), shares > 0 ? minFee : 0);
  const sellLegPrice = side === 'short' ? entry : exit;
  const tax = Math.round(sellLegPrice * shares * TAX_RATE);
  return { buyFee, sellFee, tax, total: buyFee + sellFee + tax };
}

/**
 * 一張作戰卡的所有數字。
 * side: 'long' | 'short'；entry / stop 是已經對齊檔位的價格。
 */
function planTrade(side, entry, stop, settings) {
  const s = settings || {};
  const riskBudget = s.riskBudget != null ? s.riskBudget : 3000;
  const stopDistance = Number(Math.abs(entry - stop).toFixed(4));
  // 目標倍數。PDF 原本是 1:1，但台股扣完手續費與證交稅後 1:1 需要 61% 勝率才不賠；
  // 拉到 1:2 只需要 40%。賠率是這套策略在台股唯一還有得談的槓桿，所以做成可調。
  const targetR = s.targetR != null ? s.targetR : 2;
  const target = side === 'long'
    ? roundToTick(entry + stopDistance * targetR, 'down')
    : roundToTick(entry - stopDistance * targetR, 'up');

  // 張數上限：停損距離很小的低價股會算出幾十張，那個部位規模對 3000 元的帳戶
  // 不切實際（沒沖掉要補的全額股款是七位數），所以另外壓一個上限。
  const maxLots = s.maxLots != null ? s.maxLots : 10;
  const rawLots = stopDistance > 0 ? Math.floor(riskBudget / (stopDistance * 1000)) : 0;
  const capped = Math.min(rawLots, maxLots);

  // 3000 元要是「真的最多虧這麼多」，就得把手續費和證交稅一起算進去——
  // 只用停損距離反推張數，實際停損出場時會超出預算一成以上。
  let lots = 0;
  for (let n = capped; n >= 1; n--) {
    const loss = stopDistance * n * 1000 + tradeCost(entry, stop, n, s, side).total;
    if (loss <= riskBudget) { lots = n; break; }
  }
  const lotsCapped = rawLots > maxLots && lots === maxLots;
  const tradable = lots >= 1;
  const shares = lots * 1000;

  const lossExit = stop;
  const winExit = target;
  const costAtLoss = tradeCost(entry, lossExit, lots, s, side);
  const costAtWin = tradeCost(entry, winExit, lots, s, side);

  // 損益兩平：價格要走多遠才剛好打平成本（用 1 張估算，跟張數無關的每股成本）
  const probe = tradeCost(entry, entry, Math.max(lots, 1), { ...s, minFee: 0 }, side);
  const beMove = roundToTick(probe.total / (Math.max(lots, 1) * 1000), 'up');

  // 獲利那一腳用「實際目標價」算，不要用 stopDistance × targetR——目標價被檔位取整過，
  // 兩者會差半個檔位，而那個差額全部落在使用者的口袋以外。
  const grossWin = Math.abs(target - entry) * shares;
  const grossLoss = stopDistance * shares;
  const netWin = Math.round(grossWin - costAtWin.total);
  const netLoss = Math.round(grossLoss + costAtLoss.total);

  // 期望值：用勝率把淨賺淨賠加權，看看這筆到底值不值得做
  const winRate = s.assumedWinRate != null ? s.assumedWinRate : 0.7653;
  const expectancy = Math.round(netWin * winRate - netLoss * (1 - winRate));

  return {
    side, entry, stop, target, stopDistance, targetR,
    actualR: stopDistance > 0 ? Number((Math.abs(target - entry) / stopDistance).toFixed(2)) : null,
    stopPct: Number((stopDistance / entry * 100).toFixed(2)),
    lots, shares, tradable, lotsCapped, rawLots,
    fullPayment: Math.round(entry * shares),   // 沒沖掉的話要準備的全額股款
    cost: costAtWin.total,
    costDetail: costAtWin,
    breakevenMove: beMove,
    breakevenRatio: stopDistance > 0 ? Number((beMove / stopDistance).toFixed(2)) : null,
    netWin, netLoss, expectancy,
    // 成本吃掉超過三成的目標獲利就該亮燈，這種標的贏了也只是幫券商打工
    costWarning: grossWin > 0 && costAtWin.total / grossWin > 0.3
  };
}

// ─── 隔日作戰價位推算 ────────────────────────────────────────────────────────
//
// 盤中確認 K 棒的真實高低點要到當下才知道，收盤時只能先估。
// 15 分鐘 K 的波動大約是日 ATR 的四分之一上下，所以掃蕩深度抓 0.15×ATR，
// 進場與停損各站在關鍵價位的一邊，停損距離約 0.3×ATR，最少留 2 個檔位。

function estimateLevels(side, levelPrice, atrValue, minTicks) {
  const t = tickSize(levelPrice);
  // 下限不能只看檔位：0.2% 的停損在台股當沖等於一進場就在成本裡，
  // 隨便一個買賣價差就被掃掉，所以另外壓一個「至少 0.35% 價格」的地板。
  const depth = Math.max(atrValue * 0.18, levelPrice * 0.0035, t * (minTicks || 2));
  if (side === 'long') {
    const entry = roundToTick(levelPrice + depth, 'up');
    const stop = roundToTick(levelPrice - depth, 'down');
    return { entry, stop };
  }
  const entry = roundToTick(levelPrice - depth, 'down');
  const stop = roundToTick(levelPrice + depth, 'up');
  return { entry, stop };
}

// 盤中實際掃蕩發生後，用真實的 K 棒高低點重算（做多：進場 = 確認 K 高點 + 1 檔）
function levelsFromBar(side, barHigh, barLow) {
  if (side === 'long') {
    return { entry: addTicks(barHigh, 1), stop: addTicks(barLow, -1) };
  }
  return { entry: addTicks(barLow, -1), stop: addTicks(barHigh, 1) };
}

// ─── 盤中即時監控 ────────────────────────────────────────────────────────────
//
// 收盤後的篩選只能給「預估」價位——支撐壓力是用昨天以前的資料算的，實際進場點
// 要等盤中那根 15 分鐘 K 棒真的走出來才知道。這一段就是做這件事：把即時報價的
// 快照堆成 15 分鐘蠟燭，蠟燭收盤時判斷「掃蕩後收回」是否成立，成立就用
// levelsFromBar() 算出精確的進場/停損，不重造價位計算邏輯。
//
// 證交所的即時報價 API 只給「當下快照」（最新成交價、當日累計高低），不是逐筆
// K 線，所以蠟燭是靠反覆輪詢自己堆出來的近似值——兩次輪詢之間如果有一個瞬間
// 插針又收回，可能沒被捕捉到。這點必須讓使用者知道，不能包裝成跟看盤軟體
// 一樣精確。

// ─── 交易時段（全部可設定）────────────────────────────────────────────────────
//
// 使用者只有 09:00–10:00 能當沖，所以策略壓在這一小時。但時間絕對不寫死：
// 換回全天 09:00–13:30 只要改設定，行為就要完全退回原本的樣子（有回歸測試守著）。
//
// 「距收盤前 N 分鐘」而不是絕對時間，是因為時段長度會變：一小時的窗口下
// 「13:00 不開新倉」毫無意義，但「收盤前 10 分鐘不開新倉」在任何時段都成立。

var MARKET_OPEN_MINUTES = 9 * 60;          // 證交所開盤（市場事實，不是使用者的時段）
var MARKET_CLOSE_MINUTES = 13 * 60 + 30;   // 證交所收盤
var CANDLE_MINUTES = 5;

var SESSION_DEFAULTS = {
  sessionStart: 9 * 60,      // 你的交易時段開始（09:00）
  sessionEnd: 10 * 60,       // 你的交易時段結束（10:00），之後停止輪詢
  openingSkipMinutes: 5,     // 開盤亂流：跳過前 N 分鐘內的訊號
  noNewEntryMinutes: 10,     // 距時段結束前 N 分鐘起不開新倉（要留時間讓交易走完）
  forceCloseMinutes: 2,      // 距時段結束前 N 分鐘強制平倉
  candleMinutes: 5
};

/**
 * 把設定攤成幾個「當日絕對分鐘」。所有時間判斷都跟這裡拿，不要各自再算一次。
 * 舊呼叫端有些只傳蠟燭週期（數字），這裡一併相容。
 */
function sessionOf(settings) {
  const s = (typeof settings === 'number') ? { candleMinutes: settings } : (settings || {});
  const pick = (k) => (s[k] != null ? s[k] : SESSION_DEFAULTS[k]);
  const start = pick('sessionStart');
  const end = pick('sessionEnd');
  return {
    start,
    end,
    candleMinutes: pick('candleMinutes'),
    openingSkip: pick('openingSkipMinutes'),
    noNewEntryAt: end - pick('noNewEntryMinutes'),
    forceCloseAt: end - pick('forceCloseMinutes')
  };
}

/** 分鐘數 → "09:35"，畫面上的時間字串一律由設定算出來，不再寫死 */
function fmtMinutes(m) {
  const v = ((Math.round(m) % 1440) + 1440) % 1440;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

// 台灣沒有日光節約時間，UTC+8 是常數，不用查時區資料庫
function taipeiMinutesOfDay(ms) {
  const d = new Date(ms);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return (utcMinutes + 8 * 60) % (24 * 60);
}

/** 現在是否落在「你的交易時段」內（不是證交所的開盤時間） */
function isMarketHours(ms, settings) {
  const ss = sessionOf(settings);
  const m = taipeiMinutesOfDay(ms);
  return m >= ss.start && m < ss.end;
}

// 時段開始之後第幾根蠟燭（0 起算）；不在時段內回 null，呼叫端要先擋 isMarketHours
function candleIndex(ms, settings) {
  const ss = sessionOf(settings);
  if (!isMarketHours(ms, settings)) return null;
  return Math.floor((taipeiMinutesOfDay(ms) - ss.start) / ss.candleMinutes);
}

/**
 * 這根蠟燭是否落在開盤亂流時段，PDF 策略與檢查表都要求跳過。
 *
 * 原本寫死 idx === 0，那只有在週期剛好等於要跳過的分鐘數時才對。改成用分鐘換算，
 * 任何週期下都正確（跳過 5 分鐘：5分K→前1根、跳過 15 分鐘：5分K→前3根）。
 */
function isOpeningCandle(idx, settings) {
  const ss = sessionOf(settings);
  return idx < Math.ceil(ss.openingSkip / ss.candleMinutes);
}

/**
 * 用一筆新的報價快照更新目前這根蠟燭。
 *
 * prevCandle: 上一輪的蠟燭狀態（{idx, open, high, low, close}）或 null（還沒開始）
 * tick: { price }，price 可能是 null（今天還沒成交過，或非交易時間）
 * nowMs: 這筆快照的時間戳
 * lastKnownPrice: tick.price 是 null 時的備援（沿用上一筆已知價格），避免把「還沒成交」誤判成價格是 0
 *
 * 回傳 { candle, closedCandle }：closedCandle 只在「這一輪跨到下一根蠟燭」時才有值，
 * 代表剛剛結束的那根蠟燭——訊號判定要用這個，不要用還在形成中的 candle。
 */
function updateCandle(prevCandle, tick, nowMs, lastKnownPrice, settings) {
  if (!isMarketHours(nowMs, settings)) return { candle: prevCandle, closedCandle: null };

  const idx = candleIndex(nowMs, settings);
  const price = tick && tick.price != null ? tick.price : lastKnownPrice;
  if (price == null) return { candle: prevCandle, closedCandle: null };   // 從沒拿到過價格，還不能開蠟燭

  if (!prevCandle || prevCandle.idx !== idx) {
    const closedCandle = prevCandle && prevCandle.idx !== idx ? prevCandle : null;
    return { candle: { idx, open: price, high: price, low: price, close: price }, closedCandle };
  }
  return {
    candle: {
      idx,
      open: prevCandle.open,
      high: Math.max(prevCandle.high, price),
      low: Math.min(prevCandle.low, price),
      close: price
    },
    closedCandle: null
  };
}

/**
 * 掃蕩收回判定，跟 EOD 卡片裡的邏輯是同一套規則，只是這裡吃的是即時蠟燭。
 * swept：這根蠟燭曾經跌破支撐／衝過壓力（掃蕩發生過）
 * reclaimed：目前（或收盤時）的價格已經收回關鍵價位的正確一側
 * confirmed：兩者同時成立——對形成中的蠟燭來說只是「暫時符合」，
 *   真正算數要等蠟燭收盤（呼叫端用 closedCandle 再判一次）
 */
function evaluateSweep(candle, side, levelPrice) {
  if (!candle) return { swept: false, reclaimed: false, confirmed: false };
  const swept = side === 'long' ? candle.low < levelPrice : candle.high > levelPrice;
  const reclaimed = side === 'long' ? candle.close > levelPrice : candle.close < levelPrice;
  return { swept, reclaimed, confirmed: swept && reclaimed };
}

/**
 * 進場之後：這一輪該不該出場了？
 *
 * position: { side, entry, stop, target, dayHighAtEntry, dayLowAtEntry }
 * tick: { price, high, low }  ← high/low 是證交所回的「當日累計」極值，不是我們自己堆的
 * 回傳 null（繼續持有）或 { reason:'stop'|'target'|'time', price }
 *
 * 兩個刻意的設計：
 *
 * 1. 停損優先於停利。十秒輪詢一次，同一個區間內如果兩邊看起來都碰到了，我們無從得知
 *    哪個先發生。這種時候必須假設是壞的那個——工具寧可把績效講得比實際保守，
 *    也不能反過來讓使用者以為自己賺到了。
 *
 * 2. 除了比對最新成交價，也用當日累計高低來回推。那是交易所給的真實極值，
 *    能抓到兩次輪詢之間的瞬間觸價；只看最新成交價的話，插針碰到停損又彈回來
 *    會被整個漏掉。做法是拿「進場當下的日高日低」當基準線：若進場時日高還沒到目標價、
 *    現在的日高卻超過了，代表目標價是在進場之後才被觸及的。
 */
function evaluateExit(position, tick, nowMs, settings) {
  if (!position) return null;
  const { side, entry, stop, target, dayHighAtEntry, dayLowAtEntry } = position;
  const price = tick && tick.price != null ? tick.price : null;
  const dayHigh = tick && tick.high != null ? tick.high : null;
  const dayLow = tick && tick.low != null ? tick.low : null;

  // 進場之後日高/日低是否越過了某個價位（用進場當下的極值當基準，排除進場前就碰過的情況）
  const brokeUpAfterEntry = (level) =>
    dayHigh != null && dayHigh >= level && (dayHighAtEntry == null || dayHighAtEntry < level);
  const brokeDownAfterEntry = (level) =>
    dayLow != null && dayLow <= level && (dayLowAtEntry == null || dayLowAtEntry > level);

  const stopHit = side === 'long'
    ? (price != null && price <= stop) || brokeDownAfterEntry(stop)
    : (price != null && price >= stop) || brokeUpAfterEntry(stop);
  if (stopHit) return { reason: 'stop', price: stop };

  const targetHit = side === 'long'
    ? (price != null && price >= target) || brokeUpAfterEntry(target)
    : (price != null && price <= target) || brokeDownAfterEntry(target);
  if (targetHit) return { reason: 'target', price: target };

  // 時間到就是要平，不管賺賠——沒沖掉要交割全額股款，那才是真正的災難
  if (nowMs != null && taipeiMinutesOfDay(nowMs) >= sessionOf(settings).forceCloseAt) {
    return { reason: 'time', price: price != null ? price : entry };
  }
  return null;
}

/**
 * 這筆到底划不划算——低賠率策略在台股的生死線。
 *
 * 目標倍數 R（停利距離 = R × 停損距離）下：
 *   期望值/股 = p(Rd − c) − (1−p)(d + c) = d(p(R+1) − 1) − c
 *     d = 停損距離，c = 每股來回成本，p = 勝率
 *
 * 反過來解得兩個一眼就懂的數字：
 *   · 停損距離至少要多大：d > c / (p(R+1) − 1)
 *   · 這筆需要多少勝率才不賠：p > (d + c) / (d(R+1))
 *
 * R = 1 時退化成原本的 d > c/(2p−1) 與 p > (1 + c/d)/2（有回歸測試守著）。
 *
 * 第二個數字特別有用。停損距離只有成本的一倍時，requiredWinRate 會超過 100%——
 * 那代表就算每一筆都猜對還是賠，跟勝率高不高完全無關。使用者實際踩到的那筆
 * （50.50 進場、停損 50.70、無折扣、1:1）就是這種：需要 105% 勝率，數學上不可能。
 *
 * marketDirection（可選）：大盤方向過濾算出來的條件式方向正確率。有給的話
 * 就用「假設勝率」與「方向正確率」中比較低的那個當實際勝率——站錯邊的時候，
 * 策略本身的勝率再高也沒有意義。
 */
function tradeViability(plan, settings, marketDirection) {
  const s = settings || {};
  const assumed = s.assumedWinRate != null ? s.assumedWinRate : 0.7653;
  const dirProb = marketDirection && marketDirection.applies && marketDirection.prob != null
    ? marketDirection.prob : null;
  const winRate = dirProb != null ? Math.min(assumed, dirProb) : assumed;

  const R = plan.targetR != null ? plan.targetR : 1;
  const d = plan.stopDistance;
  const costPerShare = plan.shares > 0 ? plan.costDetail.total / plan.shares : 0;
  const edge = winRate * (R + 1) - 1;

  // edge ≤ 0 代表這個賠率配這個勝率，再大的停損距離都救不回來
  const minStopDistance = edge > 0 ? roundToTick(costPerShare / edge, 'up') : Infinity;
  const requiredWinRate = d > 0 ? (d + costPerShare) / (d * (R + 1)) : Infinity;
  // 停損距離不動的前提下，這筆要多少報酬倍數才會轉正
  const requiredRatio = (d > 0 && winRate > 0)
    ? Number((((1 - winRate) * d + costPerShare) / (winRate * d)).toFixed(2))
    : Infinity;

  // 期望值要用「實際用到的勝率」重算一次——plan.expectancy 是用假設勝率算的，
  // 逆勢時那個數字會過度樂觀。
  const expectancy = Math.round(plan.netWin * winRate - plan.netLoss * (1 - winRate));

  return {
    costPerShare: Number(costPerShare.toFixed(4)),
    costShare: plan.shares > 0 && d > 0 ? plan.costDetail.total / (d * plan.shares) : 1,
    minStopDistance,
    requiredWinRate,
    requiredRatio,
    targetR: R,
    winRate,
    expectancy,
    // 方向過濾實際有沒有介入，UI 要據此決定顯示「不建議進場（逆勢）」還是「成本太高」
    countertrend: dirProb != null && dirProb < requiredWinRate,
    marketDirection: marketDirection || null,
    // netWin ≤ 0 是絕對紅線：代表就算完美走到目標價還是賠錢
    impossible: plan.netWin <= 0 || requiredWinRate >= 1,
    viable: plan.netWin > 0 && expectancy > 0 && d >= minStopDistance
  };
}

/**
 * 一小時窗口下的新問題：很多交易不會走到目標或停損，而是「時間到」被平掉——
 * 照付來回成本，卻沒有對應的價格移動。原本的期望值模型只有停利／停損兩種結局，
 * 會系統性高估。這支估「收盤前解決得掉的機率」，讓畫面能標出那個樂觀程度。
 *
 * 做法：無漂移布朗運動的首次通過時間近似。用反射原理，
 *   P(在 T 內碰到單邊障礙 a) = 2·P(|W_T| ≥ a)
 * 兩邊障礙（停損 −d、停利 +Rd）各算一次相加、上限 1。忽略了兩邊的聯合機率，
 * 所以會略為高估——這裡刻意選高估，因為這個數字是拿來「打折期望值」的，
 * 寧可讓使用者看到比較保守的期望值。
 *
 * 波動度用當日振幅%（Parkinson 近似：σ_日 ≈ 全距 / 2√(ln2) ≈ 全距 / 1.665），
 * 再依剩餘分鐘數對整個交易日（270 分鐘）開根號縮放。
 * openingFactor 給開盤時段用——開盤一小時的波動明顯高於全天平均。
 */
function resolveProbability(stopDistance, price, minutesLeft, dailyRangePct, targetR, openingFactor) {
  if (!(stopDistance > 0) || !(price > 0) || !(minutesLeft > 0) || !(dailyRangePct > 0)) return null;
  const R = targetR != null ? targetR : 1;
  const sigmaDay = (dailyRangePct / 100) * price / 1.665;
  const sigmaT = sigmaDay * Math.sqrt(minutesLeft / 270) * (openingFactor != null ? openingFactor : 1);
  if (!(sigmaT > 0)) return null;
  // 標準常態上尾機率（Abramowitz & Stegun 7.1.26 的誤差函數近似）
  const tail = (z) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989422804014327 * Math.exp(-z * z / 2);
    const pp = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
      t * (-1.821255978 + t * 1.330274429))));
    return z >= 0 ? pp : 1 - pp;
  };
  const hit = (barrier) => Math.min(1, 2 * tail(barrier / sigmaT));
  return Math.min(1, hit(stopDistance) + hit(stopDistance * R));
}

// ─── 大盤方向過濾 ────────────────────────────────────────────────────────────
//
// 使用者提出的：「台指上漲，那些當沖量大的個股通常會跟著漲，我就不能做空。」
// 用 repo 裡 59 個交易日的真實全市場資料實測，這個直覺完全成立，而且比預期嚴重：
//
//   3481 群創 beta 1.44 / 相關性 0.76 → 大盤上漲的日子它下跌的機率只有 11%
//   4989 榮科 beta 1.39 / 相關性 0.74 → 30%
//   3149 正達 beta 0.98 / 相關性 0.57 → 35%
//   2886 兆豐金 beta −0.02 / 相關性 −0.04 → 49%（幾乎不受大盤影響）
//
// 1:2 賠率需要 40% 勝率，而大盤上漲時做空這批候選平均只有 35% 方向正確——
// 光是站錯邊就把期望值打到門檻以下。使用者賠錢那筆正是做空 3481。
//
// 這裡刻意「不預測」今天大盤會漲還是跌，只用大盤已經表現出來的狀態當過濾器：
// 可驗證、可回測，而且從上面的數字看效果已經夠大。

/**
 * 大盤報酬代理：用**現有的**全市場歷史算成交值加權日報酬。
 * 不需要另外抓指數歷史——本地快取沒存成交金額，但「收盤 × 成交股數」就是成交金額，
 * 實測用這個權重算出來的 beta 與用證交所成交金額欄位算的完全一致（到小數第二位）。
 *
 * history: Map(代號 → 依日期排序的 bars)，也就是 loadHistory() 的輸出。
 * 只採計「相鄰交易日」的配對，缺資料的那天不會被跨過去硬算成一天的報酬。
 */
function marketReturnSeries(history) {
  const allDates = new Set();
  for (const bars of history.values()) for (const b of bars) allDates.add(b.date);
  const dates = Array.from(allDates).sort();
  const prevDate = new Map();
  for (let i = 1; i < dates.length; i++) prevDate.set(dates[i], dates[i - 1]);

  const acc = new Map();   // 日期 → { 加權報酬合計, 權重合計 }
  for (const bars of history.values()) {
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1], cur = bars[i];
      if (prevDate.get(cur.date) !== prev.date) continue;      // 中間缺天就跳過這一對
      if (!(prev.close > 0) || !(cur.close > 0) || !(cur.volume > 0)) continue;
      const wt = cur.close * cur.volume;
      let a = acc.get(cur.date);
      if (!a) { a = { ws: 0, w: 0 }; acc.set(cur.date, a); }
      a.ws += (cur.close / prev.close - 1) * wt;
      a.w += wt;
    }
  }
  const out = [];
  for (const d of dates) {
    const a = acc.get(d);
    if (a && a.w > 0) out.push({ date: d, ret: a.ws / a.w });
  }
  return out;
}

/** 個股 bars + 大盤報酬表 → marketBeta() 需要的兩條對齊序列 */
function alignReturns(bars, marketMap) {
  const stock = [], market = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1], cur = bars[i];
    const mr = marketMap.get(cur.date);
    if (mr == null || !(prev.close > 0) || !(cur.close > 0)) continue;
    stock.push(cur.close / prev.close - 1);
    market.push(mr);
  }
  return { stock, market };
}

/**
 * 個股對大盤的 beta、相關性，以及最關鍵的那個條件機率：
 * 「大盤上漲的日子，這檔下跌的比例是多少」——那正是做空的方向正確率。
 *
 * stockReturns / marketReturns 必須是對齊的同長度陣列。
 */
function marketBeta(stockReturns, marketReturns) {
  const n = Math.min(stockReturns.length, marketReturns.length);
  if (n < 10) return null;      // 樣本太少算出來的 beta 只是噪音
  const x = marketReturns.slice(-n), y = stockReturns.slice(-n);
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let k = 0; k < n; k++) {
    cov += (x[k] - mx) * (y[k] - my);
    vx += (x[k] - mx) * (x[k] - mx);
    vy += (y[k] - my) * (y[k] - my);
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  let up = 0, upDown = 0, down = 0, downUp = 0;
  for (let k = 0; k < n; k++) {
    if (x[k] > 0) { up++; if (y[k] < 0) upDown++; }
    else if (x[k] < 0) { down++; if (y[k] > 0) downUp++; }
  }
  return {
    n,
    beta: Number((cov / vx).toFixed(3)),
    corr: Number((cov / Math.sqrt(vx * vy)).toFixed(3)),
    upDays: up,
    downDays: down,
    // 大盤漲的日子做空對的機率 / 大盤跌的日子做多對的機率
    upDayDownProb: up >= 5 ? Number((upDown / up).toFixed(3)) : null,
    downDayUpProb: down >= 5 ? Number((downUp / down).toFixed(3)) : null
  };
}

var WEAK_CORR = 0.3;   // 相關性低於這個值就不拿方向過濾去擋單，只註記

/**
 * 把「大盤目前的方向」+「這檔的 beta/相關性」換算成這筆交易的方向正確率。
 *
 * side: 'long' | 'short'
 * betaInfo: marketBeta() 的結果（可能是 null）
 * marketChangePct: 大盤目前的漲跌幅%（tse_t00.tw 的即時報價；null = 取不到）
 *
 * 回傳 { applies, prob, note, weak }。applies=false 代表「不擋單」——可能是
 * 沒有大盤資料、樣本不足、相關性太弱，或大盤根本是平盤。
 */
function marketDirectionFilter(side, betaInfo, marketChangePct, flatThresholdPct) {
  const flat = flatThresholdPct != null ? flatThresholdPct : 0.1;
  if (marketChangePct == null) {
    return { applies: false, prob: null, weak: false, note: '沒有大盤資料，方向過濾停用' };
  }
  if (Math.abs(marketChangePct) < flat) {
    return { applies: false, prob: null, weak: false,
      note: '大盤在平盤附近（' + marketChangePct.toFixed(2) + '%），方向過濾不介入' };
  }
  if (!betaInfo) {
    return { applies: false, prob: null, weak: false, note: '歷史樣本不足，算不出與大盤的連動' };
  }
  const weak = Math.abs(betaInfo.corr) < WEAK_CORR;
  const marketUp = marketChangePct > 0;
  // 大盤漲 → 做空要看 upDayDownProb；做多要看它的補數（同一組樣本，方向相反）
  let prob;
  if (marketUp) {
    prob = side === 'short' ? betaInfo.upDayDownProb
                            : (betaInfo.upDayDownProb == null ? null : 1 - betaInfo.upDayDownProb);
  } else {
    prob = side === 'long' ? betaInfo.downDayUpProb
                           : (betaInfo.downDayUpProb == null ? null : 1 - betaInfo.downDayUpProb);
  }
  if (prob == null) {
    return { applies: false, prob: null, weak, note: '大盤同方向的樣本天數不足' };
  }
  const dirText = marketUp ? '大盤上漲' : '大盤下跌';
  const sideText = side === 'long' ? '做多' : '做空';
  if (weak) {
    return { applies: false, prob, weak: true,
      note: '與大盤連動弱（相關性 ' + betaInfo.corr + '），方向過濾參考性低，不擋單' };
  }
  return {
    applies: true, prob, weak: false,
    note: dirText + '（' + marketChangePct.toFixed(2) + '%）時，這檔 ' + sideText +
      '方向對的機率 ' + Math.round(prob * 100) + '%（beta ' + betaInfo.beta +
      '、相關性 ' + betaInfo.corr + '、樣本 ' + (marketUp ? betaInfo.upDays : betaInfo.downDays) + ' 天）'
  };
}

/** 實際出場後的損益（重用 tradeCost，不重算費用與稅） */
function realizePnl(side, entry, exitPrice, lots, settings) {
  const shares = lots * 1000;
  const dir = side === 'long' ? 1 : -1;
  const gross = (exitPrice - entry) * shares * dir;
  const cost = tradeCost(entry, exitPrice, lots, settings || {}, side).total;
  return { gross: Math.round(gross), cost, net: Math.round(gross - cost) };
}

// ─── 模擬單 ──────────────────────────────────────────────────────────────────
//
// 預設開啟。整條流程照跑，但不要求真的下單——「我進場了」變成記錄一筆模擬交易。
// 這是唯一能回答「這套在台股到底行不行」的方法：使用者目前手上一個樣本都沒有，
// 只有兩筆賠錢的實單記憶，那既不足以否定策略，也不足以肯定它。

/**
 * 逐筆記錄 → 統計。
 * trades: [{ date, code, side, entry, stop, exitPrice, exitReason, net, r }]
 * r 是實際的 R 倍數（(出場−進場)/停損距離，做空反向），時間出場時可能是任何小數。
 */
function paperStats(trades) {
  const list = (trades || []).filter((t) => t && t.exitReason);
  const n = list.length;
  if (!n) {
    return { n: 0, wins: 0, losses: 0, winRate: null, avgR: null, totalNet: 0,
      expectancy: null, maxLossStreak: 0, timeExitRatio: null, byReason: {} };
  }
  let wins = 0, totalNet = 0, sumR = 0, streak = 0, maxStreak = 0;
  const byReason = {};
  for (const t of list) {
    const net = t.net != null ? t.net : 0;
    totalNet += net;
    if (t.r != null) sumR += t.r;
    if (net > 0) { wins++; streak = 0; }
    else { streak++; if (streak > maxStreak) maxStreak = streak; }
    byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;
  }
  const withR = list.filter((t) => t.r != null).length;
  return {
    n,
    wins,
    losses: n - wins,
    winRate: Number((wins / n).toFixed(4)),
    avgR: withR ? Number((sumR / withR).toFixed(3)) : null,
    totalNet: Math.round(totalNet),
    expectancy: Math.round(totalNet / n),
    maxLossStreak: maxStreak,
    // 時間出場佔比是這次改版最該盯的數字：一小時窗口下每一筆時間出場都照付來回成本，
    // 卻沒有對應的價格移動。這個比例太高，代表窗口或停損距離設錯了。
    timeExitRatio: Number(((byReason.time || 0) / n).toFixed(3)),
    byReason
  };
}

/** 一筆已出場的交易走了幾個 R（做空反向） */
function tradeR(side, entry, stop, exitPrice) {
  const d = Math.abs(entry - stop);
  if (!(d > 0)) return null;
  const dir = side === 'long' ? 1 : -1;
  return Number((((exitPrice - entry) * dir) / d).toFixed(3));
}

// 加權指數在同一支即時報價 API 上，代號 tse_t00.tw——把它加進現有的批次查詢即可，
// 不需要任何新的基礎設施。
var INDEX_QUOTE_CODE = 'tse_t00';

// ─── 台灣市場結構的實務過濾 ──────────────────────────────────────────────────
//
// 這幾條不是策略，是台股的機制。不管訊號多漂亮，踩到都會讓實際成交跟工具算的對不上。

var LIMIT_PCT = 10;            // 台股單日漲跌幅上限 10%
var STABILITY_PCT = 3.5;       // 瞬間價格穩定措施的門檻

/**
 * 這檔今天已經跑多遠了？
 *
 * · 已經大漲大跌一段的股票，剩下的空間被壓縮，而且離漲跌停越近越可能沖不掉
 *   （沒沖掉就要交割全額股款，那是三千元帳戶最大的風險）。
 * · 距漲跌停 nearLimitPct 以內就直接別碰。
 *
 * 回傳 { changePct, extended, nearLimit, blocked }。
 */
function dayMoveStatus(price, prevClose, settings) {
  const s = settings || {};
  const maxMove = s.maxDayMovePct != null ? s.maxDayMovePct : 5;
  const nearLimit = s.nearLimitPct != null ? s.nearLimitPct : 2;
  if (!(price > 0) || !(prevClose > 0)) {
    return { changePct: null, extended: false, nearLimit: false, blocked: false };
  }
  const changePct = (price / prevClose - 1) * 100;
  const distToLimit = LIMIT_PCT - Math.abs(changePct);
  const isNearLimit = distToLimit <= nearLimit;
  const extended = Math.abs(changePct) >= maxMove;
  return {
    changePct: Number(changePct.toFixed(2)),
    extended,
    nearLimit: isNearLimit,
    blocked: extended || isNearLimit
  };
}

/** 把候選的市場別轉成證交所即時報價 API 要的前綴（tse_/otc_） */
function quoteCode(candidate) {
  const prefix = candidate.market === 'TPEX' ? 'otc_' : 'tse_';
  return prefix + candidate.code;
}

/**
 * 呼叫盤中報價代理（見 gas/daytrade_quote/），一次查完所有代號。
 * baseUrl 是使用者部署後填入的 QUOTE_GAS_URL；codes 是 quoteCode() 產生的陣列。
 */
async function fetchQuotes(baseUrl, codes, timeoutMs) {
  if (!baseUrl) throw new Error('尚未設定即時報價網址，見頁面上的部署說明');
  const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') +
    'action=quote&codes=' + encodeURIComponent(codes.join(','));
  const data = await fetchJson(url, timeoutMs || 15000);
  if (!data || data.status !== 'success') {
    throw new Error((data && data.error) || '即時報價代理回應異常');
  }
  return data.quotes || [];
}

// ─── 評分 ────────────────────────────────────────────────────────────────────

function bandScore(value, lo, hi) {
  // 落在甜蜜區給滿分，超出兩側線性遞減到 0（各留一個區間寬度的緩衝）
  if (value == null || !isFinite(value)) return 0;
  const width = hi - lo;
  if (value >= lo && value <= hi) return 1;
  if (value < lo) return Math.max(0, 1 - (lo - value) / width);
  return Math.max(0, 1 - (value - hi) / width);
}

function scoreStock(m, universe) {
  // 流動性用全市場分位數，不用絕對金額——每天市場冷熱不同，比較才有意義
  const liquidity = universe.turnoverRank != null ? universe.turnoverRank : 0;

  const volatility = Math.max(
    bandScore(m.rangePct, 2.5, 7),
    m.atrPct != null ? bandScore(m.atrPct, 2.5, 7) * 0.9 : 0
  );

  const dayTrade = m.dayTradeRatio == null
    ? 0.35   // 沒抓到當沖比重就給中性分，不因為資料缺失懲罰這檔
    : Math.min(1, m.dayTradeRatio / 0.25);

  let trend = 0;
  if (m.ema30 != null) {
    const bias = Math.abs(m.close - m.ema30) / m.close;
    trend += bandScore(bias * 100, 0.5, 6) * 0.5;              // 離均線太近方向不明、太遠追高
    if (m.emaSlope != null && Math.sign(m.emaSlope) === Math.sign(m.close - m.ema30)) trend += 0.25;
    const pos = m.closePosition;                                // 收盤在當日區間的位置
    if (pos != null) trend += (m.close > m.ema30 ? pos : 1 - pos) * 0.25;
  }

  // 關鍵價位要落在「一個停損距離之內構得到」的範圍，太遠的線隔天根本碰不到
  let structure = 0;
  if (m.nearestLevel != null && m.atr != null && m.atr > 0) {
    const dist = Math.abs(m.close - m.nearestLevel.price) / m.atr;
    structure = bandScore(dist, 0.1, 1.2);
    if (m.nearestLevel.strong) structure = Math.min(1, structure + 0.15);
  }

  const parts = {
    liquidity: liquidity * 25,
    volatility: volatility * 25,
    dayTrade: dayTrade * 20,
    trend: trend * 20,
    structure: structure * 10
  };
  const total = Math.round(parts.liquidity + parts.volatility + parts.dayTrade + parts.trend + parts.structure);
  return { total, parts };
}

// ─── 資料來源 ────────────────────────────────────────────────────────────────
//
// 網頁「不」直接打證交所——證交所沒有對瀏覽器發 CORS 授權，直接 fetch 一定是
// Failed to fetch。改成讀同網域下的 data/，那些檔案由 GitHub Actions 每天
// 在伺服器端抓好 commit 進 repo（見 scripts/fetch-twse.mjs）。同源就沒有 CORS 問題。

const DATA_BASE = 'data/';
const FETCH_TIMEOUT_MS = 20000;

// 一定要有逾時。交易所的 API 忙起來會吊著不回，沒有逾時前端就真的乾等。
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('連線逾時');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || s === '--' || s === '---' || s === 'null') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/**
 * 欄位容錯對應。
 * 交易所的 OpenAPI 欄位名稱改過不只一次，寫死欄位名遲早整頁壞掉；
 * 先試完全比對，再試正規化後的包含比對，都找不到就回 undefined 由上層標記缺失。
 */
function pickField(row, aliases) {
  for (const a of aliases) {
    if (row[a] !== undefined) return row[a];
  }
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
  const keys = Object.keys(row).map((k) => [k, norm(k)]);
  for (const a of aliases) {
    const an = norm(a);
    for (const [k, kn] of keys) {
      if (kn === an) return row[k];
    }
  }
  for (const a of aliases) {
    const an = norm(a);
    for (const [k, kn] of keys) {
      if (kn.includes(an)) return row[k];
    }
  }
  return undefined;
}

function normalizeQuote(row, market) {
  const code = String(pickField(row, ['Code', 'SecuritiesCompanyCode', '證券代號', '股票代號']) || '').trim();
  if (!/^\d{4,6}$/.test(code)) return null;      // 濾掉權證、ETN 之類代號不是純數字的
  const close = num(pickField(row, ['ClosingPrice', 'Close', '收盤價']));
  const open = num(pickField(row, ['OpeningPrice', 'Open', '開盤價']));
  const high = num(pickField(row, ['HighestPrice', 'High', '最高價']));
  const low = num(pickField(row, ['LowestPrice', 'Low', '最低價']));
  if (!close || !high || !low) return null;
  return {
    code,
    name: String(pickField(row, ['Name', 'CompanyName', '證券名稱', '公司名稱']) || code).trim(),
    market: market || 'TWSE',
    open: open || close,
    high, low, close,
    change: num(pickField(row, ['Change', '漲跌價差'])) || 0,
    volume: num(pickField(row, ['TradeVolume', 'TradingShares', '成交股數'])) || 0,
    turnover: num(pickField(row, ['TradeValue', 'TradingValue', '成交金額'])) || 0,
    trades: num(pickField(row, ['Transaction', 'TransactionNumber', '成交筆數'])) || 0
  };
}

/** 把 data/days/*.json 的緊湊陣列格式攤回成一般的報價物件 */
function unpackDay(day) {
  const out = [];
  for (const r of (day.rows || [])) {
    const close = r[5];
    if (!close) continue;
    out.push({
      code: r[0], name: r[1], market: 'TWSE', date: day.date,
      open: r[2] || close, high: r[3], low: r[4], close,
      volume: r[6] || 0, turnover: r[7] || 0, change: r[8] || 0,
      trades: 0, dayTradeVolume: r[9] == null ? null : r[9]
    });
  }
  return out;
}

/**
 * 載入 repo 裡的資料。
 * 已經下載過的日期會留在 IndexedDB，所以第二次之後只需要抓當天新增的那一份。
 * onProgress(已完成, 總數) 讓畫面可以顯示進度——第一次要抓 60 天，會跑幾秒。
 */
async function fetchMarketData(settings, onProgress) {
  const errors = [];
  const index = await fetchJson(DATA_BASE + 'index.json');
  if (!index || !Array.isArray(index.days) || !index.days.length) {
    throw new Error('data/index.json 裡沒有任何交易日，排程可能還沒跑過');
  }

  // 只下載本機還沒有的日期
  const have = await dbDates();
  const missing = index.days.filter((d) => !have.has(d));
  let done = 0;
  if (onProgress) onProgress(0, missing.length);

  // 併發 6 個就夠了，同網域的小檔案不必開太多
  const queue = missing.slice();
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const date = queue.shift();
      try {
        const day = await fetchJson(`${DATA_BASE}days/${date}.json`);
        if (day && day.rows) await saveDay(date, unpackDay(day));
      } catch (e) {
        errors.push(`${date} 的資料讀取失敗：${e.message}`);
      }
      done++;
      if (onProgress) onProgress(done, missing.length);
    }
  });
  await Promise.all(workers);

  // 最新一天就是要拿來選股的那天
  const latestDate = index.days[index.days.length - 1];
  let quotes = [];
  try {
    quotes = unpackDay(await fetchJson(`${DATA_BASE}days/${latestDate}.json`));
  } catch (e) {
    throw new Error(`最新一天（${latestDate}）的資料讀不到：${e.message}`);
  }

  const extra = { dayTrade: null, noShortSell: null, punish: null };
  const dtMap = new Map();
  for (const q of quotes) {
    if (q.dayTradeVolume != null) dtMap.set(q.code, { volume: q.dayTradeVolume });
  }
  if (dtMap.size) extra.dayTrade = dtMap;
  else errors.push('最新一天沒有當沖成交量資料，當沖比重改給中性分');

  try {
    const meta = await fetchJson(DATA_BASE + 'meta.json');
    if (meta) {
      extra.punish = new Set(meta.punish || []);
      extra.noShortSell = new Set(meta.noShortSell || []);
    }
  } catch (e) {
    errors.push(`處置股／禁先賣後買清單讀取失敗：${e.message}（請自行避開）`);
  }

  if (Array.isArray(index.warnings)) errors.push(...index.warnings.map((w) => '排程警告：' + w));

  return { quotes, extra, errors, latestDate, totalDays: index.days.length, updated: index.updated };
}

// ─── 手動貼上備援 ────────────────────────────────────────────────────────────
//
// 交易所擋 CORS 或使用者網路連不出去時，整套流程還是要能跑完。

function parsePasted(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return { quotes: [], errors: ['沒有內容'] };

  // 先試 JSON（直接把 STOCK_DAY_ALL 的回應整段貼過來）
  if (trimmed[0] === '[' || trimmed[0] === '{') {
    try {
      const raw = JSON.parse(trimmed);
      const rows = Array.isArray(raw) ? raw : (raw.data || []);
      const quotes = rows.map((r) => normalizeQuote(r, 'PASTE')).filter(Boolean);
      return quotes.length
        ? { quotes, errors: [] }
        : { quotes: [], errors: ['JSON 解析成功但認不出任何個股欄位'] };
    } catch (e) {
      return { quotes: [], errors: [`JSON 格式錯誤：${e.message}`] };
    }
  }

  // 再試 CSV / TSV：代號,名稱,開,高,低,收,量
  const quotes = [];
  const errors = [];
  const lines = trimmed.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split(/[\t,]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cells.length < 6) continue;
    const code = cells[0];
    if (!/^\d{4,6}$/.test(code)) continue;       // 標題列會自然被濾掉
    const [open, high, low, close] = [cells[2], cells[3], cells[4], cells[5]].map(num);
    if (!close || !high || !low) { errors.push(`${code} 價格欄位讀不到，略過`); continue; }
    const volume = num(cells[6]) || 0;
    quotes.push({
      code, name: cells[1] || code, market: 'PASTE',
      open: open || close, high, low, close,
      change: 0,
      // 貼上的量通常是「張」，超過十萬才當成「股」
      volume: volume > 100000 ? volume : volume * 1000,
      turnover: (volume > 100000 ? volume : volume * 1000) * close,
      trades: 0
    });
  }
  if (!quotes.length) errors.push('認不出任何資料列，格式請用：代號,名稱,開,高,低,收,量');
  return { quotes, errors };
}

// ─── 本地歷史庫（IndexedDB）────────────────────────────────────────────────
//
// EMA30 / ATR / 轉折點都需要歷史日 K。逐檔去打歷史 API 會被擋，
// 所以改成每天抓到的全市場收盤表就存一份，累積成自己的歷史庫。

const DB_NAME = 'daytrade';
const DB_STORE = 'days';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('瀏覽器不支援 IndexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'date' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// 只拿 key（日期）就好，不必把整年的資料撈進記憶體只為了知道有哪幾天
function dbKeys(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbDates() {
  try {
    const db = await openDb();
    const keys = await dbKeys(db);
    db.close();
    return new Set(keys.map(String));
  } catch (e) {
    return new Set();   // 讀不到就當成一天都沒有，全部重抓
  }
}

function dbAll(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 存成短欄位名，一天一千多檔、放幾個月也不會把配額塞爆
function packQuotes(quotes) {
  return quotes.map((q) => ({ c: q.code, o: q.open, h: q.high, l: q.low, p: q.close, v: q.volume }));
}

async function saveDay(date, quotes) {
  const db = await openDb();
  await dbPut(db, { date, rows: packQuotes(quotes) });
  db.close();
}

/** 把歷史庫攤平成 { 代號: [{date, open, high, low, close, volume}, ...] }，日期由舊到新 */
async function loadHistory(maxDays) {
  let days = [];
  try {
    const db = await openDb();
    days = await dbAll(db);
    db.close();
  } catch (e) {
    return { history: new Map(), days: 0, error: e.message };
  }
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (maxDays && days.length > maxDays) days = days.slice(-maxDays);

  const history = new Map();
  for (const day of days) {
    for (const r of day.rows || []) {
      if (!history.has(r.c)) history.set(r.c, []);
      history.get(r.c).push({
        date: day.date, open: r.o, high: r.h, low: r.l, close: r.p, volume: r.v
      });
    }
  }
  return { history, days: days.length, error: null };
}

// ─── 篩選主流程 ──────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  riskBudget: 3000,        // 單筆最大可虧金額（不是買進金額）
  feeDiscount: 0.28,       // 2.8 折（使用者已與券商談定）。這個數字直接決定可獲利門檻：
                           // 50 元的股票，無折扣要 0.41 元停損距離才划算，2.8 折只要 0.22 元。
                           // 折數談錯會讓工具高估獲利——這正是先前那筆「顯示 +305、實際 −136」的成因。
  minFee: 20,
  minPrice: 10,            // 10 元以下跳動檔位太小，容易被來回巴
  maxPrice: 80,
  minTurnover: 3e8,        // 成交金額 3 億
  minVolumeLots: 5000,     // 成交量 5000 張
  minDayTradeRatio: 0.15,
  includeTwse: true,
  includeTpex: false,
  maxCandidates: 12,
  maxLots: 10,

  // ── 交易時段（見 SESSION_DEFAULTS 的說明）──
  sessionStart: 9 * 60,      // 09:00
  sessionEnd: 10 * 60,       // 10:00：使用者唯一能盯盤的一小時
  openingSkipMinutes: 5,     // 只跳過開盤前 5 分鐘（一小時窗口下跳 15 分鐘會只剩兩次機會）
  noNewEntryMinutes: 10,     // 09:50 之後不開新倉
  forceCloseMinutes: 2,      // 09:58 強制平倉
  candleMinutes: 5,          // 5 分鐘 K：一小時窗口下 15 分鐘 K 一天只有 2 次訊號，5 分鐘有 9 次

  // ── 賠率 ──
  // 1:1 在台股需要 61% 勝率才不賠，1:2 只要 40%。獲利來自賠率不是準確度——
  // 最嚴謹的開盤策略研究（Zarattini & Aziz 2023）勝率只有 24%，靠 10R 目標賺錢。
  targetR: 2,

  assumedWinRate: 0.7653,
  maxDayMovePct: 5,          // 當日已漲跌超過這個幅度就不做（空間被壓縮、跳空風險高）
  nearLimitPct: 2,           // 距漲跌停這麼近就不做（沖不掉要交割全額股款）
  requireDayTradeList: true,
  requirePositiveExpectancy: true,
  useMarketFilter: true,     // 大盤方向過濾
  paperTrading: true         // 模擬單模式預設開啟：先累積樣本，再談要不要真的下單
};

function limitStatus(quote) {
  const prev = quote.close - (quote.change || 0);
  if (!prev) return null;
  const pct = (quote.close - prev) / prev;
  if (pct >= 0.0995) return quote.high === quote.low ? 'limit-up-locked' : 'limit-up';
  if (pct <= -0.0995) return quote.high === quote.low ? 'limit-down-locked' : 'limit-down';
  return null;
}

/**
 * 產生候選清單。
 * quotes: 今日全市場；history: 代號 → 日 K 陣列（不含今日）；extra: 當沖/處置/禁空清單
 */
function screen(quotes, history, extra, settings) {
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  const ex = extra || {};
  const rejected = { price: 0, liquidity: 0, limit: 0, punish: 0, dayTradeList: 0, risk: 0, noLevel: 0, expectancy: 0 };

  // 流動性分位數要先算，才知道今天這個成交金額在市場裡算前段還是後段
  const turnovers = quotes.map((q) => q.turnover).filter((t) => t > 0).sort((a, b) => a - b);
  const rankOf = (t) => {
    if (!turnovers.length) return 0;
    let lo = 0, hi = turnovers.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (turnovers[mid] < t) lo = mid + 1; else hi = mid; }
    return lo / turnovers.length;
  };

  // 大盤方向過濾用的 beta：先把大盤報酬代理算出來，全部候選共用一份
  const marketMap = new Map();
  if (history && history.size) {
    for (const r of marketReturnSeries(history)) marketMap.set(r.date, r.ret);
  }

  const candidates = [];
  for (const q of quotes) {
    if (q.close < s.minPrice || q.close > s.maxPrice) { rejected.price++; continue; }
    if (q.turnover < s.minTurnover || q.volume < s.minVolumeLots * 1000) { rejected.liquidity++; continue; }

    const limit = limitStatus(q);
    if (limit) { rejected.limit++; continue; }               // 漲跌停隔天跳空風險太高
    // 今天已經噴掉一大段的，隔天跳空風險同樣高，而且離漲跌停太近會沖不掉。
    // 收盤資料沒有前一日收盤欄位，用「收盤 − 漲跌」還原（limitStatus 也是這樣算的）。
    const prevClose = q.close - (q.change || 0);
    if (prevClose > 0 && dayMoveStatus(q.close, prevClose, s).blocked) { rejected.limit++; continue; }
    if (ex.punish && ex.punish.has(q.code)) { rejected.punish++; continue; }

    let dayTradeRatio = null;
    if (ex.dayTrade) {
      const dt = ex.dayTrade.get(q.code);
      if (!dt) {
        if (s.requireDayTradeList && q.market === 'TWSE') { rejected.dayTradeList++; continue; }
      } else if (q.volume > 0 && dt.volume != null) {
        dayTradeRatio = dt.volume / q.volume;
      }
    }
    if (dayTradeRatio != null && dayTradeRatio < s.minDayTradeRatio) { rejected.dayTradeList++; continue; }

    // 歷史（含今日）→ 指標
    const past = (history && history.get(q.code)) || [];
    const bars = past.filter((b) => b.date !== q.date).concat([{
      date: q.date || 'today', open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume
    }]);
    const closes = bars.map((b) => b.close);
    const emaSeries = ema(closes, 30);
    const ema30 = emaSeries[emaSeries.length - 1];
    const emaPrev = emaSeries[emaSeries.length - 4];
    const atrValue = atr(bars, 14);
    const atrPct = atrValue ? (atrValue / q.close) * 100 : null;
    const rangePct = ((q.high - q.low) / q.close) * 100;
    const closePosition = q.high > q.low ? (q.close - q.low) / (q.high - q.low) : 0.5;

    // 方向偏向：站在 EMA30 上方只找掃低做多，下方只找掃高做空。
    // 歷史不足時退而用「收盤在當日區間的位置」判斷，並標記資料不足。
    let side;
    if (ema30 != null && bars.length >= 5) side = q.close >= ema30 ? 'long' : 'short';
    else side = closePosition >= 0.5 ? 'long' : 'short';

    const shortBlocked = side === 'short' && ex.noShortSell && ex.noShortSell.has(q.code);

    // 要盯的關鍵價位：做多找下方最近的支撐，做空找上方最近的壓力
    const pv = pivots(bars, 1, 1);
    const pool = side === 'long'
      ? pv.lows.filter((l) => l.price < q.close).map((l) => ({ ...l, label: '支撐' }))
      : pv.highs.filter((h) => h.price > q.close).map((h) => ({ ...h, label: '壓力' }));
    // 今天的高低點對「明天」而言就是昨日高低點——當沖最會被掃的一條線，一定要放進來。
    // 這條也保證了就算完全沒有歷史（例如手動貼上單日資料），至少還有一個價位可以盯。
    const todayBar = bars[bars.length - 1];
    const todayLevel = side === 'long'
      ? { price: todayBar.low, date: todayBar.date, strong: true, label: '今日低點' }
      : { price: todayBar.high, date: todayBar.date, strong: true, label: '今日高點' };
    if (side === 'long' ? todayLevel.price < q.close : todayLevel.price > q.close) pool.push(todayLevel);
    // 由近到遠排序後去重（同一個檔位內的算同一條線，留標記較強的那個）
    pool.sort((a, b) => (side === 'long' ? b.price - a.price : a.price - b.price));
    const levels = [];
    for (const lv of pool) {
      const dup = levels.find((x) => Math.abs(x.price - lv.price) < tickSize(q.close));
      if (dup) { if (lv.strong) dup.strong = true; continue; }
      levels.push(lv);
      if (levels.length === 3) break;
    }
    if (!levels.length) { rejected.noLevel++; continue; }

    const nearestLevel = levels[0];
    const est = estimateLevels(side, nearestLevel.price, atrValue || q.close * 0.02, 2);
    const plan = planTrade(side, est.entry, est.stop, s);
    if (!plan.tradable) { rejected.risk++; continue; }        // 一張都買不起就別看了
    // 1:1 的獲利扣完手續費和證交稅後，用假設勝率加權還是負的——這種標的贏了也是虧，
    // 是這套低賠率策略移植到台股最常見的死法，直接擋掉。
    if (s.requirePositiveExpectancy !== false && plan.expectancy <= 0) { rejected.expectancy++; continue; }

    const metrics = {
      close: q.close, ema30, emaSlope: ema30 != null && emaPrev != null ? ema30 - emaPrev : null,
      atr: atrValue, atrPct, rangePct, closePosition, dayTradeRatio, nearestLevel
    };
    const score = scoreStock(metrics, { turnoverRank: rankOf(q.turnover) });

    // 與大盤的連動：盤中要用它把「大盤現在的方向」換算成這筆的方向正確率。
    // 用的是不含今天的歷史（bars 最後一筆是今天，配對時自然只用到前一天為止的報酬）。
    const aligned = marketMap.size ? alignReturns(bars, marketMap) : null;
    const betaInfo = aligned ? marketBeta(aligned.stock, aligned.market) : null;

    candidates.push({
      ...q, side, shortBlocked, levels, plan, score, betaInfo,
      metrics, historyDays: bars.length,
      dataThin: bars.length < 30
    });
  }

  candidates.sort((a, b) => b.score.total - a.score.total);
  return { candidates: candidates.slice(0, s.maxCandidates), rejected, scanned: quotes.length };
}

// ─── 示範資料 ────────────────────────────────────────────────────────────────
//
// 用來驗證整條流程（含各種排除規則）跑不跑得起來，也給第一次打開網站的人看看長相。

function demoData() {
  const dates = [];
  const base = new Date('2026-08-11T00:00:00Z');
  for (let i = 40; i >= 1; i--) {
    const d = new Date(base.getTime() - i * 86400000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    dates.push(d.toISOString().slice(0, 10));
  }

  // beta 是刻意給的：示範也要演得出「大盤方向過濾」。2609 是高 beta 的做空候選，
  // 大盤上漲時做空它就是逆勢——那正是使用者實際賠錢那筆的情境（做空 3481，beta 1.44）。
  const specs = [
    { code: '2317', name: '示範-正常候選', start: 28, drift: 0.004, vol: 0.022, turnover: 9e8, dtRatio: 0.28, beta: 0.9 },
    { code: '2609', name: '示範-空方候選', start: 46, drift: -0.005, vol: 0.026, turnover: 7e8, dtRatio: 0.31, beta: 1.5 },
    { code: '3037', name: '示範-高價超風險', start: 210, drift: 0.003, vol: 0.03, turnover: 12e8, dtRatio: 0.22, beta: 1.1 },
    { code: '1101', name: '示範-量能不足', start: 32, drift: 0.001, vol: 0.01, turnover: 8e7, dtRatio: 0.05, beta: 0.2 },
    { code: '8069', name: '示範-漲停鎖死', start: 35, drift: 0.02, vol: 0.05, turnover: 6e8, dtRatio: 0.4, limitUp: true, beta: 1.2 },
    // 這一檔專門用來演「大盤方向過濾」：平常跟著大盤漲（beta 1.8），今天才急殺跌破均線，
    // 所以會被判成做空候選——但大盤只要往上走，做空它就是站錯邊，監控要擋下來。
    { code: '2603', name: '示範-逆勢做空', start: 38, drift: 0.006, vol: 0.016, turnover: 8e8, dtRatio: 0.3, beta: 1.8, lateDrift: -0.022 }
  ];

  let seed = 20260811;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  // 共同的市場因子。少了它，示範資料的每檔都是獨立隨機漫步，beta 會是噪音，
  // 大盤方向過濾在示範模式下就永遠演不出來。
  const marketFactor = dates.map(() => (rand() - 0.5) * 0.02);

  const history = new Map();
  const quotes = [];
  const dayTrade = new Map();

  for (const spec of specs) {
    const bars = [];
    let price = spec.start;
    dates.forEach((date, di) => {
      const beta = spec.beta != null ? spec.beta : 1;
      // lateDrift：最後幾天轉弱，收盤跌破均線而被判成做空候選，但歷史上仍是跟著大盤漲的高
      // beta 股——這正是「方向過濾」要抓的情境，而且不會單日跳超過 5% 觸發實務過濾。
      const drift = (spec.lateDrift != null && di >= dates.length - 5) ? spec.lateDrift : spec.drift;
      price = price * (1 + drift + beta * marketFactor[di] + (rand() - 0.5) * spec.vol * 0.5);
      const open = roundToTick(price * (1 + (rand() - 0.5) * 0.01), 'nearest');
      const high = roundToTick(Math.max(open, price) * (1 + rand() * spec.vol * 0.6), 'up');
      const low = roundToTick(Math.min(open, price) * (1 - rand() * spec.vol * 0.6), 'down');
      const close = roundToTick(Math.min(high, Math.max(low, price)), 'nearest');
      bars.push({ date, open, high, low, close, volume: Math.round(spec.turnover / close) });
    });
    const last = bars[bars.length - 1];
    const prevClose = bars[bars.length - 2].close;

    let quote;
    if (spec.limitUp) {
      const lim = roundToTick(prevClose * 1.1, 'down');
      quote = { code: spec.code, name: spec.name, market: 'DEMO', open: lim, high: lim, low: lim,
        close: lim, change: lim - prevClose, volume: Math.round(spec.turnover / lim),
        turnover: spec.turnover, trades: 8000, date: '2026-08-11' };
    } else {
      quote = { code: spec.code, name: spec.name, market: 'DEMO', open: last.open, high: last.high,
        low: last.low, close: last.close, change: Number((last.close - prevClose).toFixed(2)),
        volume: last.volume, turnover: last.close * last.volume, trades: 12000, date: '2026-08-11' };
    }
    quotes.push(quote);
    history.set(spec.code, bars.slice(0, -1));
    dayTrade.set(spec.code, { volume: Math.round(quote.volume * spec.dtRatio) });
  }

  return { quotes, history, extra: { dayTrade, noShortSell: new Set(['2609']), punish: new Set() } };
}

// ─── 匯出（node 自我測試用）─────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    tickSize, roundToTick, addTicks, ema, atr, pivots,
    tradeCost, planTrade, estimateLevels, levelsFromBar,
    bandScore, scoreStock, screen, parsePasted, normalizeQuote, pickField, num,
    limitStatus, demoData, DEFAULT_SETTINGS, DATA_BASE, unpackDay,
    fetchMarketData, saveDay, loadHistory, dbDates,
    taipeiMinutesOfDay, isMarketHours, candleIndex, isOpeningCandle,
    updateCandle, evaluateSweep, evaluateExit, realizePnl, tradeViability, quoteCode, fetchQuotes,
    resolveProbability, marketReturnSeries, alignReturns, marketBeta, marketDirectionFilter,
    dayMoveStatus, LIMIT_PCT, STABILITY_PCT,
    paperStats, tradeR, INDEX_QUOTE_CODE, WEAK_CORR,
    MARKET_OPEN_MINUTES, MARKET_CLOSE_MINUTES, CANDLE_MINUTES,
    SESSION_DEFAULTS, sessionOf, fmtMinutes
  };
}
