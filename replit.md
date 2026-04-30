# TradeArena

## Overview
TradeArena is a static multi-page paper-trading platform designed for Australian university students. It simulates trading on ASX, US stocks, and cryptocurrencies, providing a realistic environment for learning and practicing investment strategies without financial risk. The platform aims to foster financial literacy and trading skills among students through engaging features like leaderboards, strategy reels, curated learning modules, and a comprehensive trader scorecard. The project envisions becoming a leading educational tool in financial trading for students, bridging the gap between theoretical knowledge and practical application.

## User Preferences
I prefer simple language. I like functional programming. I want iterative development. Ask before making major changes. I prefer detailed explanations.

## System Architecture
TradeArena is built as a pure static HTML/CSS/JS application with no build step, ensuring fast loading and simple deployment. It uses a professional navy/gold theme.

### UI/UX Decisions
- **Theme**: Professional trader aesthetic with a navy and gold color scheme.
- **Navigation**: Icon + label navigation (`.ta-nav-link` pills) for Markets, Strategies (formerly Reels — file path `reels.html` retained for compatibility), Learn, Portfolio, Profile.
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
    - **Market Data**: `TArenaDatafeed` handles live market data. Crypto data directly from Binance public REST/WebSocket; stock data (ASX, US) via a `data-proxy` Edge Function.
    - **Charting**: `TArenaChart` dynamically mounts either TradingView Advanced Charts (if available) or Lightweight Charts as a fallback, with custom themes and data adapters.
    - **Quant Metrics**: `TArenaMetrics` provides pure math helpers for profile scorecard calculations (e.g., P&L, Sharpe, Drawdown).
    - **Reels Logic**: `TArenaReels` module contains taxonomy, position sizing, and risk-reward calculations.
- **Page-Specific Features**:
    - **Profile**: Trader scorecard displaying stats, equity curve, quant metrics, badges, and tabbed content (Strategies, Reels, Journal, Holdings) with granular privacy controls via `visibility_mask`.
    - **Trade**: Real-time market data integration, order entry panel, simulated order book, and "Snap to reel" chart capture feature.
    - **Reels Feed**: Displays strategy reels with filtering, search, live P&L, and mirror functionality. Implements windowed virtualization for performance.
    - **Reel Composer**: 5-step flow for creating and publishing strategy reels, including symbol selection, chart snapping, pin tagging, thesis definition, and visibility settings.
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