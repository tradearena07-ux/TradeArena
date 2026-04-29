// ============================================================
// TArenaDatafeed — market data layer
// ============================================================
// Two consumers:
//   1. TradingView Advanced Charts library, via the UDF datafeed
//      object returned by `TArenaDatafeed.createUDF()`.
//   2. The Lightweight Charts fallback, the watchlist, the
//      symbol header, and the order panel — they call the
//      simpler helpers below.
//
// Live ticks:
//   - Crypto:  Binance public WebSocket (true real-time).
//   - Stocks:  poll the Edge Function `/data-proxy?action=quote`
//              on a 5-second interval (free tier, no WS).
// ============================================================
(function (global) {
  'use strict';

  if (!global.TARENA_CONFIG) {
    console.error('TArenaDatafeed: window.TARENA_CONFIG missing — load assets/config.js first.');
    return;
  }

  // Match the config.js shape used by assets/supabase.js (camelCase).
  const SUPABASE_URL             = global.TARENA_CONFIG.supabaseUrl;
  const SUPABASE_PUBLISHABLE_KEY = global.TARENA_CONFIG.supabaseKey;
  const FN_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/data-proxy`;

  // ----- Symbol classification ---------------------------------
  function classify(symbol) {
    const s = String(symbol || '').toUpperCase();
    if (s.endsWith('.AX')) return 'asx';
    if (['BTC','ETH','SOL','XRP','ADA','DOGE','LTC','BNB','AVAX','MATIC'].includes(s)) return 'crypto';
    return 'us';
  }

  function binancePair(symbol) {
    return `${String(symbol).toUpperCase()}USDT`;
  }

  // Resolution ↔ seconds (so we can round timestamps to bar boundaries).
  function resolutionSeconds(res) {
    const r = String(res).toUpperCase();
    if (r === 'D') return 24 * 3600;
    if (r === 'W') return 7 * 24 * 3600;
    if (r === 'M') return 30 * 24 * 3600;
    return Math.max(60, parseInt(r, 10) * 60 || 60);
  }

  // ----- Edge Function caller ----------------------------------
  // Always include the publishable key (Supabase Edge Functions
  // require a JWT by default; the auth.uid() callback the function
  // uses doesn't matter here — this is public market data).
  async function callFn(action, payload) {
    const auth = (global.TArenaDB && global.TArenaDB.auth)
      ? (await global.TArenaDB.auth.getSession()).data?.session?.access_token
      : null;
    const r = await fetch(FN_URL, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${auth || SUPABASE_PUBLISHABLE_KEY}`,
        'apikey':        SUPABASE_PUBLISHABLE_KEY,
        'content-type':  'application/json',
      },
      body: JSON.stringify(Object.assign({ action }, payload || {})),
    });
    if (!r.ok) throw new Error(`data-proxy ${r.status}`);
    return r.json();
  }

  // ----- Bars + quotes (used by everyone) ----------------------
  async function fetchBars(symbol, resolution, fromSec, toSec) {
    const j = await callFn('history', {
      symbol,
      resolution,
      from: fromSec,
      to:   toSec,
    });
    if (j.s !== 'ok') throw new Error(j.error || 'history failed');
    return j.bars || [];
  }

  async function fetchQuotes(symbols) {
    if (!symbols || !symbols.length) return {};
    const j = await callFn('quote', { symbols });
    if (j.s !== 'ok') throw new Error(j.error || 'quote failed');
    return j.quotes || {};
  }

  async function search(query, market) {
    const j = await callFn('search', { query, market });
    return j.results || [];
  }

  // ----- Live tick subscription --------------------------------
  // Returns an unsubscribe function.
  // Consumers receive a normalized {symbol, price, change, changePct, t}.
  const wsConnections = {}; // symbol → WebSocket (shared)
  const wsListeners   = {}; // symbol → Set<callback>

  function subscribeBinance(symbol, cb) {
    const sym = symbol.toUpperCase();
    const pair = binancePair(sym).toLowerCase();

    if (!wsListeners[sym]) wsListeners[sym] = new Set();
    wsListeners[sym].add(cb);

    if (!wsConnections[sym]) {
      const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@trade`);
      wsConnections[sym] = ws;
      ws.addEventListener('message', (ev) => {
        try {
          const d = JSON.parse(ev.data);
          const price = +d.p;
          if (!isFinite(price)) return;
          const tick = { symbol: sym, price, change: 0, changePct: 0, t: +d.T };
          (wsListeners[sym] || []).forEach(fn => { try { fn(tick); } catch (_) {} });
        } catch (_) {}
      });
      ws.addEventListener('close', () => {
        delete wsConnections[sym];
        // If listeners remain, reconnect after a beat.
        if (wsListeners[sym] && wsListeners[sym].size) {
          setTimeout(() => subscribeBinance(sym, () => {}), 2000);
        }
      });
    }

    return function unsubscribe() {
      if (wsListeners[sym]) {
        wsListeners[sym].delete(cb);
        if (!wsListeners[sym].size) {
          try { wsConnections[sym] && wsConnections[sym].close(); } catch (_) {}
          delete wsConnections[sym];
          delete wsListeners[sym];
        }
      }
    };
  }

  // Polled subscription for stocks.
  const pollListeners = {}; // symbol → Set<callback>
  let pollTimer = null;

  function ensurePollLoop() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const symbols = Object.keys(pollListeners);
      if (!symbols.length) { clearInterval(pollTimer); pollTimer = null; return; }
      try {
        const quotes = await fetchQuotes(symbols);
        for (const sym of symbols) {
          const q = quotes[sym];
          if (!q) continue;
          const tick = { symbol: sym, price: q.price, change: q.change, changePct: q.changePct, t: Date.now() };
          (pollListeners[sym] || []).forEach(fn => { try { fn(tick); } catch (_) {} });
        }
      } catch (e) {
        // Silent — next interval will retry.
        console.warn('quote poll failed', e.message);
      }
    }, 5000);
  }

  function subscribePoll(symbol, cb) {
    if (!pollListeners[symbol]) pollListeners[symbol] = new Set();
    pollListeners[symbol].add(cb);
    ensurePollLoop();
    // Fire one immediate fetch so the UI doesn't wait 5s for first paint.
    fetchQuotes([symbol]).then((q) => {
      if (q[symbol]) cb({ symbol, price: q[symbol].price, change: q[symbol].change, changePct: q[symbol].changePct, t: Date.now() });
    }).catch(() => {});
    return function unsubscribe() {
      if (pollListeners[symbol]) {
        pollListeners[symbol].delete(cb);
        if (!pollListeners[symbol].size) delete pollListeners[symbol];
      }
    };
  }

  function subscribeQuote(symbol, cb) {
    return classify(symbol) === 'crypto'
      ? subscribeBinance(symbol, cb)
      : subscribePoll(symbol, cb);
  }

  // ============================================================
  // TradingView UDF datafeed adapter
  // ============================================================
  // Implements the bits of the UDF spec that the Advanced Charts
  // library actually calls. See:
  // https://github.com/tradingview/charting_library/wiki/JS-Api
  // ============================================================
  function createUDF() {
    const subs = {}; // subscriberUID → { symbol, resolution, lastBar, unsubscribe }

    return {
      onReady(cb) {
        setTimeout(() => cb({
          supported_resolutions: ['1', '5', '15', '60', '240', 'D', 'W', 'M'],
          exchanges: [
            { value: '',       name: 'All exchanges', desc: '' },
            { value: 'ASX',    name: 'ASX',           desc: 'Australian Securities Exchange' },
            { value: 'US',     name: 'US',            desc: 'NASDAQ / NYSE' },
            { value: 'CRYPTO', name: 'Binance',       desc: 'Crypto' },
          ],
          symbols_types: [
            { name: 'All',    value: '' },
            { name: 'Stock',  value: 'stock' },
            { name: 'Crypto', value: 'crypto' },
          ],
          supports_marks: false,
          supports_timescale_marks: false,
          supports_time: true,
        }), 0);
      },

      searchSymbols(userInput, exchange, symbolType, onResult) {
        search(userInput, '').then((results) => {
          onResult(results.map(r => ({
            symbol:      r.symbol,
            full_name:   r.symbol,
            description: r.description,
            exchange:    r.exchange,
            ticker:      r.symbol,
            type:        r.type,
          })));
        }).catch(() => onResult([]));
      },

      resolveSymbol(symbolName, onResolve, onError) {
        const kind = classify(symbolName);
        const isCrypto = kind === 'crypto';
        setTimeout(() => onResolve({
          name:                  symbolName,
          ticker:                symbolName,
          description:           symbolName,
          type:                  isCrypto ? 'crypto' : 'stock',
          session:               '24x7',
          timezone:              'Australia/Sydney',
          exchange:              kind === 'asx' ? 'ASX' : kind === 'us' ? 'US' : 'Binance',
          listed_exchange:       kind === 'asx' ? 'ASX' : kind === 'us' ? 'US' : 'Binance',
          minmov:                1,
          pricescale:            isCrypto ? 100 : 100,
          has_intraday:          true,
          has_weekly_and_monthly: true,
          supported_resolutions: ['1', '5', '15', '60', '240', 'D', 'W', 'M'],
          volume_precision:      isCrypto ? 4 : 0,
          data_status:           'streaming',
        }), 0);
      },

      async getBars(symbolInfo, resolution, periodParams, onResult, onError) {
        const { from, to, firstDataRequest } = periodParams;
        try {
          const bars = await fetchBars(symbolInfo.name, resolution, from, to);
          if (!bars.length) {
            onResult([], { noData: true });
            return;
          }
          const formatted = bars.map(b => ({
            time:   b.t,           // ms
            open:   b.o,
            high:   b.h,
            low:    b.l,
            close:  b.c,
            volume: b.v,
          }));
          onResult(formatted, { noData: false });
          if (firstDataRequest) {
            // Stash last bar so subscribeBars can append into it.
            symbolInfo.__lastBar = formatted[formatted.length - 1];
          }
        } catch (e) {
          onError(String(e));
        }
      },

      subscribeBars(symbolInfo, resolution, onTick, subscriberUID, onReset) {
        const resSec = resolutionSeconds(resolution);
        const unsub = subscribeQuote(symbolInfo.name, (tick) => {
          const last = subs[subscriberUID]?.lastBar;
          const barTime = Math.floor(tick.t / 1000 / resSec) * resSec * 1000;
          if (last && last.time === barTime) {
            // Update the in-progress bar.
            last.high  = Math.max(last.high, tick.price);
            last.low   = Math.min(last.low,  tick.price);
            last.close = tick.price;
            onTick(last);
          } else {
            // Open a new bar.
            const bar = {
              time:   barTime,
              open:   last ? last.close : tick.price,
              high:   tick.price,
              low:    tick.price,
              close:  tick.price,
              volume: 0,
            };
            if (subs[subscriberUID]) subs[subscriberUID].lastBar = bar;
            onTick(bar);
          }
        });
        subs[subscriberUID] = { symbol: symbolInfo.name, resolution, lastBar: symbolInfo.__lastBar || null, unsubscribe: unsub };
      },

      unsubscribeBars(subscriberUID) {
        const s = subs[subscriberUID];
        if (s && typeof s.unsubscribe === 'function') s.unsubscribe();
        delete subs[subscriberUID];
      },
    };
  }

  // ============================================================
  // Save/load adapter for chart_layouts (used by Advanced Charts
  // library's `save_load_adapter` option). Falls back to no-op
  // if the user is not signed in.
  // ============================================================
  function createSaveLoadAdapter() {
    const db = global.TArenaDB;
    async function uid() {
      try { return (await db.auth.getSession()).data?.session?.user?.id || null; }
      catch (_) { return null; }
    }
    return {
      async getAllCharts() {
        const u = await uid(); if (!u) return [];
        const { data } = await db.from('chart_layouts')
          .select('id,name,symbol,resolution,updated_at')
          .eq('owner_id', u)
          .order('updated_at', { ascending: false });
        return (data || []).map(r => ({
          id:         r.id,
          name:       r.name,
          symbol:     r.symbol,
          resolution: r.resolution,
          timestamp:  Date.parse(r.updated_at) / 1000,
        }));
      },
      async removeChart(id) {
        const u = await uid(); if (!u) return;
        await db.from('chart_layouts').delete().eq('id', id).eq('owner_id', u);
      },
      async saveChart(payload) {
        const u = await uid(); if (!u) throw new Error('not signed in');
        const row = {
          owner_id:   u,
          name:       payload.name,
          symbol:     payload.symbol,
          resolution: payload.resolution,
          layout:     payload.content,
        };
        const { data, error } = await db.from('chart_layouts')
          .insert(row).select('id').single();
        if (error) throw error;
        return data.id;
      },
      async getChartContent(id) {
        const u = await uid(); if (!u) return '';
        const { data } = await db.from('chart_layouts')
          .select('layout').eq('id', id).eq('owner_id', u).single();
        return data ? data.layout : '';
      },
      // Drawing-template + study-template hooks intentionally stubbed.
      getAllStudyTemplates()  { return Promise.resolve([]); },
      removeStudyTemplate()   { return Promise.resolve(); },
      saveStudyTemplate()     { return Promise.resolve(); },
      getStudyTemplateContent() { return Promise.resolve(''); },
      getDrawingTemplates()   { return Promise.resolve([]); },
      loadDrawingTemplate()   { return Promise.resolve(''); },
      saveDrawingTemplate()   { return Promise.resolve(); },
      removeDrawingTemplate() { return Promise.resolve(); },
    };
  }

  // ----- expose ------------------------------------------------
  global.TArenaDatafeed = {
    classify,
    fetchBars,
    fetchQuotes,
    search,
    subscribeQuote,
    createUDF,
    createSaveLoadAdapter,
  };
})(window);
