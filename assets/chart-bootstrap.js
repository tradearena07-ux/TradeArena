// TArenaChart — chart bootstrap. Mounts the licensed Advanced Charts
// library if /charting_library/charting_library.js is installed, and
// otherwise lazy-loads TradingView's MIT-licensed Lightweight Charts
// from CDN and renders a navy/gold candle + EMA + Volume chart.
// mount() returns {setSymbol, takeSnapshot, getDrawings, destroy}.
(function (global) {
  'use strict';

  const ADV_PATH = '/charting_library/charting_library.js';
  // Lightweight Charts CDN sources, tried in order. unpkg is primary;
  // jsdelivr is the fallback if unpkg is blocked or unreachable.
  const LIGHTWEIGHT_CDNS = [
    'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js',
    'https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js',
  ];

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

  function detectLibrary() {
    if (detectionPromise) return detectionPromise;
    detectionPromise = (async () => {
      // Probe the licensed library. We try HEAD first, then GET if the
      // server returned 405 (some static hosts disallow HEAD on assets).
      // A 404 from either is the normal "not installed yet" path.
      let advancedPresent = false;
      try {
        let r = await fetch(ADV_PATH, { method: 'HEAD' });
        if (r.status === 405) r = await fetch(ADV_PATH, { method: 'GET', headers: { range: 'bytes=0-0' } });
        advancedPresent = r.ok;
      } catch (_) { /* network error → fall back */ }

      if (advancedPresent) {
        await loadScript(ADV_PATH);
        if (global.TradingView && typeof global.TradingView.widget === 'function') {
          mode = 'advanced';
          return mode;
        }
      }
      await loadScriptWithFallback(LIGHTWEIGHT_CDNS);
      mode = 'lightweight';
      return mode;
    })();
    return detectionPromise;
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
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

  // Try a list of script URLs in order; resolve on the first success.
  async function loadScriptWithFallback(urls) {
    let lastErr = null;
    for (const url of urls) {
      try { await loadScript(url); return; }
      catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('all script sources failed');
  }

  // ----- Advanced Charts mount ----------------------------------
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
      // `chart_property_page_trading` keeps the trading tab in chart
      // settings; replay is enabled by default in the Advanced bundle
      // and remains available because we don't add it to disabled_features.
      enabled_features:           ['study_templates', 'chart_property_page_trading'],
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
      // Default studies: EMA20, EMA50, Volume, RSI(14). Library can throw
      // here if a study isn't bundled in this build, so we log and continue.
      const studies = [
        ['Moving Average Exponential', [20], { 'plot.color': THEME.ema20 }],
        ['Moving Average Exponential', [50], { 'plot.color': THEME.ema50 }],
        ['Volume',                     [],   null],
        ['Relative Strength Index',    [14], null],
      ];
      for (const [name, inputs, overrides] of studies) {
        try { c.createStudy(name, false, false, inputs, null, overrides || undefined); }
        catch (e) { console.warn('createStudy failed', name, e); }
      }

      if (typeof widget.headerReady === 'function') {
        widget.headerReady().then(() => {
          const btn = widget.createButton();
          btn.setAttribute('title', 'Capture chart for a strategy reel');
          btn.classList.add('apply-common-tooltip');
          btn.innerHTML = '📸 Snap to reel';
          btn.addEventListener('click', () => snapAdvanced(widget));
        }, (e) => console.warn('headerReady rejected', e));
      }
    });

    return {
      mode: 'advanced',
      _widget: widget,
      setSymbol(sym, res) {
        widget.activeChart().setSymbol(sym, res || widget.activeChart().resolution());
      },
      takeSnapshot() { return snapAdvanced(widget); },
      getDrawings() {
        return serializeDrawings(widget.activeChart());
      },
      destroy() { widget.remove(); },
    };
  }

  // 10-minute TTL on the pending snap; reel composer reads via
  // TArenaChart.consumePendingSnap() which validates and evicts.
  const SNAP_TTL_MS = 10 * 60 * 1000;

  // Snap payload shape matches the task contract:
  //   { symbol, interval, drawings, png_dataurl }
  // plus the TTL bookkeeping fields ts / expiresAt.
  function persistSnap(snap) {
    const payload = {
      symbol:      snap.symbol,
      interval:    snap.interval,
      drawings:    snap.drawings || [],
      png_dataurl: snap.png_dataurl || null,
      ts:          Date.now(),
      expiresAt:   Date.now() + SNAP_TTL_MS,
    };
    localStorage.setItem('pending_chart_snap', JSON.stringify(payload));
    return payload;
  }

  // Serialize the chart's drawing tools into a structure the reel
  // composer can replay. Different Advanced Charts versions expose
  // different APIs:
  //   - `chart.exportShapes()` returns fully-serialized shape state
  //     (preferred when present).
  //   - Older bundles only expose `chart.getAllShapes()` which yields
  //     `{id, name}` records; we walk each id with `getShapeById()` and
  //     pull `getProperties()` + `getPoints()` so the persisted snap
  //     carries enough information to reconstruct the drawing.
  function serializeDrawings(c) {
    if (!c) return [];
    if (typeof c.exportShapes === "function") {
      try { return c.exportShapes() || []; } catch (_) { /* fall through */ }
    }
    if (typeof c.getAllShapes !== "function") return [];
    const ids = c.getAllShapes() || [];
    const out = [];
    for (const meta of ids) {
      const id = meta && meta.id;
      if (!id) continue;
      const shape = (typeof c.getShapeById === "function") ? c.getShapeById(id) : null;
      let properties = null, points = null;
      try { properties = shape && shape.getProperties && shape.getProperties(); } catch (_) {}
      try { points     = shape && shape.getPoints     && shape.getPoints();     } catch (_) {}
      out.push({ id, name: meta.name, properties, points });
    }
    return out;
  }

  async function snapAdvanced(widget) {
    const c = widget.activeChart();
    const symbol = c.symbol();
    const interval = c.resolution();
    const drawings = serializeDrawings(c);
    let png_dataurl = null;
    try {
      const canvas = await widget.takeClientScreenshot();
      png_dataurl = canvas.toDataURL('image/png');
    } catch (e) {
      // Screenshot can legitimately fail (cross-origin canvas, library
      // version mismatch). Save the snap without the image rather than
      // dropping the whole capture.
      console.warn('takeClientScreenshot failed', e);
    }
    const snap = persistSnap({ symbol, interval, drawings, png_dataurl });
    flashToast('Chart captured — open the reel composer to attach it (expires in 10 min).');
    return snap;
  }

  // ----- Lightweight Charts mount (fallback) ---------------------
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

    // Incremental EMA state so we can update each indicator on every
    // tick rather than recomputing the whole series.
    state.ema = { v20: null, v50: null };

    function emaSeries(period, source) {
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
      return { values: out, last: prev };
    }

    function nextEma(prev, period, value) {
      if (prev == null) return value;
      const k = 2 / (period + 1);
      return value * k + prev * (1 - k);
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
      const e20 = emaSeries(20, state.bars);
      const e50 = emaSeries(50, state.bars);
      ema20.setData(state.bars.map((b, i) => e20.values[i] == null ? null : { time: b.time, value: e20.values[i] }).filter(Boolean));
      ema50.setData(state.bars.map((b, i) => e50.values[i] == null ? null : { time: b.time, value: e50.values[i] }).filter(Boolean));
      state.ema.v20 = e20.last;
      state.ema.v50 = e50.last;
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
        let mutated = null;
        let isNewBar = false;
        if (barTime === last.time) {
          last.high  = Math.max(last.high, tick.price);
          last.low   = Math.min(last.low,  tick.price);
          last.close = tick.price;
          last.color = last.close >= last.open
            ? 'rgba(16,185,129,0.4)' : 'rgba(220,38,38,0.4)';
          candle.update(last);
          mutated = last;
        } else if (barTime > last.time) {
          // Bucket roll → carry the just-closed bar's EMA into the
          // running state before opening the new one so the next
          // EMA tick is computed off the prior close.
          state.ema.v20 = nextEma(state.ema.v20, 20, last.close);
          state.ema.v50 = nextEma(state.ema.v50, 50, last.close);
          const bar = {
            time:  barTime, open: last.close,
            high:  tick.price, low: tick.price, close: tick.price,
            value: 0,
            color: tick.price >= last.close
              ? 'rgba(16,185,129,0.4)' : 'rgba(220,38,38,0.4)',
          };
          state.bars.push(bar);
          candle.update(bar);
          mutated = bar;
          isNewBar = true;
        }
        if (mutated) {
          // Update EMA lines incrementally — the standard EMA recurrence
          // applied to the running last-EMA value gives a per-tick update
          // for the active bar (and a fresh seed when a new bar opens).
          const v20 = nextEma(state.ema.v20, 20, mutated.close);
          const v50 = nextEma(state.ema.v50, 50, mutated.close);
          ema20.update({ time: mutated.time, value: v20 });
          ema50.update({ time: mutated.time, value: v50 });
          // Volume can't be derived from a quote tick, but we still
          // need the histogram bar to exist with the right colour.
          volume.update({ time: mutated.time, value: mutated.value, color: mutated.color });
        }
        void isNewBar;
      });
    }

    // Toolbar interactions.
    toolbar.onResolution = (res) => {
      state.resolution = res;
      loadHistory().then(startLive);
    };
    toolbar.onSnap = async () => {
      const png_dataurl = await captureLightweight(container);
      persistSnap({ symbol: state.symbol, interval: state.resolution, drawings: [], png_dataurl });
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
        const png_dataurl = await captureLightweight(container);
        return persistSnap({ symbol: state.symbol, interval: state.resolution, drawings: [], png_dataurl });
      },
      getDrawings() { return []; },
      destroy() {
        if (state.unsubLive) state.unsubLive();
        chart.remove();
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
        ${['1','5','15','60','240','D','W','M'].map(r => `<button data-r="${r}" style="background:transparent;border:none;color:#a8c1db;font:600 11px 'DM Sans',sans-serif;padding:4px 10px;border-radius:5px;cursor:pointer;letter-spacing:.04em;">${r === 'D' ? '1D' : r === 'W' ? '1W' : r === 'M' ? '1M' : (parseInt(r,10) >= 60 ? (parseInt(r,10)/60)+'h' : r+'m')}</button>`).join('')}
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

  async function mount(containerId, symbol, resolution) {
    // Opportunistically evict an expired snap so stale captures
    // don't leak into a brand-new session.
    consumePendingSnap({ peek: true });
    await detectLibrary();
    return mode === 'advanced'
      ? mountAdvanced(containerId, symbol, resolution)
      : mountLightweight(containerId, symbol, resolution);
  }

  // Reel composer (Task #5) uses this to grab the most recent capture
  // and clear it. With {peek:true} the snap is returned without being
  // removed (used internally to evict expired entries). Returns null
  // when no valid (non-expired) snap is present.
  function consumePendingSnap(opts) {
    const peek = !!(opts && opts.peek);
    const raw = localStorage.getItem('pending_chart_snap');
    if (!raw) return null;
    let snap;
    try { snap = JSON.parse(raw); }
    catch (e) {
      console.warn('pending_chart_snap was not valid JSON; clearing', e);
      localStorage.removeItem('pending_chart_snap');
      return null;
    }
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
