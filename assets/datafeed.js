// TArenaDatafeed — market data layer used by the chart, watchlist,
// symbol header and order panel. Crypto ticks come from Binance WS,
// stock ticks are polled from the data-proxy edge function every 5s.
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

  // Live tick subscription. Consumers receive {symbol, price, change, changePct, t}.
  const wsConnections = {}; // symbol → WebSocket
  const wsListeners   = {}; // symbol → Set<callback>
  // Cached 24h percent change per crypto symbol, refreshed periodically
  // from the Binance ticker via the data-proxy. The trade-stream emits
  // this value alongside each tick so consumers don't see a flat 0%
  // change for crypto pairs.
  const crypto24h     = {}; // symbol → { changePct, change, ts }
  const crypto24hTimers = {}; // symbol → interval id

  function refreshCrypto24h(sym) {
    fetchQuotes([sym]).then((q) => {
      const v = q[sym];
      if (!v) return;
      crypto24h[sym] = {
        changePct: v.changePct || 0,
        change:    v.change    || 0,
        ts:        Date.now(),
      };
    }).catch((e) => console.warn('crypto 24h refresh failed', sym, e.message));
  }

  // Open (or re-open) the Binance trade stream for `sym`. Listeners in
  // wsListeners[sym] are preserved across reconnects; this function only
  // touches wsConnections so reconnect doesn't accumulate phantom callbacks.
  function openBinanceSocket(sym) {
    const pair = binancePair(sym).toLowerCase();
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${pair}@trade`);
    wsConnections[sym] = ws;

    ws.addEventListener('message', (ev) => {
      const d = JSON.parse(ev.data);
      const price = +d.p;
      if (!isFinite(price)) return;
      const meta = crypto24h[sym] || { change: 0, changePct: 0 };
      const tick = {
        symbol:    sym,
        price,
        change:    meta.change    || 0,
        changePct: meta.changePct || 0,
        t:         +d.T,
      };
      const set = wsListeners[sym];
      if (set) set.forEach(fn => fn(tick));
    });

    ws.addEventListener('close', () => {
      // Only clear if we're still the registered socket — guards against
      // a manual close() racing with an upstream-initiated close.
      if (wsConnections[sym] === ws) delete wsConnections[sym];
      // Reconnect only if there are still listeners that want ticks.
      if (wsListeners[sym] && wsListeners[sym].size) {
        setTimeout(() => {
          if (wsListeners[sym] && wsListeners[sym].size && !wsConnections[sym]) {
            openBinanceSocket(sym);
          }
        }, 2000);
      }
    });
  }

  function subscribeBinance(symbol, cb) {
    const sym = symbol.toUpperCase();
    if (!wsListeners[sym]) wsListeners[sym] = new Set();
    wsListeners[sym].add(cb);
    if (!wsConnections[sym]) openBinanceSocket(sym);
    // Prime + periodically refresh 24h percent change so the trade
    // stream can emit a realistic changePct.
    if (!crypto24hTimers[sym]) {
      refreshCrypto24h(sym);
      crypto24hTimers[sym] = setInterval(() => refreshCrypto24h(sym), 30000);
    }

    return function unsubscribe() {
      const set = wsListeners[sym];
      if (!set) return;
      set.delete(cb);
      if (!set.size) {
        if (wsConnections[sym]) wsConnections[sym].close();
        delete wsConnections[sym];
        delete wsListeners[sym];
        if (crypto24hTimers[sym]) {
          clearInterval(crypto24hTimers[sym]);
          delete crypto24hTimers[sym];
          delete crypto24h[sym];
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
      let quotes;
      try { quotes = await fetchQuotes(symbols); }
      catch (e) { console.warn('quote poll failed', e.message); return; }
      for (const sym of symbols) {
        const q = quotes[sym];
        if (!q) continue;
        const tick = { symbol: sym, price: q.price, change: q.change, changePct: q.changePct, t: Date.now() };
        const set = pollListeners[sym];
        if (set) set.forEach(fn => fn(tick));
      }
    }, 5000);
  }

  function subscribePoll(symbol, cb) {
    if (!pollListeners[symbol]) pollListeners[symbol] = new Set();
    pollListeners[symbol].add(cb);
    ensurePollLoop();
    // Prime with one immediate fetch so the UI doesn't wait 5s for first paint.
    fetchQuotes([symbol]).then((q) => {
      if (q[symbol]) cb({ symbol, price: q[symbol].price, change: q[symbol].change, changePct: q[symbol].changePct, t: Date.now() });
    }).catch((e) => console.warn('quote prime failed', symbol, e.message));
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

  // UDF datafeed adapter for the TradingView Advanced Charts library.
  // Implements only the methods the library actually calls; spec at
  // https://github.com/tradingview/charting_library/wiki/JS-Api
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
        // Translate the Advanced Charts exchange/symbolType filter into a
        // proxy "market" hint so the upstream search returns relevant rows
        // (rather than every Common Stock match across providers).
        const exch = String(exchange || '').toUpperCase();
        const stype = String(symbolType || '').toLowerCase();
        let market = '';
        if (exch === 'ASX')                    market = 'asx';
        else if (exch === 'US' || exch === 'NASDAQ' || exch === 'NYSE') market = 'us';
        else if (exch === 'BINANCE')           market = 'crypto';
        else if (stype === 'crypto')           market = 'crypto';
        else if (stype === 'stock')            market = 'us';

        search(userInput, market).then((results) => {
          let rows = results;
          // Defense-in-depth: filter again client-side in case the proxy
          // returns rows from another market.
          if (exch && exch !== '') {
            rows = rows.filter(r => String(r.exchange || '').toUpperCase() === exch
              || (exch === 'US' && (r.exchange === 'US' || r.exchange === 'NASDAQ' || r.exchange === 'NYSE'))
              || (exch === 'BINANCE' && r.type === 'crypto'));
          }
          if (stype) {
            rows = rows.filter(r => String(r.type || '').toLowerCase() === stype);
          }
          onResult(rows.map(r => ({
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

  // Save/load adapter for the Advanced Charts library's `save_load_adapter`
  // option. Persists to public.chart_layouts scoped to the signed-in user;
  // returns empty results when no user is present.
  function createSaveLoadAdapter() {
    const db = global.TArenaDB;
    async function uid() {
      const r = await db.auth.getSession();
      return r.data?.session?.user?.id || null;
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
