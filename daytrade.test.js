const D = require('./daytrade.js');
const fs = require('fs');
let fail = 0, pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
}
function near(a, b, eps) { return Math.abs(a - b) <= (eps == null ? 1e-6 : eps); }

// ── 1. 門檻公式推廣：R=1 必須完全等於舊行為 ────────────────────────────────
{
  const S = { ...D.DEFAULT_SETTINGS, feeDiscount: 1.0, targetR: 1, assumedWinRate: 0.7653 };
  const plan = D.planTrade('short', 50.50, 50.70, S);
  const v = D.tradeViability(plan, S);
  // 舊公式：minStop = c/(2p-1)，requiredWinRate = (1+c/d)/2
  const c = v.costPerShare, d = plan.stopDistance, p = 0.7653;
  ok('R=1 minStopDistance 等於舊公式', near(v.minStopDistance, D.roundToTick(c / (2 * p - 1), 'up')),
     v.minStopDistance);
  // c 是回傳時取到小數 4 位的值，容許一點誤差
  ok('R=1 requiredWinRate 等於舊公式', near(v.requiredWinRate, (1 + c / d) / 2, 1e-3), v.requiredWinRate);
  ok('使用者那筆需要 >100% 勝率', v.requiredWinRate > 1, (v.requiredWinRate * 100).toFixed(0) + '%');
  ok('使用者那筆判定不可行', !v.viable && v.impossible);
  ok('目標價 = 1:1 等距', near(plan.target, 50.30, 0.001), plan.target);
}
// R=2 應該讓需要勝率掉到 40% 附近，最小停損距離變小
{
  const S = { ...D.DEFAULT_SETTINGS, feeDiscount: 0.28, targetR: 2 };
  const plan = D.planTrade('long', 50.0, 49.45, S);   // 停損 0.55 ≈ 1.1%
  const v = D.tradeViability(plan, S);
  ok('1:2 目標價 = 進場 + 2×停損距離', near(plan.target, 51.1, 0.051), plan.target);
  ok('1:2 需要勝率落在 38~44%', v.requiredWinRate > 0.38 && v.requiredWinRate < 0.44,
     (v.requiredWinRate * 100).toFixed(1) + '%');
  const v1 = D.tradeViability(D.planTrade('long', 50.0, 49.45, { ...S, targetR: 1 }), { ...S, targetR: 1 });
  ok('1:1 需要的勝率比 1:2 高', v1.requiredWinRate > v.requiredWinRate,
     (v1.requiredWinRate * 100).toFixed(0) + '% vs ' + (v.requiredWinRate * 100).toFixed(0) + '%');
  ok('1:2 的最小停損距離比 1:1 小', v.minStopDistance < v1.minStopDistance,
     v.minStopDistance + ' vs ' + v1.minStopDistance);
}

// ── 2. 交易時段設定 ──────────────────────────────────────────────────────────
const at = (h, m) => Date.parse('2026-08-19T00:00:00Z') + (h * 60 + m - 480) * 60000;
{
  const S = D.DEFAULT_SETTINGS;                       // 09:00–10:00
  ok('08:59 不在時段內', !D.isMarketHours(at(8, 59), S));
  ok('09:00 在時段內', D.isMarketHours(at(9, 0), S));
  ok('09:59 在時段內', D.isMarketHours(at(9, 59), S));
  ok('10:00 已結束', !D.isMarketHours(at(10, 0), S));
  const ss = D.sessionOf(S);
  ok('不開新倉時間 = 09:50', ss.noNewEntryAt === 590, ss.noNewEntryAt);
  ok('強制平倉時間 = 09:58', ss.forceCloseAt === 598, ss.forceCloseAt);
  ok('fmtMinutes(598) = 09:58', D.fmtMinutes(598) === '09:58', D.fmtMinutes(598));

  const pos = { side: 'long', entry: 50, stop: 49.5, target: 51 };
  ok('09:57 還不強制平倉', D.evaluateExit(pos, { price: 50.1 }, at(9, 57), S) === null);
  const ex = D.evaluateExit(pos, { price: 50.1 }, at(9, 58), S);
  ok('09:58 觸發時間出場', ex && ex.reason === 'time', ex && ex.reason);

  // 換回全天時段要退回原本行為
  const full = { ...S, sessionStart: 540, sessionEnd: 810, noNewEntryMinutes: 30,
                 forceCloseMinutes: 10, candleMinutes: 15, openingSkipMinutes: 15 };
  const fs2 = D.sessionOf(full);
  ok('全天時段：13:00 不開新倉', fs2.noNewEntryAt === 13 * 60, fs2.noNewEntryAt);
  ok('全天時段：13:20 強制平倉', fs2.forceCloseAt === 13 * 60 + 20, fs2.forceCloseAt);
  ok('全天時段 13:00 仍在盤中', D.isMarketHours(at(13, 0), full));
  ok('全天時段 09:57 不強制平倉', D.evaluateExit(pos, { price: 50.1 }, at(9, 57), full) === null);
}

