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
| `profile.html`   | Profile page — gradient avatar, stats, bio, holdings/watchlist/activity tabs, edit modal. Post-login landing. |
| `trade.html`     | Markets — TradingView chart, watchlist sidebar, symbol search, big symbol header, right-side order entry panel, simulated order book. |
| `portfolio.html` | Groww-style portfolio — investments hero, time-range tabs, perf chart, allocation bar, holdings list, top movers. |
| `admin.html`     | Admin panel — registrations, university breakdown, CSV export. **Gated by `profiles.is_admin = true`** (no shared passphrase). |

## Shared assets (`/assets`)
- `config.js`   — Supabase URL + publishable key (safe to expose; rotate by editing this file)
- `supabase.js` — Singleton Supabase client at `window.TArenaDB`
- `app.js`      — `TArenaAuth` (full Supabase-backed API) + `TArenaUI` (`renderNav`, `renderFooter`, `fmtMoney`, `fmtPct`, `getAvatar`, `avatarHtml`)
- `market.js`   — `TArenaMarket` (mock prices, holdings, watchlist, orders, tick simulator) — to be replaced by real market data in Task #3
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
The full schema, RLS policies, and helper functions live in `supabase/migrations/0001_init.sql`.

To install (or reset) the database:
1. Open the Supabase Dashboard → **SQL Editor** → **New query**.
2. Paste the contents of `supabase/migrations/0001_init.sql` and click **Run**.
3. Confirm the `profiles`, `strategies`, `paper_trades`, `holdings_view`, `reels`, `reel_tags`, `reel_mirrors`, `follows`, `leagues`, `league_members`, `chart_layouts`, `price_bars` tables/views exist with RLS enabled.
4. **(Optional)** Seed the 8 legacy demo accounts so old logins (`liamos`, `alexchen`, etc. with password `demo1234`) keep working: run `select public.seed_demo_users();` in the SQL editor. Re-runnable; already-seeded accounts are skipped.

The migration creates these helper RPCs (callable from the client unless noted):
- `email_for_username_login(p_username, p_password)` — verifies the password against `auth.users.encrypted_password` (bcrypt via `pgcrypto`) and returns the email **only on a correct credential pair**, so it cannot be used to enumerate emails.
- `check_username_available(p_username)` / `check_email_available(p_email)` — boolean availability checks for signup.
- `has_visibility(p_owner, p_field)` — SECURITY DEFINER helper that lets RLS policies on other tables check the owner's `visibility_mask` without granting cross-row read access to `profiles`.
- `get_my_holdings()` / `get_holdings_for(p_owner uuid)` — visibility-aware accessors for the materialized `holdings_view` (the view itself is not directly granted to clients).
- `list_registrations()` — admin-only view of all profiles + auth emails.
- `seed_demo_users()` — one-shot demo seeder (no client grant; runs from SQL editor).
- `refresh_holdings_view()` — admin/cron refresh for the materialized view.

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
- `tarena_orders`            — placed orders log (mock — replaced in Task #3)
- `tarena_watchlist`         — user's watched symbols (mock — replaced in Task #3)

## Trade page (TradingView + order entry)
The TradingView widget is configured for a pro-trader feel: dark theme overridden to navy/gold (`#0c1d36` background, `#10b981` up, `#dc2626` down, gold grid), default studies (MA + Volume), full top + side toolbar, date-range picker. The right-side order panel mirrors a real broker. Below it sits a simulated **order book with depth bars**. *(Replaced with broker-grade Advanced Charts library in Task #3.)*

## Portfolio page (Groww-style)
- Big "Investments" header with current value, total returns ($/%), and today's change tile.
- Time-range tabs (1D/1W/1M/3M/1Y/ALL) above a Chart.js area chart with a gold gradient.
- Asset Allocation card with a segmented bar (ASX/US/Crypto/Cash) + legend.
- Holdings list — one row per holding showing icon, symbol, name, market badge, qty × avg, current value, P&L $/%, today's change %.
- Top Movers tiles — Gainers / Losers / Most Active.

## Conventions
- Every page must include `<div id="tarena-nav"></div>` and `<div id="tarena-footer"></div>` then load — in this order — `assets/config.js`, the Supabase UMD bundle, `assets/supabase.js`, `assets/app.js`, then call `TArenaUI.renderNav('<page-id>')`.
- Page IDs: `home`, `trade`, `portfolio`, `profile`, `auth`, `admin`.
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
