#!/usr/bin/env bash
# cmd_up.sh — bring the sandbox up end to end and drop into a shell:
#   1. guard kube context           5. ensure Mutagen sync (reuses script/mutagen.sh)
#   2. build image if missing       6. run postCreate once
#   3. apply pod + claude PVC        7. start port-forwards (5173 / 3001)
#   4. wait for pod ready           8. exec interactive shell
# Re-running `up` against an already-running sandbox is cheap: each step is a
# no-op when its work is already done.

main() {
  require_context

  # 1. Build the dev image if Minikube doesn't have it yet. cmd_build.sh defines
  #    image_present()/build_image() as functions (its main() is not called here).
  source "$COLLAB_DC_TOOL_DIR/lib/cmd_build.sh"
  if ! image_present; then
    echo "Dev image $COLLAB_DC_IMAGE not found in Minikube."
    build_image
  fi

  # 2. Host mounts. Both kinds go through `minikube mount` + hostPath and must be
  #    started BEFORE the pod so its hostPath volumes bind onto live 9p mounts:
  #      - drag-and-drop dirs (screenshots): same path both sides, read-only.
  #      - the repo's .git (when [git].mount_dotgit): host .git -> <workspace>/.git,
  #        read-write, so in-pod git/gh work (.git is excluded from the Mutagen
  #        sync, so this mount is the pod's only copy of the history).
  local mounts; mounts="$(resolved_mount_paths)"
  local host_git="" pod_git=""
  if dotgit_enabled; then
    host_git="$COLLAB_DC_TARGET_REPO/.git"
    pod_git="$COLLAB_DC_WORKSPACE_MOUNT/.git"
  fi
  local mount_targets; mount_targets="$(all_mount_paths)"
  if [[ -n "$mount_targets" ]]; then
    echo "Checking host mounts${host_git:+ (incl. .git for in-pod git)}..."
    ensure_host_mounts <<<"$mount_targets" || true
  fi
  build_mount_blocks <<<"$mounts"
  [[ -n "$host_git" ]] && append_dotgit_mount "$host_git" "$pod_git"

  # 3. Apply the claude-config PVC and the app-dev pod (idempotent). Switching
  #    from collab's stock manifest to ours (or any image / mount-list change)
  #    triggers a rollout, and a recreated pod is a NEW container — the existing
  #    Mutagen sync would still point at the dead one. Step 4 detects that by
  #    comparing container IDs rather than by tracking pod names across the
  #    rollout, which is unreliable while two pods briefly coexist.
  echo "Applying sandbox manifests..."
  apply_manifest "$COLLAB_DC_TOOL_DIR/k8s/claude-pvc.yaml"
  apply_manifest "$COLLAB_DC_TOOL_DIR/k8s/app-dev.yaml"

  # 3. Wait for the pod. Then confirm it actually sees the mounts: an unchanged
  #    manifest means `apply` won't recreate the pod, so a pod left over from a
  #    reboot can still be bound to directories that were empty at its start.
  echo "Waiting for the $COLLAB_DC_DEPLOYMENT pod to be ready..."
  kc rollout status "deployment/$COLLAB_DC_DEPLOYMENT" --timeout=120s
  local pod_after; pod_after="$(pod_name)"
  if [[ -n "$mount_targets" ]]; then
    ensure_pod_binding "$pod_after"
    pod_after="$(pod_name)"
  fi

  # 4. Sync + install. The CLI owns the Mutagen sync (ensure_sync, targeting the
  #    `app` container by ID — the installer sidecar makes script/mutagen.sh's
  #    container grep ambiguous). Refresh unless the existing session already
  #    points at THIS container; a session that merely exists may be syncing into
  #    a container that no longer runs, which leaves /local-dev empty with no
  #    error. On a refresh, also (re)install deps in the isolated installer.
  local pod="$pod_after"
  if sync_targets_pod "$pod_after"; then
    echo "Mutagen sync '$COLLAB_DC_MUTAGEN_SYNC' already targets the running pod."
  else
    ensure_sync "$pod"
    if sync_active; then
      source "$COLLAB_DC_TOOL_DIR/lib/cmd_install_deps.sh"
      install_deps_isolated "$pod"
    else
      echo "Skipping dependency install (no active sync; code isn't in the pod yet)." >&2
    fi
  fi

  # 5. Seed host Claude skills/plugins/status-line into the pod (read-from-host
  #    model: a pod can't bind-mount host dirs, so copy them onto the PVC each
  #    `up` so updates propagate). Authored from the host; in-pod edits are
  #    overwritten next up. Runs BEFORE postCreate so the status-line script is
  #    present when postCreate wires it into settings.json.
  seed_claude_config "$pod"

  # 6. Run postCreate. Unconditionally: it's idempotent and cheap now that the
  #    static shell setup lives in the image, and the old "once per fresh pod"
  #    marker is exactly what let a pod recreated outside `up` come up
  #    half-configured.
  run_postcreate "$pod"

  # 7. Start port-forwards for the browser (Vite 5173, Express 3001) if absent.
  #    DBs need no forward — they're reachable in-cluster by service name.
  start_port_forwards

  # 8. Exec interactive shell (lands in /local-dev via the pod's workingDir).
  echo
  echo "Entering sandbox. Start the app with: dev   (then open http://localhost:5173)"
  enter_pod_shell "$pod"
}

start_port_forwards() {
  if pgrep -f "port-forward.*$COLLAB_DC_DEPLOYMENT.*5173" >/dev/null 2>&1; then
    echo "Port-forwards already running (http://localhost:5173)."
    return
  fi
  echo "Starting port-forwards: localhost:5173->5173 (Vite), localhost:3001->3001 (Express)..."
  kubectl port-forward "deployment/$COLLAB_DC_DEPLOYMENT" -n "$COLLAB_DC_NAMESPACE" \
    5173:5173 3001:3001 >/dev/null 2>&1 &
  disown || true
  sleep 1
  echo "  Stop later with: pkill -f 'port-forward.*$COLLAB_DC_DEPLOYMENT'"
}
