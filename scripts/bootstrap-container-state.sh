#!/usr/bin/env bash
#
# create the persistent state the foreman containers
# run on, under the checkout (/app on foreman). A rebuild restores these
# directories from backup, or runs this to seed them again:
#
#   state/home   HOME for every container process: .ssh, .gitconfig,
#                .claude and .claude.json
#   workspace    THE workspace clone (<org>/<repo>), bind-mounted at
#                /app/workspace; the operator's ~/projects becomes a symlink
#                to it (decision 2 in #514)
#
# Idempotent: an existing non-empty file is never overwritten unless --force
# is passed, so a second run changes nothing. It never prints a file's
# contents, so no secret reaches the terminal or a log.
#
# Run it as the user the containers run as (uid 1000, marek on foreman), not
# as root: that is what gives every file the right owner without a chown.
#
# Usage:
#   scripts/bootstrap-container-state.sh [--force] [--migrate-workspace]
#
#   --force              overwrite files that already exist in state/home
#   --refresh-sessions   update .claude/projects transcripts that are newer on
#                        the host than in state/home. Run it at the cutover,
#                        after the systemd units stop, so a session that kept
#                        running after the first seed resumes from its end.
#   --migrate-workspace  move the operator's workspace clone (SEED_WORKSPACE)
#                        into workspace/ and leave a symlink in its place. Only
#                        when workspace/ is still empty; never merges.
#   --merge-seed <tar>   only merge a tarball of another seat's
#                        ~/.claude/projects (top-level dir projects/) into
#                        state/home/.claude, then alias its sessions, and stop.
#                        Never overwrites an existing file and never replaces
#                        an alias symlink with a real directory. Set
#                        SEED_WORKSPACE to the workspace path the seed's
#                        sessions ran in (on foreman: /home/marek/projects).
#
# Environment (all optional):
#   SEED_HOME         where the operator's own .ssh/.claude/git config live
#                     (default: $HOME)
#   SEED_WORKSPACE    the operator's workspace clone (default: $SEED_HOME/projects)
#   SSH_KEY           private key to seed (default: $SEED_HOME/.ssh/id_ed25519;
#                     decision 4 keeps the operator's key until foreman has its own)
#   GIT_USER_NAME, GIT_USER_EMAIL
#                     the container's git identity; default is the invoking
#                     user's own `git config --global` values
#   CONTAINER_UID     uid the containers run as (default: 1000)
#   APP_DIR           the checkout holding state/ and workspace/ (default:
#                     this script's repo)
#   FOREMAN_WORKSPACE_DIR
#                     the workspace clone's host path, as docker-compose.yml
#                     mounts it (default: $APP_DIR/workspace)

set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

