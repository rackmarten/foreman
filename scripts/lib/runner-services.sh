# shellcheck shell=bash
#
# the decisions scripts/deploy.sh and
# scripts/healthcheck.sh make about foreman's three runner services, kept
# apart from the docker/systemctl calls so scripts/runner-services.test.mjs can
# drive them with fixture process tables. Sourced, never run.
#
# A process table is `ps -eo pid=,ppid=,args=` output: one "PID PPID ARGS"
# row per process. The host sees every container's processes in it too.

# shellcheck disable=SC2034 # used by the scripts that source this
RUNNER_SERVICES="dispatch chat pipeline"

# The systemd --user unit each service replaced (rollback and cutover only).
legacy_unit() { echo "foreman-$1.service"; }

# Every descendant pid of <pid> (not <pid> itself), one per line.
# stdin: process table.
descendants() {
  awk -v root="$1" '
    { parent[$1] = $2; order[NR] = $1 }
    END {
      keep[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= NR; i++) {
          p = order[i]
          if (!(p in keep) && (parent[p] in keep)) { keep[p] = 1; changed = 1 }
        }
      }
      for (i = 1; i <= NR; i++) if (order[i] != root && (order[i] in keep)) print order[i]
    }'
}

# The work process a container runs: compose starts it under `init: true`, so
# the container's own pid 1 (<init_pid> as the host sees it) is docker-init and
# `work` is its child. stdin: process table.
container_main_pid() {
  awk -v init="$1" '$2 == init { print $1; exit }'
}

# Busy means the service's work process has a child: for dispatch a live
# claude session, for pipeline a merge, deploy or healthcheck. This is the
# systemd-era unit_busy test unchanged, just fed from a process table.
# stdin: process table.
tree_busy() {
  awk -v main="$1" 'BEGIN { busy = 1 } $2 == main { busy = 0 } END { exit busy }'
}

# True when <main_pid>'s tree is running a deploy of <repo> itself: that is
# this deploy, reached over SSH from inside the service (the pipeline runs
# deploy-service.sh foreman, which SSHes back here and runs deploy.sh).
# Restarting that service now would kill the SSH client, and with it the rest
# of this very deploy. stdin: process table.
tree_self_deploy() {
  local table pids
  table="$(cat)"
  pids=" $(descendants "$1" <<<"$table" | tr '\n' ' ') "
  awk -v repo="$2" -v pids="$pids" '
    index(pids, " " $1 " ") {
      n = split($0, a, /[ \t]+/)
      for (i = 1; i < n; i++) {
        if (a[i] ~ /(^|\/)deploy-service\.sh$/) {
          for (j = i + 1; j <= n; j++) if (a[j] == repo) found = 1
        }
      }
    }
    END { exit found ? 0 : 1 }
  ' <<<"$table"
}

# Inside one of the runner containers, which service it is. compose sets
# FOREMAN_SERVICE per service; the marker file (/.dockerenv) guards against a
# stray FOREMAN_SERVICE in a host shell. Prints nothing on the host.
own_service() {
  if [ -n "${FOREMAN_SERVICE:-}" ] && [ -e "${FOREMAN_CONTAINER_MARKER:-/.dockerenv}" ]; then
    echo "$FOREMAN_SERVICE"
  fi
}

# What deploy.sh does with one service:
#   start   - not running under compose yet (clean checkout, or cutover)
#   restart - running and idle: recreate it on the new image
#   defer   - busy with this very deploy: restart it from a detached process
#             once it is idle, and report success now
#   skip    - busy with other work: leave it on the old code and say so
deploy_action() { # <running 0|1> <busy 0|1> <self 0|1>
  if [ "$1" != 1 ]; then echo start
  elif [ "$2" != 1 ]; then echo restart
  elif [ "$3" = 1 ]; then echo defer
  else echo skip
  fi
}