// ── 3. 5 分鐘 K + 跳過前 5 分鐘 → 09:10–09:50 共 9 個可用確認時點 ────────────
{
  const S = D.DEFAULT_SETTINGS;
  ok('09:00 是第 0 根', D.candleIndex(at(9, 0), S) === 0);
  ok('09:07 是第 1 根', D.candleIndex(at(9, 7), S) === 1);
  ok('第 0 根算開盤亂流', D.isOpeningCandle(0, S));
  ok('第 1 根不算開盤亂流', !D.isOpeningCandle(1, S));
  // 可用的「已收盤蠟燭」：第 1 根(09:05-09:10 收於 09:10) 起算，且要留 ≥10 分鐘給交易走完
  const ss = D.sessionOf(S);
  let usable = 0;
  for (let idx = 0; idx < (ss.end - ss.start) / ss.candleMinutes; idx++) {
    const closeAt = ss.start + (idx + 1) * ss.candleMinutes;
    if (D.isOpeningCandle(idx, S)) continue;
    if (closeAt > ss.noNewEntryAt) continue;
    usable++;
  }
  ok('一小時內共 9 個可用確認時點', usable === 9, String(usable));

  // 跳過 15 分鐘的舊設定：5 分鐘 K 要跳過前 3 根
  const old = { ...S, openingSkipMinutes: 15 };
  ok('跳過15分鐘 + 5分K → 前 3 根都算亂流',
     D.isOpeningCandle(2, old) && !D.isOpeningCandle(3, old));
  ok('跳過15分鐘 + 15分K → 只有第 1 根算亂流',
     D.isOpeningCandle(0, { ...old, candleMinutes: 15 }) &&
     !D.isOpeningCandle(1, { ...old, candleMinutes: 15 }));
}

