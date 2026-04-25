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
| `auth.html`      | Sign-in — student/public toggle, demo-mode 6-digit OTP |
| `trade.html`     | War Room — TradingView chart, watchlist, holdings, quick trade |
| `portfolio.html` | Portfolio — performance chart, allocation pie, holdings table, CSV export |
| `admin.html`     | Admin panel — registrations, university breakdown, demo-data tools (passphrase: `arena2026`) |

## Shared assets (`/assets`)
- `styles.css`  — design system (navy/gold tokens, nav, cards, tables, buttons, modal, forms)
- `app.js`     — `TArenaAuth` (demo-mode OTP via localStorage) + `TArenaUI` (renderNav, renderFooter, fmtMoney, fmtPct)
- `market.js`  — `TArenaMarket` (mock prices, holdings, watchlist, orders, tick simulator)
- `favicon.svg` — gold shield logo

## Auth model
Pure client-side demo. `TArenaAuth.sendOtp(email, type)` generates a 6-digit code, stores it in localStorage with a 10-minute expiry, and returns it so the auth page can display it in a "DEMO" banner. `verifyOtp(code)` matches it and creates a session in `localStorage['tarena_session']`. Trade & Portfolio call `TArenaAuth.requireAuth()` which redirects to `auth.html` when no session is present. The Account pill in the nav signs the user out.

For production, replace `TArenaAuth.sendOtp` and `verifyOtp` with calls to a real backend (Supabase, Firebase, or your own service).

## Conventions
- Every page must include `<div id="tarena-nav"></div>` and `<div id="tarena-footer"></div>` then call `TArenaUI.renderNav('<page-id>')` after loading `app.js`.
- Page IDs: `home`, `trade`, `portfolio`, `auth`, `admin`.
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
