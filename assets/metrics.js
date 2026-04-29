// TArenaMetrics — pure quant computations for the trader scorecard.
//
// Every function takes plain JS arrays/numbers, returns plain JS, and
// has no side effects. Empty inputs return `null` (so the UI can show
// an "—" placeholder rather than NaN). Closed trades are the unit of
// account; open positions don't contribute to realised P&L.
//
// A "trade" record has the shape:
//   {
//     id, owner_id, symbol, market, side ('buy'|'sell'),
//     qty, entry_price, exit_price,
//     opened_at  (ISO string),
//     closed_at  (ISO string | null),
//     status     ('open' | 'closed' | 'cancelled'),
//   }
//
// `pnl(trade)` is the realised dollar P&L of the trade:
//   buy:  (exit - entry) * qty
//   sell: (entry - exit) * qty
//
// All functions assume the input list is already filtered to the
// owner you care about. Calling code is expected to pass `closed`
// trades only to the stat functions; passing mixed status produces
// undefined behaviour (intentionally — keeps the math obvious).
(function (global) {
  'use strict';

  const TRADING_DAYS = 252;

  function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }

  function pnl(t) {
    if (!t || t.exit_price == null || t.entry_price == null) return 0;
    const diff = (Number(t.exit_price) - Number(t.entry_price)) * Number(t.qty || 0);
    return t.side === 'sell' ? -diff : diff;
  }

  function rMultiple(t) {
    // R-multiple = realised P&L / initial-risk. Risk = |entry - stop_loss|*qty.
    // Returns null when no stop was set (so we don't fabricate R values).
    if (!t || t.stop_loss == null || t.entry_price == null) return null;
    const risk = Math.abs(Number(t.entry_price) - Number(t.stop_loss)) * Number(t.qty || 0);
    if (!isFinite(risk) || risk <= 0) return null;
    return pnl(t) / risk;
  }

  function winners(trades) { return trades.filter(t => pnl(t) > 0); }
  function losers(trades)  { return trades.filter(t => pnl(t) < 0); }

  function winRate(trades) {
    if (!trades || !trades.length) return null;
    return winners(trades).length / trades.length;
  }

  function avgWin(trades) {
    const w = winners(trades);
    if (!w.length) return null;
    return w.reduce((a, t) => a + pnl(t), 0) / w.length;
  }

  function avgLoss(trades) {
    const l = losers(trades);
    if (!l.length) return null;
    return l.reduce((a, t) => a + pnl(t), 0) / l.length;
  }

  function avgRR(trades) {
    const rs = trades.map(rMultiple).filter(r => r !== null);
    if (!rs.length) return null;
    return rs.reduce((a, b) => a + b, 0) / rs.length;
  }

  function profitFactor(trades) {
    let gross = 0, loss = 0;
    for (const t of trades) {
      const p = pnl(t);
      if (p > 0) gross += p;
      else if (p < 0) loss += -p;
    }
    if (loss === 0) return gross > 0 ? Infinity : null;
    return gross / loss;
  }

  function expectancy(trades) {
    if (!trades.length) return null;
    return trades.reduce((a, t) => a + pnl(t), 0) / trades.length;
  }

  function avgHoldingDays(trades) {
    const spans = trades
      .map(t => {
        if (!t.opened_at || !t.closed_at) return null;
        const a = new Date(t.opened_at).getTime();
        const b = new Date(t.closed_at).getTime();
        return isFinite(a) && isFinite(b) && b >= a ? (b - a) / 86400000 : null;
      })
      .filter(d => d !== null);
    if (!spans.length) return null;
    return spans.reduce((a, b) => a + b, 0) / spans.length;
  }

  // Bucket realised P&L into per-day returns relative to a starting
  // capital, so we can compute Sharpe / Sortino / drawdown off a
  // proper time series rather than per-trade noise.
  function dailyReturns(trades, startingCapital) {
    if (!trades.length) return [];
    const start = startingCapital || 100000;
    const buckets = new Map(); // YYYY-MM-DD -> day pnl
    for (const t of trades) {
      const closed = t.closed_at && new Date(t.closed_at);
      if (!closed || isNaN(closed)) continue;
      const key = closed.toISOString().slice(0, 10);
      buckets.set(key, (buckets.get(key) || 0) + pnl(t));
    }
    const days = [...buckets.keys()].sort();
    const out = [];
    let equity = start;
    for (const d of days) {
      const dayPnl = buckets.get(d);
      const ret = dayPnl / equity;
      out.push({ d, ret, dayPnl });
      equity += dayPnl;
    }
    return out;
  }

  function sharpe(trades, startingCapital) {
    const daily = dailyReturns(trades, startingCapital);
    if (daily.length < 2) return null;
    const mean = daily.reduce((a, x) => a + x.ret, 0) / daily.length;
    const variance = daily.reduce((a, x) => a + (x.ret - mean) ** 2, 0) / (daily.length - 1);
    const std = Math.sqrt(variance);
    if (std === 0) return null;
    return (mean / std) * Math.sqrt(TRADING_DAYS);
  }

  function sortino(trades, startingCapital) {
    const daily = dailyReturns(trades, startingCapital);
    if (daily.length < 2) return null;
    const mean = daily.reduce((a, x) => a + x.ret, 0) / daily.length;
    const downside = daily.filter(x => x.ret < 0);
    if (!downside.length) return null;
    const dVar = downside.reduce((a, x) => a + x.ret ** 2, 0) / downside.length;
    const dStd = Math.sqrt(dVar);
    if (dStd === 0) return null;
    return (mean / dStd) * Math.sqrt(TRADING_DAYS);
  }

  // Equity curve = starting cash + cumulative realised P&L by closed-trade
  // close timestamp. Returns array of { t (ms), value, benchmark (optional) }.
  // benchmarkSeries is an optional [{t, close}] array — we normalise its
  // first close to startingCapital so both lines start from the same point.
  function equityCurve(trades, startingCapital, benchmarkSeries) {
    const start = startingCapital || 100000;
    const sorted = [...trades]
      .filter(t => t.status === 'closed' && t.closed_at)
      .sort((a, b) => new Date(a.closed_at) - new Date(b.closed_at));
    const out = [{ t: sorted.length ? new Date(sorted[0].closed_at).getTime() - 86400000 : Date.now() - 86400000, value: start }];
    let eq = start;
    for (const t of sorted) {
      eq += pnl(t);
      out.push({ t: new Date(t.closed_at).getTime(), value: eq });
    }
    if (benchmarkSeries && benchmarkSeries.length) {
      const first = Number(benchmarkSeries[0].close) || 1;
      const map = new Map(benchmarkSeries.map(b => [b.t, (Number(b.close) / first) * start]));
      for (const row of out) {
        // pick the closest benchmark sample at or before this row's time
        let chosen = null;
        for (const b of benchmarkSeries) {
          if (b.t <= row.t) chosen = b; else break;
        }
        if (chosen) row.benchmark = (Number(chosen.close) / first) * start;
      }
      // also keep the explicit map for callers that want to overlay
      void map;
    }
    return out;
  }

  function maxDrawdown(equityCurveArr) {
    if (!equityCurveArr || equityCurveArr.length < 2) return null;
    let peak = equityCurveArr[0].value;
    let mdd = 0;
    for (const p of equityCurveArr) {
      if (p.value > peak) peak = p.value;
      const dd = peak === 0 ? 0 : (p.value - peak) / peak;
      if (dd < mdd) mdd = dd;
    }
    return mdd; // negative number, e.g. -0.18 = 18% DD
  }

  function recoveryFactor(equityCurveArr) {
    if (!equityCurveArr || equityCurveArr.length < 2) return null;
    const start = equityCurveArr[0].value;
    const end   = equityCurveArr[equityCurveArr.length - 1].value;
    const mdd   = maxDrawdown(equityCurveArr);
    if (mdd == null || mdd === 0) return null;
    const netProfit = end - start;
    return netProfit / Math.abs(mdd * start);
  }

  function totalReturnPct(equityCurveArr) {
    if (!equityCurveArr || equityCurveArr.length < 2) return null;
    const start = equityCurveArr[0].value;
    const end   = equityCurveArr[equityCurveArr.length - 1].value;
    if (start === 0) return null;
    return (end - start) / start;
  }

  // Convenience aggregator the page uses — single pass, returns a
  // ready-to-render object. All values are nullable.
  function summarise(trades, opts) {
    opts = opts || {};
    const startingCapital = opts.startingCapital || 100000;
    const closed = trades.filter(t => t.status === 'closed');
    const curve = equityCurve(closed, startingCapital, opts.benchmark);
    return {
      tradesCount:    closed.length,
      winRate:        winRate(closed),
      avgWin:         avgWin(closed),
      avgLoss:        avgLoss(closed),
      avgRR:          avgRR(closed),
      sharpe:         sharpe(closed, startingCapital),
      sortino:        sortino(closed, startingCapital),
      maxDrawdown:    maxDrawdown(curve),
      recoveryFactor: recoveryFactor(curve),
      profitFactor:   profitFactor(closed),
      expectancy:     expectancy(closed),
      avgHoldingDays: avgHoldingDays(closed),
      totalReturnPct: totalReturnPct(curve),
      equityCurve:    curve,
    };
  }

  global.TArenaMetrics = {
    pnl, rMultiple,
    winRate, avgWin, avgLoss, avgRR,
    profitFactor, expectancy, avgHoldingDays,
    sharpe, sortino, maxDrawdown, recoveryFactor,
    equityCurve, totalReturnPct,
    dailyReturns,
    summarise,
    num,
  };

})(window);