// ── 4. 大盤 beta 對帳：用 repo 裡的真實資料重現規劃階段算出的數字 ─────────────
{
  const idx = JSON.parse(fs.readFileSync('data/index.json', 'utf8'));
  const history = new Map();
  for (const date of idx.days) {
    const day = JSON.parse(fs.readFileSync('data/days/' + date + '.json', 'utf8'));
    for (const r of day.rows) {
      if (!r[5]) continue;
      if (!history.has(r[0])) history.set(r[0], []);
      history.get(r[0]).push({ date, open: r[2], high: r[3], low: r[4], close: r[5], volume: r[6] || 0 });
    }
  }
  const series = D.marketReturnSeries(history);
  ok('大盤報酬序列 = 天數 − 1', series.length === idx.days.length - 1,
     series.length + ' vs ' + idx.days.length);
  const mm = new Map(series.map((r) => [r.date, r.ret]));

  // 這裡刻意用「範圍」而不是固定值：GitHub Actions 每個交易日都會換掉最舊的一天，
  // 釘死到小數點後兩位的話，這個測試每天都會紅一次，但那不是程式壞了。
  // 範圍夠窄，公式真的寫錯一定抓得到；下面的 console 會印出當下的實際值供對照。
  //
  // 規劃階段用 2026-05-21～2026-08-14 那 59 天算出來的基準：
  //   3481 β1.44 r0.76 11% ／ 4989 β1.39 r0.74 30% ／ 3149 β0.98 r0.57 35% ／ 2886 β−0.02 r−0.04 49%
  const expect = {
    '3481': { beta: [1.25, 1.65], corr: [0.68, 0.85], p: [0.05, 0.22] },
    '4989': { beta: [1.20, 1.60], corr: [0.65, 0.85], p: [0.20, 0.42] },
    '3149': { beta: [0.80, 1.20], corr: [0.45, 0.70], p: [0.25, 0.48] },
    '2886': { beta: [-0.20, 0.20], corr: [-0.20, 0.20], p: [0.40, 0.60] }
  };
  const inRange = (v, r) => v != null && v >= r[0] && v <= r[1];
  const table = [];
  for (const [code, e] of Object.entries(expect)) {
    const al = D.alignReturns(history.get(code), mm);
    const b = D.marketBeta(al.stock, al.market);
    table.push('    ' + code + '  β ' + (b && b.beta) + '  r ' + (b && b.corr) +
      '  大盤漲時做空對的機率 ' + (b && b.upDayDownProb != null ? Math.round(b.upDayDownProb * 100) + '%' : '—'));
    ok(code + ' beta 落在 ' + e.beta.join('~'), b && inRange(b.beta, e.beta), b && b.beta);
    ok(code + ' 相關性落在 ' + e.corr.join('~'), b && inRange(b.corr, e.corr), b && b.corr);
    ok(code + ' 大盤漲時做空正確率落在 ' + e.p.map((x) => Math.round(x * 100) + '%').join('~'),
       b && inRange(b.upDayDownProb, e.p), b && b.upDayDownProb);
  }
  console.log('  目前資料（' + series.length + ' 天）算出來的實際值：');
  console.log(table.join('\n'));

  // 方向過濾：大盤上漲時做空 3481 要被擋；2886 相關性太弱只註記不擋
  const al3481 = D.alignReturns(history.get('3481'), mm);
  const b3481 = D.marketBeta(al3481.stock, al3481.market);
  const f = D.marketDirectionFilter('short', b3481, 0.8);
  ok('大盤漲 → 做空 3481 方向過濾生效', f.applies && f.prob < 0.2, JSON.stringify(f.prob));

  const S = { ...D.DEFAULT_SETTINGS, targetR: 2 };
  const plan = D.planTrade('short', 50.0, 50.55, S);
  const vNoFilter = D.tradeViability(plan, S);
  const vFilter = D.tradeViability(plan, S, f);
  ok('沒過濾時這筆可行', vNoFilter.viable);
  ok('逆勢時同一筆被判不可行', !vFilter.viable);
  ok('逆勢旗標有立起來', vFilter.countertrend);

  const al2886 = D.alignReturns(history.get('2886'), mm);
  const b2886 = D.marketBeta(al2886.stock, al2886.market);
  const f2 = D.marketDirectionFilter('short', b2886, 0.8);
  ok('2886 連動弱 → 不擋單只註記', !f2.applies && f2.weak, f2.note);
  ok('沒有大盤資料 → 過濾停用', !D.marketDirectionFilter('short', b3481, null).applies);
  ok('大盤平盤 → 過濾不介入', !D.marketDirectionFilter('short', b3481, 0.02).applies);
  // 大盤上漲時做多 3481 應該是順勢，方向正確率高
  const fLong = D.marketDirectionFilter('long', b3481, 0.8);
  ok('大盤漲 → 做多 3481 方向正確率 ≈ 89%', near(fLong.prob, 0.89, 0.01), fLong.prob);
}

// ── 4b. marketBeta 公式本身：用手算得出答案的固定 fixture，不受資料更新影響 ──────
{
  // 個股報酬 = 2 × 大盤報酬（完全連動、beta 剛好 2、相關性剛好 1）
  const market = [0.01, -0.01, 0.02, -0.02, 0.005, -0.005, 0.015, -0.015, 0.01, -0.01, 0.02, -0.02];
  const stock = market.map((x) => x * 2);
  const b = D.marketBeta(stock, market);
  ok('完全連動 → beta = 2', near(b.beta, 2, 1e-6), b.beta);
  ok('完全連動 → 相關性 = 1', near(b.corr, 1, 1e-6), b.corr);
  ok('完全同向 → 大盤漲時做空永遠錯', b.upDayDownProb === 0, b.upDayDownProb);
  ok('完全同向 → 大盤跌時做多永遠錯', b.downDayUpProb === 0, b.downDayUpProb);

  const inverse = D.marketBeta(market.map((x) => -x), market);
  ok('完全反向 → beta = −1', near(inverse.beta, -1, 1e-6), inverse.beta);
  ok('完全反向 → 大盤漲時做空永遠對', inverse.upDayDownProb === 1, inverse.upDayDownProb);

  ok('樣本 < 10 天回 null', D.marketBeta([0.01, 0.02], [0.01, 0.02]) === null);
  ok('大盤沒有變異回 null', D.marketBeta(stock, market.map(() => 0)) === null);
}

