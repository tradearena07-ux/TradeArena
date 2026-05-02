# TradeArena

## Overview
TradeArena is a static multi-page paper-trading platform designed for Australian university students. It simulates trading on ASX, US stocks, and cryptocurrencies, providing a realistic environment for learning and practicing investment strategies without financial risk. The platform aims to foster financial literacy and trading skills among students through engaging features like leaderboards, strategy reels, curated learning modules, and a comprehensive trader scorecard. The project envisions becoming a leading educational tool in financial trading for students, bridging the gap between theoretical knowledge and practical application.

## User Preferences
I prefer simple language. I like functional programming. I want iterative development. Ask before making major changes. I prefer detailed explanations.

## System Architecture
TradeArena is built as a pure static HTML/CSS/JS application with no build step, ensuring fast loading and simple deployment. It uses a professional navy/gold theme.

### UI/UX Decisions
- **Theme**: Professional trader aesthetic with a navy and gold color scheme.
- **Navigation**: Icon + label navigation (`.ta-nav-link` pills) for Markets, Learn (file path `reels.html` retained for compatibility), School, Portfolio, Profile. A live ticker strip (BTC/ETH/AAPL/BHP.AX) marquees above the glass-blur sticky nav.
- **Footer**: 4-column company footer with product, company, legal, brand, social links, a paper-trading risk disclaimer, copyright, and a sign-in nudge for unauthenticated users.
- **Logo**: Transparent monoline gold shield with a chart spark.
- **Typography**: Uses DM Sans exclusively for a clean, modern look.
- **Numeric Display**: Tabular alignment for numbers using `font-feature-settings:'tnum'`.
- **Modals**: Standardized modal components for actions like editing profiles.

### Technical Implementations
- **Stack**: Pure static HTML/CSS/JS, served by Python `http.server` in development.
- **Authentication & Database**: Supabase (Postgres + Auth, RLS-protected) via `@supabase/supabase-js` UMD bundle.
- **Core Libraries**:
    - **TradingView Widget**: Integrated for advanced charting capabilities.
    - **Chart.js**: Used for various data visualizations, notably equity curves.
    - **Font Awesome**: For icons.
    - **Google Fonts**: DM Sans.
- **Auth Model**:
    - **First-time signup**: Email-OTP verification followed by username and password creation, and profile data submission.
    - **Returning user login**: Username/email and password.
    - **Forgot password**: Email-OTP verification for password reset.
    - **Security**: Supabase RLS policies enforce authorization; publishable key is client-side safe.
- **Data Handling**:
    - **Market Data**: `TArenaDatafeed` handles live market data. Crypto data directly from Binance public REST/WebSocket; stock data (ASX, US) via a `data-proxy` Edge Function (deploy with `bash scripts/deploy-data-proxy.sh` after setting `SUPABASE_ACCESS_TOKEN` and `FINNHUB_API_KEY` secrets).
    - **Charting**: `TArenaChart` dynamically mounts either TradingView Advanced Charts (if available) or Lightweight Charts as a fallback, with custom themes and data adapters. The Lightweight Charts surface on `trade.html` calls `TArenaDatafeed.fetchBars` for real OHLCV (Binance for crypto, proxy for ASX/US) and falls back to a synthetic seeded random walk when the upstream is unreachable.
    - **Trade page tabs**: The top sub-tabs (ASX / US Stocks / Crypto / Forex) auto-jump the chart symbol to a market-default (BHP.AX / AAPL / BTC / AUDUSD) and filter the Markets browser below; ALL MARKETS leaves the chart alone.
    - **Markets data backfill**: Stock tables (ASX/US) get 52w high/low + day volume from Yahoo's `/v8/finance/chart` endpoint (no API key, CORS-friendly) via `fetchExtendedSnapshots()`. Fetched lazily on first ASX/US tab open, throttled to 4 concurrent requests, cached 5min per symbol. Also doubles as ASX price/change fallback when the Supabase data-proxy edge function isn't deployed. Most Traded cards show a "Vol" row sourced from `_vol` (stocks) or CoinGecko's `total_volume` (crypto).
    - **Quant Metrics**: `TArenaMetrics` provides pure math helpers for profile scorecard calculations (e.g., P&L, Sharpe, Drawdown).
    - **Reels Logic**: `TArenaReels` module contains taxonomy, position sizing, and risk-reward calculations.
