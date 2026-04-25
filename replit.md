# TradeArena

Static multi-page paper-trading site for Australian uni students. ASX, US stocks & crypto. Navy/gold "warrior arena" brand.

## Stack
- Pure static HTML/CSS/JS (no build step)
- Served by Python `http.server` on port 5000 in dev
- Deployed as a static site (publicDir = `.`)
- Third-party: TradingView widget, Chart.js, Font Awesome, Google Fonts (Cinzel + DM Sans)

## Pages
| File | Purpose |
|------|---------|
| `index.html`     | Landing — hero, features, leaderboard, live ticker |
| `auth.html`      | Sign-in — student/public toggle, demo-mode 6-digit OTP with huge code banner + "Use this code" auto-fill |
| `profile.html`   | **Instagram-style profile** — gradient avatar, stats row, bio, highlights, tabs (Holdings/Watchlist/Activity), Edit Profile modal. Post-login landing. |
| `trade.html`     | War Room — TradingView chart, watchlist, holdings, quick trade |
| `portfolio.html` | Portfolio — performance chart, allocation pie, holdings table, CSV export |
| `admin.html`     | Admin panel — registrations, university breakdown, demo-data tools (passphrase: `arena2026`) |

## Shared assets (`/assets`)
- `styles.css`  — design system (navy/gold tokens, nav, cards, tables, buttons, modal, forms)
- `app.js`     — `TArenaAuth` (demo-mode OTP, sessions, profiles via localStorage) + `TArenaUI` (renderNav with avatar pill+dropdown, renderFooter, fmtMoney, fmtPct, getAvatar, avatarHtml)
- `market.js`  — `TArenaMarket` (mock prices, holdings, watchlist, orders, tick simulator)
- `favicon.svg` — gold shield logo

## Auth model
Pure client-side demo. `TArenaAuth.sendOtp(email, type)` generates a 6-digit code, stores it in localStorage with a 10-minute expiry, and returns it so the auth page can display it in a HUGE "DEMO MODE" banner with a one-click "Use this code" button that auto-fills + verifies. Public emails (Gmail/Outlook/etc) are accepted when the user picks the **Public** tab. `verifyOtp(code)` matches it and creates a session in `localStorage['tarena_session']`. After verification, the user is redirected to `profile.html` (the Instagram-style account page). All protected pages call `TArenaAuth.requireAuth()` which redirects to `auth.html` when no session exists. The nav avatar-pill opens a dropdown menu (View profile / Portfolio / Trade / Sign out).

User-editable profile data is keyed by email under `localStorage['tarena_profiles']` and accessed via `getProfile(email)` / `saveProfile(email, updates)`. Avatars are deterministic gradients derived from the email hash plus initials — see `TArenaUI.getAvatar(email)`.

For production, replace `TArenaAuth.sendOtp` and `verifyOtp` with calls to a real backend (Supabase, Firebase, or your own service).

## localStorage keys
- `tarena_session`       — current signed-in user
- `tarena_pending_otp`   — pending verification code (auto-cleared on verify)
- `tarena_registrations` — all signed-up users (for admin panel)
- `tarena_profiles`      — per-user editable profile data (display name, bio, tier)
- `tarena_orders`        — user's trade history
- `tarena_watchlist`     — user's watched symbols

## Conventions
- Every page must include `<div id="tarena-nav"></div>` and `<div id="tarena-footer"></div>` then call `TArenaUI.renderNav('<page-id>')` after loading `app.js`.
- Page IDs: `home`, `trade`, `portfolio`, `profile`, `auth`, `admin`.
- All `<link rel="icon">` point to `assets/favicon.svg`.
- TradingView symbols use the broker-prefixed format (`ASX:BHP`, `NASDAQ:AAPL`, `BINANCE:BTCUSDT`) — stored in `TArenaMarket.data[i].tv`.
- Money formatting goes through `TArenaUI.fmtMoney` / `fmtPct` for consistency.

## Local dev
```
python3 -m http.server 5000 --bind 0.0.0.0
```
Workflow `Start application` runs this automatically. Just refresh after edits.

## Deployment
Already configured as a static deployment with `publicDir = "."`. Click Publish to push live.