// ── 5. 時間出場機率 ──────────────────────────────────────────────────────────
{
  const p = D.resolveProbability(0.55, 50, 30, 4.0, 2);
  ok('解決機率落在 0~1', p > 0 && p <= 1, String(p));
  const pShort = D.resolveProbability(0.55, 50, 5, 4.0, 2);
  ok('剩越少時間越難解決', pShort < p, pShort + ' < ' + p);
  const pWide = D.resolveProbability(2.0, 50, 30, 4.0, 2);
  ok('停損越寬越難解決', pWide < p, pWide + ' < ' + p);
  ok('參數不合法回 null', D.resolveProbability(0, 50, 30, 4, 2) === null);
}

// ── 6. 模擬單統計 ────────────────────────────────────────────────────────────
{
  const trades = [
    { exitReason: 'target', net: 800, r: 2 },
    { exitReason: 'stop', net: -450, r: -1 },
    { exitReason: 'stop', net: -450, r: -1 },
    { exitReason: 'time', net: -60, r: 0.1 },
    { exitReason: 'target', net: 800, r: 2 }
  ];
  const st = D.paperStats(trades);
  ok('筆數 5', st.n === 5, st.n);
  ok('勝率 40%', near(st.winRate, 0.4), st.winRate);
  ok('平均 R = 0.42', near(st.avgR, 0.42, 0.001), st.avgR);
  ok('累計損益 +640', st.totalNet === 640, st.totalNet);
  ok('最大連虧 3', st.maxLossStreak === 3, st.maxLossStreak);
  ok('時間出場佔比 20%', near(st.timeExitRatio, 0.2), st.timeExitRatio);
  ok('空清單不會爆', D.paperStats([]).n === 0);
  ok('tradeR 做空 +2R', near(D.tradeR('short', 50, 50.5, 49), 2), D.tradeR('short', 50, 50.5, 49));
  ok('tradeR 做多 −1R', near(D.tradeR('long', 50, 49.5, 49.5), -1));
}

