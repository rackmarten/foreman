#!/usr/bin/env bash
#
# Store foreman's GitHub token in the secret store as GH_TOKEN, sync it to
# foreman, and prove the container can use it. Run by the OPERATOR, from a
# device the admin proxy in front of the store knows as theirs (the
# workstation): setting a secret's value is admin-only there, and "admin" is a
# request through KEYRING_URL carrying the proxy's admin identity token. An
# agent run gets 403 by design.
#
# The token is read from stdin only, never from an argument (argv lands in
# shell history and in `ps`). It is never echoed; every request that carries
# it sends it on curl's or ssh's stdin, never in argv.
#
# Usage:
#   scripts/set-github-token.sh [--dry-run]            # prompts, input hidden
#   pass show github/foreman | scripts/set-github-token.sh
#
# Steps, each reported by name if it fails:
#   1. read      read and sanity-check the token (ghp_... or github_pat_...)
#   2. github    GitHub accepts it (GET /user; prints the login and scopes)
#   3. store-check  the store answers and says whether GH_TOKEN is declared yet
#   4. store     declare GH_TOKEN for foreman (new group foreman-github) or
#                replace its value                         [skipped by --dry-run]
#   5. sync      the store renders foreman's secrets/global.env  [skipped by --dry-run]
#   6. verify    in a one-off foreman container: `gh auth status` and
#                `git ls-remote` over https. --dry-run hands the container
#                the token over ssh's stdin instead of relying on the sync.
#
# Environment:
#   KEYRING_URL   required: the secret store's URL, through its admin proxy
#   FOREMAN_SSH   ssh destination of foreman, default foreman
#   FOREMAN_DIR   foreman's checkout on that host, default /app
#   VERIFY_REPO   repo for the ls-remote check, default this checkout's
#                 origin as an https URL
#   GITHUB_API    default https://api.github.com

set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      # Deliberately does not repeat the argument: it may be the token.
      echo "unknown argument (the token goes on stdin, never as an argument; see --help)" >&2
      exit 2
      ;;
  esac
done

KEYRING_URL="${KEYRING_URL:-}"
FOREMAN_SSH="${FOREMAN_SSH:-foreman}"
FOREMAN_DIR="${FOREMAN_DIR:-/app}"
if [ -z "${VERIFY_REPO:-}" ]; then
  VERIFY_REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." remote get-url origin 2>/dev/null || true)"
  VERIFY_REPO="$(printf '%s' "$VERIFY_REPO" | sed -E 's#^(git@github\.com:|ssh://git@github\.com/)#https://github.com/#')"
fi
GITHUB_API="${GITHUB_API:-https://api.github.com}"
SECRET=GH_TOKEN
GROUP=foreman-github
[ -n "$KEYRING_URL" ] || { echo "KEYRING_URL is not set: point it at the secret store, through its admin proxy" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TOKEN=""
STEP=""

step() { STEP="$1"; echo "[$1] $2"; }
# Any text that reaches the terminal from outside this script goes through
# here first, in case something echoes the token back.
redact() { local s; s="$(cat)"; [ -n "$TOKEN" ] && s="${s//"$TOKEN"/[redacted]}"; printf '%s\n' "$s"; }
fail() { echo "[$STEP] FAILED: $*" | redact >&2; exit 1; }

# http <method> <url> [stdin-mode]: status code on stdout, body in $TMP/body.
# stdin-mode "auth" sends the token as a header on stdin, "body" sends stdin
# as the request body; both keep the token out of argv.
http() {
  local method="$1" url="$2" mode="${3:-}"
  local args=(-sS --max-time 120 -o "$TMP/body" -w '%{http_code}' -X "$method")
  case "$mode" in
    auth) args+=(-H @-) ;;
    body) args+=(-H 'content-type: application/json' --data-binary @-) ;;
  esac
  curl "${args[@]}" "$url"
}
body() { redact < "$TMP/body" | head -c 400; }

# --- 1. read ----------------------------------------------------------------
step read "reading the token from stdin"
if [ -t 0 ]; then
  printf 'GitHub token (input hidden): ' >&2
  IFS= read -rs TOKEN || true
  echo >&2
else
  IFS= read -r TOKEN || true
fi
TOKEN="${TOKEN//[[:space:]]/}"
[ -n "$TOKEN" ] || fail "no token on stdin"
if ! [[ "$TOKEN" =~ ^(ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})$ ]]; then
  fail "that does not look like a GitHub PAT (expected ghp_... or github_pat_...)"
