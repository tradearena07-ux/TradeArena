/**
 * TradeArena — Price Cache & Skeleton Loading Utility
 * assets/js/price-cache.js
 *
 * Provides:
 *  - Skeleton shimmer placeholders (never show $0.0000)
 *  - localStorage price caching (instant display on return visits)
 *  - Freshness indicator: ● Green (live <30s) | ● Amber (cached <5min) | ● Grey (loading)
 *
 * Usage:
 *   PriceCache.init()            — call on page load, restores cached prices
 *   PriceCache.save(prices)      — call after every price update
 *   PriceCache.setSkeleton(el)   — replace an element's content with shimmer
 *   PriceCache.setLiveStatus()   — set indicator to green "Live"
 *   PriceCache.setLoadingStatus()— set indicator to grey "Loading..."
 */

window.PriceCache = (function () {
  const STORAGE_KEY  = 'ta_prices';
  const MAX_AGE_MS   = 5 * 60 * 1000;  // 5 minutes
  const LIVE_AGE_MS  = 30 * 1000;      // 30 seconds = "live"

  // ── CSS injected once ──────────────────────────────────────────────
  const CSS = `
.skeleton {
  background: linear-gradient(
    90deg,
    rgba(201,160,48,0.05) 25%,
    rgba(201,160,48,0.12) 50%,
    rgba(201,160,48,0.05) 75%
  );
  background-size: 200% 100%;
  animation: ta-shimmer 1.4s infinite;
  border-radius: 4px;
  display: inline-block;
  min-width: 60px;
  height: 14px;
  vertical-align: middle;
  pointer-events: none;
  user-select: none;
}
.skeleton.sk-sm  { min-width: 40px;  height: 11px; }
.skeleton.sk-md  { min-width: 70px;  height: 14px; }
.skeleton.sk-lg  { min-width: 100px; height: 16px; }
.skeleton.sk-xl  { min-width: 140px; height: 22px; }
.skeleton.sk-chg { min-width: 50px;  height: 11px; }
@keyframes ta-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Freshness dot indicator */
.px-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--muted, #8899aa);
  transition: color .3s;
}
.px-status .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #8899aa;
  flex-shrink: 0;
  transition: background .3s;
}
.px-status.live   { color: #3ecf8e; }
.px-status.live   .dot { background: #3ecf8e; animation: livePulse 2s infinite; }
.px-status.recent { color: #f0a050; }
.px-status.recent .dot { background: #f0a050; }
.px-status.loading{ color: #8899aa; }
.px-status.loading .dot { background: #8899aa; }
`;

  function injectCSS() {
    if (document.getElementById('ta-skeleton-css')) return;
    const s = document.createElement('style');
    s.id = 'ta-skeleton-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Skeleton helpers ───────────────────────────────────────────────

  /** Replace element's innerHTML with a shimmer bar */
  function setSkeleton(el, sizeClass = 'sk-md') {
    if (!el) return;
    el.innerHTML = `<span class="skeleton ${sizeClass}"></span>`;
  }

  /** Replace element's text with '--' if it shows $0 or is empty */
  function guardZero(el) {
    if (!el) return;
    const t = el.textContent.trim();
    if (!t || t === '$0' || t === '$0.00' || t === '$0.0000' || t === '0' || t === '—') {
      setSkeleton(el);
    }
  }

  /** Apply skeleton to all elements matching selector */
  function skeletonAll(selector, sizeClass = 'sk-md') {
    document.querySelectorAll(selector).forEach(el => setSkeleton(el, sizeClass));
  }

  // ── localStorage cache ─────────────────────────────────────────────

  function save(prices) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        prices,
        timestamp: Date.now(),
      }));
    } catch (_) {}
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const { prices, timestamp } = JSON.parse(raw);
      const age = Date.now() - timestamp;
      if (age > MAX_AGE_MS) return null;
      return { prices, age };
    } catch (_) { return null; }
  }

  // ── Status indicator ───────────────────────────────────────────────

  /**
   * Find or create the status indicator element.
   * Looks for [data-px-status] in the DOM; creates one if not found.
   */
  function getStatusEl() {
    return document.querySelector('[data-px-status]');
  }

  function setStatus(state, label) {
    const el = getStatusEl();
    if (!el) return;
    el.className = 'px-status ' + state;
    el.innerHTML = `<span class="dot"></span>${label}`;
  }

  function setLiveStatus() {
    setStatus('live', 'Live');
  }

  function setRecentStatus(ageMs) {
    const mins = Math.round(ageMs / 60000);
    const label = mins < 1 ? 'Just now' : `${mins}m ago`;
    setStatus('recent', `Prices from ${label}`);
  }

  function setLoadingStatus() {
    setStatus('loading', 'Loading...');
  }

  // ── Formatted price helpers ────────────────────────────────────────

  function fmtMoney(v) {
    if (!v || !isFinite(v)) return null;
    if (v >= 1000) return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (v >= 1)    return '$' + v.toFixed(2);
    return '$' + v.toFixed(4);
  }

  function fmtPct(v) {
    if (v == null || !isFinite(v)) return null;
    const sign = v >= 0 ? '+' : '';
    return sign + v.toFixed(2) + '%';
  }

  // ── Public API ─────────────────────────────────────────────────────

  return {
    CSS,
    injectCSS,
    setSkeleton,
    guardZero,
    skeletonAll,
    save,
    load,
    setLiveStatus,
    setRecentStatus,
    setLoadingStatus,
    fmtMoney,
    fmtPct,
    LIVE_AGE_MS,
    MAX_AGE_MS,
  };
})();
