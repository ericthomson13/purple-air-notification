#!/usr/bin/env bash
# Points git at the tracked .githooks/ directory instead of the untracked
# .git/hooks/ - runs automatically via `npm install` (the `prepare` script),
# so every clone gets the pre-push check without a manual setup step.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

git config core.hooksPath .githooks
echo "Git hooks path set to .githooks/ (pre-push runs typecheck + tests)."
