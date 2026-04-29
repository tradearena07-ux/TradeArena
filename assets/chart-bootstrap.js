// ============================================================
// TArenaChart — chart bootstrap with graceful fallback
// ============================================================
// Detection rules (run once at module load):
//   1. If `/charting_library/charting_library.js` HEAD's 200,
//      treat it as the licensed Advanced Charts library and
//      mount the full broker-grade widget.
//   2. Otherwise, lazy-load TradingView's MIT-licensed
//      Lightweight Charts library from CDN and render a
//      simpler-but-pro candle + EMA + Volume chart.
//
// Public API (returned by `mount()`):
//   chart.setSymbol(symbol, resolution?) → swap the active symbol
//   chart.takeSnapshot()                 → Promise<{symbol, resolution, drawings, png}>
//   chart.getDrawings()                  → drawing JSON (Advanced) | [] (fallback)
//   chart.destroy()                      → tear down
// ============================================================
(function (global) {
  'use strict';

  const ADV_PATH       = '/charting_library/charting_library.js';
  const LIGHTWEIGHT_JS = 'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js';

  let mode = null;  // 'advanced' | 'lightweight'
  let detectionPromise = null;

  // Theme constants — keep in sync with the navy/gold design tokens.
  const THEME = {
    bg:         '#0c1d36',
    bg2:        '#0f2547',
    grid:       'rgba(168,193,219,0.05)',
    text:       '#a8c1db',
    border:     'rgba(168,193,219,0.15)',
    upColor:    '#10b981',
    downColor:  '#dc2626',
    gold:       '#e8c060',
    ema20:      '#e8c060',
    ema50:      '#a8c1db',
    volume:     'rgba(168,193,219,0.35)',
  };

  // ----- Detect which library to use ---------------------------
  function detectLibrary() {
    if (detectionPromise) return detectionPromise;
    detectionPromise = (async () => {
      try {
        const r = await fetch(ADV_PATH, { method: 'HEAD' });
        if (r.ok) {
          await loadScript(ADV_PATH);
          if (global.TradingView && typeof global.TradingView.widget === 'function'
              && global.TradingView.widget.length /* Advanced library constructor takes 1 arg = options */) {
            mode = 'advanced';
            return mode;
          }
        }
      } catch (_) { /* fall through */ }
      await loadScript(LIGHTWEIGHT_JS);
      mode = 'lightweight';
      return mode;
    })();
    return detectionPromise;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      // Avoid double-loading.
      if ([...document.scripts].some(s => s.src === src || s.src.endsWith(src))) {
        return resolve();
      }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`failed to load ${src}`));
      document.head.appendChild(s);
    });
  }

  // ============================================================
  // Advanced Charts mount
  // ============================================================
  function mountAdvanced(containerId, symbol, resolution) {
    const widget = new global.TradingView.widget({
      container:                  containerId,
      library_path:               '/charting_library/',
      datafeed:                   global.TArenaDatafeed.createUDF(),
      symbol:                     symbol,
      interval:                   resolution || '60',
      timezone:                   'Australia/Sydney',
      locale:                     'en',
      theme:                      'Dark',
      autosize:                   true,
      fullscreen:                 false,
      enabled_features:           ['hide_left_toolbar_by_default', 'study_templates'],
      disabled_features:          ['use_localstorage_for_settings', 'header_symbol_search', 'header_compare'],
      charts_storage_api_version: '1.1',
      client_id:                  'tradearena.app',
      user_id:                    'public',
      save_load_adapter:          global.TArenaDatafeed.createSaveLoadAdapter(),
      load_last_chart:            false,
      overrides: {
        'paneProperties.background':              THEME.bg,
        'paneProperties.backgroundType':          'solid',
        'paneProperties.vertGridProperties.color': THEME.grid,
        'paneProperties.horzGridProperties.color': THEME.grid,
        'scalesProperties.textColor':             THEME.text,
        'scalesProperties.lineColor':             THEME.border,
        'mainSeriesProperties.candleStyle.upColor':         THEME.upColor,
        'mainSeriesProperties.candleStyle.downColor':       THEME.downColor,
        'mainSeriesProperties.candleStyle.borderUpColor':   THEME.upColor,
        'mainSeriesProperties.candleStyle.borderDownColor': THEME.downColor,
        'mainSeriesProperties.candleStyle.wickUpColor':     THEME.upColor,
        'mainSeriesProperties.candleStyle.wickDownColor':   THEME.downColor,
      },
      studies_overrides: {
        'volume.volume.color.0':                   THEME.downColor,
        'volume.volume.color.1':                   THEME.upColor,
        'moving average.plot.color':               THEME.gold,
        'moving average exponential.plot.color':   THEME.gold,
        'relative strength index.plot.color':      THEME.gold,
      },
    });

    widget.onChartReady(() => {
      const c = widget.activeChart();
      // Default studies: EMA20, EMA50, Volume, RSI(14).
      try { c.createStudy('Moving Average Exponential', false, false, [20], null, { 'plot.color': THEME.ema20 }); } catch (_) {}
      try { c.createStudy('Moving Average Exponential', false, false, [50], null, { 'plot.color': THEME.ema50 }); } catch (_) {}
      try { c.createStudy('Volume', false, false); } catch (_) {}
      try { c.createStudy('Relative Strength Index', false, false, [14]); } catch (_) {}

      // Inject a "Snap to reel" toolbar button.
      try {
        widget.headerReady().then(() => {
          const btn = widget.createButton();
          btn.setAttribute('title', 'Capture chart for a strategy reel');
          btn.classList.add('apply-common-tooltip');
          btn.innerHTML = '📸 Snap to reel';
          btn.addEventListener('click', () => snapAdvanced(widget));
        });
      } catch (_) { /* no headerReady in some library versions */ }
    });

    return {
      mode: 'advanced',
      _widget: widget,
      setSymbol(sym, res) {
        widget.activeChart().setSymbol(sym, res || widget.activeChart().resolution());
      },
      async takeSnapshot() {
        return snapAdvanced(widget);
      },
      getDrawings() {
        try {
          const c = widget.activeChart();
          return c.getAllShapes ? c.getAllShapes() : [];
        } catch (_) { return []; }
      },
      destroy() {
        try { widget.remove(); } catch (_) {}
      },
    };
  }

  // 10-minute TTL on the pending snap. The reel composer consumes
  // this through `TArenaChart.consumePendingSnap()` which validates
  // and auto-evicts expired entries.
  const SNAP_TTL_MS = 10 * 60 * 1000;

  function persistSnap(snap) {
    const payload = Object.assign({}, snap, {
      ts:        Date.now(),
      expiresAt: Date.now() + SNAP_TTL_MS,
    });
    localStorage.setItem('pending_chart_snap', JSON.stringify(payload));
    return payload;
  }

  async function snapAdvanced(widget) {
    const c = widget.activeChart();
    const symbol = c.symbol();
    const resolution = c.resolution();
    let drawings = [];
    try { drawings = c.getAllShapes ? c.getAllShapes() : []; } catch (_) {}
    let png = null;
    try {
      const canvas = await widget.takeClientScreenshot();
      png = canvas.toDataURL('image/png');
    } catch (e) {
      console.warn('takeClientScreenshot failed', e);
    }
    const snap = persistSnap({ symbol, resolution, drawings, png });
    flashToast('Chart captured — open the reel composer to attach it (expires in 10 min).');
    return snap;
  }

  // ============================================================
  // Lightweight Charts mount (fallback)
  // ============================================================
  function mountLightweight(containerId, symbol, resolution) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    container.style.position = 'relative';

    const chart = global.LightweightCharts.createChart(container, {
      layout: {
        background: { type: 'solid', color: THEME.bg },
        textColor:  THEME.text,
        fontFamily: "'DM Sans', sans-serif",
      },
      grid: {
        vertLines: { color: THEME.grid },
        horzLines: { color: THEME.grid },
      },
      rightPriceScale: { borderColor: THEME.border },
      timeScale:       { borderColor: THEME.border, timeVisible: true, secondsVisible: false },
      crosshair:       { mode: 1 },
      autoSize:        true,
    });

    const candle = chart.addCandlestickSeries({
      upColor:           THEME.upColor,
      downColor:         THEME.downColor,
      borderUpColor:     THEME.upColor,
      borderDownColor:   THEME.downColor,
      wickUpColor:       THEME.upColor,
      wickDownColor:     THEME.downColor,
    });

    const ema20 = chart.addLineSeries({ color: THEME.ema20, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const ema50 = chart.addLineSeries({ color: THEME.ema50, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });

    const volume = chart.addHistogramSeries({
      color:        THEME.volume,
      priceFormat:  { type: 'volume' },
      priceScaleId: '',
    });
    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    // Toolbar (timeframe + snap-to-reel).
    const toolbar = renderLightweightToolbar(container);

    // State bound to the chart.
    let state = {
      symbol:     symbol,
      resolution: resolution || '60',
      bars:       [],
      unsubLive:  null,
    };

    function ema(period, source) {
      const out = [];
      const k = 2 / (period + 1);
      let prev = null;
      for (let i = 0; i < source.length; i++) {
        const v = source[i].close;
        if (i < period - 1) { out.push(null); continue; }
        if (prev === null) {
          let sum = 0;
          for (let j = 0; j < period; j++) sum += source[j].close;
          prev = sum / period;
          out.push(prev);
          continue;
        }
        prev = v * k + prev * (1 - k);
        out.push(prev);
      }
      return source.map((b, i) => out[i] == null ? null : { time: b.time, value: out[i] }).filter(Boolean);
    }

    function applyBars(bars) {
      state.bars = bars.map(b => ({
        time:   Math.floor(b.t / 1000),
        open:   b.o,
        high:   b.h,
        low:    b.l,
        close:  b.c,
        value:  b.v,
        color:  b.c >= b.o ? 'rgba(16,185,129,0.4)' : 'rgba(220,38,38,0.4)',
      }));
      candle.setData(state.bars);
      ema20.setData(ema(20, state.bars));
      ema50.setData(ema(50, state.bars));
      volume.setData(state.bars.map(b => ({ time: b.time, value: b.value, color: b.color })));
      chart.timeScale().fitContent();
    }

    async function loadHistory() {
      const resSec = resolutionForSeconds(state.resolution);
      const lookback = resSec <= 300 ? 86400 * 2          // 2d for 1m/5m
                    : resSec <= 3600 ? 86400 * 30         // 30d for 15m/1h
                    : resSec <= 14400 ? 86400 * 120       // 120d for 4h
                    : 86400 * 365 * 2;                    // 2y for D/W/M
      const to = Math.floor(Date.now() / 1000);
      const from = to - lookback;
      try {
        const bars = await global.TArenaDatafeed.fetchBars(state.symbol, state.resolution, from, to);
        applyBars(bars);
      } catch (e) {
        console.warn('history failed', e);
        renderError(container, `Couldn't load chart history: ${e.message}`);
      }
    }

    function startLive() {
      if (state.unsubLive) { state.unsubLive(); state.unsubLive = null; }
      const resSec = resolutionForSeconds(state.resolution);
      state.unsubLive = global.TArenaDatafeed.subscribeQuote(state.symbol, (tick) => {
        if (!state.bars.length) return;
        const last = state.bars[state.bars.length - 1];
        const barTime = Math.floor(tick.t / 1000 / resSec) * resSec;
        if (barTime === last.time) {
          last.high = Math.max(last.high, tick.price);
          last.low  = Math.min(last.low,  tick.price);
          last.close = tick.price;
          candle.update(last);
        } else if (barTime > last.time) {
          const bar = { time: barTime, open: last.close, high: tick.price, low: tick.price, close: tick.price, value: 0 };
          state.bars.push(bar);
          candle.update(bar);
        }
      });
    }

    // Toolbar interactions.
    toolbar.onResolution = (res) => {
      state.resolution = res;
      loadHistory().then(startLive);
    };
    toolbar.onSnap = async () => {
      const png = await captureLightweight(container);
      persistSnap({ symbol: state.symbol, resolution: state.resolution, drawings: [], png });
      flashToast('Chart captured — open the reel composer to attach it (expires in 10 min).');
    };

    loadHistory().then(startLive);

    return {
      mode: 'lightweight',
      _chart: chart,
      setSymbol(sym, res) {
        state.symbol = sym;
        if (res) state.resolution = res;
        loadHistory().then(startLive);
      },
      async takeSnapshot() {
        const png = await captureLightweight(container);
        return persistSnap({ symbol: state.symbol, resolution: state.resolution, drawings: [], png });
      },
      getDrawings() { return []; },
      destroy() {
        try { if (state.unsubLive) state.unsubLive(); } catch (_) {}
        try { chart.remove(); } catch (_) {}
      },
    };
  }

  function resolutionForSeconds(res) {
    const r = String(res).toUpperCase();
    if (r === 'D') return 86400;
    if (r === 'W') return 86400 * 7;
    if (r === 'M') return 86400 * 30;
    return Math.max(60, parseInt(r, 10) * 60 || 60);
  }

  function renderLightweightToolbar(container) {
    const bar = document.createElement('div');
    bar.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;display:flex;gap:6px;align-items:center;z-index:5;pointer-events:none;';
    bar.innerHTML = `
      <div style="display:flex;gap:4px;background:rgba(15,37,71,0.85);border:1px solid rgba(168,193,219,0.15);border-radius:8px;padding:4px;pointer-events:auto;">
        ${['1','5','15','60','240','D','W'].map(r => `<button data-r="${r}" style="background:transparent;border:none;color:#a8c1db;font:600 11px 'DM Sans',sans-serif;padding:4px 10px;border-radius:5px;cursor:pointer;letter-spacing:.04em;">${r === 'D' ? '1D' : r === 'W' ? '1W' : (parseInt(r,10) >= 60 ? (parseInt(r,10)/60)+'h' : r+'m')}</button>`).join('')}
      </div>
      <div style="margin-left:auto;pointer-events:auto;">
        <button id="snapBtn" style="background:rgba(232,192,96,0.12);border:1px solid rgba(232,192,96,0.4);color:#e8c060;font:700 11px 'DM Sans',sans-serif;padding:6px 12px;border-radius:8px;cursor:pointer;letter-spacing:.04em;">📸 Snap to reel</button>
      </div>
      <div style="position:absolute;bottom:-22px;right:0;font:500 10px 'DM Sans',sans-serif;color:#a8c1db;opacity:0.6;letter-spacing:.06em;text-transform:uppercase;pointer-events:none;">Lightweight Charts · install Advanced library to unlock replay + drawings</div>`;
    container.appendChild(bar);

    const api = { onResolution: () => {}, onSnap: () => {} };
    let activeRes = '60';
    bar.querySelectorAll('button[data-r]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeRes = btn.dataset.r;
        bar.querySelectorAll('button[data-r]').forEach(b => {
          const on = b === btn;
          b.style.background = on ? 'rgba(232,192,96,0.15)' : 'transparent';
          b.style.color      = on ? '#e8c060' : '#a8c1db';
        });
        api.onResolution(activeRes);
      });
      if (btn.dataset.r === '60') btn.click();
    });
    bar.querySelector('#snapBtn').addEventListener('click', () => api.onSnap());

    return api;
  }

  // Lightweight Charts has no built-in screenshot; rasterize the
  // canvas ourselves. Walks every <canvas> inside the container
  // and composites them onto a single output canvas.
  async function captureLightweight(container) {
    const canvases = container.querySelectorAll('canvas');
    if (!canvases.length) return null;
    const w = container.clientWidth;
    const h = container.clientHeight;
    const out = document.createElement('canvas');
    out.width  = w;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = THEME.bg;
    ctx.fillRect(0, 0, w, h);
    canvases.forEach((c) => {
      const rect = c.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      ctx.drawImage(c, rect.left - cRect.left, rect.top - cRect.top, c.width, c.height);
    });
    return out.toDataURL('image/png');
  }

  function renderError(container, message) {
    container.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center;color:#a8c1db;font-family:'DM Sans',sans-serif;">
      <div>
        <div style="font-size:32px;margin-bottom:12px;opacity:0.6;">📉</div>
        <div style="font-weight:700;color:#fff;margin-bottom:6px;">${message}</div>
        <div style="font-size:12px;opacity:0.7;">Make sure the data-proxy edge function is deployed and FINNHUB_API_KEY is set.</div>
      </div>
    </div>`;
  }

  function flashToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(15,37,71,0.95);border:1px solid rgba(232,192,96,0.4);color:#e8c060;font:600 13px "DM Sans",sans-serif;padding:12px 20px;border-radius:10px;z-index:9999;box-shadow:0 12px 36px rgba(0,0,0,.5);';
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2400);
    setTimeout(() => t.remove(), 2800);
  }

  // ============================================================
  // Public mount
  // ============================================================
  async function mount(containerId, symbol, resolution) {
    // Opportunistically evict any expired snap on every chart mount
    // so stale captures don't leak into a brand-new session.
    consumePendingSnap({ peek: true });
    await detectLibrary();
    if (mode === 'advanced')   return mountAdvanced(containerId, symbol, resolution);
    /* lightweight */          return mountLightweight(containerId, symbol, resolution);
  }

  // ============================================================
  // Pending-snap consumer API
  // ============================================================
  // The reel composer (Task #5) calls `consumePendingSnap()` to
  // grab the most recent capture and clear it. With `{peek: true}`
  // the snap is returned without being removed (used internally to
  // auto-evict expired entries on chart mount).
  // Returns null when no valid snap is present.
  // ============================================================
  function consumePendingSnap(opts) {
    const peek = !!(opts && opts.peek);
    let raw;
    try { raw = localStorage.getItem('pending_chart_snap'); }
    catch (_) { return null; }
    if (!raw) return null;
    let snap;
    try { snap = JSON.parse(raw); }
    catch (_) { localStorage.removeItem('pending_chart_snap'); return null; }
    // Backfill expiresAt for any pre-TTL snap left behind by an
    // older build of this file.
    if (typeof snap.expiresAt !== 'number') {
      snap.expiresAt = (snap.ts || 0) + SNAP_TTL_MS;
    }
    if (Date.now() > snap.expiresAt) {
      localStorage.removeItem('pending_chart_snap');
      return null;
    }
    if (!peek) localStorage.removeItem('pending_chart_snap');
    return snap;
  }

  global.TArenaChart = { mount, getMode: () => mode, consumePendingSnap };
})(window);
