#!/usr/bin/env bash
#
# mirror the operator's Claude rules into the
# containers' HOME, so an edit reaches the runners and chat without a
# re-bootstrap. Exactly four entries are written into
# $APP_DIR/state/home/.claude:
#
#   CLAUDE.md      a stub importing claude-config's global.md and
#                  machines/foreman-runner.md from the workspace's
#                  <org>/claude-config clone, by its path inside the
#                  containers (/app/workspace/...), so they get the
#                  unattended rules, not the interactive ones marek's own
#                  ~/.claude/CLAUDE.md imports. The clone is fast-forwarded
#                  first. With no clone, marek's CLAUDE.md is mirrored
#                  instead, with a warning.
#   settings.json, agents/, skills/ (including skills/synced)
#                  mirrored from ${SEED_HOME:-$HOME}/.claude, symlinks
#                  followed.
#
# Nothing else: no credentials, projects/, plugins/ or runtime state.
#
# A file that differs is replaced atomically (temp file in the same directory,
# then mv), so a claude process starting mid-sync never reads half a file.
# Files and directories under the destination's agents/ and skills/ that are
# gone from the source are deleted. Idempotent: a second run reports 0
# changes. It never prints a file's contents.
#
# Runs on the foreman host as uid 1000 (marek), from the crontab entry
# scripts/install-claude-rules-cron.sh installs and from deploy.sh. Refuses to
# run inside a container (FOREMAN_SERVICE set), where it would mirror the
# container's own HOME into itself.
#
# Usage:
#   scripts/sync-claude-rules.sh [--apply]
#
#   --apply   write the changes; without it this is a dry run that lists them
#
# Environment (all optional):
#   SEED_HOME       whose ~/.claude is the source (default: $HOME)
#   APP_DIR         the checkout holding state/ (default: this script's repo)
#   CONTAINER_UID   the only uid allowed to run this (default: 1000)
#   FOREMAN_WORKSPACE_DIR  host side of the containers' /app/workspace mount
#                   (default: the value in $APP_DIR/.env, else ./workspace,
#                   relative to $APP_DIR, as in docker-compose.yml)
#   RULES_ORG       which <org>/claude-config to use (default: the first one)

set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "${FOREMAN_SERVICE:-}" ]; then
  echo "FOREMAN_SERVICE is set (${FOREMAN_SERVICE}): run this on the foreman host, not inside a container" >&2
  exit 1
fi
CONTAINER_UID="${CONTAINER_UID:-1000}"
if [ "$(id -u)" != "$CONTAINER_UID" ]; then
  echo "run this as uid ${CONTAINER_UID} (the containers' user), not uid $(id -u)" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SRC="${SEED_HOME:-$HOME}/.claude"
DEST="${APP_DIR}/state/home/.claude"
if [ ! -d "$SRC" ]; then
  echo "no $SRC to mirror from" >&2
  exit 1
fi

CHANGES=0
change() { CHANGES=$((CHANGES + 1)); echo "  $1 ${2#"$DEST"/}"; }

# Anything at <path> that is not a plain file (a directory, a symlink) goes
# first, so the new file does not land inside or through it.
clear_non_file() {
  if { [ -e "$1" ] || [ -L "$1" ]; } && { [ -L "$1" ] || [ ! -f "$1" ]; }; then
    rm -rf -- "$1"
  fi
}

sync_file() { # <src> <dest>
  local src="$1" dest="$2" tmp
  if [ -f "$dest" ] && [ ! -L "$dest" ] && cmp -s "$src" "$dest"; then return 0; fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then change "~" "$dest"; else change "+" "$dest"; fi
  [ "$APPLY" = 1 ] || return 0
  clear_non_file "$dest"
  mkdir -p "$(dirname "$dest")"
  tmp="$(mktemp "$(dirname "$dest")/.sync-claude-rules.XXXXXX")"
  cp -pL "$src" "$tmp"
  mv -f "$tmp" "$dest"
}

remove() { # <dest path>
  change "-" "$1"
  [ "$APPLY" = 1 ] && rm -rf -- "$1"
  return 0
}