fi
echo "  ok: ${TOKEN%%_*}_... token, ${#TOKEN} characters"

# --- 2. github ----------------------------------------------------------------
step github "checking the token against ${GITHUB_API}/user"
code="$(printf 'Authorization: Bearer %s\n' "$TOKEN" | http GET "${GITHUB_API}/user" auth)" || fail "could not reach GitHub"
[ "$code" = 200 ] || fail "GitHub answered HTTP ${code}: $(body)"
login="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("login",""))' < "$TMP/body" 2>/dev/null || true)"
echo "  ok: authenticates as ${login:-<unknown>}"

# --- 3. store-check -------------------------------------------------------------
step store-check "asking ${KEYRING_URL} about ${SECRET}"
code="$(http GET "${KEYRING_URL}/api/secrets/${SECRET}")" || fail "could not reach the secret store"
case "$code" in
  200) declared=1; echo "  ok: ${SECRET} is declared, its value will be replaced" ;;
  404) declared=0; echo "  ok: ${SECRET} is not declared yet, it will be declared in group ${GROUP} for foreman" ;;
  *) fail "the secret store answered HTTP ${code}: $(body)" ;;
esac

# --- 4. store ---------------------------------------------------------------------
# The token only ever contains [A-Za-z0-9_] (checked above), so it needs no
# JSON escaping.
if [ "$DRY_RUN" = 1 ]; then
  step store "skipped (--dry-run)"
else
  step store "storing ${SECRET} in the secret store"
  if [ "$declared" = 1 ]; then
    code="$(printf '{"value":"%s"}' "$TOKEN" | http PUT "${KEYRING_URL}/api/secrets/${SECRET}" body)" || fail "could not reach the secret store"
  else
    code="$(printf '{"name":"%s","group":"%s","hosts":["foreman"],"value":"%s"}' "$SECRET" "$GROUP" "$TOKEN" \
      | http POST "${KEYRING_URL}/api/secrets" body)" || fail "could not reach the secret store"
  fi
  case "$code" in
    200|201) echo "  ok: stored" ;;
    403) fail "the secret store refused (HTTP 403): setting a value is admin-only; run this from your own device, through ${KEYRING_URL}" ;;
    *) fail "the secret store answered HTTP ${code}: $(body)" ;;
  esac
fi

# --- 5. sync ------------------------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  step sync "skipped (--dry-run)"
else
  step sync "syncing foreman's secrets/global.env"
  code="$(printf '{"hosts":["foreman"]}' | http POST "${KEYRING_URL}/api/sync" body)" || fail "could not reach the secret store"
  [ "$code" = 200 ] || fail "the secret store's sync answered HTTP ${code}: $(body)"
  echo "  ok: synced"
fi

# --- 6. verify ------------------------------------------------------------------------
# A one-off container (`docker compose run --rm`) is safe while the systemd
# units still run. The remote script reads one line from stdin: the token on a
# dry run, an empty line otherwise (then GH_TOKEN comes from global.env).
step verify "gh auth status and git ls-remote inside a foreman container on ${FOREMAN_SSH}"
q_repo="$(printf '%q' "$VERIFY_REPO")"
q_dir="$(printf '%q' "$FOREMAN_DIR")"
remote="IFS= read -r t; cd ${q_dir} || exit 1
env=(); if [ -n \"\$t\" ]; then export GH_TOKEN=\"\$t\"; env=(-e GH_TOKEN); fi
docker compose run --rm -T \"\${env[@]}\" dispatch sh -c 'gh auth status --hostname github.com && git ls-remote \"\$1\" HEAD >/dev/null && echo ls-remote ok' sh ${q_repo}"
send=""
[ "$DRY_RUN" = 1 ] && send="$TOKEN"
if ! out="$(printf '%s\n' "$send" | ssh -o BatchMode=yes "$FOREMAN_SSH" "bash -c $(printf '%q' "$remote")" 2>&1)"; then
  printf '%s\n' "$out" | redact | sed 's/^/  | /' >&2
  fail "the container could not use the token (output above)"
fi
printf '%s\n' "$out" | redact | sed 's/^/  | /'
echo "  ok"

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run passed: nothing was stored. Run again without --dry-run to store it."
else
  echo "done: ${SECRET} is stored, synced to foreman, and works in the container."
fi
