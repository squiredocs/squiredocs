#!/usr/bin/env bash
# cmd_restart.sh — recreate the sandbox pod without losing Claude Code session
# context (sessions live on the claude-config PVC, so they survive). Prints
# recent resume IDs, SIGTERMs in-pod Claude so it can flush, recreates the pod,
# then re-establishes the Mutagen sync (the container ID changes on recreate, so
# the old sync would dangle).

main() {
  require_context
  local pod; pod="$(pod_name)"

  # 1. Recent session IDs, read from inside the pod (sessions are on the PVC).
  if [[ -n "$pod" ]]; then
    local sess_dir="/root/.claude/projects/$(printf '%s' "$COLLAB_DC_WORKSPACE_MOUNT" | tr '/' '-')"
    local listing
    listing="$(kc exec "$pod" -- sh -c "ls -t '$sess_dir'/*.jsonl 2>/dev/null | head -5" 2>/dev/null || true)"
    if [[ -n "$listing" ]]; then
      echo "Recent Claude sessions (resume with any of these):"
      while read -r f; do
        [[ -z "$f" ]] && continue
        printf "  claude --resume %s\n" "$(basename "$f" .jsonl)"
      done <<<"$listing"
      echo
    fi
  fi

  # 2. Let in-pod Claude exit cleanly.
  if [[ -n "$pod" ]] && kc exec "$pod" -- pgrep -x claude >/dev/null 2>&1; then
    echo "Sending SIGTERM to in-pod Claude sessions..."
    kc exec "$pod" -- pkill -TERM -x claude || true
    sleep 3
  fi

  # 3. Heal host mounts BEFORE recreating. The new pod binds its hostPath volumes
  #    at creation; if a 9p mount is dead at that moment it binds an empty dir
  #    (type: DirectoryOrCreate) and the pod silently loses .git and the
  #    drag-and-drop dirs. `up` did this and `restart` didn't, which is how a
  #    restarted pod ended up with no mounts.
  local mount_targets; mount_targets="$(all_mount_paths)"
  if [[ -n "$mount_targets" ]]; then
    echo "Checking host mounts..."
    ensure_host_mounts <<<"$mount_targets" || true
  fi

  # 4. Re-apply the manifest first, so the new pod declares the CURRENT mount
  #    set. `rollout restart` alone reuses the existing pod template, which
  #    silently drops any path that joined the desired set since the last `up`.
  echo "Applying sandbox manifests..."
  apply_pod_manifest

  # 5. Recreate.
  echo "Recreating the $COLLAB_DC_DEPLOYMENT pod..."
  kc rollout restart "deployment/$COLLAB_DC_DEPLOYMENT"
  kc rollout status "deployment/$COLLAB_DC_DEPLOYMENT" --timeout=120s

  # 5. The recreated pod is a new container with a fresh (empty) /local-dev
  #    volume. Refresh the sync against it (ensure_sync terminates the stale one
  #    and recreates it), then reinstall deps in the isolated installer container.
  local new_pod; new_pod="$(pod_name)"
  ensure_sync "$new_pod"
  if sync_active; then
    source "$COLLAB_DC_TOOL_DIR/lib/cmd_install_deps.sh"
    install_deps_isolated "$new_pod"
  fi

  # 6. Re-seed host Claude config and re-run postCreate. The PVC keeps sessions
  #    and login, but skills/plugins/status-line are copies that a fresh pod
  #    needs again — and postCreate re-wires settings.json to the pod-side
  #    status-line path. `up` did both; `restart` used to do neither.
  seed_claude_config "$new_pod"
  run_postcreate "$new_pod"

  echo
  echo "Pod recreated. Exec back in with: collab-devcontainer shell"
}
