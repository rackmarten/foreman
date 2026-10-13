#!/usr/bin/env bash
#
# deploy foreman's runner as Docker Compose services.
# Builds the image, then brings up dispatch, chat and pipeline one at a time
# with --no-deps, so deploying one never disturbs the other two (the reason
# they were split into separate processes in #145/#160). A service that is
# busy keeps running the previously built code, exactly as under systemd.
#
#   scripts/deploy.sh                    normal deploy
#   scripts/deploy.sh --when-idle <svc>  internal: wait until <svc> is idle,
#                                        then bring it up (the self-deploy case)
#
# The first run after the cutover also retires each systemd --user unit as
# soon as that service is idle; see README "Rollback to the systemd units".
# A host without systemd has no units to retire; every systemctl
# call below is guarded or quiet, so the deploy is the same minus that step.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source-path=SCRIPTDIR source=lib/runner-services.sh
source "${APP_DIR}/scripts/lib/runner-services.sh"

LOG_DIR="${APP_DIR}/state/logs"
PINBOARD_URL="${PINBOARD_URL:-http://pinboard:8095}"
WHEN_IDLE_TIMEOUT="${WHEN_IDLE_TIMEOUT:-3600}"
WHEN_IDLE_INTERVAL="${WHEN_IDLE_INTERVAL:-10}"

# --- inside a runner container -------------------------------------------------
# deploy-service.sh reaches this script over SSH on the host, so the real
# self-deploy case is handled below by process tree. If it is ever run inside
# a container instead, the container has no checkout to build from and
# restarting its own service would kill it mid-run: hand the whole deploy to
# the host, detached so this process exiting does not take it along.
if [ -n "$(own_service)" ]; then
  host="${FOREMAN_HOST_SSH:-${HOMELAB_USER:-marek}@foreman}"
  echo "Running inside foreman's $(own_service) container; handing the deploy to ${host}."
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$host" \
    "cd /app && mkdir -p state/logs && setsid nohup ./scripts/deploy.sh >> state/logs/deploy-handoff.log 2>&1 < /dev/null &"
  echo "Handed off; the host's output goes to /app/state/logs/deploy-handoff.log."
  exit 0
fi

cd "$APP_DIR"
compose() { docker compose --project-directory "$APP_DIR" "$@"; }

# --- the service's current process tree ----------------------------------------

legacy_active() { systemctl --user is-active --quiet "$(legacy_unit "$1")" 2>/dev/null; }

# The pid of the service's `work` process, whichever runtime has it; empty
# when it is not running at all.
main_pid() {
  local svc="$1" pid cid
  if legacy_active "$svc"; then
    pid="$(systemctl --user show -p MainPID --value "$(legacy_unit "$svc")" 2>/dev/null || echo 0)"
    [ "$pid" != 0 ] && echo "$pid"
    return 0
  fi
  cid="$(compose ps -q --status running "$svc" 2>/dev/null || true)"
  [ -n "$cid" ] || return 0
  pid="$(docker inspect -f '{{.State.Pid}}' "$cid" 2>/dev/null || echo 0)"
  [ "$pid" != 0 ] && ps -eo pid=,ppid=,args= | container_main_pid "$pid"
  return 0
}

proc_busy() { [ -n "$1" ] && ps -eo pid=,ppid=,args= | tree_busy "$1"; }

# chat holds a claude child per OPEN THREAD, not per running turn,
# so the process test would call it busy whenever any thread is open and the
# deploy would silently change nothing. pinboard already knows whether a turn
# is running: a thread is awaitingAgent from a human's message until the
# agent's reply lands (a parked permission request or question included).
# taskId=none matches the daemon's own filter. Fails closed: an unreachable
# pinboard falls back to the process check, because cutting a live turn is
# worse than skipping a restart.
chat_busy() {
  local body open
  body="$(curl -sf -m 5 "${PINBOARD_URL}/api/chat/threads?status=open&awaitingAgent=true&taskId=none" 2>/dev/null)" || {
    echo "  (could not reach pinboard at ${PINBOARD_URL} - falling back to the process check)" >&2
    proc_busy "$1"
    return
  }
  open="$(printf '%s' "$body" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null)" || {
    echo "  (pinboard returned something unreadable - falling back to the process check)" >&2
    proc_busy "$1"
    return
  }
  [ "$open" != "0" ]
}

busy() { # <svc> <main pid>
  if [ "$1" = chat ]; then chat_busy "$2"; else proc_busy "$2"; fi
}

self_deploy() { [ -n "$1" ] && ps -eo pid=,ppid=,args= | tree_self_deploy "$1" foreman; }

# --- bringing a service up -----------------------------------------------------

# Stop the systemd unit this service replaces, then start it under compose.
# If compose cannot start it, put the unit back so the loop is never left
# running nowhere.
bring_up() {
  local svc="$1" unit
  unit="$(legacy_unit "$svc")"
  if [ -f "$HOME/.config/systemd/user/$unit" ]; then
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/$unit"
    systemctl --user daemon-reload
    echo "Retired the systemd unit $unit."
    # A session that kept going under the unit resumes from its end.
    ./scripts/bootstrap-container-state.sh --refresh-sessions >/dev/null \
      || echo "  (refreshing session transcripts failed; starting $svc anyway)" >&2
  fi
  if compose up -d --no-deps "$svc"; then
    echo "Brought up $svc on the new image."
  else
    if [ -f "systemd/$unit" ] && command -v systemctl >/dev/null 2>&1; then
      cp "systemd/$unit" "$HOME/.config/systemd/user/$unit"
      systemctl --user daemon-reload
      systemctl --user enable --now "$unit" || true
      echo "compose could not start $svc; re-enabled $unit so it keeps running." >&2
    fi
    return 1
  fi
}

