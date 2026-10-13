#!/usr/bin/env bash
#
# nightly disk and Claude Code upkeep for foreman. Since a past task
# it runs as the compose `housekeeping` profile, started by a host crontab
# entry (scripts/install-housekeeping-cron.sh), and prunes the HOST's docker
# daemon through the mounted socket. On 2026-09-28 the disk hit 98% of 32G, mostly
# docker images/build cache/anonymous volumes left by agent test runs and the
# npm cache. (Task workdirs are the dispatcher's job, see runner.ts's
# sweepTaskWorkdirs.)
#
# Dry run by default: prints what it would run and changes nothing. --apply
# prunes docker and verifies the npm cache.
#
# The Claude Code CLI comes from the image (CLAUDE_CODE_VERSION in the
# Dockerfile), so there is nothing to `claude update`. Instead it reports the
# installed version and warns when npm has a newer one: an outdated CLI is an
# infra failure (#440), and the fix is bumping that build arg.

set -euo pipefail

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  *) echo "usage: $0 [--apply]" >&2; exit 2 ;;
esac

export PATH="$HOME/.local-node/bin:$PATH"
run() {
  echo "+ $*"
  if (( APPLY )); then "$@" || echo "  (failed with exit $?, continuing)"; fi
}

df_line() {
  echo "df $1: $(df -h --output=used,avail,pcent / | tail -n1 | xargs)"
}

df_line before

echo "== docker"
if command -v docker >/dev/null 2>&1; then
  docker system df || true
  run docker container prune -f --filter until=24h
  run docker image prune -a -f --filter until=72h
  run docker builder prune -f --filter until=72h
  # Since Docker 23 `volume prune` only removes anonymous volumes; named
  # volumes need --all, which is deliberately not passed.
  run docker volume prune -f
else
  echo "docker not installed, skipping"
fi

echo "== npm"
run npm cache verify

echo "== claude version"
bin="${CLAUDE_BIN:-claude}"
installed="$("$bin" --version 2>/dev/null | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"
latest="$(npm view @anthropic-ai/claude-code version 2>/dev/null || true)"
echo "claude installed: ${installed:-unknown}, latest published: ${latest:-unknown}"
if [ -n "$installed" ] && [ -n "$latest" ] && [ "$installed" != "$latest" ] \
  && [ "$(printf '%s\n%s\n' "$installed" "$latest" | sort -V | tail -n1)" = "$latest" ]; then
  echo "WARNING: claude ${installed} is older than the published ${latest}. Bump CLAUDE_CODE_VERSION in the Dockerfile and redeploy."
fi

df_line after
docker system df 2>/dev/null || true
