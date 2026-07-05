#!/usr/bin/env bash
# Pushes any REQUIRED_VARS missing from the deployed Worker's secrets using
# values from .env. Run before `wrangler deploy` so a fresh clone can go
# from "filled in .env" to "fully configured" without manual `secret put`
# calls for every var every time.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REQUIRED_VARS=(PURPLEAIR_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET ADMIN_TOKEN)

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

existing="$(npx wrangler secret list 2>/dev/null | node -e '
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => {
    try {
      console.log(JSON.parse(data).map((s) => s.name).join("\n"));
    } catch {
      // no secrets yet, or wrangler not authenticated - treat as none set
    }
  });
')"

missing_no_value=()

for var in "${REQUIRED_VARS[@]}"; do
  if grep -qx "$var" <<<"$existing"; then
    echo "✓ $var already set on Cloudflare"
    continue
  fi

  value="${!var:-}"
  if [[ -z "$value" ]]; then
    missing_no_value+=("$var")
    continue
  fi

  echo "→ $var missing on Cloudflare, pushing from .env..."
  printf '%s' "$value" | npx wrangler secret put "$var" >/dev/null
  echo "✓ $var pushed"
done

if [[ ${#missing_no_value[@]} -gt 0 ]]; then
  echo ""
  echo "The following secrets are not set on Cloudflare and have no value in .env:"
  for var in "${missing_no_value[@]}"; do
    echo "  - $var"
  done
  echo ""
  echo "Fill them into .env (see .env.example) and re-run, or set them directly:"
  echo "  npx wrangler secret put <NAME>"
  exit 1
fi