when_idle() {
  local svc="$1" waited=0 idle=0 pid
  echo "$(date -Is) waiting for $svc to go idle (up to ${WHEN_IDLE_TIMEOUT}s)"
  while [ "$waited" -lt "$WHEN_IDLE_TIMEOUT" ]; do
    pid="$(main_pid "$svc")"
    # Idle twice in a row, one interval apart: a pipeline between two child
    # processes (deploy finished, stage not written yet) is not idle.
    if [ -n "$pid" ] && busy "$svc" "$pid"; then idle=0; else idle=$((idle + 1)); fi
    if [ "$idle" -ge 2 ]; then
      bring_up "$svc"
      echo "$(date -Is) done"
      return
    fi
    sleep "$WHEN_IDLE_INTERVAL"
    waited=$((waited + WHEN_IDLE_INTERVAL))
  done
  echo "$(date -Is) $svc never went idle; it keeps running the previously built code. Run scripts/deploy.sh again once it is." >&2
  return 1
}

if [ "${1:-}" = --when-idle ]; then
  when_idle "$2"
  exit
fi

# --- deploy --------------------------------------------------------------------

echo "Deploying ${HOSTNAME:-foreman} from ${APP_DIR}..."

# agent task workdirs, group-writable and setgid so a second
# license's Linux user can create its own.
mkdir -p "${WORK_TASK_ROOT:-/app/tasks}" "$LOG_DIR"
chmod 2775 "${WORK_TASK_ROOT:-/app/tasks}"

# Idempotent: seeds anything missing under state/. (The one-time move of the
# operator's ~/projects into workspace/, --migrate-workspace, is no longer run
# here, on a new machine it would take over an unrelated ~/projects.)
# FOREMAN_WORKSPACE_DIR moves the workspace mount; compose reads it from .env
# on its own, so the bootstrap has to see the same value.
if [ -z "${FOREMAN_WORKSPACE_DIR:-}" ] && [ -f .env ]; then
  FOREMAN_WORKSPACE_DIR="$(sed -n 's/^FOREMAN_WORKSPACE_DIR=//p' .env | tail -n 1)"
  export FOREMAN_WORKSPACE_DIR
fi
./scripts/bootstrap-container-state.sh
# the containers mirror the operator's CLAUDE.md, settings.json,
# agents/ and skills/; the cron entry below keeps them in step between deploys.
# Optional: a host with no ~/.claude of its own has nothing to
# mirror, and the containers keep their own.
CLAUDE_RULES=0
if [ -d "${SEED_HOME:-$HOME}/.claude" ]; then
  CLAUDE_RULES=1
  ./scripts/sync-claude-rules.sh --apply
else
  echo "No ${SEED_HOME:-$HOME}/.claude on this host; skipping the Claude rules mirror."
fi

# Every dependency is on the public npm registry: no build secret.
compose build

for svc in $RUNNER_SERVICES; do
  pid="$(main_pid "$svc")"
  running=0; is_busy=0; is_self=0
  if [ -n "$pid" ]; then
    running=1
    if busy "$svc" "$pid"; then is_busy=1; fi
    if self_deploy "$pid"; then is_self=1; fi
  fi
  case "$(deploy_action "$running" "$is_busy" "$is_self")" in
    start|restart)
      bring_up "$svc"
      ;;
    defer)
      # This deploy is running inside $svc's own tree (the pipeline deploying
      # foreman). Restarting it now kills the SSH session this script runs in
      # before it finishes, and the pipeline would redeploy on restart. A
      # detached waiter restarts it once the deploy has returned and the
      # stage has moved on.
      setsid nohup "${APP_DIR}/scripts/deploy.sh" --when-idle "$svc" >> "${LOG_DIR}/deploy-when-idle.log" 2>&1 < /dev/null &
      echo "$svc is running this deploy; it restarts on its own once idle"
      echo "  (log: ${LOG_DIR}/deploy-when-idle.log)."
      ;;
    skip)
      if legacy_active "$svc"; then
        # Cutover only: a service still on its systemd unit moves to compose
        # the first time it is idle, rather than waiting for the next deploy.
        setsid nohup "${APP_DIR}/scripts/deploy.sh" --when-idle "$svc" >> "${LOG_DIR}/deploy-when-idle.log" 2>&1 < /dev/null &
        echo "SKIPPED moving $svc to compose for now - work is in flight on"
        echo "  $(legacy_unit "$svc"), which keeps running the previously built code"
        echo "  until it is idle; a detached waiter moves it then"
        echo "  (log: ${LOG_DIR}/deploy-when-idle.log)."
        continue
      fi
      echo "SKIPPED restarting $svc - work is in flight. It keeps running the"
      echo "  previously built code until restarted. Once it is idle, run:"
      echo "    scripts/deploy.sh"
      ;;
  esac
done

# Housekeeping: a host crontab entry runs the compose profile nightly. It
# replaced foreman-housekeeping.timer, retired here if it is still installed.
for unit in foreman-housekeeping.timer foreman-housekeeping.service; do
  if [ -f "$HOME/.config/systemd/user/$unit" ]; then
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/$unit"
    systemctl --user daemon-reload
    echo "Retired the systemd unit $unit."
  fi
done
./scripts/install-housekeeping-cron.sh
# the host's own git (timers fetching the workspace clone) reaches
# GitHub over https with GH_TOKEN, like the containers.
./scripts/setup-host-git.sh
if [ "$CLAUDE_RULES" = 1 ]; then ./scripts/install-claude-rules-cron.sh; fi

echo "Deployment completed."
