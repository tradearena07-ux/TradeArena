/**
 * TradeArena — Vercel Serverless Market Data API
 * /api/market.js
 *
 * Acts as a server-side proxy for all market data.
 * Runs on Vercel Edge/Node runtime — no CORS issues ever.
 *
 * Supported query params:
 *   ?type=stock&symbol=BHP.AX
 *   ?type=bulk&symbol=BHP.AX,CBA.AX,AAPL,TSLA
 *   ?type=history&symbol=BHP.AX&interval=1d&range=1y
 *   ?type=crypto&symbol=bitcoin,ethereum,solana
 *   ?type=forex
 *   ?type=index&symbol=ASX200
 */

// Browser-like headers to avoid Yahoo Finance 401/403 blocks
const YAHOO_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  'Cache-Control': 'no-cache',
};

// Yahoo Finance v8 chart endpoint — returns OHLCV + meta
const YAHOO_V8 = 'https://query1.finance.yahoo.com/v8/finance/chart/';
// Fallback to query2 if query1 is throttled
const YAHOO_V8_ALT = 'https://query2.finance.yahoo.com/v8/finance/chart/';

/**
 * Fetch Yahoo Finance data with automatic fallback between query1 and query2.
 */
async function fetchYahoo(path, params = '') {
  const url1 = `${YAHOO_V8}${path}${params}`;
  const url2 = `${YAHOO_V8_ALT}${path}${params}`;
  let res;
  try {
    res = await fetch(url1, { headers: YAHOO_HEADERS });
    if (!res.ok) throw new Error(`query1 returned ${res.status}`);
  } catch (_) {
    // Fallback to query2
    res = await fetch(url2, { headers: YAHOO_HEADERS });
  }
  if (!res.ok) throw new Error(`Yahoo returned ${res.status}`);
  return res.json();
}

/**
 * Parse Yahoo chart meta into a clean quote object.
 */
function parseMeta(meta, symbol) {
  if (!meta || !meta.regularMarketPrice) return null;
  const price  = meta.regularMarketPrice;
  const prev   = meta.chartPreviousClose || meta.previousClose || price;
  // Yahoo v8 often omits regularMarketChangePercent — derive from price/prev
  const changePct = (meta.regularMarketChangePercent != null)
    ? meta.regularMarketChangePercent
    : (prev && prev !== price ? ((price - prev) / prev) * 100 : 0);
  return {
    symbol,
    price,
    change:      changePct,
    changeAbs:   price - prev,
    high:        meta.regularMarketDayHigh   || price,
    low:         meta.regularMarketDayLow    || price,
    open:        meta.regularMarketOpen      || price,
    prevClose:   prev,
    volume:      meta.regularMarketVolume    || 0,
    marketCap:   meta.marketCap              || 0,
    currency:    meta.currency               || 'AUD',
    exchange:    meta.exchangeName           || '',
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh  || 0,
    fiftyTwoWeekLow:  meta.fiftyTwoWeekLow   || 0,
  };
}