// ── 7. 既有行為回歸 ──────────────────────────────────────────────────────────
{
  // 49.98 的檔位是 0.05（未滿 50），最近的檔位是 50.00；往下取才是 49.95
  ok('檔位 49.98 最近 → 50.00', D.roundToTick(49.98, 'nearest') === 50, D.roundToTick(49.98, 'nearest'));
  ok('檔位 49.98 往下 → 49.95', D.roundToTick(49.98, 'down') === 49.95, D.roundToTick(49.98, 'down'));
  ok('檔位 50.03 → 50.0', D.roundToTick(50.03, 'nearest') === 50, D.roundToTick(50.03, 'nearest'));
  ok('檔位 50.15 → 50.2（半檔不因浮點誤差往下捨）', D.roundToTick(50.15, 'nearest') === 50.2,
     D.roundToTick(50.15, 'nearest'));
  // 102.3 的檔位是 0.5（100~500），最近的是 102.5
  ok('檔位 102.3 最近 → 102.5', D.roundToTick(102.3, 'nearest') === 102.5, D.roundToTick(102.3, 'nearest'));
  ok('檔位 102.3 往下 → 102.0', D.roundToTick(102.3, 'down') === 102, D.roundToTick(102.3, 'down'));

  // 30 元、停損 0.45 → 部位計算（含成本）不得超過風險預算
  const S = { ...D.DEFAULT_SETTINGS, feeDiscount: 0.28, riskBudget: 3000 };
  const plan = D.planTrade('long', 30.0, 29.55, S);
  ok('30元/0.45停損 至少 1 張且不超過預算', plan.tradable && plan.netLoss <= 3000,
     plan.lots + '張 netLoss=' + plan.netLoss);

  // 做空的證交稅課在賣出腳（進場價）
  const cShort = D.tradeCost(50.0, 49.0, 1, { feeDiscount: 1, minFee: 0 }, 'short');
  const cLong = D.tradeCost(50.0, 49.0, 1, { feeDiscount: 1, minFee: 0 }, 'long');
  ok('做空稅基是進場價', cShort.tax === Math.round(50.0 * 1000 * 0.0015), cShort.tax);
  ok('做多稅基是出場價', cLong.tax === Math.round(49.0 * 1000 * 0.0015), cLong.tax);

  // 掃蕩判定
  ok('做多掃低後收回 = 成立',
     D.evaluateSweep({ low: 49.0, high: 50.2, close: 49.6 }, 'long', 49.5).confirmed);
  ok('掃了但沒收回 = 不成立',
     !D.evaluateSweep({ low: 49.0, high: 49.4, close: 49.2 }, 'long', 49.5).confirmed);

  // 蠟燭聚合
  const S5 = D.DEFAULT_SETTINGS;
  let c = null;
  ({ candle: c } = D.updateCandle(null, { price: 50 }, at(9, 6), null, S5));
  ({ candle: c } = D.updateCandle(c, { price: 50.4 }, at(9, 8), 50, S5));
  ok('同一根蠟燭內更新高點', c.high === 50.4 && c.idx === 1, JSON.stringify(c));
  const r = D.updateCandle(c, { price: 50.2 }, at(9, 11), 50.4, S5);
  ok('跨根時吐出已收盤的蠟燭', r.closedCandle && r.closedCandle.idx === 1 && r.candle.idx === 2,
     JSON.stringify(r));

  // 停損優先於停利
  const both = D.evaluateExit(
    { side: 'long', entry: 50, stop: 49.5, target: 51, dayHighAtEntry: 50, dayLowAtEntry: 50 },
    { price: 50.2, high: 51.2, low: 49.4 }, at(9, 30), D.DEFAULT_SETTINGS);
  ok('兩邊都碰到時回停損', both && both.reason === 'stop', both && both.reason);

  // 篩選整條流程
  const demo = D.demoData();
  const res = D.screen(demo.quotes, demo.history, demo.extra, D.DEFAULT_SETTINGS);
  ok('示範資料能跑出候選', res.candidates.length > 0, res.candidates.length + ' 檔');
  ok('候選都是 1:2 目標', res.candidates.every((x) => x.plan.targetR === 2));
}

// ── 8. 台灣市場結構的實務過濾 ────────────────────────────────────────────────
{
  const S = D.DEFAULT_SETTINGS;
  ok('漲 3% 不擋', !D.dayMoveStatus(103, 100, S).blocked);
  ok('漲 5% 要擋（空間被壓縮）', D.dayMoveStatus(105, 100, S).extended);
  ok('跌 6% 要擋', D.dayMoveStatus(94, 100, S).blocked);
  ok('距漲停 2% 內要擋', D.dayMoveStatus(108.5, 100, S).nearLimit);
  ok('沒有前收就不判斷', !D.dayMoveStatus(50, 0, S).blocked);
  ok('changePct 算對', D.dayMoveStatus(104, 100, S).changePct === 4);
}

// ── 9. 示範資料要演得出方向過濾（逆勢做空被擋）──────────────────────────────
{
  const demo = D.demoData();
  const res = D.screen(demo.quotes, demo.history, demo.extra, D.DEFAULT_SETTINGS);
  const ct = res.candidates.find((c) => c.code === '2603');
  ok('示範有高 beta 的做空候選', ct && ct.side === 'short' && ct.betaInfo.beta > 1.3,
     ct && ct.side + ' beta=' + (ct.betaInfo && ct.betaInfo.beta));
  const f = D.marketDirectionFilter('short', ct.betaInfo, 0.72);
  const v = D.tradeViability(ct.plan, D.DEFAULT_SETTINGS, f);
  ok('大盤上漲時它被判逆勢', v.countertrend && !v.viable,
     '方向正確率 ' + Math.round(f.prob * 100) + '%，需要 ' + Math.round(v.requiredWinRate * 100) + '%');
  // 同一檔在大盤下跌時不該被擋
  const f2 = D.marketDirectionFilter('short', ct.betaInfo, -0.72);
  const v2 = D.tradeViability(ct.plan, D.DEFAULT_SETTINGS, f2);
  ok('大盤下跌時同一檔不擋', !v2.countertrend, JSON.stringify(f2.prob));
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通過 / ' + fail + ' 失敗');
process.exit(fail ? 1 : 0);
