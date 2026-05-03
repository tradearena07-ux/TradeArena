#!/usr/bin/env bash
# ============================================================
# Deploy the `data-proxy` Supabase Edge Function.
# ============================================================
# Required secrets (set them in Replit -> Tools -> Secrets, or
# export them in your shell before running):
#   SUPABASE_ACCESS_TOKEN   personal access token (sbp_...)
#                           https://supabase.com/dashboard/account/tokens
#   FINNHUB_API_KEY         free key from https://finnhub.io/register
#                           (only needed for live US stock quotes)
#
# Usage:
#   bash scripts/deploy-data-proxy.sh
# ============================================================
set -euo pipefail

PROJECT_REF="chncykagtzotdtflkhim"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "  Get one at https://supabase.com/dashboard/account/tokens" >&2
  echo "  Then add it as a Replit Secret called SUPABASE_ACCESS_TOKEN." >&2
  exit 1
fi

# Install the Supabase CLI on demand if it isn't already available.
if ! command -v supabase >/dev/null 2>&1; then
  echo "Supabase CLI not found — installing via npx (one-shot)…"
  SUPA="npx --yes supabase@latest"
else
  SUPA="supabase"
fi

echo "Linking project $PROJECT_REF…"
$SUPA link --project-ref "$PROJECT_REF" >/dev/null

if [[ -n "${FINNHUB_API_KEY:-}" ]]; then
  echo "Setting FINNHUB_API_KEY secret on the function…"
  $SUPA secrets set FINNHUB_API_KEY="$FINNHUB_API_KEY" >/dev/null
else
  echo "WARNING: FINNHUB_API_KEY is not set — US stock quotes will be empty." >&2
  echo "         ASX (Yahoo) and crypto (Binance) will still work." >&2
fi

echo "Deploying data-proxy…"
$SUPA functions deploy data-proxy --no-verify-jwt

echo
echo "Smoke-testing /v1/data-proxy…"
SUPABASE_URL="https://$PROJECT_REF.supabase.co"
# Pull the publishable (anon) key out of assets/config.js without
# tangled escaping — single-quoted patterns keep $ and quotes literal.
PUB_KEY="$(sed -n "s/.*supabaseKey:[[:space:]]*'\([^']*\)'.*/\1/p" assets/config.js | head -n1)"
if [[ -z "$PUB_KEY" ]]; then
  echo "WARNING: could not parse supabaseKey from assets/config.js — skipping smoke test." >&2
else
  RESPONSE="$(curl -sS -X POST "$SUPABASE_URL/functions/v1/data-proxy" \
    -H "Authorization: Bearer $PUB_KEY" \
    -H "apikey: $PUB_KEY" \
    -H "content-type: application/json" \
    -d '{"action":"quote","symbols":["BHP.AX","AAPL","BTC"]}')"
  echo "$RESPONSE" | head -c 600
  echo
  if echo "$RESPONSE" | grep -q '"s":"ok"'; then
    echo
    echo "Smoke test PASSED — function is live."
  else
    echo "Smoke test FAILED — response above does not contain {\"s\":\"ok\"}." >&2
    exit 2
  fi
fi
echo
echo "Done. Reload tradearena.com.au/trade.html to see live ASX + US prices."
