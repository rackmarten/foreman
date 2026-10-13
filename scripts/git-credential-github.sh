#!/usr/bin/env bash
#
# git credential helper for foreman's HOST (the containers use
# `gh auth git-credential` with GH_TOKEN from their env_file instead, see the
# Dockerfile). It answers `get` for https://github.com with GH_TOKEN, the same
# token the containers use, so the host-side timers that fetch the workspace
# clone (weekly version check, ...) need no SSH key and no second secret.
# scripts/setup-host-git.sh installs it.
#
# GH_TOKEN comes from the environment, else from the checkout's
# secrets/global.env, else from its .env (the containers' env_file order:
# global.env wins). It never prints anything but the credential, and prints
# nothing at all for another host, another operation or a missing token, so
# git falls through to its next helper (none: the fetch fails, it never falls
# back to SSH or to someone else's gh login).
#
#   APP_DIR   the checkout holding secrets/ and .env (default: this script's repo)

set -euo pipefail

[ "${1:-}" = get ] || exit 0

protocol="" host=""
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in
    protocol=*) protocol="${line#protocol=}" ;;
    host=*) host="${line#host=}" ;;
  esac
done
[ "$protocol" = https ] && [ "$host" = github.com ] || exit 0

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# The last GH_TOKEN= line of an env file, without surrounding quotes.
from_file() {
  [ -r "$1" ] || return 0
  sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}GH_TOKEN=//p' "$1" | tail -n 1 \
    | sed "s/^\"\(.*\)\"$/\1/; s/^'\(.*\)'$/\1/"
}

token="${GH_TOKEN:-}"
[ -n "$token" ] || token="$(from_file "${APP_DIR}/secrets/global.env")"
[ -n "$token" ] || token="$(from_file "${APP_DIR}/.env")"
if [ -z "$token" ]; then
  echo "git-credential-github: no GH_TOKEN in the environment, ${APP_DIR}/secrets/global.env or ${APP_DIR}/.env" >&2
  exit 0
fi

printf 'protocol=https\nhost=github.com\nusername=x-access-token\npassword=%s\n' "$token"
