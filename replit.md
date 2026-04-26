# TradeArena

Static multi-page paper-trading site for Australian uni students. ASX, US stocks & crypto. Navy/gold professional trader theme.

## Stack
- Pure static HTML/CSS/JS (no build step)
- Served by Python `http.server` on port 5000 in dev
- Deployed as a static site (publicDir = `.`)
- Third-party: TradingView widget, Chart.js, Font Awesome, Google Fonts (Cinzel + DM Sans)

## Pages
| File | Purpose |
|------|---------|
| `index.html`     | Landing — hero, features, leaderboard, live ticker |
| `auth.html`      | Sign-in — Instagram-style. Tabs **Log in / Create account** + **Forgot password**. New users do email→OTP→set username+password (one time). Returning users do username/email + password (no OTP). Demo OTP shown in big gold banner with auto-fill. |
| `profile.html`   | Instagram-style profile — gradient avatar, stats row, bio, highlights, tabs (Holdings/Watchlist/Activity), Edit Profile modal. Post-login landing. |
| `trade.html`     | **Markets** — TradingView chart (full toolbar/indicators in navy/gold theme), watchlist sidebar, symbol search with autocomplete, big symbol header, **right-side order entry panel** (Buy/Sell tabs, Market/Limit, qty quick-pick, summary, place button), simulated order book with bid/ask depth, lower tabs (Overview/Recent trades/My orders). |
| `portfolio.html` | **Groww-style portfolio** — big "Investments" hero with current value + total returns + today's change, time-range tabs (1D/1W/1M/3M/1Y/ALL), clean perf chart, segmented allocation bar with legend, holdings list (one row per holding with qty×avg, current value, P&L $/%), top movers cards (Gainers/Losers/Active). |
| `admin.html`     | Admin panel — registrations, university breakdown, demo-data tools (passphrase: `arena2026`) |

## Shared assets (`/assets`)
- `styles.css` — design tokens (navy/gold), nav, cards, tables, buttons, modal, forms, avatar pill + dropdown menu
- `app.js`    — `TArenaAuth` (full auth API: `startSignup`/`verifySignupOtp`/`completeSignup`, `login`, `startReset`/`verifyResetOtp`/`completeReset`, `getSession`/`signOut`/`requireAuth`, `getProfile`/`saveProfile`, `seedDemoUsers`, `clearAllData`) + `TArenaUI` (`renderNav`, `renderFooter`, `fmtMoney`, `fmtPct`, `getAvatar`, `avatarHtml`)
- `market.js` — `TArenaMarket` (mock prices, holdings, watchlist, orders, tick simulator)
- `favicon.svg` — gold shield logo

## Auth model — Instagram-style
Pure client-side demo using localStorage.

**First-time sign-up (3 steps):**
1. Choose Student/Public, enter email → OTP generated, banner shows it.
2. Verify the 6-digit code (or click **Use this code** to auto-fill).
3. Pick a username + create a password (with strength meter).
→ Account created in `tarena_users`, session set, redirect to profile.

**Returning user log-in (no OTP):**
- Enter username **or** email + password → instant log-in, redirect to profile.

**Forgot password (3 steps):**
- Email/username → OTP → set new password → logged in.

Demo seeded users (`seedDemoUsers()`) all share password `demo1234` so any can be used for testing. Example: username `liamos` / password `demo1234`.

User passwords are stored plaintext in `localStorage['tarena_users']` for demo only — replace with hashed server-side storage for production. User-editable profile data is keyed by email under `localStorage['tarena_profiles']`. Avatars are deterministic gradients derived from the email hash plus initials.

## localStorage keys
- `tarena_session`       — current signed-in user
- `tarena_users`         — all created accounts with passwords (`{ [email]: { email, username, password, university, type, createdAt } }`)
- `tarena_pending_otp`   — pending OTP for signup or password-reset (auto-cleared after use)
- `tarena_registrations` — lightweight summary for admin panel
- `tarena_profiles`      — per-user editable profile data (display name, bio, tier)
- `tarena_orders`        — placed orders log
- `tarena_watchlist`     — user's watched symbols

## Trade page (TradingView + order entry)
The TradingView widget is configured for a pro-trader feel: dark theme overridden to navy/gold (`#0c1d36` background, `#10b981` up, `#dc2626` down, gold grid), default studies (MA + Volume), full top + side toolbar, date-range picker. The right-side order panel mirrors a real broker: Buy/Sell colored tabs, Market/Limit toggle, quantity field with 25/50/75/Max quick-pick, live total, and a coloured submit button. Below it sits a simulated **order book with depth bars** (5 asks + 5 bids and a spread row).

## Portfolio page (Groww-style)
- Big "Investments" header with current value, total returns ($/%), and today's change tile.
- Time-range tabs (1D/1W/1M/3M/1Y/ALL) above a clean Chart.js area chart with a gold gradient.
- Asset Allocation card with a segmented bar (ASX/US/Crypto/Cash) + legend.
- Holdings list — one row per holding showing icon, symbol, name, market badge, qty × avg, current value, P&L $/%, and today's change %.
- Top Movers tiles — Gainers / Losers / Most Active.

## Conventions
- Every page must include `<div id="tarena-nav"></div>` and `<div id="tarena-footer"></div>` then call `TArenaUI.renderNav('<page-id>')` after loading `app.js`.
- Page IDs: `home`, `trade`, `portfolio`, `profile`, `auth`, `admin`.
- All `<link rel="icon">` point to `assets/favicon.svg`.
- TradingView symbols use the broker-prefixed format (`ASX:BHP`, `NASDAQ:AAPL`, `BINANCE:BTCUSDT`) — stored in `TArenaMarket.data[i].tv`.
- Money formatting goes through `TArenaUI.fmtMoney` / `fmtPct` for consistency.
- Numeric values in tables/lists use `font-feature-settings:'tnum'` for tabular alignment.
- Tone: professional trader. Avoid "warrior", "battle", "war room" wording.

## Local dev
```
python3 -m http.server 5000 --bind 0.0.0.0
```
Workflow `Start application` runs this automatically. Just refresh after edits.

## Deployment
Already configured as a static deployment with `publicDir = "."`. Click Publish to push live.