- **Page-Specific Features**:
    - **Profile**: Trader scorecard displaying stats, equity curve, quant metrics, badges, and tabbed content (Strategies, Reels, Journal, Holdings) with granular privacy controls via `visibility_mask`.
    - **Trade**: Real-time market data integration, order entry panel, simulated order book, and "Snap to reel" chart capture feature.
    - **Learn Feed (`reels.html`)**: Instagram-style lesson grid with hero banner ("Teach Trading. Build Your Audience."), four tabs (For You / Following / Trending / New), search bar, responsive card grid (chart snapshot, single gold subject pill, symbol + direction badge, creator avatar/handle/follower count, 2-line thesis, Entry/Stop/Target mini-table, live P&L pill, Watch/Mirror/Save/Share action row, hover Follow CTA), and a 280px right rail showing "Top Educators This Week" + "Most Mirrored Strategies" derived client-side from loaded rows. Mirror sheet + deep-link `?reel=<uuid>` preserved.
    - **Creator Studio (`reels-new.html`)**: 3-step wizard (Trade Setup → Add Chart → Write Thesis) with progress bar, sticky live preview rail, and creator benefits callout. Step 1: symbol search, LONG/SHORT pill toggle, four number inputs (Entry/Stop/Target/Risk%), live R:R verdict, timeframe selector. Step 2: drag-drop upload OR Snap-from-TradeArena, max 5 numbered pin annotations with free-text labels. Step 3: 280-char thesis, single subject dropdown, public/followers/private visibility, full-width gold Publish button. Subject + timeframe + pin labels are mapped onto the existing `tags[]` schema (strategy/indicator types) so `publish_reel` RPC needs no backend changes.
    - **Portfolio**: Groww-style portfolio overview with performance charts, asset allocation, holdings list, and top movers.
    - **Schools**: Curated learning modules with reels playlists, quizzes, and paper-trade challenges, progressive unlocking based on completion.
    - **Admin Panel**: For managing registrations, universities, and schools (modules, quizzes, challenges).
- **Client-side Storage**: Uses `localStorage` for session management, pending states (e.g., chart snaps), and user preferences (watchlist).

### Feature Specifications
- **Multi-market Support**: ASX, US stocks, and cryptocurrencies.
- **Paper Trading**: Simulated trading with a starting capital of $25,000.
- **Leaderboard**: Displays top traders.
- **Strategy Reels**: Users can create and share trading strategies with chart annotations.
- **Learning Modules**: Structured educational content with quizzes and challenges to unlock perks.
- **Trader Scorecard**: Detailed performance analytics, social features (follow/unfollow), and customizable privacy settings.
- **Real-time Data**: Live price updates for quotes and charts.
- **Order Management**: Simulated order entry and execution.
- **Responsive Design**: Adapts to different screen sizes.

## External Dependencies
- **Supabase**: For database (Postgres), authentication, and Edge Functions.
- **TradingView**: Advanced Charts library (licensed) or Lightweight Charts (CDN) for interactive charting.
- **Chart.js**: For rendering performance graphs and allocation charts.
- **Font Awesome**: Icon library.
- **Google Fonts**: DM Sans.
- **Binance API**: Public REST and WebSocket for cryptocurrency market data.
- **Finnhub**: (via `data-proxy` Edge Function) for US stock market data.
- **Yahoo Finance**: (via `data-proxy` Edge Function) for ASX market data.