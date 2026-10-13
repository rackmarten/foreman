#!/usr/bin/env bash
#
# installs (or updates) the host crontab entry that runs the
# compose `housekeeping` profile nightly, replacing foreman-housekeeping.timer.
# Idempotent: the entry is found by its marker comment and rewritten in place.
# deploy.sh runs this on every deploy.
#
#   HOUSEKEEPING_SCHEDULE  cron schedule, default "30 4 * * *" (04:30)

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEDULE="${HOUSEKEEPING_SCHEDULE:-30 4 * * *}"
MARKER="# foreman-housekeeping (scripts/install-housekeeping-cron.sh)"
ENTRY="${SCHEDULE} cd ${APP_DIR} && mkdir -p state/logs && docker compose --profile housekeeping run --rm housekeeping >> state/logs/housekeeping.log 2>&1"

# Optional: a host without cron just runs it by hand.
if ! command -v crontab >/dev/null 2>&1; then
  echo "No crontab on this host; skipping the housekeeping cron entry."
  exit 0
fi

current="$(crontab -l 2>/dev/null || true)"
wanted="$(printf '%s\n' "$current" | awk -v m="${MARKER%%(*}(" 'index($0, m) == 1 { skip = 1; next } skip { skip = 0; next } { print }' | sed '/^$/d')"
wanted="$(printf '%s\n%s\n%s\n' "$wanted" "$MARKER" "$ENTRY" | sed '/^$/d')"

if [ "$current" = "$wanted" ]; then
  echo "Housekeeping cron entry is up to date (${SCHEDULE})."
else
  printf '%s\n' "$wanted" | crontab -
  echo "Installed the housekeeping cron entry (${SCHEDULE}); log: ${APP_DIR}/state/logs/housekeeping.log"
fi
