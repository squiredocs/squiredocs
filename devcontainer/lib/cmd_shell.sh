#!/usr/bin/env bash
# cmd_shell.sh — exec another interactive shell into the running sandbox pod.
# Cheaper than `up` when you just want a second terminal.

main() {
  require_context
  local pod; pod="$(pod_name)"
  if [[ -z "$pod" ]]; then
    echo "collab-devcontainer: no $COLLAB_DC_DEPLOYMENT pod running. Run 'collab-devcontainer up' first." >&2
    exit 1
  fi

  # Heal the host mounts, then make sure this pod actually sees them. `shell` is
  # the usual way back into the sandbox after a reboot, and a pod that came up
  # before its mounts looks completely normal — until git or a dragged-in
  # screenshot path turns up missing. Cheap: one mount-table read when healthy.
  local targets; targets="$(all_mount_paths)"
  if [[ -n "$targets" ]]; then
    ensure_host_mounts <<<"$targets" >/dev/null || true
    ensure_pod_binding "$pod"
    pod="$(pod_name)"   # a rebind recreates the pod
  fi

  enter_pod_shell "$pod"
}