export default async function handler(req, res) {
  // ── CORS headers — allow all origins ──
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=5');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const { type, symbol, interval, range } = req.query;

  try {

    // ══════════════════════════════════════════════════
    // TYPE: crypto — CoinGecko (AUD prices, no key)
    // ══════════════════════════════════════════════════
    if (type === 'crypto') {
      const ids = symbol || 'bitcoin,ethereum,solana,ripple,cardano';
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=aud&include_24hr_change=true&include_high_24h=true&include_low_24h=true&include_24hr_vol=true`;
      const r = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });
      if (!r.ok) throw new Error(`CoinGecko returned ${r.status}`);
      const data = await r.json();
      return res.status(200).json({ success: true, data });
    }

    // ══════════════════════════════════════════════════
    // TYPE: forex — Frankfurter (free, no key)
    // ══════════════════════════════════════════════════
    if (type === 'forex') {
      const r = await fetch(
        'https://api.frankfurter.dev/v2/rates?base=USD&symbols=AUD,EUR,GBP,JPY,CNY,CAD',
        { headers: { 'Accept': 'application/json' } }
      );
      if (!r.ok) throw new Error(`Frankfurter returned ${r.status}`);
      const data = await r.json();
      return res.status(200).json({ success: true, data });
    }

    // ══════════════════════════════════════════════════
    // TYPE: index — Market indices via Yahoo Finance
    // ══════════════════════════════════════════════════
    if (type === 'index') {
      const indexMap = {
        'ASX200': '%5EAORD',
        'SP500':  '%5EGSPC',
        'NASDAQ': '%5EIXIC',
        'DOW':    '%5EDJI',
        'VIX':    '%5EVIX',
      };
      const ticker = indexMap[symbol] || symbol;
      const data = await fetchYahoo(`${ticker}`, '?interval=1d&range=1d');
      const meta = data?.chart?.result?.[0]?.meta;
      const quote = parseMeta(meta, symbol);
      if (!quote) {
        return res.status(200).json({ success: false, error: 'No index data returned' });
      }
      return res.status(200).json({ success: true, data: quote });
    }

    // ══════════════════════════════════════════════════
    // TYPE: history — OHLCV candles for charts
    // ══════════════════════════════════════════════════
    if (type === 'history') {
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol is required' });
      }
      const iv  = interval || '1d';
      const rng = range    || '1y';
      const data = await fetchYahoo(
        encodeURIComponent(symbol),
        `?interval=${iv}&range=${rng}&includePrePost=false`
      );
      const result = data?.chart?.result?.[0];
      if (!result) {
        return res.status(200).json({ success: false, error: 'No chart data returned' });
      }
      const timestamps = result.timestamp || [];
      const q = result.indicators?.quote?.[0] || {};
      const candles = timestamps
        .map((t, i) => ({
          time:   t,
          open:   q.open?.[i]   != null ? parseFloat(q.open[i].toFixed(6))   : null,
          high:   q.high?.[i]   != null ? parseFloat(q.high[i].toFixed(6))   : null,
          low:    q.low?.[i]    != null ? parseFloat(q.low[i].toFixed(6))    : null,
          close:  q.close?.[i]  != null ? parseFloat(q.close[i].toFixed(6))  : null,
          volume: q.volume?.[i] || 0,
        }))
        .filter(c => c.open != null && c.high != null && c.low != null && c.close != null
                  && !isNaN(c.close) && c.close > 0);
      return res.status(200).json({ success: true, data: candles });
    }

    // ══════════════════════════════════════════════════
    // TYPE: stock — Single symbol quote
    // ══════════════════════════════════════════════════
    if (type === 'stock') {
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol is required' });
      }
      const data = await fetchYahoo(
        encodeURIComponent(symbol),
        '?interval=1d&range=1d'
      );
      const meta = data?.chart?.result?.[0]?.meta;
      const quote = parseMeta(meta, symbol);
      if (!quote) {
        return res.status(200).json({ success: false, error: 'No price data returned' });
      }
      return res.status(200).json({ success: true, data: quote });
    }

    // ══════════════════════════════════════════════════
    // TYPE: bulk — Multiple symbols in one request
    // ══════════════════════════════════════════════════
    if (type === 'bulk') {
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol is required' });
      }
      const symbols = symbol.split(',').map(s => s.trim()).filter(Boolean);
      // Fetch all symbols in parallel
      const results = await Promise.all(
        symbols.map(async (sym) => {
          try {
            const data = await fetchYahoo(
              encodeURIComponent(sym),
              '?interval=1d&range=1d'
            );
            const meta = data?.chart?.result?.[0]?.meta;
            return parseMeta(meta, sym);
          } catch (e) {
            return null;
          }
        })
      );
      return res.status(200).json({
        success: true,
        data: results.filter(Boolean),
      });
    }

    // ══════════════════════════════════════════════════
    // TYPE: all — Fetch everything in one shot
    // (bulk ASX + US stocks, crypto, forex, indices)
    // ══════════════════════════════════════════════════
    if (type === 'all') {
      const ASX_SYMS = ['BHP.AX','CBA.AX','MQG.AX','WDS.AX','RIO.AX','NAB.AX','ANZ.AX','WBC.AX','CSL.AX','FMG.AX'];
      const US_SYMS  = ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','NFLX'];
      const allSyms  = [...ASX_SYMS, ...US_SYMS];

      const [stockResults, cryptoRes, forexRes, idxASX, idxSP, idxNASDAQ] = await Promise.allSettled([
        Promise.all(allSyms.map(async sym => {
          try {
            const d = await fetchYahoo(encodeURIComponent(sym), '?interval=1d&range=1d');
            return parseMeta(d?.chart?.result?.[0]?.meta, sym);
          } catch { return null; }
        })),
        fetch(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,ripple,cardano&vs_currencies=aud&include_24hr_change=true&include_high_24h=true&include_low_24h=true`).then(r => r.json()),
        fetch('https://api.frankfurter.dev/v2/rates?base=USD&symbols=AUD,EUR,GBP,JPY,CNY,CAD').then(r => r.json()),
        fetchYahoo('%5EAORD', '?interval=1d&range=1d'),
        fetchYahoo('%5EGSPC', '?interval=1d&range=1d'),
        fetchYahoo('%5EIXIC', '?interval=1d&range=1d'),
      ]);

      const stocks = {};
      if (stockResults.status === 'fulfilled') {
        (stockResults.value || []).filter(Boolean).forEach(s => { stocks[s.symbol] = s; });
      }

      const crypto = {};
      if (cryptoRes.status === 'fulfilled') {
        const CRYPTO_MAP = { bitcoin:'BTC', ethereum:'ETH', solana:'SOL', ripple:'XRP', cardano:'ADA' };
        Object.entries(cryptoRes.value || {}).forEach(([id, vals]) => {
          const sym = CRYPTO_MAP[id];
          if (sym) crypto[sym] = { symbol: sym, price: vals.aud, change: vals.aud_24h_change || 0, high: vals.aud_24h_high, low: vals.aud_24h_low };
        });
      }

      const forex = forexRes.status === 'fulfilled' ? (forexRes.value?.rates || {}) : {};

      const indices = {};
      if (idxASX.status === 'fulfilled')    indices.ASX200  = parseMeta(idxASX.value?.chart?.result?.[0]?.meta,    'ASX200');
      if (idxSP.status === 'fulfilled')     indices.SP500   = parseMeta(idxSP.value?.chart?.result?.[0]?.meta,     'SP500');
      if (idxNASDAQ.status === 'fulfilled') indices.NASDAQ  = parseMeta(idxNASDAQ.value?.chart?.result?.[0]?.meta, 'NASDAQ');

      return res.status(200).json({ success: true, data: { stocks, crypto, forex, indices } });
    }

    return res.status(400).json({ success: false, error: `Unknown type: "${type}". Valid types: stock, bulk, history, crypto, forex, index, all` });

  } catch (error) {
    console.error('[TradeArena API]', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
