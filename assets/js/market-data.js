// =====================================================================
//  TradeArena — Market Data Library  v3.0
//  assets/js/market-data.js
//
//  ALL calls go through /api/market (Vercel serverless function).
//  No CORS proxies. No direct Yahoo Finance calls from the browser.
//  Server-side fetching means Yahoo Finance can never block us.
//
//  Usage:
//    <script src="/assets/js/market-data.js"></script>
//    MarketData.startLivePrices();
//    window.addEventListener('marketDataUpdated', e => {
//      const { stocks, crypto, forex, indices } = e.detail;
//    });
// =====================================================================

(function (global) {
  'use strict';

  // ── API endpoint (same origin — Vercel serverless) ──
  var API = '/api/market';

  // ── Symbols to track ──
  var SYMBOLS = {
    ASX:  ['BHP.AX','CBA.AX','MQG.AX','WDS.AX','RIO.AX','NAB.AX','ANZ.AX','WBC.AX','CSL.AX','FMG.AX'],
    US:   ['AAPL','TSLA','NVDA','MSFT','AMZN','GOOGL','META','NFLX'],
    CRYPTO_IDS: 'bitcoin,ethereum,solana,ripple,cardano',
    CRYPTO_MAP: {
      bitcoin:  'BTC',
      ethereum: 'ETH',
      solana:   'SOL',
      ripple:   'XRP',
      cardano:  'ADA',
    },
  };

  // ── Cache (14 seconds TTL) ──
  var _cache = {};
  var CACHE_TTL = 14000;

  function _cacheValid(key) {
    return _cache[key] && (Date.now() - _cache[key].ts < CACHE_TTL);
  }
  function _cacheSet(key, data) {
    _cache[key] = { data: data, ts: Date.now() };
    return data;
  }
  function _cacheGet(key) {
    return _cache[key] ? _cache[key].data : null;
  }

  // ── In-memory price store ──
  var _stocks  = {};
  var _crypto  = {};
  var _forex   = {};
  var _indices = {};
  var _refreshHandle = null;

  // ══════════════════════════════════════════════════════════════
  // CORE FETCH HELPERS
  // ══════════════════════════════════════════════════════════════

  function getStock(symbol) {
    if (_cacheValid(symbol)) return Promise.resolve(_cacheGet(symbol));
    return fetch(API + '?type=stock&symbol=' + encodeURIComponent(symbol))
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j.success && j.data) ? _cacheSet(symbol, j.data) : null; })
      .catch(function(){ return null; });
  }

  function getBulk(symbols) {
    if (!symbols || !symbols.length) return Promise.resolve([]);
    var key = 'bulk:' + symbols.join(',');
    if (_cacheValid(key)) return Promise.resolve(_cacheGet(key));
    return fetch(API + '?type=bulk&symbol=' + encodeURIComponent(symbols.join(',')))
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j.success && j.data) ? _cacheSet(key, j.data) : []; })
      .catch(function(){ return []; });
  }

  function getCrypto() {
    if (_cacheValid('crypto')) return Promise.resolve(_cacheGet('crypto'));
    return fetch(API + '?type=crypto&symbol=' + SYMBOLS.CRYPTO_IDS)
      .then(function(r){ return r.json(); })
      .then(function(j){
        if (!j.success || !j.data) return {};
        var mapped = {};
        Object.keys(j.data).forEach(function(id){
          var vals = j.data[id];
          var sym  = SYMBOLS.CRYPTO_MAP[id];
          if (sym) mapped[sym] = {
            symbol: sym,
            price:  vals.aud,
            change: vals.aud_24h_change || 0,
            high:   vals.aud_24h_high   || vals.aud,
            low:    vals.aud_24h_low    || vals.aud,
            volume: vals.aud_24h_vol    || 0,
          };
        });
        return _cacheSet('crypto', mapped);
      })
      .catch(function(){ return {}; });
  }

  function getForex() {
    if (_cacheValid('forex')) return Promise.resolve(_cacheGet('forex'));
    return fetch(API + '?type=forex')
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j.success && j.data && j.data.rates) ? _cacheSet('forex', j.data.rates) : {}; })
      .catch(function(){ return {}; });
  }

  function getIndex(name) {
    var key = 'idx:' + name;
    if (_cacheValid(key)) return Promise.resolve(_cacheGet(key));
    return fetch(API + '?type=index&symbol=' + encodeURIComponent(name))
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j.success && j.data) ? _cacheSet(key, j.data) : null; })
      .catch(function(){ return null; });
  }

  function getIndices() {
    return Promise.all(['ASX200','SP500','NASDAQ'].map(function(n){
      return getIndex(n).then(function(d){ return { name: n, data: d }; });
    })).then(function(arr){
      var r = {};
      arr.forEach(function(x){ if (x.data) r[x.name] = x.data; });
      return r;
    });
  }

  function getChartHistory(symbol, isASX, timeframe) {
    var sym = symbol;
    if (isASX && sym.indexOf('.AX') === -1) sym = sym + '.AX';
    var tfMap = {
      '1m':  { interval:'1m',  range:'1d'  },
      '5m':  { interval:'5m',  range:'5d'  },
      '15m': { interval:'15m', range:'5d'  },
      '1h':  { interval:'1h',  range:'1mo' },
      '4h':  { interval:'1h',  range:'3mo' },
      '1D':  { interval:'1d',  range:'1y'  },
      '1W':  { interval:'1wk', range:'5y'  },
      '1M':  { interval:'1mo', range:'max' },
    };
    var tf = tfMap[timeframe] || tfMap['1D'];
    var key = 'hist:' + sym + ':' + timeframe;
    if (_cacheValid(key)) return Promise.resolve(_cacheGet(key));
    return fetch(API + '?type=history&symbol=' + encodeURIComponent(sym) + '&interval=' + tf.interval + '&range=' + tf.range)
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j.success && j.data && j.data.length) ? _cacheSet(key, j.data) : []; })
      .catch(function(){ return []; });
  }

  // Alias for backward compat
  function fetchChartHistory(symbol, isASX, timeframe) {
    return getChartHistory(symbol, isASX, timeframe);
  }

  function fetchLiveQuote(symbol) {
    return fetch(API + '?type=stock&symbol=' + encodeURIComponent(symbol))
      .then(function(r){ return r.json(); })
      .then(function(j){ return (j.success && j.data) ? j.data : null; })
      .catch(function(){ return null; });
  }

  // ══════════════════════════════════════════════════════════════
  // BULK REFRESH
  // ══════════════════════════════════════════════════════════════

  function getAllPrices() {
    var allASX = SYMBOLS.ASX.join(',');
    var allUS  = SYMBOLS.US.join(',');

    return Promise.all([
      fetch(API + '?type=bulk&symbol=' + encodeURIComponent(allASX)).then(function(r){ return r.json(); }).catch(function(){ return { success:false }; }),
      fetch(API + '?type=bulk&symbol=' + encodeURIComponent(allUS)).then(function(r){ return r.json(); }).catch(function(){ return { success:false }; }),
      getCrypto(),
      getForex(),
      getIndices(),
    ]).then(function(results){
      var asxResult  = results[0];
      var usResult   = results[1];
      var cryptoData = results[2];
      var forexData  = results[3];
      var indicesData= results[4];

      var stocks = {};
      if (asxResult.success) {
        (asxResult.data || []).forEach(function(s){
          if (!s) return;
          stocks[s.symbol] = s;
          stocks[s.symbol.replace('.AX','')] = s; // clean key
        });
      }
      if (usResult.success) {
        (usResult.data || []).forEach(function(s){ if (s) stocks[s.symbol] = s; });
      }

      _stocks  = stocks;
      _crypto  = cryptoData  || {};
      _forex   = forexData   || {};
      _indices = indicesData || {};

      var payload = { stocks: _stocks, crypto: _crypto, forex: _forex, indices: _indices };

      global.marketData       = payload;
      global.lastMarketUpdate = new Date();

      _syncLegacyTArenaMarket(payload);
      _syncTradePrices(payload);

      global.dispatchEvent(new CustomEvent('marketDataUpdated', { detail: payload }));
      return payload;
    });
  }

  function startLivePrices() {
    getAllPrices();
    if (_refreshHandle) clearInterval(_refreshHandle);
    _refreshHandle = setInterval(getAllPrices, 15000);
  }

  function startMarketRefresh() { startLivePrices(); }

  function stopLivePrices() {
    if (_refreshHandle) { clearInterval(_refreshHandle); _refreshHandle = null; }
  }

  // ══════════════════════════════════════════════════════════════
  // TICKER BAR UPDATER
  // ══════════════════════════════════════════════════════════════

  function updateTickerBar(data) {
    var track = global.document && global.document.getElementById('tickerTrack');
    if (!track) return;
    var stocks = (data && data.stocks) || {};
    var crypto = (data && data.crypto) || {};
    var items = [
      { sym:'BHP',  d: stocks['BHP']  || stocks['BHP.AX'] },
      { sym:'BTC',  d: crypto['BTC']  },
      { sym:'ETH',  d: crypto['ETH']  },
      { sym:'AAPL', d: stocks['AAPL'] },
      { sym:'TSLA', d: stocks['TSLA'] },
      { sym:'NVDA', d: stocks['NVDA'] },
      { sym:'CBA',  d: stocks['CBA']  || stocks['CBA.AX'] },
      { sym:'SOL',  d: crypto['SOL']  },
    ].filter(function(i){ return i.d && i.d.price; });

    if (!items.length) return;
    var html = items.map(function(i){
      var up  = i.d.change >= 0;
      var cls = up ? 'up' : 'dn';
      return '<span class="tick">' + i.sym + ' <span class="' + cls + '">' + formatPrice(i.d.price, i.sym) + ' ' + (up ? '▲' : '▼') + ' ' + Math.abs(i.d.change).toFixed(2) + '%</span></span>';
    }).join('');
    track.innerHTML = html + html;
  }

  // ══════════════════════════════════════════════════════════════
  // FORMATTING HELPERS
  // ══════════════════════════════════════════════════════════════

  function formatPrice(price, symbol) {
    if (!price || price === 0 || !isFinite(price)) return '--';
    if (symbol === 'BTC' || price > 10000) return '$' + Math.round(price).toLocaleString('en-AU');
    return '$' + parseFloat(price).toFixed(2);
  }

  function formatChange(change) {
    if (change === null || change === undefined || !isFinite(change)) return '--';
    var sign = change >= 0 ? '+' : '';
    return sign + parseFloat(change).toFixed(2) + '%';
  }

  // ══════════════════════════════════════════════════════════════
  // LEGACY COMPATIBILITY BRIDGES
  // ══════════════════════════════════════════════════════════════

  function _syncLegacyTArenaMarket(payload) {
    if (!global.TArenaMarket) return;
    try {
      var rows = [];
      Object.values(payload.stocks || {}).forEach(function(s){
        if (!s || !s.price) return;
        var sym = s.symbol.replace('.AX','');
        if (rows.find(function(r){ return r.symbol === sym; })) return;
        rows.push({ symbol:sym, price:s.price, change:s.change||0, high:s.high||s.price, low:s.low||s.price, volume:s.volume||0 });
      });
      Object.values(payload.crypto || {}).forEach(function(c){
        if (!c || !c.price) return;
        rows.push({ symbol:c.symbol, price:c.price, change:c.change||0, high:c.high||c.price, low:c.low||c.price, volume:c.volume||0 });
      });
      if (rows.length) global.TArenaMarket.data = rows;
    } catch(e) {}
  }

  function _syncTradePrices(payload) {
    if (typeof global.PRICES === 'undefined') return;
    try {
      Object.values(payload.stocks || {}).forEach(function(s){
        if (!s || !s.price) return;
        global.PRICES[s.symbol] = { price:s.price, changePct:s.change||0, high:s.high||s.price, low:s.low||s.price, open:s.open||s.price, volume:s.volume||0, w52h:s.fiftyTwoWeekHigh||0 };
      });
      Object.values(payload.crypto || {}).forEach(function(c){
        if (!c || !c.price) return;
        global.PRICES[c.symbol] = { price:c.price, changePct:c.change||0, high:c.high||c.price, low:c.low||c.price, open:c.price, volume:c.volume||0 };
      });
    } catch(e) {}
  }

  // ══════════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ══════════════════════════════════════════════════════════════

  function getDataStatus() {
    return {
      stocks:  Object.keys(_stocks).length,
      crypto:  Object.keys(_crypto).length,
      forex:   Object.keys(_forex).length,
      indices: Object.keys(_indices).length,
      lastUpdate: global.lastMarketUpdate || null,
    };
  }

  function getStatusHtml() {
    var s = getDataStatus();
    var ok = s.stocks > 0 || s.crypto > 0;
    var dot = ok ? '<span style="color:#4ade80">●</span>' : '<span style="color:#f87171">●</span>';
    return dot + ' Live · ' + s.stocks + ' stocks · ' + s.crypto + ' crypto';
  }

  // ══════════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════════

  global.MarketData = {
    getStock:          getStock,
    getBulk:           getBulk,
    getCrypto:         getCrypto,
    getForex:          getForex,
    getIndex:          getIndex,
    getIndices:        getIndices,
    getChartHistory:   getChartHistory,
    fetchChartHistory: fetchChartHistory,
    fetchLiveQuote:    fetchLiveQuote,
    getAllPrices:       getAllPrices,
    startLivePrices:   startLivePrices,
    startMarketRefresh:startMarketRefresh,
    stopLivePrices:    stopLivePrices,
    updateTickerBar:   updateTickerBar,
    formatPrice:       formatPrice,
    formatChange:      formatChange,
    getDataStatus:     getDataStatus,
    getStatusHtml:     getStatusHtml,
    SYMBOLS:           SYMBOLS,
  };

}(window));
