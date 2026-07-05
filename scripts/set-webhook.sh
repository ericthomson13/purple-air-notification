#!/usr/bin/env bash
# Registers the Worker's /webhook/telegram endpoint with Telegram's
# setWebhook API, using TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET /
# WORKER_URL from .env. This is a one-time step (re-run if the token,
# webhook secret, or Worker URL ever change).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN in .env first}"
: "${TELEGRAM_WEBHOOK_SECRET:?Set TELEGRAM_WEBHOOK_SECRET in .env first}"
: "${WORKER_URL:?Set WORKER_URL in .env first (e.g. https://purple-air-notification.<subdomain>.workers.dev)}"

response="$(curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${WORKER_URL}/webhook/telegram" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]')"

echo "$response"

if ! echo "$response" | grep -q '"ok":true'; then
  echo "" >&2
  echo "setWebhook did not report ok:true - see response above." >&2
  exit 1
fi

echo ""
echo "Webhook set to ${WORKER_URL}/webhook/telegram"
