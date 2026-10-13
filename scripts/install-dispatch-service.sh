#!/usr/bin/env bash
# One-time install of foreman's three systemd --user services: the I7 dispatch
# loop, the I8 chat poller and the post-PR pipeline poller (task
# #160). They are separate processes on purpose - see the header comment in
# each unit file for the failures that split them apart.
# Run as marek, no sudo needed for this part - see the printed note at the
# end for the one root step that's still required (enabling lingering).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAMES=("foreman-dispatch.service" "foreman-chat.service" "foreman-pipeline.service")
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$UNIT_DIR"
for unit in "${UNIT_NAMES[@]}"; do
  cp "$REPO_ROOT/systemd/$unit" "$UNIT_DIR/$unit"
done

systemctl --user daemon-reload
for unit in "${UNIT_NAMES[@]}"; do
  systemctl --user enable --now "$unit"
  echo "Installed and started $unit. Check status with:"
  echo "  systemctl --user status $unit"
  echo "  journalctl --user -u $unit -f"
done
echo
echo "IMPORTANT: without lingering enabled, these services stop shortly after"
echo "the last login session for marek ends (including the SSH session a"
echo "deploy runs over) - they will NOT survive logout or a reboot yet. Run"
echo "this once, as root (needs sudo, not something this script does for"
echo "you):"
echo "  sudo loginctl enable-linger marek"
