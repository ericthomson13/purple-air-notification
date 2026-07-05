#!/usr/bin/env bash
# Prints Telegram's current webhook registration for this bot, using
# TELEGRAM_BOT_TOKEN from .env. Useful for checking whether set-webhook.sh
# actually took effect.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN in .env first}"

curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | node -e '
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    console.log(JSON.stringify(JSON.parse(data), null, 2));
  });
'
