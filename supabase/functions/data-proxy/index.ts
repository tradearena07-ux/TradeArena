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

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const FINNHUB_API_KEY = Deno.env.get("FINNHUB_API_KEY") ?? "";
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Service-role client used only for writing into price_bars cache.
const sb: SupabaseClient | null = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })
  : null;

const CORS: Record<string, string> = {
  "access-control-allow-origin":  "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

// ----- types -------------------------------------------------------------

type Bar    = { t: number; o: number; h: number; l: number; c: number; v: number };
type Quote  = { price: number; change: number; changePct: number };
type Kind   = "asx" | "us" | "crypto";
type ProviderKind = "yahoo" | "finnhub" | "binance";

type SearchResult = {
  symbol:      string;
  description: string;
  exchange:    string;
  type:        string;
};

type JsonValue =
  | string | number | boolean | null
  | JsonValue[]
  | { [k: string]: JsonValue };

type RequestBody = { [k: string]: JsonValue | undefined };

type ResponseBody = {
  s:       "ok" | "error";
  error?:  string;
  bars?:   Bar[];
  quotes?: Record<string, Quote>;
  results?: SearchResult[];
  cached?: boolean;
  stale?:  boolean;
};

// ----- runtime guards ----------------------------------------------------

function asString(v: JsonValue | undefined, fallback = ""): string {
  return typeof v === "string" ? v : v == null ? fallback : String(v);
}
function asNumber(v: JsonValue | undefined, fallback = 0): number {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (isFinite(n)) return n;
  }
  return fallback;
}
function asBool(v: JsonValue | undefined): boolean {
  return v === true || v === "true" || v === 1;
}
function asStringArray(v: JsonValue | undefined): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => asString(x).trim()).filter(Boolean);
}
function num(v: unknown, fallback = NaN): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isFinite(n) ? n : fallback;
  }
  return fallback;
}

// ----- helpers -----------------------------------------------------------

const CRYPTO_BASES = new Set([
  "BTC","ETH","SOL","XRP","ADA","DOGE","LTC","BNB","AVAX","MATIC",
  "DOT","LINK","TRX","SHIB","UNI","XLM","ATOM","ETC","FIL","NEAR",
  "APT","ARB","OP","SUI","HBAR","ICP","INJ","RNDR","TON","PEPE",
]);
const CRYPTO_QUOTES = ["USDT","USDC","BUSD","USD","AUD","EUR","BTC","ETH"];

function stripCryptoQuote(symbol: string): string | null {
  const s = symbol.toUpperCase().replace(/[-/]/g, "");
  for (const q of CRYPTO_QUOTES) {
    if (s.length > q.length && s.endsWith(q)) {
      const base = s.slice(0, -q.length);
      if (CRYPTO_BASES.has(base)) return base;
    }
  }
  return null;
}

function classify(symbol: string): Kind {
  const s = symbol.toUpperCase();
  if (s.endsWith(".AX")) return "asx";
  if (CRYPTO_BASES.has(s)) return "crypto";
  if (stripCryptoQuote(s)) return "crypto";
  return "us";
}

const RES_MAP: Record<ProviderKind, Record<string, string>> = {
  yahoo:   { "1":"1m","5":"5m","15":"15m","30":"30m","60":"1h","240":"1h","D":"1d","W":"1wk","M":"1mo" },
  finnhub: { "1":"1","5":"5","15":"15","30":"30","60":"60","240":"60","D":"D","W":"W","M":"M" },
  binance: { "1":"1m","5":"5m","15":"15m","30":"30m","60":"1h","240":"4h","D":"1d","W":"1w","M":"1M" },
};
const RES_FALLBACK: Record<ProviderKind, string> = { yahoo: "1d", finnhub: "D", binance: "1d" };

function mapResolution(res: string, kind: ProviderKind): string {
  return RES_MAP[kind][res.toUpperCase()] ?? RES_FALLBACK[kind];
}