FORCE=0
MIGRATE=0
REFRESH=0
MERGE_SEED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --migrate-workspace) MIGRATE=1 ;;
    --refresh-sessions) REFRESH=1 ;;
    --merge-seed)
      [ $# -ge 2 ] || { echo "--merge-seed needs a tarball" >&2; exit 2; }
      MERGE_SEED="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
STATE_HOME="${APP_DIR}/state/home"
WORKSPACE_DIR="${FOREMAN_WORKSPACE_DIR:-${APP_DIR}/workspace}"
SEED_HOME="${SEED_HOME:-$HOME}"
SEED_WORKSPACE="${SEED_WORKSPACE:-${SEED_HOME}/projects}"
SSH_KEY="${SSH_KEY:-${SEED_HOME}/.ssh/id_ed25519}"
CONTAINER_UID="${CONTAINER_UID:-1000}"

if [ "$(id -u)" != "$CONTAINER_UID" ]; then
  echo "run this as uid ${CONTAINER_UID} (the containers' user), not uid $(id -u)" >&2
  exit 1
fi

CHANGES=0
changed() { CHANGES=$((CHANGES + 1)); echo "  + $*"; }
note() { echo "  - $*"; }

# A file may be written when it is missing or empty, or with --force.
writable() { [ "$FORCE" = 1 ] || [ ! -s "$1" ]; }

ensure_dir() { # <path> <mode>
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
    changed "created $1"
  fi
  # Permission bits only: a setgid parent directory is not a mode change.
  if [ "$(printf '%o' $((8#$(stat -c %a "$1") & 8#777)))" != "$2" ]; then
    chmod "$2" "$1"
    changed "chmod $2 $1"
  fi
}

seed_file() { # <src> <dest> <mode>
  local src="$1" dest="$2" mode="$3"
  if [ ! -s "$src" ]; then
    note "no $src to seed $dest from"
    return
  fi
  if writable "$dest" && ! cmp -s "$src" "$dest"; then
    install -m "$mode" "$src" "$dest"
    changed "seeded $dest"
  fi
}

# Claude keys a session's transcripts by its cwd. A chat session started in
# the old workspace path is filed under that path's name; alias it under the
# new one so `--resume` finds it from /app/workspace too. Only for a moved
# workspace, and only where the new name is still free.
alias_sessions() { # <projects dir>
  local dir="$1" old new entry name target
  [ -d "$dir" ] || return 0
  old="$(printf '%s' "$SEED_WORKSPACE" | sed 's/[^A-Za-z0-9]/-/g')"
  new="$(printf '%s' "$WORKSPACE_DIR" | sed 's/[^A-Za-z0-9]/-/g')"
  [ "$old" != "$new" ] || return 0
  shopt -s nullglob
  for entry in "$dir/$old" "$dir/$old"-*; do
    if [ ! -d "$entry" ] || [ -L "$entry" ]; then continue; fi
    name="$(basename "$entry")"
    target="$dir/${new}${name#"$old"}"
    if [ ! -e "$target" ] && [ ! -L "$target" ]; then
      ln -s -- "$name" "$target"
      changed "aliased sessions $name as $(basename "$target")"
    fi
  done
  shopt -u nullglob
}

# --- seed merge (--merge-seed) ------------------------------------------------
# Extracts only projects/. --skip-old-files leaves every existing file alone;
# --keep-directory-symlink keeps an alias like -app-workspace-foo a symlink
# instead of turning it into a real directory. Then the seed's sessions under
# the old workspace path get their alias like any other.
if [ -n "$MERGE_SEED" ]; then
  if [ ! -f "$MERGE_SEED" ]; then
    echo "no seed tarball at $MERGE_SEED" >&2
    exit 1
  fi
  dest="$STATE_HOME/.claude"
  echo "merging ${MERGE_SEED} into ${dest}"
  ensure_dir "$dest" 700
  count() { find "$dest/projects" -type f 2>/dev/null | wc -l; }
  before="$(count)"
  tar -x -f "$MERGE_SEED" -C "$dest" --skip-old-files --keep-directory-symlink --no-same-owner projects
  added=$(( $(count) - before ))
  [ "$added" -gt 0 ] && changed "merged ${added} new file(s) from ${MERGE_SEED}"
  alias_sessions "$dest/projects"
  echo "done: ${CHANGES} change(s)"
  exit 0
fi

echo "state: ${STATE_HOME}"
ensure_dir "${APP_DIR}/state" 700
ensure_dir "$STATE_HOME" 700

# --- ssh -------------------------------------------------------------------
ensure_dir "$STATE_HOME/.ssh" 700
seed_file "$SSH_KEY" "$STATE_HOME/.ssh/id_ed25519" 600
seed_file "${SSH_KEY}.pub" "$STATE_HOME/.ssh/id_ed25519.pub" 644
seed_file "${SEED_HOME}/.ssh/known_hosts" "$STATE_HOME/.ssh/known_hosts" 600
if [ -s "${SEED_HOME}/.ssh/config" ]; then
  seed_file "${SEED_HOME}/.ssh/config" "$STATE_HOME/.ssh/config" 600
fi

# --- git identity ------------------------------------------------------------
gitconfig="$STATE_HOME/.gitconfig"
set_git() { # <key> <env value> <label>
  local key="$1" value="$2"
  [ -n "$value" ] || value="$(HOME="$SEED_HOME" git config --global --get "$key" 2>/dev/null || true)"
  if [ -z "$value" ]; then
    note "no $key: set $3 or the invoking user's git config --global $key"
    return
  fi
  local current
  current="$(git config --file "$gitconfig" --get "$key" 2>/dev/null || true)"
  if [ "$current" != "$value" ] && { [ -z "$current" ] || [ "$FORCE" = 1 ]; }; then
    git config --file "$gitconfig" "$key" "$value"
    changed "git $key"
  fi
}
set_git user.name "${GIT_USER_NAME:-}" GIT_USER_NAME
set_git user.email "${GIT_USER_EMAIL:-}" GIT_USER_EMAIL

# --- claude ------------------------------------------------------------------
# A copy of the operator's ~/.claude, so a retained session id (projects/)
# stays resumable across the cutover, and settings.json, CLAUDE.md, agents/
# and skills/ carry over (a past task's findings). Existing files are skipped,
# so a re-run only adds what is new on the host. Not copied: the stored
# login (the containers authenticate with CLAUDE_CODE_OAUTH_TOKEN) and
# per-process runtime state.
CLAUDE_SKIP=".credentials.json session-env shell-snapshots ide daemon daemon.log cache"
seed_claude() {
  local src="${SEED_HOME}/.claude" dest="$STATE_HOME/.claude" entry name copied errors mode
  if [ ! -d "$src" ]; then
    note "no $src to seed .claude from"
    return
  fi
  ensure_dir "$dest" 700
  errors="$(mktemp)"
  local update="--update=none"
  [ "$FORCE" = 1 ] && update="--update=all"
  shopt -s nullglob dotglob
  for entry in "$src"/*; do
    name="$(basename "$entry")"
    case " $CLAUDE_SKIP " in *" $name "*) continue ;; esac
    mode="$update"
    [ "$name" = projects ] && [ "$REFRESH" = 1 ] && [ "$FORCE" != 1 ] && mode="--update=older"
    copied="$(cp -a -v "$mode" "$entry" "$dest/" 2>"$errors" | grep -c "^'" || true)"
    # cp -v names a file it then fails to open, so those do not count.
    copied=$((copied - $(grep -c "cannot open" "$errors" || true)))
    [ "$copied" -gt 0 ] && changed "copied $copied file(s) from $entry"
    # Files the invoking user cannot read (on foreman: a few of peter's
    # transcripts from before a past task) are not this user's sessions and
    # cannot be resumed as it anyway, so they are reported, not fatal.
    if [ -s "$errors" ]; then
      note "skipped $(wc -l < "$errors") unreadable file(s) under $entry: $(head -n 1 "$errors")"
    fi
  done
  shopt -u nullglob dotglob
  rm -f "$errors"
}
seed_claude
seed_file "${SEED_HOME}/.claude.json" "$STATE_HOME/.claude.json" 600

# --- workspace -----------------------------------------------------------------
echo "workspace: ${WORKSPACE_DIR}"
if [ -L "$SEED_WORKSPACE" ]; then
  if [ "$(readlink -f "$SEED_WORKSPACE")" = "$(readlink -f "$WORKSPACE_DIR")" ]; then
    note "$SEED_WORKSPACE already points at $WORKSPACE_DIR"
  else
    note "$SEED_WORKSPACE is a symlink to somewhere else, leaving it alone"
  fi
elif [ -d "$SEED_WORKSPACE" ] && [ "$MIGRATE" = 1 ]; then
  if [ -e "$WORKSPACE_DIR" ] && [ -n "$(ls -A "$WORKSPACE_DIR")" ]; then
    echo "both $SEED_WORKSPACE and $WORKSPACE_DIR hold a workspace; merge them by hand" >&2
    exit 1
  else
    # Same filesystem on foreman, so this is a rename: running processes keep
    # their cwd, and a path under the old name resolves again the moment the
    # symlink exists.
    [ -d "$WORKSPACE_DIR" ] && rmdir "$WORKSPACE_DIR"
    mv "$SEED_WORKSPACE" "$WORKSPACE_DIR"
    ln -s "$WORKSPACE_DIR" "$SEED_WORKSPACE"
    changed "moved $SEED_WORKSPACE to $WORKSPACE_DIR and left a symlink"
  fi
fi
[ -e "$WORKSPACE_DIR" ] || { mkdir -p "$WORKSPACE_DIR"; changed "created $WORKSPACE_DIR (clone <org>/<repo> into it)"; }

if [ -L "$SEED_WORKSPACE" ]; then
  alias_sessions "$STATE_HOME/.claude/projects"
  alias_sessions "${SEED_HOME}/.claude/projects"
fi

echo "done: ${CHANGES} change(s)"
