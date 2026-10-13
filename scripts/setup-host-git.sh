#!/usr/bin/env bash
#
# point the invoking user's global git config on foreman's host at
# GitHub over https with GH_TOKEN, the way the image does for the containers:
#
#   credential.https://github.com.helper   scripts/git-credential-github.sh
#                                          (any earlier helper for it reset)
#   url.https://github.com/.insteadOf      git@github.com: and
#                                          ssh://git@github.com/
#
# so every existing git@github.com remote (the workspace clone the host-side
# timers fetch) keeps working unchanged without an SSH key on GitHub. SSH
# stays for reaching the LXCs only. Idempotent; deploy.sh runs it on every
# deploy. Other git config is left alone.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="!${APP_DIR}/scripts/git-credential-github.sh"
CRED_KEY="credential.https://github.com.helper"
URL_KEY="url.https://github.com/.insteadOf"

CHANGES=0

# An empty first value clears helpers from a lower-priority config (system),
# so only ours answers for github.com.
current="$(git config --global --get-all "$CRED_KEY" 2>/dev/null || true)"
if [ "$current" != "$(printf '\n%s' "$HELPER")" ]; then
  git config --global --unset-all "$CRED_KEY" 2>/dev/null || true
  git config --global --add "$CRED_KEY" ""
  git config --global --add "$CRED_KEY" "$HELPER"
  CHANGES=$((CHANGES + 1))
fi

for prefix in "git@github.com:" "ssh://git@github.com/"; do
  if ! git config --global --get-all "$URL_KEY" 2>/dev/null | grep -qxF -- "$prefix"; then
    git config --global --add "$URL_KEY" "$prefix"
    CHANGES=$((CHANGES + 1))
  fi
done

if [ "$CHANGES" = 0 ]; then
  echo "Host git already uses https with GH_TOKEN for github.com."
else
  echo "Host git now uses https with GH_TOKEN for github.com (${CHANGES} change(s))."
fi
