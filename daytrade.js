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
  const target = side === 'long'
    ? roundToTick(entry + stopDistance, 'down')
    : roundToTick(entry - stopDistance, 'up');

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

  const grossWin = stopDistance * shares;
  const grossLoss = stopDistance * shares;
  const netWin = Math.round(grossWin - costAtWin.total);
  const netLoss = Math.round(grossLoss + costAtLoss.total);

  // 期望值：用勝率把淨賺淨賠加權，看看這筆到底值不值得做
  const winRate = s.assumedWinRate != null ? s.assumedWinRate : 0.7653;
  const expectancy = Math.round(netWin * winRate - netLoss * (1 - winRate));

  return {
    side, entry, stop, target, stopDistance,
    stopPct: Number((stopDistance / entry * 100).toFixed(2)),
    lots, shares, tradable, lotsCapped, rawLots,
    fullPayment: Math.round(entry * shares),   // 沒沖掉的話要準備的全額股款
    cost: costAtWin.total,
    costDetail: costAtWin,
    breakevenMove: beMove,
    breakevenRatio: stopDistance > 0 ? Number((beMove / stopDistance).toFixed(2)) : null,
    netWin, netLoss, expectancy,
    // 成本吃掉超過三成的 1:1 獲利就該亮燈，這種標的贏了也只是幫券商打工
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

var MARKET_OPEN_MINUTES = 9 * 60;          // 09:00
var MARKET_CLOSE_MINUTES = 13 * 60 + 30;   // 13:30
var CANDLE_MINUTES = 15;
var OPENING_NOISE_MINUTES = 15;            // 09:00-09:15 這根蠟燭的訊號不算數
var NO_NEW_ENTRY_MINUTES = 13 * 60;        // 13:00 之後不開新倉
var FORCE_CLOSE_MINUTES = 13 * 60 + 20;    // 13:20 一定要平倉，沒沖掉就要交割全額股款

// 台灣沒有日光節約時間，UTC+8 是常數，不用查時區資料庫
function taipeiMinutesOfDay(ms) {
  const d = new Date(ms);
  const utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return (utcMinutes + 8 * 60) % (24 * 60);
}

function isMarketHours(ms) {
  const m = taipeiMinutesOfDay(ms);
  return m >= MARKET_OPEN_MINUTES && m < MARKET_CLOSE_MINUTES;
}

// 09:00 之後第幾根蠟燭（0 起算）；非交易時間回傳 null，呼叫端要自己先檔 isMarketHours
function candleIndex(ms, minutes) {
  if (!isMarketHours(ms)) return null;
  return Math.floor((taipeiMinutesOfDay(ms) - MARKET_OPEN_MINUTES) / (minutes || CANDLE_MINUTES));
}

/**
 * 這根蠟燭是否落在開盤亂流時段（09:00-09:15），PDF 策略與檢查表都要求跳過。
 *
 * 原本寫死 idx === 0。那只有在蠟燭週期剛好是 15 分鐘時才等於 09:00-09:15——
 * 純屬巧合，OPENING_NOISE_MINUTES 這個常數宣告了卻從來沒被用到。
 * 週期一改成 5 分鐘，「跳過前 15 分鐘」會無聲縮成「跳過前 5 分鐘」。
 * 改成用分鐘換算，任何週期下都正確（5分→前3根、10分→前2根、15分→前1根）。
 */
function isOpeningCandle(idx, minutes) {
  return idx < Math.ceil(OPENING_NOISE_MINUTES / (minutes || CANDLE_MINUTES));
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
function updateCandle(prevCandle, tick, nowMs, lastKnownPrice, minutes) {
  if (!isMarketHours(nowMs)) return { candle: prevCandle, closedCandle: null };

  const idx = candleIndex(nowMs, minutes);
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
function evaluateExit(position, tick, nowMs) {
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
  if (nowMs != null && taipeiMinutesOfDay(nowMs) >= FORCE_CLOSE_MINUTES) {
    return { reason: 'time', price: price != null ? price : entry };
  }
  return null;
}

/**
 * 這筆到底划不划算——1:1 策略在台股的生死線。
 *
 * 期望值/股 = p(d − c) − (1−p)(d + c) = d(2p−1) − c
 *   d = 停損距離，c = 每股來回成本，p = 勝率
 *
 * 反過來解，就得到兩個一眼就懂的數字：
 *   · 停損距離至少要多大：d > c / (2p−1)
 *   · 這筆需要多少勝率才不賠：p > (1 + c/d) / 2
 *
 * 第二個特別有用。停損距離只有成本的一倍時，requiredWinRate 會超過 100%——
 * 那代表就算每一筆都猜對還是賠，跟勝率高不高完全無關。使用者實際踩到的那筆
 * （50.50 進場、停損 50.70、無折扣）就是這種：需要 105% 勝率，數學上不可能。
 *
 * 收盤篩選本來就有 requirePositiveExpectancy 會擋掉這種標的，但盤中訊號確認後
 * 是拿「實際那根 K 棒的極值」重算停損的，常常比收盤估的窄很多，卻沒有再檢查一次。
 */
function tradeViability(plan, settings) {
  const s = settings || {};
  const winRate = s.assumedWinRate != null ? s.assumedWinRate : 0.7653;
  const d = plan.stopDistance;
  const costPerShare = plan.shares > 0 ? plan.costDetail.total / plan.shares : 0;
  const edge = 2 * winRate - 1;

  // 勝率 ≤ 50% 時 1:1 沒有任何停損距離救得回來
  const minStopDistance = edge > 0 ? roundToTick(costPerShare / edge, 'up') : Infinity;
  const requiredWinRate = d > 0 ? (1 + costPerShare / d) / 2 : Infinity;
  // 維持 1:1 不動的前提下，這筆要多少報酬倍數才會轉正
  const requiredRatio = (d > 0 && winRate > 0)
    ? Number((((1 - winRate) * d + costPerShare) / (winRate * d)).toFixed(2))
    : Infinity;

  return {
    costPerShare: Number(costPerShare.toFixed(4)),
    costShare: plan.shares > 0 && d > 0 ? plan.costDetail.total / (d * plan.shares) : 1,
    minStopDistance,
    requiredWinRate,
    requiredRatio,
    // netWin ≤ 0 是絕對紅線：代表就算完美走到目標價還是賠錢
    impossible: plan.netWin <= 0 || requiredWinRate >= 1,
    viable: plan.netWin > 0 && plan.expectancy > 0 && d >= minStopDistance
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
  if (!baseUrl) throw new Error('尚未設定即時報價網址（https://script.google.com/macros/s/AKfycbxHEz11LPzHXJxTTtQmhSEOnxy2RqUHJiSXjy-6SHsy7wt8aVlQLvHL0idQnIQukHOj/exec）');
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
  feeDiscount: 1.0,        // 無折扣。保守假設——寧可低估獲利，也不要高估
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
  candleMinutes: 15,       // 蠟燭週期。越短→停損越窄→越可能被成本吃掉，見 tradeViability
  assumedWinRate: 0.7653,
  requireDayTradeList: true,
  requirePositiveExpectancy: true
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

  const candidates = [];
  for (const q of quotes) {
    if (q.close < s.minPrice || q.close > s.maxPrice) { rejected.price++; continue; }
    if (q.turnover < s.minTurnover || q.volume < s.minVolumeLots * 1000) { rejected.liquidity++; continue; }

    const limit = limitStatus(q);
    if (limit) { rejected.limit++; continue; }               // 漲跌停隔天跳空風險太高
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

    candidates.push({
      ...q, side, shortBlocked, levels, plan, score,
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

  const specs = [
    { code: '2317', name: '示範-正常候選', start: 28, drift: 0.004, vol: 0.022, turnover: 9e8, dtRatio: 0.28 },
    { code: '2609', name: '示範-空方候選', start: 46, drift: -0.005, vol: 0.026, turnover: 7e8, dtRatio: 0.31 },
    { code: '3037', name: '示範-高價超風險', start: 210, drift: 0.003, vol: 0.03, turnover: 12e8, dtRatio: 0.22 },
    { code: '1101', name: '示範-量能不足', start: 32, drift: 0.001, vol: 0.01, turnover: 8e7, dtRatio: 0.05 },
    { code: '8069', name: '示範-漲停鎖死', start: 35, drift: 0.02, vol: 0.05, turnover: 6e8, dtRatio: 0.4, limitUp: true }
  ];

  let seed = 20260811;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  const history = new Map();
  const quotes = [];
  const dayTrade = new Map();

  for (const spec of specs) {
    const bars = [];
    let price = spec.start;
    for (const date of dates) {
      price = price * (1 + spec.drift + (rand() - 0.5) * spec.vol);
      const open = roundToTick(price * (1 + (rand() - 0.5) * 0.01), 'nearest');
      const high = roundToTick(Math.max(open, price) * (1 + rand() * spec.vol * 0.6), 'up');
      const low = roundToTick(Math.min(open, price) * (1 - rand() * spec.vol * 0.6), 'down');
      const close = roundToTick(Math.min(high, Math.max(low, price)), 'nearest');
      bars.push({ date, open, high, low, close, volume: Math.round(spec.turnover / close) });
    }
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
    MARKET_OPEN_MINUTES, MARKET_CLOSE_MINUTES, CANDLE_MINUTES,
    NO_NEW_ENTRY_MINUTES, FORCE_CLOSE_MINUTES
  };
}
