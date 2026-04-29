// TradeArena — reels client helpers (taxonomy, sizing, formatting).
// Pure-data + pure-functions module — no DOM, no network. Loaded by
// reels.html and reels-new.html.
(function (global) {
  'use strict';

  // ----------------------------------------------------------
  // Curated taxonomy. Lives client-side so the composer can offer
  // autocomplete without a round-trip; the server stores the chosen
  // string verbatim. Keep the ids stable — search/filter URLs rely
  // on them.
  // ----------------------------------------------------------
  const INDICATORS = [
    'RSI', 'MACD', 'EMA20', 'EMA50', 'EMA200', 'SMA',
    'Bollinger Bands', 'VWAP', 'Stochastic', 'ATR', 'OBV',
    'Ichimoku', 'Fibonacci Retracement', 'Pivot Points', 'Volume Profile',
  ];

  const PATTERNS = [
    'Head & Shoulders', 'Inverse H&S', 'Double Top', 'Double Bottom',
    'Triangle', 'Flag', 'Pennant', 'Wedge', 'Cup & Handle', 'Channel',
    'Doji', 'Hammer', 'Engulfing',
  ];

  const STRATEGIES = [
    'Breakout', 'Pullback', 'Mean Reversion', 'Momentum', 'Trend Following',
    'Swing', 'Scalp', 'Earnings Play', 'Gap Fill', 'News Catalyst',
  ];

  // One-line definitions surfaced inside the pin popover. Keep these
  // short — they're meant to make the user curious enough to tap
  // through to the Schools lesson, not to replace it.
  const DEFINITIONS = {
    // Indicators
    'RSI': 'Relative Strength Index (0–100). Above 70 = overbought, below 30 = oversold.',
    'MACD': 'Trend-following momentum: difference between two EMAs vs. its signal line.',
    'EMA20': '20-period exponential moving average — short-term trend reference.',
    'EMA50': '50-period EMA — medium-term trend; commonly the "trend filter."',
    'EMA200': '200-period EMA — institutional trend line; bull above, bear below.',
    'SMA': 'Simple moving average — equal-weighted average of recent closes.',
    'Bollinger Bands': 'Volatility envelope: 20-SMA ± 2σ. Mean reversion at the bands.',
    'VWAP': 'Volume-weighted average price — fair-value reference for the session.',
    'Stochastic': 'Momentum oscillator (0–100) comparing close to recent range.',
    'ATR': 'Average True Range — volatility unit. Common stop-loss sizing input.',
    'OBV': 'On-balance volume — running cumulative volume signed by candle direction.',
    'Ichimoku': 'Multi-line trend system: cloud, baseline, conversion, lagging span.',
    'Fibonacci Retracement': 'Pullback levels (38.2%, 50%, 61.8%) from a measured swing.',
    'Pivot Points': 'Floor pivots — support/resistance derived from yesterday\'s OHLC.',
    'Volume Profile': 'Histogram of volume traded at each price level over a range.',

    // Patterns
    'Head & Shoulders': 'Three-peak reversal: shoulders flank a higher head; breaks neckline lower.',
    'Inverse H&S': 'Bullish reversal — three troughs with the middle deepest.',
    'Double Top': 'Two peaks at similar highs — bearish reversal on neckline break.',
    'Double Bottom': 'Two troughs at similar lows — bullish reversal on neckline break.',
    'Triangle': 'Converging trendlines — symmetrical, ascending, or descending.',
    'Flag': 'Sharp move (the pole) followed by a tight, slanted consolidation.',
    'Pennant': 'Like a flag, but the consolidation is a small symmetrical triangle.',
    'Wedge': 'Both trendlines slope the same way; rising = bearish, falling = bullish.',
    'Cup & Handle': 'Rounded base (cup) plus a small pullback (handle), then breakout.',
    'Channel': 'Parallel up/down trendlines containing price action.',
    'Doji': 'Open ≈ close — indecision candle, often precedes reversal.',
    'Hammer': 'Long lower wick, small body — bullish reversal at support.',
    'Engulfing': 'Body fully engulfs prior candle\'s body — momentum reversal signal.',

    // Strategies
    'Breakout': 'Enter on a confirmed move out of a consolidation range.',
    'Pullback': 'Buy a healthy retracement inside an established trend.',
    'Mean Reversion': 'Fade extremes — bet on price returning to its average.',
    'Momentum': 'Ride strength — buy what\'s rising, sell what\'s falling.',
    'Trend Following': 'Stay with the prevailing direction; exit on trend break.',
    'Swing': 'Multi-day to multi-week holds capturing one leg of a trend.',
    'Scalp': 'Very short holds (seconds–minutes) for small repeated edges.',
    'Earnings Play': 'Position around an earnings release for IV/post-earnings drift.',
    'Gap Fill': 'Trade the tendency for opening gaps to close intraday.',
    'News Catalyst': 'Trade reactions to scheduled or unscheduled news events.',
  };

  // Icon shorthand for the pin tag-type chip prefix.
  const ICON_FOR_TYPE = {
    indicator: 'fa-wave-square',
    pattern:   'fa-shapes',
    strategy:  'fa-chess-knight',
    ticker:    'fa-tag',
  };

  // ----------------------------------------------------------
  // Math
  // ----------------------------------------------------------
  function positionSize({ entry, stop, riskPct, account }) {
    entry   = +entry;
    stop    = +stop;
    riskPct = +riskPct;
    account = +account;
    if (!isFinite(entry) || !isFinite(stop) || !isFinite(riskPct) || !isFinite(account)) return 0;
    if (entry <= 0 || stop <= 0 || riskPct <= 0 || account <= 0) return 0;
    const perUnit = Math.abs(entry - stop);
    if (perUnit < 1e-9) return 0;
    const dollarRisk = account * (riskPct / 100);
    // Truncate (floor) to 6 decimals so the composer preview matches
    // the server's `tarena_position_size` byte-for-byte. Don't use
    // .toFixed(6) — its rounding differs from Postgres `round()`.
    return Math.floor((dollarRisk / perUnit) * 1e6) / 1e6;
  }

  function riskReward({ entry, stop, target, direction }) {
    entry  = +entry;
    stop   = +stop;
    target = +target;
    if (!isFinite(entry) || !isFinite(stop) || !isFinite(target)) return null;
    if (entry === stop) return null;
    direction = (direction || 'long').toLowerCase();
    const risk   = Math.abs(entry - stop);
    const reward = direction === 'long'
      ? (target - entry)
      : (entry - target);
    if (risk === 0) return null;
    return +(reward / risk).toFixed(2);
  }

  // Live unrealised P&L for an open position. `side` matches
  // paper_trades.side ('buy' = long, 'sell' = short).
  function livePnl({ entry, qty, side, last }) {
    entry = +entry; qty = +qty; last = +last;
    if (!isFinite(entry) || !isFinite(qty) || !isFinite(last)) return { abs: 0, pct: 0 };
    const dir = (side === 'sell') ? -1 : 1;
    const abs = (last - entry) * qty * dir;
    const cost = entry * qty;
    const pct = cost > 0 ? (abs / cost) * 100 : 0;
    return { abs, pct };
  }

  // Lookup a tag's definition, falling back to a clean placeholder
  // so the popover never renders "undefined".
  function defineTag(tagValue) {
    return DEFINITIONS[tagValue] || `${tagValue} — tap to learn this in Schools.`;
  }

  // Build a stable sort order for chips (indicators first, then
  // patterns, then strategies). Same order as the composer offers.
  function tagSortKey(tag) {
    const order = { indicator: 0, pattern: 1, strategy: 2, ticker: 3 };
    return [order[tag.tag_type] ?? 9, tag.ordinal || 0, tag.tag_value || ''];
  }

  // ----------------------------------------------------------
  // Public exports
  // ----------------------------------------------------------
  global.TArenaReels = {
    INDICATORS, PATTERNS, STRATEGIES, DEFINITIONS, ICON_FOR_TYPE,
    positionSize, riskReward, livePnl, defineTag, tagSortKey,
  };
})(window);