sync_dir() { # <src dir> <dest dir>
  local src="$1" dest="$2" rel gone=""
  if [ ! -d "$src" ]; then
    if [ -e "$dest" ] || [ -L "$dest" ]; then remove "$dest"; fi
    return 0
  fi
  if [ -L "$dest" ] || { [ -e "$dest" ] && [ ! -d "$dest" ]; }; then
    remove "$dest"
  fi
  # Deletions first, top-down: a removed directory takes its children along,
  # so they are skipped rather than listed one by one.
  if [ -d "$dest" ] && [ ! -L "$dest" ]; then
    while IFS= read -r -d '' rel; do
      rel="${rel#./}"
      if [ -n "$gone" ] && [[ "$rel" == "$gone"/* ]]; then continue; fi
      if [ ! -e "$src/$rel" ] \
        || { [ -d "$src/$rel" ] && [ ! -d "$dest/$rel" ]; } \
        || { [ ! -d "$src/$rel" ] && [ -d "$dest/$rel" ]; }; then
        remove "$dest/$rel"
        gone="$rel"
      fi
    done < <(cd "$dest" && find . -mindepth 1 -print0)
  fi
  while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    if [ ! -d "$dest/$rel" ]; then
      change "+" "$dest/$rel/"
      [ "$APPLY" = 1 ] && mkdir -p "$dest/$rel"
    fi
  done < <(cd "$src" && find -L . -type d -print0)
  while IFS= read -r -d '' rel; do
    sync_file "$src/${rel#./}" "$dest/${rel#./}"
  done < <(cd "$src" && find -L . -type f -print0)
}

echo "mirror: ${SRC} -> ${DEST}$([ "$APPLY" = 1 ] || echo ' (dry run)')"
if [ "$APPLY" = 1 ] && [ ! -d "$DEST" ]; then
  mkdir -p "$DEST"
  chmod 700 "$DEST"
fi
# The containers mount the workspace at /app/workspace (docker-compose.yml);
# the host side moves with FOREMAN_WORKSPACE_DIR, read from .env like deploy.sh.
CONTAINER_WORKSPACE=/app/workspace
if [ -z "${FOREMAN_WORKSPACE_DIR:-}" ] && [ -f "$APP_DIR/.env" ]; then
  FOREMAN_WORKSPACE_DIR="$(sed -n 's/^FOREMAN_WORKSPACE_DIR=//p' "$APP_DIR/.env" | tail -n 1)"
fi
host_ws="${FOREMAN_WORKSPACE_DIR:-./workspace}"
[[ "$host_ws" == /* ]] || host_ws="$APP_DIR/${host_ws#./}"
rules_org="${RULES_ORG:-}"
if [ -z "$rules_org" ]; then
  for d in "$host_ws"/*/claude-config; do
    if [ -d "$d" ]; then rules_org="$(basename "$(dirname "$d")")"; break; fi
  done
fi
rules_host="$host_ws/${rules_org:-<org>}/claude-config"
# Pull before checking, so a file renamed upstream falls back this run rather
# than leaving a stub that imports nothing. Never prompts or hangs a deploy.
if [ "$APPLY" = 1 ] && [ -n "$rules_org" ] && [ -d "$rules_host/.git" ]; then
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10" \
    timeout 60 git -C "$rules_host" pull -q --ff-only \
    || echo "warning: could not fast-forward ${rules_host}, using it as it is" >&2
fi
if [ -n "$rules_org" ] && [ -f "$rules_host/global.md" ] && [ -f "$rules_host/machines/foreman-runner.md" ]; then
  rules_container="$CONTAINER_WORKSPACE/$rules_org/claude-config"
  stub="$(mktemp)"
  trap 'rm -f "$stub"' EXIT
  printf '%s\n' \
    "<!-- Written by foreman's scripts/sync-claude-rules.sh. Edit claude-config, not this file. -->" \
    "@${rules_container}/global.md" \
    "@${rules_container}/machines/foreman-runner.md" > "$stub"
  sync_file "$stub" "$DEST/CLAUDE.md"
  mirrored=(settings.json)
else
  echo "warning: no claude-config clone with global.md and machines/foreman-runner.md at ${rules_host}; mirroring ${SRC}/CLAUDE.md instead, whose imports may not resolve inside the containers" >&2
  mirrored=(CLAUDE.md settings.json)
fi
for f in "${mirrored[@]}"; do
  if [ -f "$SRC/$f" ]; then
    sync_file "$SRC/$f" "$DEST/$f"
  elif [ -e "$DEST/$f" ] || [ -L "$DEST/$f" ]; then
    remove "$DEST/$f"
  fi
done
sync_dir "$SRC/agents" "$DEST/agents"
sync_dir "$SRC/skills" "$DEST/skills"

echo "done: ${CHANGES} change(s)$([ "$APPLY" = 1 ] || echo ', dry run: re-run with --apply to write them')"
