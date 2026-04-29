# TradeArena

Static multi-page paper-trading site for Australian uni students. ASX, US stocks & crypto. Navy/gold professional trader theme.

## Stack
- Pure static HTML/CSS/JS (no build step)
- Served by Python `http.server` on port 5000 in dev
- Deployed as a static site (publicDir = `.`)
- **Auth + DB**: Supabase (Postgres + Auth, RLS-protected) — client uses the `@supabase/supabase-js` v2 UMD bundle
- Third-party: TradingView widget, Chart.js, Font Awesome, Google Fonts (Cinzel + DM Sans)

## Pages
| File | Purpose |
|------|---------|
| `index.html`     | Landing — hero, features, leaderboard, live ticker |
| `auth.html`      | Sign-in — Tabs **Log in / Create account** + **Forgot password**. Supabase email-OTP for signup + password reset; password login (no OTP) for returning users. |
| `profile.html`   | Trader scorecard — header (avatar, handle, tier, university, follower stats, edit/follow), 6 stat tiles, equity-curve card with benchmark dropdown + range tabs, full quant-metrics card, verified-achievement badges, 4-tab content (Strategies / Reels / Journal / Holdings) with locked-card empty states for any section the trader has hidden. Edit modal exposes a per-section privacy toggle grid that writes to `profiles.visibility_mask`. View other traders via `?u=username`. |
| `trade.html`     | Markets — TradingView chart, watchlist sidebar, symbol search, big symbol header, right-side order entry panel, simulated order book. |
| `reels.html`     | Strategy reels feed — For You / Following / Trending tabs, search ($ticker, #tag, free text), indicator/pattern/strategy filter rails, live P&L per card, mirror sheet, on-chart pin popovers. Auth-gated. |
| `reels-new.html` | Reel composer — 5-step flow (symbol → snap → pin tags → thesis & risk → visibility), live R:R + position-sizing preview, click-to-drop pins, publishes via `publish_reel` RPC which also auto-opens a paper trade. |
| `portfolio.html` | Groww-style portfolio — investments hero, time-range tabs, perf chart, allocation bar, holdings list, top movers. |
| `admin.html`     | Admin panel — registrations, university breakdown, CSV export. **Gated by `profiles.is_admin = true`** (no shared passphrase). |

## Shared assets (`/assets`)
- `config.js`   — Supabase URL + publishable key (safe to expose; rotate by editing this file)
- `supabase.js` — Singleton Supabase client at `window.TArenaDB`
- `app.js`      — `TArenaAuth` (full Supabase-backed API) + `TArenaUI` (`renderNav`, `renderFooter`, `fmtMoney`, `fmtPct`, `getAvatar`, `avatarHtml`)
- `market.js`   — `TArenaMarket` static catalogue (symbol → name/market/mcap/52w). `tick()` is the fallback random simulator still used by the home ticker and portfolio page — those pages get rebuilt later. The Trade page **does not** use `tick()`; it gets live prices from `datafeed.js`.
- `datafeed.js` — `TArenaDatafeed` market-data layer. `fetchBars`, `fetchQuotes`, `subscribeQuote` (Binance WS for crypto + 5s poll for stocks), plus a TradingView UDF adapter (`createUDF()`) and a Supabase save/load adapter (`createSaveLoadAdapter()`).
- `chart-bootstrap.js` — `TArenaChart.mount(containerId, symbol, resolution)` — detects whether the Advanced Charts library is installed and mounts either it or the Lightweight Charts fallback.
- `metrics.js` — `window.TArenaMetrics`, pure quant-math helpers used by the profile scorecard: `pnl`, `rMultiple`, `winRate`, `avgWin`, `avgLoss`, `avgRR`, `profitFactor`, `expectancy`, `avgHoldingDays`, `dailyReturns`, `sharpe`/`sortino` (annualized over 252 trading days), `equityCurve`, `maxDrawdown`, `recoveryFactor`, `totalReturnPct`, plus a single-shot `summarise(trades, opts)` aggregator. Empty inputs return `null` so the UI can render "—" instead of NaN.
- `reels.js` — `window.TArenaReels`, taxonomy + math helpers shared by the feed and composer: `INDICATORS` / `PATTERNS` / `STRATEGIES` arrays, a `DEFINITIONS` map (one-line description per tag for the on-chart pin popover), `ICON_FOR_TYPE` (Font Awesome class per tag type), `positionSize({entry,stop,riskPct,account})` (mirrors the SQL `tarena_position_size` so client + server agree), `riskReward({entry,stop,target,direction})`, `livePnl({entry,qty,side,last})`, `defineTag(value)`, `tagSortKey(tag)`. Pure functions, no DOM, no network.
- `styles.css`  — design tokens (navy/gold), nav, cards, tables, buttons, modal, forms, avatar pill + dropdown menu
- `favicon.svg` — gold shield logo

## Auth model — Supabase
**First-time sign-up (3 steps):**
1. Choose Student/Public, enter email → Supabase emails a 6-digit OTP via `signInWithOtp({ shouldCreateUser: true })`.
2. Verify the 6-digit code (`verifyOtp({ type: 'email' })`) — this also signs the user in.
3. Pick a username + create a password — `updateUser({ password, data: { username, type, university }})` plus an `INSERT` into `public.profiles` (RLS allows self-insert).

**Returning user log-in (no OTP):**
- Username **or** email + password. Username login first calls the `lookup_email_by_login(p_input)` RPC to resolve the email, then `signInWithPassword`.

**Forgot password (3 steps):**
- Email/username → `signInWithOtp({ shouldCreateUser: false })` → verify OTP → `updateUser({ password })`.

The Supabase **publishable key** in `assets/config.js` is designed to ship in client code; real authorization is enforced by RLS policies on every table. The original task spec called for the URL/key to be sourced from Replit Secrets at workspace setup time, but because this site has no build step we can't do `process.env`-style substitution — `config.js` is committed with the literal values instead. To rotate the key: regenerate it in Supabase Dashboard → Project Settings → API, paste the new value into `assets/config.js`, and redeploy. (If we move to a bundled build later, `config.js` should be regenerated from the `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` Replit Secrets and excluded from git.)

## Database setup (one-time)
The base schema, RLS policies, and helper functions live in `supabase/migrations/0001_init.sql`. The Task #4 scorecard adds visibility-aware accessors and a tighter `paper_trades` policy in `supabase/migrations/0002_profile_scorecard.sql`. The Task #5 reels engine adds publish/mirror/feed RPCs in `supabase/migrations/0003_reels_engine.sql` — run **all three** files in order.

To install (or reset) the database:
1. Open the Supabase Dashboard → **SQL Editor** → **New query**.
2. Paste the contents of `supabase/migrations/0001_init.sql` and click **Run**, then repeat with `0002_profile_scorecard.sql`, then `0003_reels_engine.sql`.
3. Confirm the `profiles`, `strategies`, `paper_trades`, `holdings_view`, `reels`, `reel_tags`, `reel_mirrors`, `reel_engagement`, `follows`, `leagues`, `league_members`, `chart_layouts`, `price_bars` tables/views exist with RLS enabled.
4. **(Optional)** Seed the 8 legacy demo accounts so old logins (`liamos`, `alexchen`, etc. with password `demo1234`) keep working: run `select public.seed_demo_users();` in the SQL editor. Re-runnable; already-seeded accounts are skipped.

The migration creates these helper RPCs (callable from the client unless noted):
- `email_for_username_login(p_username, p_password)` — verifies the password against `auth.users.encrypted_password` (bcrypt via `pgcrypto`) and returns the email **only on a correct credential pair**, so it cannot be used to enumerate emails.
- `check_username_available(p_username)` / `check_email_available(p_email)` — boolean availability checks for signup.
- `has_visibility(p_owner, p_field)` — SECURITY DEFINER helper that lets RLS policies on other tables check the owner's `visibility_mask` without granting cross-row read access to `profiles`.
- `get_my_holdings()` / `get_holdings_for(p_owner uuid)` — visibility-aware accessors for the materialized `holdings_view` (the view itself is not directly granted to clients).
- `list_registrations()` — admin-only view of all profiles + auth emails.
- `seed_demo_users()` — one-shot demo seeder (no client grant; runs from SQL editor).
- `refresh_holdings_view()` — admin/cron refresh for the materialized view.

**Profile scorecard RPCs (added by `0002_profile_scorecard.sql`):**
- `get_profile_card(p_username)` — public profile + the owner's `visibility_mask` so the client can decide which sub-cards to render. The `university` column is nulled out when the owner has hidden it (and the viewer is not the owner).
- `get_journal_for(p_owner)` — full closed-trade history (with `notes`, `symbol`, `target`, etc.), gated by `visibility_mask.journal`.
- `get_perf_trades_for(p_owner)` — minimal projection (`id, symbol, side, qty, entry_price, exit_price, stop_loss, status, opened_at, closed_at`) used to compute the equity curve and quant tiles client-side, gated by `metrics OR equity_curve`. This keeps the "publish my performance without my journal narrative" hybrid-privacy story honest.
- `get_strategies_for(p_owner)` — strategy library, gated by `visibility_mask.strategies`.
- `get_follow_stats(p_owner)`, `am_following(p_target)`, `follow_user(p_target)`, `unfollow_user(p_target)` — social-graph helpers.
- `compute_badges_for(p_owner)` — auto-issues five achievement badges (`100_trades`, `6_profitable_months`, `top_sharpe_q3_26`, `mirror_master`, `strategy_curator`) computed from existing `paper_trades` / `reel_mirrors` / `strategies` data — no extra schema required. `profile.html` calls this on every render and unions the result with the curated `profiles.badges` array, so newly-earned badges show up immediately without waiting on a backfill job.
- `get_cash_balance_for(p_owner)` — server-computed cash balance (`100_000 + Σ realised P&L − Σ open-position cost basis`). Gated **only** by `visibility_mask.cash`, so a trader can advertise their cash buffer while keeping every other section private (or vice-versa). Returns `null` when private.

Every new SECURITY DEFINER function explicitly `REVOKE ALL ... FROM PUBLIC` before granting `EXECUTE` to `authenticated`, so anonymous callers can't invoke them even if PUBLIC retains the default privilege somewhere upstream.

The `paper_trades_read` policy is also tightened in 0002: the same row is now exposed to outsiders **only** when its `status='open'` matches `visibility_mask.holdings = true` **or** its `status='closed'` matches `visibility_mask.journal = true`. (The owner still sees everything.) This means a trader can publish their journal without revealing currently-open positions, or vice-versa.

The `strategies` table previously had a permissive `strategies_read_all` policy that made every user's strategy library globally enumerable. 0002 replaces it with a visibility-aware `strategies_read` policy `(owner_id = auth.uid() OR has_visibility(owner_id, 'strategies'))` so the base table now enforces the same gate as `get_strategies_for`.

## Privacy + RLS model
- **`profiles`** is RLS-restricted to **self-only SELECT** so sensitive columns (`is_admin`, `visibility_mask`, raw `bio`) never leak to other users.
- **`profiles.email` does not exist.** The canonical email lives only in `auth.users`. Duplicating it would create a PII enumeration surface.
- **`public_profiles`** is a view (with `security_invoker = false`) exposing only the contractually-public columns: `id`, `username`, `display_name`, `tier`, `avatar_color`, `badges`. **Granted to `authenticated` only** — unauthenticated visitors cannot enumerate the user list. Every cross-user lookup (mentions, leaderboards, reels feed) reads from this view rather than the base table.
- **`holdings_view`** is a Postgres `MATERIALIZED VIEW` rolled up from `paper_trades`. Materialized views in Postgres do not enforce RLS, so direct SELECT is granted only to `service_role`; clients access it through `get_my_holdings()` (own rows) or `get_holdings_for(owner)` (gated by `visibility_mask.holdings`).
- **Forgot-password requires the email, not the username.** Allowing username-based reset would force the server to disclose the corresponding email, which is the same enumeration vector the password-verifying login RPC is designed to avoid.

## Granting admin access
Admin pages are gated by `profiles.is_admin = true`. To promote a user:
```sql
update public.profiles set is_admin = true where username = 'liamos';
```

## Email templates
By default Supabase emails the magic-link confirmation that includes both a clickable link and a 6-digit `{{ .Token }}` code. Our flow uses the **code**, not the link, so make sure the **Magic Link** email template in Supabase Dashboard → Authentication → Email Templates contains `{{ .Token }}`. (The default template does.)

## Storage keys (client-side)
- `tarena_sb_session`        — Supabase auth session (managed by SDK)
- `tarena_pending_email`     — multi-step signup / reset state (cleared after success)
- `tarena_profile_cache`     — last-known profile snapshot keyed by email (for fast nav rendering)
- `tarena_orders`            — placed orders log (still localStorage; paper_trades wiring lives with Task #4)
- `tarena_watchlist`         — user's watched symbols (drives live quote subscriptions on the Trade page)
- `pending_chart_snap`       — most recent "Snap to reel" capture `{symbol, interval, drawings, png_dataurl, ts, expiresAt}`. **10-minute TTL**, enforced by `TArenaChart.consumePendingSnap()` (the reel composer's read API) which auto-evicts expired entries.

## Trade page (broker-grade chart + real market data)

The chart pane is mounted by **`assets/chart-bootstrap.js`** which detects which TradingView library is available:

1. **`/charting_library/charting_library.js` present** → mounts the **TradingView Advanced Charts library** with our UDF datafeed (`assets/datafeed.js`), navy/gold theme overrides, default studies (EMA20, EMA50, Volume, RSI(14)), full drawing toolset, multi-timeframe (1m → 1M), bar-replay mode, and a save/load adapter that reads/writes `chart_layouts`.
2. **library not yet installed** → lazy-loads **TradingView Lightweight Charts** (MIT) from CDN and renders a navy/gold candle chart with EMA20 / EMA50 / Volume + a built-in timeframe toolbar. The page never looks broken while the Advanced library application is being processed.

In both modes a **"📸 Snap to reel"** toolbar button captures `{symbol, interval, drawings, png_dataurl}` and stashes it in `localStorage.pending_chart_snap` (with a 10-minute TTL) so the reel composer (Task #5) can attach it. The composer reads the snap with `TArenaChart.consumePendingSnap()` which validates the TTL and removes the entry; expired captures are also evicted opportunistically on every chart mount.

The right-side order panel and the watchlist subscribe to the **same live price stream** used by the chart, so everything moves in sync (no more random tick simulator on the Trade page). Live ticks come from:
- **Binance public WebSocket** for crypto (true real-time).
- **5-second polling** of the data-proxy edge function for ASX (Yahoo Finance) and US (Finnhub).

### Installing the Advanced Charts library

The library is licensed by TradingView and not redistributable, so each Replit project has to apply for it once.

1. Apply at <https://www.tradingview.com/charting-library/>. Approval is usually fast for non-commercial educational use; mention the project name "TradeArena" and the dev URL.
2. Once approved, download the zip and unzip it so that `charting_library/charting_library.js` sits at the **project root** (sibling of `index.html`).
3. Hard-refresh the Trade page. The bootstrap auto-detects the new file and switches over.

### Deploying the `data-proxy` edge function

```bash
npm install -g supabase
supabase login
supabase link --project-ref chncykagtzotdtflkhim
supabase secrets set FINNHUB_API_KEY=YOUR_KEY    # https://finnhub.io/register
supabase functions deploy data-proxy
```

The function fans out to Yahoo Finance (ASX), Finnhub (US), and Binance (crypto). Every history call is **read-through-cache** against `public.price_bars`: the function returns cached bars immediately only when the cache covers **both** ends of the requested window (earliest cached bar ≤ `from + one bar`, latest cached bar within one bar of `to`). Otherwise it backfills only the missing **head** (older history, when the user back-scrolls past the cached range) and/or **tail** (recent history) from upstream and merges them with the cached set. On upstream failure with cached bars present, the function returns the cached set with `stale: true` instead of erroring. This means bar-replay scrubbing and repeat history loads stay free, while back-scroll and first-load both work correctly. Source + smoke-test in `supabase/functions/data-proxy/`.

## Profile page (trader scorecard)

Open with `profile.html` (own scorecard) or `profile.html?u=<username>` (any trader).

**Layout (top → bottom):** header (avatar + display name + handle + tier chip + optional university chip + bio + follower/following counts + Edit/Follow button) → 6 stat tiles (All-time P&L, Win rate, Sharpe, Max DD, Profit factor, Trades) → equity-curve card (Chart.js area, benchmark switch ASX200/SPX/BTC, range tabs 1M/3M/6M/1Y/ALL) → quant-metrics card (12 numbers — sharpe, sortino, recovery factor, profit factor, expectancy, avg R:R, avg holding days, etc.) → verified-achievement badges → 4 tabs (Strategies / Reels / Journal / Holdings).

**Hybrid privacy.** Each numeric/visual section is gated independently by the owner's `profiles.visibility_mask` JSONB. When a section is hidden, the matching tile/card renders a `Private` lock instead of fabricating placeholder data. The Edit modal exposes one toggle per maskable field (`holdings`, `cash`, `equity_curve`, `metrics`, `strategies`, `journal`, `reels`, `university`) and writes the new mask via `TArenaAuth.saveProfile({ visibilityMask })`. RLS in `0002_profile_scorecard.sql` enforces the same gates server-side, so an attacker cannot bypass the UI by calling RPCs directly.

**Benchmark line.** Until the Trade-page datafeed exposes a generic `fetchBenchmark(code)`, the equity-curve card overlays a deterministic synthetic series so the line stays stable across reloads (and the swap-in is one function — `syntheticBenchmark()` in `profile.html`). Real index data plugs in here without touching the rest of the page.

**Quant math** lives in `assets/metrics.js` (pure functions, no DB access). The page calls `TArenaMetrics.summarise(trades, { startingCapital: 100000, benchmark })` once per render.

## Reels (strategy feed + composer)

Two pages, one shared client module (`assets/reels.js`), and one migration (`supabase/migrations/0003_reels_engine.sql`).

**Server (`0003_reels_engine.sql`).** Every client read/write goes through SECURITY DEFINER RPCs so the visibility logic, position sizing, and atomic publish/trade pairing all live in one hardened code path.

- `tarena_position_size(entry, stop, risk_pct, account)` — risk-based qty math. The exact same formula is implemented in JS (`TArenaReels.positionSize`) so the composer's preview matches what the server will open.
- `can_read_reel(visibility, author_id)` — mirrors `reels_read` policy logic. `'league'` visibility is treated as **private until leagues ship** so users who pick "League only" today don't accidentally broadcast publicly when leagues launch with different rules.
- `publish_reel(p_payload jsonb)` — atomic insert: validates payload (thesis ≤ 280, direction ∈ {long,short}, entry/stop > 0, risk_pct ∈ [0.05, 25]), inserts the reel, inserts each pin into `reel_tags`, opens a `paper_trades` row sized to `risk_pct` of a $100k paper account, **fills the trade silently at `payload.live_price`** (the client's live quote at submit time — falls back to `payload.entry` if missing), then back-links `reels.paper_trade_id`. Returns the new reel id.
- `mirror_reel(p_reel_id, p_risk_pct, p_account_size, p_live_price)` — opens a paper trade in the **viewer's** account using their own risk %, **fills at the viewer's `p_live_price`** (so the trade enters at live, never at the author's stale entry), inserts a `reel_mirrors` row. **Idempotent** on `(reel_id, mirrored_by)` — second press returns the existing mirror id instead of erroring. Rejects self-mirror and gates on `can_read_reel`.
- `toggle_engagement(p_reel_id, p_kind)` — like/save toggle, share/view as one-shot inserts (unique constraint on `(reel_id, user_id, kind)`). Returns `{on, count, kind}` so the UI can update the chip without a follow-up read.
- `feed_reels(p_cursor, p_limit, p_tab, p_tag, p_ticker, p_q, p_user)` — the single read-side feed query. Tabs: `'fy'` (chronological), `'following'` (joined to `follows`), `'trending'` (engagement-weighted in last 24h). Filters: exact tag match, exact symbol match, exact author-username match (`p_user` — fed by the `@user` search prefix), substring search across thesis + tag values. Returns `{rows, next_cursor}` — each row carries the author profile, tag list with pin coords, engagement counts (`likes/saves/shares/views/mirrors`), and viewer state (`liked/saved/mirrored`).
- `get_reel(p_id)` — single-reel fetch with the same shape (used for share-link deep-loads).

All Task #5 RPCs `REVOKE ALL FROM PUBLIC` then `GRANT EXECUTE TO authenticated`.

**Feed page (`reels.html`).** Three-column shell on desktop (filter rail + feed + hot tickers), single column on mobile. Each card carries chart snapshot with numbered pins, the chip row (pinned chips show a matching number badge and an SVG leader line connects each chip to its pin on the chart), thesis, levels, mirror/like/save/share/comment actions, and an author footer with avatar, handle, tier, **win-rate %** (computed from the author's closed paper trades — long wins when exit > entry, short wins when exit < entry; shows "—" until the author has a closed trade), and a **Follow / Following toggle** (single-tap, optimistically updates every other mounted card by the same author). **Windowed virtualization** — every loaded reel sits in an empty `<article class="reel-slot">` placeholder; only the cards within ±3 of the viewport are mounted at any time (a single `IntersectionObserver` drives both window reconciliation and live-quote sub mount/unmount, so DOM and WS fan-out stay bounded even at hundreds of loaded reels). The placeholder height is preserved on unmount so scroll position never jumps. Pin popover renders the tag definition from `TArenaReels.DEFINITIONS` and offers a "Show all reels using this" filter that round-trips through `?tag=…`. Search recognises Twitter-style `$TICKER`, `#tag`, and `@user` shortcuts and falls back to free-text. Deep links of the form `?reel=<uuid>` resolve through `get_reel` on boot and prepend the matching reel to the top of the feed (with a smooth scroll). Mirror sheet renders a live position-size + risk + projected-reward preview as the user moves the risk slider, and the mirror RPC fills at the viewer's live quote captured at click time.

**Composer (`reels-new.html`).** Five steps with a stepper pill that auto-advances as the user fills in each section. Symbol step uses `TArenaMarket` for autocomplete (keyboard-navigable) and prefills entry/stop/target from the live mock price. Snap step reads `localStorage.pending_chart_snap` (produced by the chart's "Snap to reel" button — see Trade page section); a `storage` event listener auto-refreshes the snap if the user takes a new one in another tab. Pin step toggles a placement mode — clicks on the snapshot drop a numbered pin and open an editor row with type/value selects backed by `TArenaReels.INDICATORS / PATTERNS / STRATEGIES`. Changing a pin's `tag_type` resets its `tag_value` to the first option of the **chosen** type (an earlier version of this code switched on the field name and silently saved a strategy value under an indicator row). The right-rail preview card recomputes R:R + qty + dollar risk on every keystroke. Visibility offers Public / Followers / **League only** / Private; League is gated server-side by `can_read_reel`, which treats it as private until leagues ship so the post is visible only to the author. On publish, the composer captures the live quote one last time (preferring `TArenaDatafeed.fetchQuotes`, falling back to the static catalogue) and ships it to `publish_reel` as `live_price` so the auto paper-trade fills silently at the live quote, not the author's intended limit entry. The snap entry is then cleared so the next composer doesn't reuse it.

**Position sizing convention.** All sizing assumes a $100,000 paper account (matches `profile.html`). `qty = (account × risk_pct/100) ÷ |entry − stop|`. The mirror sheet exposes risk %; the composer's preview uses the author's chosen risk %. Both client and server clamp risk_pct to [0.05%, 25%].

## Portfolio page (Groww-style)
- Big "Investments" header with current value, total returns ($/%), and today's change tile.
- Time-range tabs (1D/1W/1M/3M/1Y/ALL) above a Chart.js area chart with a gold gradient.
- Asset Allocation card with a segmented bar (ASX/US/Crypto/Cash) + legend.
- Holdings list — one row per holding showing icon, symbol, name, market badge, qty × avg, current value, P&L $/%, today's change %.
- Top Movers tiles — Gainers / Losers / Most Active.

## Conventions
- Every page must include `<div id="tarena-nav"></div>` and `<div id="tarena-footer"></div>` then load — in this order — `assets/config.js`, the Supabase UMD bundle, `assets/supabase.js`, `assets/app.js`, then call `TArenaUI.renderNav('<page-id>')`.
- Page IDs: `home`, `trade`, `reels`, `portfolio`, `profile`, `auth`, `admin`.
- All `<link rel="icon">` point to `assets/favicon.svg`.
- TradingView symbols use the broker-prefixed format (`ASX:BHP`, `NASDAQ:AAPL`, `BINANCE:BTCUSDT`).
- Money formatting goes through `TArenaUI.fmtMoney` / `fmtPct` for consistency.
- Numeric values in tables/lists use `font-feature-settings:'tnum'` for tabular alignment.
- Tone: professional trader. Avoid "warrior", "battle", "war room" wording.
- All `TArenaAuth` auth calls (`startSignup`, `verifySignupOtp`, `completeSignup`, `login`, `startReset`, `verifyResetOtp`, `completeReset`, `signOut`, `saveProfile`, `getRegistrations`, `isUsernameAvailable`, `reloadSession`) return Promises — `await` them. `getSession`, `requireAuth`, `getProfile`, `isStudentEmail`, `getUniversity`, `suggestUsername` stay synchronous (read from in-memory cache primed at module load).

## Local dev
```
python3 -m http.server 5000 --bind 0.0.0.0
```
Workflow `Start application` runs this automatically. Just refresh after edits.

## Deployment
Already configured as a static deployment with `publicDir = "."`. Click Publish to push live.
