#!/usr/bin/env bash
# shell-init.sh — sandbox shell setup, baked into the image at
# /etc/collab-devcontainer.sh and sourced from /etc/bash.bashrc (interactive
# shells) and /etc/profile.d/ (login shells).
#
# This lives in the IMAGE, not in postcreate.sh, on purpose. /root is ephemeral:
# a pod recreate — `restart`, a minikube restart, a kubelet eviction, anything —
# resets ~/.bashrc to the stock Debian one. postCreate only runs from `up`, so
# any other path to a new pod used to silently lose `yolo`, the claude wrapper,
# and the .env autoload. Baking it in means every shell in every pod has them,
# including a bare `kubectl exec ... bash` that never touches this CLI.

WORKSPACE="${WORKSPACE:-/local-dev}"

# Claude Code's native install lives in ~/.local/bin (with a /usr/local/bin
# symlink). Put it on PATH so the CLI stops warning that its install dir isn't
# there — it surfaces that around its periodic self-updates, which land in
# ~/.local/bin and would otherwise be shadowed by the baked-in version.
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac

# The pod is an isolated sandbox, so let Claude Code run
# --dangerously-skip-permissions despite running as root. Also set in the pod
# manifest; exported here too so the shell is self-sufficient on a stock pod.
export IS_SANDBOX=1

# The app may set ANTHROPIC_API_KEY (for the in-app Claude model) in .env, which
# Claude Code would prefer over the OAuth creds written by `/login`. Unset it for
# the CLI subprocess only — the app still sees the key, the CLI uses OAuth.
#
# No `command` prefix here: `env` execs a real binary and resolves it through
# PATH, where shell functions are invisible — so this cannot recurse. Adding
# `command` breaks it outright, because `env` would try to exec the shell
# builtin as a program ("env: 'command': No such file or directory").
claude() { env -u ANTHROPIC_API_KEY claude "$@"; }

# `yolo` — Claude Code in bypass-permissions mode.
yolo() { claude --dangerously-skip-permissions "$@"; }

# Load the synced .env so ad-hoc commands (migrate, scripts) see the same vars
# the app's dotenv loads. dotenv still handles the app itself; this is shell
# convenience. Interactive only: a `bash -lc` build step shouldn't inherit it.
if [[ $- == *i* ]] && [ -r "$WORKSPACE/.env" ]; then
  set -a && . "$WORKSPACE/.env" && set +a
fi

# Land in the workspace. Interactive only — `bash -lc 'cd /elsewhere && ...'`
# (install-deps, CI-style one-shots) must keep its own working directory.
if [[ $- == *i* ]]; then
  cd "$WORKSPACE" 2>/dev/null || true
fi
