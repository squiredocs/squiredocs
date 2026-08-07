#!/usr/bin/env bash
# postcreate.sh — setup that can't be baked into the image, run INSIDE the pod
# as root. cmd_up.sh / cmd_restart.sh `kubectl cp` this in and exec it.
#
# Everything static — `yolo`, the claude wrapper, PATH, .env autoload, the
# /private/var symlink, git safe.directory — now lives in the IMAGE
# (image/shell-init.sh, sourced from /etc/bash.bashrc). That's deliberate: /root
# is ephemeral, so anything appended to ~/.bashrc here is lost on the next pod
# recreate, and postCreate doesn't run on every path to a new pod.
#
# What's left is the state that depends on host-seeded files or the PVC. This
# script is idempotent and cheap, so it runs on every up/restart rather than
# once behind a marker — a marker is exactly what let a recreated pod come up
# half-configured.

WORKSPACE="${WORKSPACE:-/local-dev}"

# Claude Code is baked into the image at /usr/local/bin/claude. Install only if
# somehow absent (e.g. a future image that drops it). Scoped pipefail so a curl
# failure doesn't get masked.
if ! command -v claude >/dev/null 2>&1; then
  set -o pipefail
  curl -fsSL https://claude.ai/install.sh | bash -s stable
  set +o pipefail
  ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude 2>/dev/null || true
fi

# The image marks /local-dev safe for git; re-add only if the workspace was
# reconfigured to something else. --get-all + grep -qx keeps this from appending
# a duplicate entry on every run.
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$WORKSPACE"; then
  git config --global --add safe.directory "$WORKSPACE" 2>/dev/null || true
fi

# Pre-accept Bypass Permissions mode so `yolo` never shows the one-time
# "WARNING: Claude Code running in Bypass Permissions mode" prompt. The flag
# lives in ~/.claude/settings.json (on the persistent PVC). Merge so we don't
# clobber any other settings already there.
mkdir -p ~/.claude
if [ -s ~/.claude/settings.json ] && jq -e . ~/.claude/settings.json >/dev/null 2>&1; then
  tmp="$(mktemp)"
  jq '. + {skipDangerousModePermissionPrompt: true}' ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
else
  echo '{"skipDangerousModePermissionPrompt": true}' > ~/.claude/settings.json
fi

# If a status-line script was seeded from the host (cmd_up runs seeding before
# this), wire settings.json to it. The host's statusLine.command uses an
# absolute /Users/... path that doesn't exist in the pod, so point at the pod
# path. Only when the script is present, so we don't configure a missing one.
if [ -f "$HOME/.claude/statusline-command.sh" ]; then
  tmp="$(mktemp)"
  jq --arg cmd "bash $HOME/.claude/statusline-command.sh" \
     '.statusLine = {type: "command", command: $cmd}' \
     ~/.claude/settings.json > "$tmp" && mv "$tmp" ~/.claude/settings.json
fi

echo "postCreate complete. 'claude' is ready (run 'claude' then /login once — it persists on the PVC)."
