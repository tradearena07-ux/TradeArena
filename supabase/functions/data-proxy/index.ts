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

async function cacheBars(symbol: string, resolution: string, bars: Bar[]) {
  if (!sb || bars.length === 0) return;
  const rows = bars.map(b => ({
    symbol,
    resolution,
    t: new Date(b.t).toISOString(),
    o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
  }));
  // Upsert in batches of 500.
  for (let i = 0; i < rows.length; i += 500) {
    const slice = rows.slice(i, i + 500);
    await sb.from("price_bars").upsert(slice, { onConflict: "symbol,resolution,t" });
  }
}

// ----- handlers ----------------------------------------------------------

async function handleHistory(body: any): Promise<Response> {
  const symbol     = String(body.symbol ?? "").trim();
  const resolution = String(body.resolution ?? "D").trim();
  const fromSec    = +body.from || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const toSec      = +body.to   || Math.floor(Date.now() / 1000);
  if (!symbol) return jsonResponse({ s: "error", error: "symbol required" }, 400);

  const kind = classify(symbol);
  let bars: Bar[] = [];
  try {
    if (kind === "asx")    bars = await fetchYahooHistory(symbol, resolution, fromSec, toSec);
    if (kind === "us")     bars = await fetchFinnhubHistory(symbol, resolution, fromSec, toSec);
    if (kind === "crypto") bars = await fetchBinanceHistory(symbol, resolution, fromSec, toSec);
  } catch (err) {
    return jsonResponse({ s: "error", error: String(err) }, 502);
  }

  // Fire-and-forget cache write so the client doesn't wait on it.
  cacheBars(symbol, resolution, bars).catch(e => console.error("cacheBars", e));

  return jsonResponse({ s: "ok", bars });
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
