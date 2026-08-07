#!/usr/bin/env bash
# cmd_install_deps.sh — (re)install npm dependencies in the ISOLATED installer
# container (`-c installer`), which shares /local-dev with the app container but
# has none of its secrets. A malicious postinstall in a transitive dep can't
# read the DB/SES creds. Run after package-lock.json changes. Idempotent.
#
# Exposes install_deps_isolated() so cmd_up can reuse it on a fresh pod.

install_deps_isolated() {
  local pod="$1"
  echo "Installing root dependencies (npm ci) in the isolated installer container..."
  kc exec "$pod" -c installer -- sh -c "cd $COLLAB_DC_WORKSPACE_MOUNT && npm ci"
  echo "Installing client dependencies (npm ci)..."
  kc exec "$pod" -c installer -- sh -c "cd $COLLAB_DC_WORKSPACE_MOUNT/client && npm ci"
}

main() {
  require_context
  local pod; pod="$(pod_name)"
  if [[ -z "$pod" ]]; then
    echo "collab-devcontainer: no $COLLAB_DC_DEPLOYMENT pod running. Run 'collab-devcontainer up' first." >&2
    exit 1
  fi
  install_deps_isolated "$pod"
  echo "Dependencies installed."
}
