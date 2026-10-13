#!/usr/bin/env bash

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

echo "Running health check for ${HOSTNAME:-project}..."

compose() { docker compose --project-directory "$APP_DIR" "$@"; }

# The chat service is deliberately not checked here: it is allowed to be down
# (a thread just waits), whereas a dispatcher or pipeline poller that is down
# silently stops all autonomous work - queued tasks never start, and merged
# work never reaches its LXC.
#
# A service still on its systemd unit counts as up, but only while the
# cutover is pending: deploy.sh retires the unit the first time the service is
# idle, and a self-deploying pipeline is still on its unit when the pipeline
# runs this check.
for svc in dispatch pipeline; do
  if [ -n "$(compose ps -q --status running "$svc")" ]; then
    echo "$svc is running."
  elif systemctl --user is-active --quiet "foreman-$svc.service" 2>/dev/null; then
    echo "$svc is still on foreman-$svc.service (cutover pending; see README)."
  else
    echo "$svc is not running." >&2
    exit 1
  fi
done

# Reaches pinboard with the image's own work CLI and the containers' env,
# so this also proves the image and its config are usable.
compose run --rm --no-deps -T dispatch work task list >/dev/null

echo "Health check passed."
