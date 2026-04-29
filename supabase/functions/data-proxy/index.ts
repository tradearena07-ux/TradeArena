// ============================================================
// data-proxy — Supabase Edge Function (Deno)
// ============================================================
// Fans out market-data requests to free public providers and
// caches the resulting OHLCV bars in `public.price_bars` so
// repeated history requests (and bar-replay) don't re-hit the
// upstream APIs.
//
// Routing by symbol convention:
//   *.AX           → Yahoo Finance     (ASX equities)
//   <plain ticker> → Finnhub           (US equities; needs FINNHUB_API_KEY)
//   BTC/ETH/SOL/…  → Binance           (crypto, no key required)
//
// API (all POST, JSON body):
//   { action: "history", symbol, resolution, from, to }
//     → { s: "ok", bars: [{t,o,h,l,c,v}, …] }
//
//   { action: "quote",   symbols: ["BHP.AX","AAPL","BTC"] }
//     → { s: "ok", quotes: { "BHP.AX": {price, change, changePct}, … } }
//
//   { action: "search",  query, market? }
//     → { s: "ok", results: [{symbol, description, exchange, type}, …] }
//
// Deploy:
//   supabase functions deploy data-proxy
//   supabase secrets set FINNHUB_API_KEY=xxx
// ============================================================

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Service-role client used only for writing into price_bars cache.
const sb = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const CORS = {
  "access-control-allow-origin":  "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

// ----- helpers -----------------------------------------------------------

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number };

