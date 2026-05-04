// =====================================================================
//  TradeArena — Centralized Market Data Engine
//  assets/js/market-data.js
//
//  Single source of truth for ALL live prices across the entire site.
//  Sources:
//    • Yahoo Finance (via CORS proxies) — ASX stocks, US stocks, indices
//    • CoinGecko — Crypto (AUD prices, no API key)
//    • Frankfurter — Forex rates (no API key)
//
//  Usage:
//    <script src="assets/js/market-data.js"></script>
//    MarketData.startMarketRefresh();
//    window.addEventListener('marketDataUpdated', e => { ... });
// =====================================================================
(function (global) {
  'use strict';

  // ============ CONFIGURATION ============
  const ASX_STOCKS = ['BHP', 'CBA', 'MQG', 'WDS', 'RIO', 'NAB', 'ANZ', 'WBC'];
  const US_STOCKS  = ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META'];
  const CRYPTO_IDS = {
    bitcoin:  'BTC',
    ethereum: 'ETH',
    solana:   'SOL',
    ripple:   'XRP',
    cardano:  'ADA',
  };
  const INDEX_SYMBOLS = [
    { symbol: '%5EAORD', name: 'ASX 200', key: 'ASX200' },
    { symbol: '%5EGSPC', name: 'S&P 500', key: 'SP500' },
    { symbol: '%5EIXIC', name: 'NASDAQ',  key: 'NASDAQ' },
    { symbol: '%5EDJI',  name: 'DOW',     key: 'DOW' },
  ];
  const REFRESH_INTERVAL = 15000; // 15 seconds
  const PROXY_TIMEOUT    = 6000;  // 6 seconds per proxy attempt

  // ============ DATA SOURCES ============
  // Primary: Supabase Edge Function (data-proxy) — server-side, cached, reliable
  // Fallback: Public CORS proxies — used only if Edge Function is unavailable
  const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
  const SUPABASE_URL = (window.TARENA_CONFIG && window.TARENA_CONFIG.supabaseUrl)
    ? window.TARENA_CONFIG.supabaseUrl
    : 'https://chncykagtzotdtflkhim.supabase.co';
  const SUPABASE_KEY = (window.TARENA_CONFIG && window.TARENA_CONFIG.supabaseKey)
    ? window.TARENA_CONFIG.supabaseKey
    : '';
  const DATA_PROXY_URL = SUPABASE_URL + '/functions/v1/data-proxy';
  const PROXIES = [
    function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); },
    function (u) { return 'https://corsproxy.io/?' + encodeURIComponent(u); },
    function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); },
  ];

  // ============ STATE ============
  var _marketData = {
    stocks:  {},
    crypto:  {},
    forex:   {},
    indices: {},
  };
  var _lastUpdate    = null;
  var _refreshHandle = null;
  var _failCount     = 0;
  var _fetchInFlight = false;

  // Yahoo JSON response cache to reduce redundant requests
  var _yfCache = {}; // symbol → { ts, data }
  var _YF_TTL  = 8000; // 8s cache

  // ============ EDGE FUNCTION FETCHER (primary) ============
  // Routes through the Supabase data-proxy edge function which handles
  // server-side Yahoo fetching with caching in price_bars table.
  function _fetchViaEdgeFunction(symbol, interval, range) {
    var controller, timeout;
    try {
      controller = new AbortController();
      timeout = setTimeout(function () { controller.abort(); }, PROXY_TIMEOUT);
    } catch (_) { controller = null; timeout = null; }
    var opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
      },
      body: JSON.stringify({ action: 'bars', symbol: symbol, interval: interval, range: range }),
    };
    if (controller) opts.signal = controller.signal;
    return fetch(DATA_PROXY_URL, opts).then(function (res) {
      if (timeout) clearTimeout(timeout);
      if (!res.ok) throw new Error('edge-fn HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (timeout) clearTimeout(timeout);
      // Edge function returns { s: 'ok', bars: [...] } with OHLCV bars
      // OR it may return raw Yahoo JSON shape — handle both
      if (data && data.s === 'ok' && Array.isArray(data.bars)) {
        // Convert edge function bar format to Yahoo chart shape
        var bars = data.bars;
        var timestamps = bars.map(function (b) { return b.t || b.time; });
        var opens   = bars.map(function (b) { return b.o || b.open; });
        var highs   = bars.map(function (b) { return b.h || b.high; });
        var lows    = bars.map(function (b) { return b.l || b.low; });
        var closes  = bars.map(function (b) { return b.c || b.close; });
        var volumes = bars.map(function (b) { return b.v || b.volume || 0; });
        var lastClose = closes[closes.length - 1] || 0;
        return {
          chart: { result: [{
            meta: {
              regularMarketPrice: lastClose,
              chartPreviousClose: closes[closes.length - 2] || lastClose,
              regularMarketDayHigh: Math.max.apply(null, highs.slice(-1)),
              regularMarketDayLow:  Math.min.apply(null, lows.slice(-1)),
              regularMarketOpen:    opens[opens.length - 1] || lastClose,
              regularMarketVolume:  volumes[volumes.length - 1] || 0,
            },
            timestamp: timestamps,
            indicators: { quote: [{ open: opens, high: highs, low: lows, close: closes, volume: volumes }] },
          }] },
        };
      }
      // If edge function returned raw Yahoo shape, pass through
      if (data && data.chart && data.chart.result && data.chart.result[0]) {
        return data;
      }
      throw new Error('edge-fn unexpected shape');
    }).catch(function (e) {
      if (timeout) clearTimeout(timeout);
      throw e;
    });
  }

  // ============ EDGE FUNCTION QUOTE FETCHER ============
  function _fetchQuoteViaEdgeFunction(symbol) {
    var controller, timeout;
    try {
      controller = new AbortController();
      timeout = setTimeout(function () { controller.abort(); }, PROXY_TIMEOUT);
    } catch (_) { controller = null; timeout = null; }
    var opts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
      },
      body: JSON.stringify({ action: 'quote', symbol: symbol }),
    };
    if (controller) opts.signal = controller.signal;
    return fetch(DATA_PROXY_URL, opts).then(function (res) {
      if (timeout) clearTimeout(timeout);
      if (!res.ok) throw new Error('edge-fn quote HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (timeout) clearTimeout(timeout);
      if (data && data.s === 'ok' && data.p > 0) {
        // Edge function quote shape: { s: 'ok', p: price, dp: changePct, ... }
        var price = data.p;
        var prev  = data.pc || price;
        return {
          chart: { result: [{
            meta: {
              regularMarketPrice:         price,
              chartPreviousClose:         prev,
              regularMarketChangePercent: data.dp || ((price - prev) / prev * 100),
              regularMarketDayHigh:       data.h  || price,
              regularMarketDayLow:        data.l  || price,
              regularMarketOpen:          data.o  || price,
              regularMarketVolume:        data.v  || 0,
              fiftyTwoWeekHigh:           data.h52 || null,
              fiftyTwoWeekLow:            data.l52 || null,
            },
            timestamp: [Math.floor(Date.now() / 1000)],
            indicators: { quote: [{ open: [price], high: [price], low: [price], close: [price], volume: [0] }] },
          }] },
        };
      }
      // Pass through raw Yahoo shape if returned
      if (data && data.chart && data.chart.result && data.chart.result[0]) return data;
      throw new Error('edge-fn quote unexpected shape');
    }).catch(function (e) {
      if (timeout) clearTimeout(timeout);
      throw e;
    });
  }

  // ============ YAHOO FINANCE FETCHER (CORS proxy fallback) ============
  function _fetchYahooJsonViaProxy(yahooUrl) {
    var lastErr;
    var i = 0;
    function tryNext() {
      if (i >= PROXIES.length) {
        return Promise.reject(lastErr || new Error('all proxies failed'));
      }
      var wrap = PROXIES[i++];
      var proxyUrl = wrap(yahooUrl);
      var controller;
      var timeout;
      try {
        controller = new AbortController();
        timeout = setTimeout(function () { controller.abort(); }, PROXY_TIMEOUT);
      } catch (_) {
        controller = null;
        timeout = null;
      }
      var opts = controller ? { signal: controller.signal } : {};
      return fetch(proxyUrl, opts).then(function (res) {
        if (timeout) clearTimeout(timeout);
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); return tryNext(); }
        return res.json().then(function (data) {
          if (data && data.chart && data.chart.result && data.chart.result[0]) {
            return data;
          }
          lastErr = new Error('bad shape');
          return tryNext();
        });
      }).catch(function (e) {
        if (timeout) clearTimeout(timeout);
        lastErr = e;
        return tryNext();
      });
    }
    return tryNext();
  }

  // ============ UNIFIED YAHOO FETCHER (edge-fn first, proxy fallback) ============
  function _fetchYahooJson(yahooUrl, symbol, interval, range) {
    // Try edge function first (server-side, cached, no CORS issues)
    if (symbol && interval && range) {
      return _fetchViaEdgeFunction(symbol, interval, range).catch(function (e) {
        console.warn('[MarketData] Edge function failed, falling back to CORS proxy:', e.message);
        return _fetchYahooJsonViaProxy(yahooUrl);
      });
    }
    // For quote-only requests, try edge function quote endpoint first
    if (symbol) {
      return _fetchQuoteViaEdgeFunction(symbol).catch(function (e) {
        console.warn('[MarketData] Edge function quote failed, falling back to CORS proxy:', e.message);
        return _fetchYahooJsonViaProxy(yahooUrl);
      });
    }
    return _fetchYahooJsonViaProxy(yahooUrl);
  }

  // ============ FETCH SINGLE STOCK/INDEX PRICE ============
  function fetchPrice(symbol, isASX) {
    var ticker = isASX ? symbol + '.AX' : symbol;
    var cacheKey = ticker;
    var cached = _yfCache[cacheKey];
    if (cached && (Date.now() - cached.ts) < _YF_TTL) {
      return Promise.resolve(cached.data);
    }

    var yahooUrl = YAHOO_BASE + encodeURIComponent(ticker) + '?interval=1d&range=1d';
    return _fetchYahooJson(yahooUrl, ticker, '1d', '1d').then(function (data) {
      var meta = data.chart.result[0].meta;
      if (!meta || !(meta.regularMarketPrice > 0)) return null;
      var price    = meta.regularMarketPrice;
      var prev     = meta.chartPreviousClose || meta.previousClose || 0;
      var changePct = (typeof meta.regularMarketChangePercent === 'number')
        ? meta.regularMarketChangePercent
        : (prev ? ((price - prev) / prev) * 100 : 0);
      var result = {
        symbol:    symbol,
        ticker:    ticker,
        price:     price,
        change:    changePct,
        changeAbs: price - prev,
        high:      meta.regularMarketDayHigh  || null,
        low:       meta.regularMarketDayLow   || null,
        open:      meta.regularMarketOpen     || null,
        prevClose: prev,
        volume:    meta.regularMarketVolume   || null,
        h52:       meta.fiftyTwoWeekHigh      || null,
        l52:       meta.fiftyTwoWeekLow       || null,
        exchange:  isASX ? 'ASX' : 'US',
        lastUpdated: new Date(),
      };
      _yfCache[cacheKey] = { ts: Date.now(), data: result };
      return result;
    }).catch(function () {
      return null;
    });
  }

  // ============ FETCH CRYPTO (CoinGecko) ============
  function fetchCrypto() {
    var ids = Object.keys(CRYPTO_IDS).join(',');
    var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids +
      '&vs_currencies=aud&include_24hr_change=true&include_24hr_vol=true&include_high_24h=true&include_low_24h=true';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('CoinGecko ' + r.status);
      return r.json();
    }).then(function (data) {
      var result = {};
      Object.keys(CRYPTO_IDS).forEach(function (cgId) {
        var sym = CRYPTO_IDS[cgId];
        var d = data[cgId];
        if (!d || typeof d.aud !== 'number') return;
        result[sym] = {
          symbol:    sym,
          price:     d.aud,
          change:    d.aud_24h_change || 0,
          high:      d.aud_24h_high || null,
          low:       d.aud_24h_low  || null,
          volume:    d.aud_24h_vol  || null,
          exchange:  'CRYPTO',
          lastUpdated: new Date(),
        };
      });
      return result;
    }).catch(function (e) {
      console.warn('[MarketData] CoinGecko failed:', e.message);
      return {};
    });
  }

  // ============ FETCH FOREX (Frankfurter) ============
  function fetchForex() {
    var url = 'https://api.frankfurter.dev/v2/rates?base=USD&symbols=AUD,EUR,GBP,JPY,CNY,CAD';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Frankfurter ' + r.status);
      return r.json();
    }).then(function (data) {
      return data.rates || {};
    }).catch(function (e) {
      console.warn('[MarketData] Frankfurter failed:', e.message);
      return {};
    });
  }

  // ============ FETCH INDICES ============
  function fetchIndices() {
    var results = {};
    var promises = INDEX_SYMBOLS.map(function (idx) {
      return fetchPrice(idx.symbol, false).then(function (data) {
        if (data) {
          results[idx.key] = Object.assign({}, data, { name: idx.name });
        }
      });
    });
    return Promise.all(promises).then(function () { return results; });
  }

  // ============ MASTER FETCH ============
  function fetchAllMarketData() {
    if (_fetchInFlight) return Promise.resolve(_marketData);
    _fetchInFlight = true;

    var stockPromises = [];
    ASX_STOCKS.forEach(function (s) {
      stockPromises.push(fetchPrice(s, true));
    });
    US_STOCKS.forEach(function (s) {
      stockPromises.push(fetchPrice(s, false));
    });

    return Promise.all([
      fetchCrypto(),
      fetchForex(),
      fetchIndices(),
      Promise.all(stockPromises),
    ]).then(function (results) {
      var cryptoData  = results[0];
      var forexData   = results[1];
      var indicesData = results[2];
      var stockResults = results[3];

      // Merge crypto
      _marketData.crypto = Object.assign(_marketData.crypto || {}, cryptoData);

      // Merge forex
      _marketData.forex = forexData;

      // Merge indices
      _marketData.indices = Object.assign(_marketData.indices || {}, indicesData);

      // Merge stocks
      var allSymbols = ASX_STOCKS.concat(US_STOCKS);
      allSymbols.forEach(function (sym, i) {
        if (stockResults[i]) {
          _marketData.stocks[sym] = stockResults[i];
        }
      });

      _lastUpdate = new Date();
      _failCount = 0;

      // Store globally
      global.marketData = _marketData;
      global.lastMarketUpdate = _lastUpdate;

      // Dispatch event
      global.dispatchEvent(new CustomEvent('marketDataUpdated', {
        detail: _marketData,
      }));

      // Sync into TArenaMarket for backward compatibility
      _syncLegacyMarket();

      _fetchInFlight = false;
      return _marketData;
    }).catch(function (e) {
      console.warn('[MarketData] fetchAllMarketData error:', e);
      _failCount++;
      _fetchInFlight = false;
      return _marketData;
    });
  }

  // ============ LEGACY SYNC ============
  // Mirror live prices into TArenaMarket so the nav search dropdown,
  // hero mockup, and any other legacy consumer shows real data.
  function _syncLegacyMarket() {
    var M = global.TArenaMarket;
    if (!M || !M.find) return;

    // Sync stocks
    Object.keys(_marketData.stocks).forEach(function (sym) {
      var stock = _marketData.stocks[sym];
      if (!stock || !stock.price) return;
      var ticker = stock.exchange === 'ASX' ? sym + '.AX' : sym;
      var m = M.find(ticker);
      if (m) {
        m.price  = stock.price;
        m.change = stock.change || 0;
      }
    });

    // Sync crypto
    Object.keys(_marketData.crypto).forEach(function (sym) {
      var crypto = _marketData.crypto[sym];
      if (!crypto || !crypto.price) return;
      var m = M.find(sym);
      if (m) {
        m.price  = crypto.price;
        m.change = crypto.change || 0;
      }
    });

    // Repaint the global ticker strip
    if (global.TArenaUI && global.TArenaUI.repaintTicker) {
      global.TArenaUI.repaintTicker();
    }
  }

  // ============ HISTORICAL CHART DATA ============
  function fetchChartHistory(symbol, isASX, timeframe) {
    var ticker = isASX ? symbol + '.AX' : symbol;
    var tfMap = {
      '1m':  { interval: '1m',  range: '1d' },
      '5m':  { interval: '5m',  range: '5d' },
      '15m': { interval: '15m', range: '5d' },
      '1h':  { interval: '1h',  range: '1mo' },
      '4h':  { interval: '1h',  range: '3mo' },
      '1D':  { interval: '1d',  range: '1y' },
      '1W':  { interval: '1wk', range: '5y' },
      '1M':  { interval: '1mo', range: '10y' },
    };
    var tf = tfMap[timeframe] || tfMap['1D'];
    var yahooUrl = YAHOO_BASE + encodeURIComponent(ticker) +
      '?interval=' + tf.interval + '&range=' + tf.range;

    return _fetchYahooJson(yahooUrl, ticker, tf.interval, tf.range).then(function (data) {
      var result = data.chart.result[0];
      if (!result) return [];
      var timestamps = result.timestamp || [];
      var quotes = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
      var bars = [];
      for (var i = 0; i < timestamps.length; i++) {
        var o = quotes.open   && quotes.open[i];
        var h = quotes.high   && quotes.high[i];
        var l = quotes.low    && quotes.low[i];
        var c = quotes.close  && quotes.close[i];
        var v = quotes.volume && quotes.volume[i];
        if (o != null && h != null && l != null && c != null) {
          bars.push({
            time:   timestamps[i],
            t:      timestamps[i] * 1000, // ms for LWC compat
            open:   o, o: o,
            high:   h, h: h,
            low:    l, l: l,
            close:  c, c: c,
            volume: v || 0, v: v || 0,
          });
        }
      }
      return bars;
    }).catch(function (e) {
      console.warn('[MarketData] fetchChartHistory failed for', ticker, e.message);
      return [];
    });
  }

  // ============ FETCH SINGLE LIVE QUOTE ============
  // For on-demand single-symbol quote (used by chart header refresh)
  function fetchLiveQuote(symbol) {
    var isASX = symbol.endsWith('.AX');
    var cleanSym = isASX ? symbol.replace('.AX', '') : symbol;

    // Check if it's a crypto symbol
    var cryptoReverse = {};
    Object.keys(CRYPTO_IDS).forEach(function (cgId) {
      cryptoReverse[CRYPTO_IDS[cgId]] = cgId;
    });
    if (cryptoReverse[symbol]) {
      // Fetch from CoinGecko for single crypto
      var cgId = cryptoReverse[symbol];
      var url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + cgId +
        '&vs_currencies=aud&include_24hr_change=true';
      return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
        var row = d[cgId];
        if (!row || typeof row.aud !== 'number') return null;
        return {
          price:     row.aud,
          change:    row.aud_24h_change || 0,
          changePct: row.aud_24h_change || 0,
        };
      }).catch(function () { return null; });
    }

    // Otherwise use Yahoo
    return fetchPrice(cleanSym, isASX).then(function (data) {
      if (!data) return null;
      return {
        price:     data.price,
        change:    data.changeAbs,
        changePct: data.change,
        high:      data.high,
        low:       data.low,
        open:      data.open,
        prevClose: data.prevClose,
        volume:    data.volume,
      };
    });
  }

  // ============ AUTO REFRESH ============
  function startMarketRefresh() {
    // Immediate first fetch
    fetchAllMarketData();
    // Clear any existing interval
    if (_refreshHandle) clearInterval(_refreshHandle);
    _refreshHandle = setInterval(fetchAllMarketData, REFRESH_INTERVAL);
  }

  function stopMarketRefresh() {
    if (_refreshHandle) {
      clearInterval(_refreshHandle);
      _refreshHandle = null;
    }
  }

  // ============ STATUS HELPERS ============
  function getDataStatus() {
    if (_failCount >= 3) return 'offline';
    if (!_lastUpdate) return 'loading';
    var age = Date.now() - _lastUpdate.getTime();
    if (age < 30000) return 'live';
    if (age < 60000) return 'delayed';
    return 'offline';
  }

  function getStatusHtml() {
    var status = getDataStatus();
    if (status === 'live') {
      return '<span class="md-status md-live"><span class="md-dot md-dot-green"></span> Live</span>';
    } else if (status === 'delayed') {
      return '<span class="md-status md-delayed"><span class="md-dot md-dot-amber"></span> Delayed</span>';
    } else if (status === 'loading') {
      return '<span class="md-status md-loading"><i class="fa-solid fa-spinner fa-spin" style="font-size:10px;margin-right:4px;"></i> Loading…</span>';
    }
    return '<span class="md-status md-offline"><span class="md-dot md-dot-grey"></span> Offline</span>';
  }

  // ============ TICKER BAR HELPER ============
  function updateTickerBar(data) {
    var tickerItems = [
      { sym: 'BTC',  price: data.crypto && data.crypto.BTC  ? data.crypto.BTC.price  : null, change: data.crypto && data.crypto.BTC  ? data.crypto.BTC.change  : null },
      { sym: 'ETH',  price: data.crypto && data.crypto.ETH  ? data.crypto.ETH.price  : null, change: data.crypto && data.crypto.ETH  ? data.crypto.ETH.change  : null },
      { sym: 'AAPL', price: data.stocks && data.stocks.AAPL ? data.stocks.AAPL.price  : null, change: data.stocks && data.stocks.AAPL ? data.stocks.AAPL.change  : null },
      { sym: 'BHP.AX', price: data.stocks && data.stocks.BHP ? data.stocks.BHP.price : null, change: data.stocks && data.stocks.BHP ? data.stocks.BHP.change : null },
      { sym: 'TSLA', price: data.stocks && data.stocks.TSLA ? data.stocks.TSLA.price  : null, change: data.stocks && data.stocks.TSLA ? data.stocks.TSLA.change  : null },
      { sym: 'NVDA', price: data.stocks && data.stocks.NVDA ? data.stocks.NVDA.price  : null, change: data.stocks && data.stocks.NVDA ? data.stocks.NVDA.change  : null },
      { sym: 'SOL',  price: data.crypto && data.crypto.SOL  ? data.crypto.SOL.price   : null, change: data.crypto && data.crypto.SOL  ? data.crypto.SOL.change   : null },
      { sym: 'MSFT', price: data.stocks && data.stocks.MSFT ? data.stocks.MSFT.price  : null, change: data.stocks && data.stocks.MSFT ? data.stocks.MSFT.change  : null },
    ];

    var tickerHTML = tickerItems.filter(function (i) { return i.price != null && i.price > 0; }).map(function (item) {
      var isUp = item.change >= 0;
      var priceStr = item.price > 1000
        ? '$' + Math.round(item.price).toLocaleString('en-AU')
        : '$' + item.price.toFixed(2);
      var arrow = isUp ? '▲' : '▼';
      var pctStr = Math.abs(item.change || 0).toFixed(2) + '%';
      return '<span class="ta-tk-item">' +
        '<span class="ta-tk-sym">' + item.sym + '</span>' +
        '<span class="ta-tk-px">' + priceStr + '</span>' +
        '<span class="' + (isUp ? 'ta-tk-up' : 'ta-tk-dn') + '">' + arrow + ' ' + pctStr + '</span>' +
        '</span>';
    }).join('');

    // Update both the global ticker (app.js rendered) and the index.html ticker
    var tickers = document.querySelectorAll('.ta-ticker-row');
    if (tickers.length) {
      tickers.forEach(function (row) { row.innerHTML = tickerHTML; });
    }

    // Also update #tickerTrack if it exists (index.html)
    var track = document.getElementById('tickerTrack');
    if (track) {
      track.innerHTML = tickerHTML + tickerHTML;
    }
  }

  // ============ PRICE FORMATTER HELPERS ============
  function fmtPrice(price) {
    if (price == null || price === 0) return '--';
    if (price >= 10000) return '$' + Math.round(price).toLocaleString('en-AU');
    if (price >= 1) return '$' + price.toFixed(2);
    return '$' + price.toFixed(4);
  }

  function fmtChange(change) {
    if (change == null) return '--';
    var sign = change >= 0 ? '+' : '';
    return sign + change.toFixed(2) + '%';
  }

  function fmtVolume(vol) {
    if (!vol) return '--';
    if (vol >= 1e9) return (vol / 1e9).toFixed(1) + 'B';
    if (vol >= 1e6) return (vol / 1e6).toFixed(1) + 'M';
    if (vol >= 1e3) return (vol / 1e3).toFixed(1) + 'K';
    return vol.toString();
  }

  // ============ EXPORT ============
  global.MarketData = {
    // Core
    fetchAllMarketData:  fetchAllMarketData,
    fetchPrice:          fetchPrice,
    fetchCrypto:         fetchCrypto,
    fetchForex:          fetchForex,
    fetchIndices:        fetchIndices,
    fetchChartHistory:   fetchChartHistory,
    fetchLiveQuote:      fetchLiveQuote,
    startMarketRefresh:  startMarketRefresh,
    stopMarketRefresh:   stopMarketRefresh,

    // Ticker
    updateTickerBar:     updateTickerBar,

    // Status
    getDataStatus:       getDataStatus,
    getStatusHtml:       getStatusHtml,

    // Formatters
    fmtPrice:            fmtPrice,
    fmtChange:           fmtChange,
    fmtVolume:           fmtVolume,

    // Data access
    getData:             function () { return _marketData; },
    getLastUpdate:       function () { return _lastUpdate; },

    // Config
    ASX_STOCKS:          ASX_STOCKS,
    US_STOCKS:           US_STOCKS,
    CRYPTO_IDS:          CRYPTO_IDS,
    INDEX_SYMBOLS:       INDEX_SYMBOLS,
  };

  // Also store on window for global access
  global.marketData = _marketData;

})(window);
