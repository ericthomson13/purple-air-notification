#!/usr/bin/env bash
# Sends a Telegram DM to ADMIN_CHAT_ID announcing a successful deploy, with
# the version currently in package.json. Wired as the `postdeploy` npm
# lifecycle hook, so it only runs after `npm run deploy` exits 0 - a failed
# deploy never reaches this script. Silently skipped if TELEGRAM_BOT_TOKEN
# or ADMIN_CHAT_ID aren't set (e.g. no admin chat configured).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${ADMIN_CHAT_ID:-}" ]]; then
  echo "· Skipping deploy notification (TELEGRAM_BOT_TOKEN or ADMIN_CHAT_ID not set)"
  exit 0
fi

VERSION="$(node -p "require('./package.json').version")"

curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${ADMIN_CHAT_ID}" \
  -d "text=✅ purple-air-notification deployed successfully — version ${VERSION}" \
  >/dev/null

echo "✓ Sent deploy notification (version ${VERSION})"
