#!/usr/bin/env bash
#
# installs (or updates) the host crontab entry that mirrors the
# operator's Claude rules into the containers' HOME every 15 minutes
# (scripts/sync-claude-rules.sh --apply). Same pattern as
# install-housekeeping-cron.sh: the entry is found by its marker comment and
# rewritten in place. deploy.sh runs this on every deploy.
#
#   CLAUDE_RULES_SCHEDULE  cron schedule, default "*/15 * * * *"

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEDULE="${CLAUDE_RULES_SCHEDULE:-*/15 * * * *}"
MARKER="# foreman-claude-rules (scripts/install-claude-rules-cron.sh)"
ENTRY="${SCHEDULE} cd ${APP_DIR} && mkdir -p state/logs && ./scripts/sync-claude-rules.sh --apply >> state/logs/sync-claude-rules.log 2>&1"

# Optional: a host without cron just runs it by hand.
if ! command -v crontab >/dev/null 2>&1; then
  echo "No crontab on this host; skipping the Claude rules cron entry."
  exit 0
fi

current="$(crontab -l 2>/dev/null || true)"
wanted="$(printf '%s\n' "$current" | awk -v m="${MARKER%%(*}(" 'index($0, m) == 1 { skip = 1; next } skip { skip = 0; next } { print }' | sed '/^$/d')"
wanted="$(printf '%s\n%s\n%s\n' "$wanted" "$MARKER" "$ENTRY" | sed '/^$/d')"

if [ "$current" = "$wanted" ]; then
  echo "Claude rules cron entry is up to date (${SCHEDULE})."
else
  printf '%s\n' "$wanted" | crontab -
  echo "Installed the Claude rules cron entry (${SCHEDULE}); log: ${APP_DIR}/state/logs/sync-claude-rules.log"
fi