function classify(symbol: string): "asx" | "us" | "crypto" {
  const s = symbol.toUpperCase();
  if (s.endsWith(".AX")) return "asx";
  if (["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "LTC", "BNB", "AVAX", "MATIC"].includes(s)) return "crypto";
  return "us";
}

// Map a TradingView-style resolution ("1", "60", "D", …) to each provider.
function mapResolution(res: string, kind: "yahoo" | "finnhub" | "binance"): string {
  const r = res.toUpperCase();
  if (kind === "yahoo") {
    return ({ "1":"1m","5":"5m","15":"15m","30":"30m","60":"1h","240":"1h","D":"1d","W":"1wk","M":"1mo" } as any)[r] ?? "1d";
  }
  if (kind === "finnhub") {
    return ({ "1":"1","5":"5","15":"15","30":"30","60":"60","240":"60","D":"D","W":"W","M":"M" } as any)[r] ?? "D";
  }
  // binance
  return ({ "1":"1m","5":"5m","15":"15m","30":"30m","60":"1h","240":"4h","D":"1d","W":"1w","M":"1M" } as any)[r] ?? "1d";
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

// ----- providers ---------------------------------------------------------

async function fetchYahooHistory(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  const interval = mapResolution(resolution, "yahoo");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${fromSec}&period2=${toSec}`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 TradeArena" } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const j: any = await r.json();
  const result = j?.chart?.result?.[0];
  if (!result) return [];
  const ts: number[] = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  return ts.map((t, i) => ({
    t: t * 1000,
    o: +q.open?.[i],
    h: +q.high?.[i],
    l: +q.low?.[i],
    c: +q.close?.[i],
    v: +(q.volume?.[i] ?? 0),
  })).filter(b => isFinite(b.o) && isFinite(b.c));
}

async function fetchYahooQuote(symbol: string): Promise<{ price: number; change: number; changePct: number } | null> {
  // Use the chart endpoint with a 1-day range so we don't need Yahoo's authenticated quote API.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 TradeArena" } });
  if (!r.ok) return null;
  const j: any = await r.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = +meta.regularMarketPrice;
  const prev  = +meta.chartPreviousClose;
  if (!isFinite(price) || !isFinite(prev) || prev === 0) return null;
  const change    = price - prev;
  const changePct = (change / prev) * 100;
  return { price, change, changePct };
}

async function fetchFinnhubHistory(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  if (!FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY not configured");
  const r2 = mapResolution(resolution, "finnhub");
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${r2}&from=${fromSec}&to=${toSec}&token=${FINNHUB_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const j: any = await r.json();
  if (j.s !== "ok" || !Array.isArray(j.t)) return [];
  return j.t.map((t: number, i: number) => ({
    t: t * 1000,
    o: +j.o[i],
    h: +j.h[i],
    l: +j.l[i],
    c: +j.c[i],
    v: +(j.v?.[i] ?? 0),
  }));
}

async function fetchFinnhubQuote(symbol: string): Promise<{ price: number; change: number; changePct: number } | null> {
  if (!FINNHUB_API_KEY) return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j: any = await r.json();
  if (typeof j?.c !== "number" || j.c === 0) return null;
  return { price: j.c, change: j.d ?? 0, changePct: j.dp ?? 0 };
}

function binanceSymbol(base: string): string {
  return `${base.toUpperCase()}USDT`;
}

async function fetchBinanceHistory(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  const interval = mapResolution(resolution, "binance");
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol(symbol)}&interval=${interval}&startTime=${fromSec * 1000}&endTime=${toSec * 1000}&limit=1000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const j: any = await r.json();
  if (!Array.isArray(j)) return [];
  return j.map((row: any[]) => ({
    t: +row[0],
    o: +row[1],
    h: +row[2],
    l: +row[3],
    c: +row[4],
    v: +row[5],
  }));
}

async function fetchBinanceQuote(symbol: string): Promise<{ price: number; change: number; changePct: number } | null> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol(symbol)}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j: any = await r.json();
  const price = +j.lastPrice;
  const change = +j.priceChange;
  const changePct = +j.priceChangePercent;
  if (!isFinite(price)) return null;
  return { price, change, changePct };
}

// ----- cache -------------------------------------------------------------

async function writeCache(symbol: string, resolution: string, bars: Bar[]) {
  if (!sb || bars.length === 0) return;
  const rows = bars.map(b => ({
    symbol,
    resolution,
    t: new Date(b.t).toISOString(),
    o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    await sb.from("price_bars").upsert(slice, { onConflict: "symbol,resolution,t" });
  }
}

async function readCache(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  if (!sb) return [];
  const { data, error } = await sb
    .from("price_bars")
    .select("t,o,h,l,c,v")
    .eq("symbol", symbol)
    .eq("resolution", resolution)
    .gte("t", new Date(fromSec * 1000).toISOString())
    .lte("t", new Date(toSec   * 1000).toISOString())
    .order("t", { ascending: true })
    .limit(5000);
  if (error || !data) return [];
  return data.map((r: any) => ({
    t: Date.parse(r.t),
    o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v,
  }));
}

// How many seconds does each bar cover? Used to decide whether the
// cached bars are "fresh enough" relative to the requested `to` and
// whether to skip the upstream fetch entirely.
function resolutionSeconds(res: string): number {
  const r = res.toUpperCase();
  if (r === "D") return 86400;
  if (r === "W") return 86400 * 7;
  if (r === "M") return 86400 * 30;
  return Math.max(60, parseInt(r, 10) * 60 || 60);
}

// Merge two bar arrays by timestamp (later one wins on conflict),
// sort ascending. Used to splice fresh upstream bars into the
// cached set without losing either side.
function mergeBars(a: Bar[], b: Bar[]): Bar[] {
  const m = new Map<number, Bar>();
  for (const x of a) m.set(x.t, x);
  for (const x of b) m.set(x.t, x);
  return [...m.values()].sort((p, q) => p.t - q.t);
}

// ----- handlers ----------------------------------------------------------

async function handleHistory(body: any): Promise<Response> {
  const symbol     = String(body.symbol ?? "").trim();
  const resolution = String(body.resolution ?? "D").trim();
  const fromSec    = +body.from || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const toSec      = +body.to   || Math.floor(Date.now() / 1000);
  // The `force` flag is only used by internal callers that want to
  // explicitly bypass the cache (e.g. an admin "refresh" button).
  const force      = !!body.force;
  if (!symbol) return jsonResponse({ s: "error", error: "symbol required" }, 400);

  const kind = classify(symbol);

  // ----- Cache read --------------------------------------------------
  // Try to satisfy the request from `public.price_bars` first so the
  // bar-replay UI and repeated history loads don't re-hit upstream.
  const resSec  = resolutionSeconds(resolution);
  const cached  = force ? [] : await readCache(symbol, resolution, fromSec, toSec);
  const nowSec  = Math.floor(Date.now() / 1000);

  async function fetchUpstream(fromS: number, toS: number): Promise<Bar[]> {
    if (toS <= fromS) return [];
    if (kind === "asx")    return fetchYahooHistory(symbol, resolution, fromS, toS);
    if (kind === "us")     return fetchFinnhubHistory(symbol, resolution, fromS, toS);
    if (kind === "crypto") return fetchBinanceHistory(symbol, resolution, fromS, toS);
    return [];
  }

  // Identify head/tail gaps. The cache fully covers the request when
  // the earliest cached bar is at or before `from + 1 bar` AND the
  // latest cached bar is within one bar of the request's `to` (or now,
  // whichever is earlier). Otherwise we fetch only the missing window
  // on each side.
  const earliestCachedSec = cached.length ? Math.floor(cached[0].t / 1000)                  : null;
  const latestCachedSec   = cached.length ? Math.floor(cached[cached.length - 1].t / 1000)  : null;
  const targetEdge        = Math.min(toSec, nowSec) - resSec;

  const headCovered = earliestCachedSec !== null && earliestCachedSec <= fromSec + resSec;
  const tailCovered = latestCachedSec   !== null && latestCachedSec   >= targetEdge;

  if (cached.length >= 5 && headCovered && tailCovered) {
    // Cache fully satisfies the request — hot path for replay scrubbing.
    return jsonResponse({ s: "ok", bars: cached, cached: true });
  }

  // ----- Incremental upstream fetch ----------------------------------
  // Fill missing head and tail separately so back-scroll into older
  // history works even when the cache only holds the recent window.
  let head: Bar[] = [];
  let tail: Bar[] = [];
  try {
    if (cached.length === 0) {
      // Cold cache → single full-range fetch.
      tail = await fetchUpstream(fromSec, toSec);
    } else {
      if (!headCovered) head = await fetchUpstream(fromSec, earliestCachedSec! - 1);
      if (!tailCovered) tail = await fetchUpstream(latestCachedSec!,  toSec);
    }
  } catch (err) {
    // If we have any cached data, fall back to it rather than erroring out
    // — partial data beats no data when upstream is rate-limited.
    if (cached.length) {
      console.warn("upstream failed, serving cached", symbol, err);
      return jsonResponse({ s: "ok", bars: cached, cached: true, stale: true });
    }
    return jsonResponse({ s: "error", error: String(err) }, 502);
  }

  // Fire-and-forget write of the new upstream bars (both head and tail).
  const fresh = head.concat(tail);
  if (fresh.length) {
    writeCache(symbol, resolution, fresh).catch(e => console.error("writeCache", e));
  }

  const merged = mergeBars(cached, fresh);
  return jsonResponse({ s: "ok", bars: merged, cached: cached.length > 0 });
}

async function handleQuote(body: any): Promise<Response> {
  const symbols: string[] = Array.isArray(body.symbols) ? body.symbols.map((s: any) => String(s).trim()).filter(Boolean) : [];
  if (!symbols.length) return jsonResponse({ s: "error", error: "symbols required" }, 400);

  const out: Record<string, { price: number; change: number; changePct: number }> = {};
  await Promise.all(symbols.map(async (symbol) => {
    const kind = classify(symbol);
    try {
      let q = null;
      if (kind === "asx")    q = await fetchYahooQuote(symbol);
      if (kind === "us")     q = await fetchFinnhubQuote(symbol);
      if (kind === "crypto") q = await fetchBinanceQuote(symbol);
      if (q) out[symbol] = q;
    } catch (e) {
      console.warn("quote failed", symbol, e);
    }
  }));

  return jsonResponse({ s: "ok", quotes: out });
}

async function handleSearch(body: any): Promise<Response> {
  // Lightweight search — Finnhub for symbols, Binance for crypto. Yahoo's
  // search endpoint is unauthenticated but rate-limited; for ASX we just
  // pattern-match against a small static catalogue on the client.
  const query  = String(body.query ?? "").trim();
  const market = String(body.market ?? "").trim().toLowerCase();
  if (!query) return jsonResponse({ s: "ok", results: [] });

  const results: any[] = [];

  if ((!market || market === "us") && FINNHUB_API_KEY) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${FINNHUB_API_KEY}`);
      if (r.ok) {
        const j: any = await r.json();
        for (const row of (j.result ?? []).slice(0, 10)) {
          if (row.type !== "Common Stock") continue;
          if (row.symbol.includes(".")) continue;
          results.push({ symbol: row.symbol, description: row.description, exchange: "US", type: "stock" });
        }
      }
    } catch (_) { /* ignore */ }
  }

  if (!market || market === "crypto") {
    const upper = query.toUpperCase();
    for (const s of ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "BNB", "AVAX", "MATIC", "LTC"]) {
      if (s.startsWith(upper) || upper === s) {
        results.push({ symbol: s, description: `${s}/USDT`, exchange: "Binance", type: "crypto" });
      }
    }
  }

  return jsonResponse({ s: "ok", results });
}

// ----- entry -------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return jsonResponse({ s: "error", error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty body is fine */ }
  const action = String(body.action ?? "").toLowerCase();

  switch (action) {
    case "history": return handleHistory(body);
    case "quote":   return handleQuote(body);
    case "search":  return handleSearch(body);
    default:        return jsonResponse({ s: "error", error: `unknown action: ${action}` }, 400);
  }
});
