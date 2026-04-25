# TradeArena

A static multi-page website for TradeArena — a paper-trading platform for ASX stocks, US shares, and crypto with campus leaderboards.

## Project Structure

- `index.html` — Landing page
- `auth.html` — Sign in / sign up
- `trade.html` — Trading interface
- `portfolio.html` — User portfolio
- `admin.html` — Admin panel

External dependencies are loaded from CDNs (Google Fonts, Font Awesome, Supabase JS).

## Running Locally

The site is served by Python's built-in HTTP server:

```
python3 -m http.server 5000 --bind 0.0.0.0
```

This runs as the `Start application` workflow on port 5000.

## Deployment

Configured as a static deployment serving from the project root.
