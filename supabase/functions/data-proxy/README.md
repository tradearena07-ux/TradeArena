# `data-proxy` Edge Function

Fans out chart history + live quotes for the Trade page. Routes by symbol:

| Symbol pattern | Provider       | API key          |
|----------------|----------------|------------------|
| `*.AX`         | Yahoo Finance  | none             |
| `BTC`/`ETH`/…  | Binance public | none             |
| anything else  | Finnhub        | `FINNHUB_API_KEY` (free tier) |

Bars are cached into `public.price_bars` so repeated history requests and bar-replay don't re-hit upstream.

## Deploy

```bash
# install the Supabase CLI once
npm install -g supabase

# log in & link
supabase login
supabase link --project-ref chncykagtzotdtflkhim

# set the only required secret
supabase secrets set FINNHUB_API_KEY=YOUR_KEY_HERE   # https://finnhub.io/register

# deploy
supabase functions deploy data-proxy
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-injected by Supabase — do **not** set them yourself.

## Smoke test

```bash
curl -X POST "$SUPABASE_URL/functions/v1/data-proxy" \
  -H "Authorization: Bearer $SUPABASE_PUBLISHABLE_KEY" \
  -H "content-type: application/json" \
  -d '{"action":"quote","symbols":["BHP.AX","AAPL","BTC"]}'
```

Expected response shape:

```json
{ "s": "ok", "quotes": { "BHP.AX": {"price": 43.82, "change": 0.86, "changePct": 2.0}, … } }
```

## Local dev

```bash
supabase functions serve data-proxy --env-file .env.local
```
