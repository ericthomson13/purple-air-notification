#!/usr/bin/env bash
# Configures the bot's command list and description via Telegram's Bot API
# directly (setMyCommands / setMyDescription / setMyShortDescription) -
# achieves the same result as configuring through @BotFather's chat
# commands, but scriptable and safe to re-run any time (idempotent).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${TELEGRAM_BOT_TOKEN:?Set TELEGRAM_BOT_TOKEN in .env first}"

echo "Setting command list..."
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{
    "commands": [
      {"command": "locations", "description": "List available locations"},
      {"command": "subscribe", "description": "Get alerts for a location, e.g. /subscribe leadville-co"},
      {"command": "addlocation", "description": "Add a new location and subscribe, e.g. /addlocation boulder-co"},
      {"command": "removelocation", "description": "Remove a location you added"},
      {"command": "unsubscribe", "description": "Stop alerts for a location"},
      {"command": "status", "description": "Show your subscriptions and current AQI"}
    ]
  }'
echo ""

echo "Setting bot description (shown before /start)..."
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyDescription" \
  -H "Content-Type: application/json" \
  -d '{"description": "Get a Telegram alert when the air quality (AQI) at a location crosses 50/100/150/200/300, in either direction. Powered by PurpleAir community sensors. Send /start to begin."}'
echo ""

echo "Setting bot short description (profile/share previews)..."
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyShortDescription" \
  -H "Content-Type: application/json" \
  -d '{"short_description": "AQI threshold alerts for your area, powered by PurpleAir."}'
echo ""

echo "Done."