function jsonResponse(body: ResponseBody, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

// ----- providers ---------------------------------------------------------

// Narrow shapes for the upstream fields we actually read. `unknown` for
// sibling fields keeps the surface small without resorting to `any`.
type YahooChartResult = {
  timestamp?: number[];
  meta?: {
    regularMarketPrice?:  number;
    chartPreviousClose?:  number;
  };
  indicators?: {
    quote?: Array<{
      open?:   Array<number | null>;
      high?:   Array<number | null>;
      low?:    Array<number | null>;
      close?:  Array<number | null>;
      volume?: Array<number | null>;
    }>;
  };
};
type YahooChartResponse = { chart?: { result?: YahooChartResult[] } };

async function fetchYahooHistory(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  const interval = mapResolution(resolution, "yahoo");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&period1=${fromSec}&period2=${toSec}`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 TradeArena" } });
  if (!r.ok) throw new Error(`Yahoo ${r.status}`);
  const j = await r.json() as YahooChartResponse;
  const result = j.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp ?? [];
  const q  = result.indicators?.quote?.[0] ?? {};
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const o = num(q.open?.[i]);
    const h = num(q.high?.[i]);
    const l = num(q.low?.[i]);
    const c = num(q.close?.[i]);
    const v = num(q.volume?.[i], 0);
    if (isFinite(o) && isFinite(c)) {
      bars.push({ t: ts[i] * 1000, o, h, l, c, v });
    }
  }
  return bars;
}

async function fetchYahooQuote(symbol: string): Promise<Quote | null> {
  // Use the chart endpoint with a 1-day range so we don't need Yahoo's authenticated quote API.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 TradeArena" } });
  if (!r.ok) return null;
  const j = await r.json() as YahooChartResponse;
  const meta = j.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = num(meta.regularMarketPrice);
  const prev  = num(meta.chartPreviousClose);
  if (!isFinite(price) || !isFinite(prev) || prev === 0) return null;
  const change    = price - prev;
  const changePct = (change / prev) * 100;
  return { price, change, changePct };
}

type FinnhubCandleResponse = {
  s: string;
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
};

async function fetchFinnhubHistory(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  if (!FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY not configured");
  const r2  = mapResolution(resolution, "finnhub");
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${r2}&from=${fromSec}&to=${toSec}&token=${FINNHUB_API_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`Finnhub ${r.status}`);
  const j = await r.json() as FinnhubCandleResponse;
  if (j.s !== "ok" || !Array.isArray(j.t)) return [];
  const bars: Bar[] = [];
  for (let i = 0; i < j.t.length; i++) {
    bars.push({
      t: j.t[i] * 1000,
      o: num(j.o?.[i]),
      h: num(j.h?.[i]),
      l: num(j.l?.[i]),
      c: num(j.c?.[i]),
      v: num(j.v?.[i], 0),
    });
  }
  return bars;
}

type FinnhubQuoteResponse = { c?: number; d?: number; dp?: number };

async function fetchFinnhubQuote(symbol: string): Promise<Quote | null> {
  if (!FINNHUB_API_KEY) return null;
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;
  const r   = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json() as FinnhubQuoteResponse;
  const c = num(j.c);
  if (!isFinite(c) || c === 0) return null;
  return { price: c, change: num(j.d, 0), changePct: num(j.dp, 0) };
}

function binanceSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  const base = CRYPTO_BASES.has(s) ? s : (stripCryptoQuote(s) ?? s);
  return `${base}USDT`;
}

// Binance kline rows are positional arrays of mixed string/number values:
// [openTime, open, high, low, close, volume, closeTime, …]
type BinanceKlineRow = (string | number)[];

async function fetchBinanceHistory(symbol: string, resolution: string, fromSec: number, toSec: number): Promise<Bar[]> {
  const interval = mapResolution(resolution, "binance");
  const url = `https://api.binance.com/api/v3/klines?symbol=${binanceSymbol(symbol)}&interval=${interval}&startTime=${fromSec * 1000}&endTime=${toSec * 1000}&limit=1000`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${r.status}`);
  const j = await r.json() as BinanceKlineRow[];
  if (!Array.isArray(j)) return [];
  return j.map((row) => ({
    t: num(row[0]),
    o: num(row[1]),
    h: num(row[2]),
    l: num(row[3]),
    c: num(row[4]),
    v: num(row[5], 0),
  }));
}

type BinanceTicker24h = {
  lastPrice?:          string;
  priceChange?:        string;
  priceChangePercent?: string;
};

async function fetchBinanceQuote(symbol: string): Promise<Quote | null> {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol(symbol)}`;
  const r   = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json() as BinanceTicker24h;
  const price     = num(j.lastPrice);
  const change    = num(j.priceChange,        0);
  const changePct = num(j.priceChangePercent, 0);
  if (!isFinite(price)) return null;
  return { price, change, changePct };
}

// ----- cache -------------------------------------------------------------

type PriceBarRow = {
  symbol:     string;
  resolution: string;
  t:          string;
  o: number; h: number; l: number; c: number; v: number;
};

async function writeCache(symbol: string, resolution: string, bars: Bar[]): Promise<void> {
  if (!sb || bars.length === 0) return;
  const rows: PriceBarRow[] = bars.map(b => ({
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
  const rows = data as Array<Pick<PriceBarRow, "t" | "o" | "h" | "l" | "c" | "v">>;
  return rows.map((r) => ({
    t: Date.parse(r.t),
    o: num(r.o), h: num(r.h), l: num(r.l), c: num(r.c), v: num(r.v, 0),
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

async function handleHistory(body: RequestBody): Promise<Response> {
  const symbol     = asString(body.symbol).trim();
  const resolution = asString(body.resolution, "D").trim();
  const fromSec    = asNumber(body.from) || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
  const toSec      = asNumber(body.to)   || Math.floor(Date.now() / 1000);
  // The `force` flag is only used by internal callers that want to
  // explicitly bypass the cache (e.g. an admin "refresh" button).
  const force      = asBool(body.force);
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

async function handleQuote(body: RequestBody): Promise<Response> {
  const symbols = asStringArray(body.symbols);
  if (!symbols.length) return jsonResponse({ s: "error", error: "symbols required" }, 400);

  const out: Record<string, Quote> = {};
  await Promise.all(symbols.map(async (symbol) => {
    const kind = classify(symbol);
    try {
      let q: Quote | null = null;
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

type FinnhubSearchRow      = { symbol?: string; description?: string; type?: string };
type FinnhubSearchResponse = { result?: FinnhubSearchRow[] };

type YahooSearchQuote   = {
  symbol?:             string;
  shortname?:          string;
  longname?:           string;
  exchDisp?:           string;
  exchange?:           string;
  quoteType?:          string;
};
type YahooSearchResponse = { quotes?: YahooSearchQuote[] };

async function searchYahooAsx(query: string): Promise<SearchResult[]> {
  // Yahoo's search endpoint is unauthenticated and returns ASX listings
  // with `.AX` suffixes. We filter to those so the ASX exchange branch
  // returns real results instead of an empty list.
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 TradeArena" } });
    if (!r.ok) return [];
    const j = await r.json() as YahooSearchResponse;
    const out: SearchResult[] = [];
    for (const q of j.quotes ?? []) {
      const sym = asString(q.symbol).toUpperCase();
      if (!sym.endsWith(".AX")) continue;
      out.push({
        symbol:      sym,
        description: asString(q.shortname || q.longname || sym),
        exchange:    "ASX",
        type:        "stock",
      });
      if (out.length >= 10) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

async function handleSearch(body: RequestBody): Promise<Response> {
  // Lightweight search — Yahoo for ASX, Finnhub for US, Binance/static
  // catalogue for crypto. Each provider is gated by the optional
  // `market` filter so callers can scope results to one exchange.
  const query  = asString(body.query).trim();
  const market = asString(body.market).trim().toLowerCase();
  if (!query) return jsonResponse({ s: "ok", results: [] });

  const results: SearchResult[] = [];

  if (!market || market === "asx") {
    const asx = await searchYahooAsx(query);
    results.push(...asx);
  }

  if ((!market || market === "us") && FINNHUB_API_KEY) {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(query)}&token=${FINNHUB_API_KEY}`);
      if (r.ok) {
        const j = await r.json() as FinnhubSearchResponse;
        for (const row of (j.result ?? []).slice(0, 10)) {
          if (row.type !== "Common Stock") continue;
          const sym = asString(row.symbol);
          if (!sym || sym.includes(".")) continue;
          results.push({ symbol: sym, description: asString(row.description), exchange: "US", type: "stock" });
        }
      }
    } catch (_) { /* ignore */ }
  }

  if (!market || market === "crypto") {
    const upper = query.toUpperCase();
    for (const s of CRYPTO_BASES) {
      if (s.startsWith(upper) || upper === s) {
        results.push({ symbol: s, description: `${s}/USDT`, exchange: "Binance", type: "crypto" });
      }
    }
  }

  return jsonResponse({ s: "ok", results });
}

// ----- entry -------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST")    return jsonResponse({ s: "error", error: "POST only" }, 405);

  let body: RequestBody = {};
  try {
    const parsed = await req.json() as JsonValue;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as RequestBody;
    }
  } catch (_) { /* empty body is fine */ }
  const action = asString(body.action).toLowerCase();

  switch (action) {
    case "history": return handleHistory(body);
    case "quote":   return handleQuote(body);
    case "search":  return handleSearch(body);
    default:        return jsonResponse({ s: "error", error: `unknown action: ${action}` }, 400);
  }
});
