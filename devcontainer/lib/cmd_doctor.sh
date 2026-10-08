#!/usr/bin/env bash
# cmd_doctor.sh — validate the setup. Prints PASS/WARN/FAIL per check.
# Exit 0 if all pass or WARN; 1 if any FAIL.

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
DOCTOR_FAIL_COUNT=0
DOCTOR_WARN_COUNT=0

pass() { printf '  %sPASS%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %sWARN%s %s\n' "$YELLOW" "$RESET" "$1"; DOCTOR_WARN_COUNT=$((DOCTOR_WARN_COUNT + 1)); }
fail() { printf '  %sFAIL%s %s\n' "$RED" "$RESET" "$1"; DOCTOR_FAIL_COUNT=$((DOCTOR_FAIL_COUNT + 1)); }

main() {
  echo "## Config file"
  if [[ -z "${COLLAB_DC_CONFIG_FILE:-}" ]]; then
    fail "no config found. Place collab-devcontainer.toml at the repo root, or scaffold ~/.config/collab-devcontainer/<repo-basename>.toml"
    summary; return
  fi
  pass "config: $COLLAB_DC_CONFIG_FILE"
  case "$COLLAB_DC_CONFIG_FILE" in
    "$HOME/.config/collab-devcontainer/"*) pass "using host fallback (no in-repo toml)" ;;
  esac
  if [[ "${COLLAB_DC_SCHEMA_VERSION:-}" == "$COLLAB_DC_SCHEMA_VERSION_SUPPORTED" ]]; then
    pass "schema_version=$COLLAB_DC_SCHEMA_VERSION"
  else
    fail "schema_version=${COLLAB_DC_SCHEMA_VERSION:-missing} (this tool supports $COLLAB_DC_SCHEMA_VERSION_SUPPORTED)"
  fi

  echo
  echo "## Tooling"
  for bin in kubectl minikube docker mutagen; do
    if command -v "$bin" >/dev/null 2>&1; then pass "$bin on PATH"; else
      [[ "$bin" == mutagen ]] && warn "mutagen not on PATH (needed to sync local edits into the pod)" \
                              || fail "$bin not on PATH"
    fi
  done

  echo
  echo "## Kube context"
  local current
  current="$(kubectl config current-context 2>/dev/null || true)"
  if [[ "$current" == "$COLLAB_DC_CONTEXT" ]]; then
    pass "current context is '$COLLAB_DC_CONTEXT'"
  else
    fail "current context is '${current:-none}', expected '$COLLAB_DC_CONTEXT' (kubectl config use-context $COLLAB_DC_CONTEXT)"
  fi
  if minikube -p "$COLLAB_DC_CONTEXT" status >/dev/null 2>&1; then
    pass "minikube profile '$COLLAB_DC_CONTEXT' is running"
  else
    fail "minikube profile '$COLLAB_DC_CONTEXT' not running (minikube start)"
  fi

  echo
  echo "## Cluster resources (namespace: $COLLAB_DC_NAMESPACE)"
  if kc get namespace "$COLLAB_DC_NAMESPACE" >/dev/null 2>&1 || kubectl --context "$COLLAB_DC_CONTEXT" get namespace "$COLLAB_DC_NAMESPACE" >/dev/null 2>&1; then
    pass "namespace exists"
  else
    fail "namespace '$COLLAB_DC_NAMESPACE' missing (kubectl apply -f k8s/namespace.yaml in collab)"
  fi
  check_service "$COLLAB_DC_PG_SERVICE"
  check_service "$COLLAB_DC_REDIS_SERVICE"
  local dpod; dpod="$(pod_name)"
  if [[ -n "$dpod" ]]; then
    pass "$COLLAB_DC_DEPLOYMENT pod running: $dpod"
    if kc get pod "$dpod" -o jsonpath='{.spec.containers[*].name}' 2>/dev/null | grep -qw installer; then
      pass "isolated 'installer' container present (no-secrets dependency installs)"
    else
      warn "no 'installer' container — pod predates the isolated-install manifest; 'up' will roll it"
    fi
  else
    warn "$COLLAB_DC_DEPLOYMENT pod not running — 'collab-devcontainer up' will start it"
  fi
  if kc get pvc collab-claude-config >/dev/null 2>&1; then
    local phase; phase="$(kc get pvc collab-claude-config -o jsonpath='{.status.phase}' 2>/dev/null)"
    [[ "$phase" == "Bound" ]] && pass "claude-config PVC bound" || warn "claude-config PVC phase=$phase"
  else
    warn "claude-config PVC not created yet — 'up' will apply it"
  fi

  echo
  echo "## Dev image"
  if ( minikube_docker_env && docker images -q "$COLLAB_DC_IMAGE" 2>/dev/null | grep -q . ); then
    pass "$COLLAB_DC_IMAGE present in Minikube's Docker daemon"
  else
    warn "$COLLAB_DC_IMAGE not built yet — 'collab-devcontainer build' (or 'up') will build it"
  fi

  echo
  echo "## Mutagen sync"
  # Existence of a session by that name is not the question — it outlives the
  # container it was created against, so after a pod recreate it happily syncs
  # into a dead container while /local-dev sits empty. Check the target.
  if ! sync_active; then
    warn "sync '$COLLAB_DC_MUTAGEN_SYNC' not active — 'up' will create it (CLI-owned, against the app container)"
  elif [[ -z "$dpod" ]]; then
    warn "sync '$COLLAB_DC_MUTAGEN_SYNC' exists but no pod is running to verify its target"
  elif sync_targets_pod "$dpod"; then
    pass "sync '$COLLAB_DC_MUTAGEN_SYNC' active and targeting the running pod"
  else
    fail "sync '$COLLAB_DC_MUTAGEN_SYNC' exists but points at a dead container — /local-dev in the pod will be empty. Fix: collab-devcontainer up"
  fi

  echo
  echo "## Host mounts (drag-and-drop + rw_paths)"
  # Liveness comes from the node's mount table, NOT pgrep. A `minikube mount`
  # process outlives the mount it created (Mac reboot, minikube stop/start), so
  # pgrep reports a healthy-looking orphan while the pod sees an empty dir —
  # this check used to PASS in exactly the situation it exists to catch.
  local mp; mp="$(resolved_mount_paths)"
  if [[ -z "$mp" ]]; then
    pass "no host mounts configured ([mounts].host_paths and rw_paths empty)"
  else
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      if path_is_rw "$p"; then check_mount_path "$p" "$p" rw
      else                     check_mount_path "$p" "$p" ro
      fi
    done <<<"$mp"
  fi
  local shadowed; shadowed="$(shadowed_rw_paths)"
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    warn "[mounts].rw_paths entry '$p' is nested inside another mounted path — the pod gets the read-only ancestor instead. Un-nest it to make it writable."
  done <<<"$shadowed"

  echo
  echo "## In-pod git (.git mount)"
  local dotgit_set
  dotgit_set="$(printf '%s' "${COLLAB_DC_MOUNT_DOTGIT:-}" | tr '[:upper:]' '[:lower:]')"
  if dotgit_enabled; then
    local gp="$COLLAB_DC_TARGET_REPO/.git"
    check_mount_path "$gp" "$COLLAB_DC_WORKSPACE_MOUNT/.git"
  elif [[ "$dotgit_set" =~ ^(1|true|yes|on)$ ]]; then
    warn "[git].mount_dotgit is set but $COLLAB_DC_TARGET_REPO/.git is not a directory (worktree/submodule pointer unsupported)"
  else
    pass "[git].mount_dotgit disabled (in-pod git has no repo history)"
  fi

  echo
  echo "## Mount auto-heal (LaunchAgent)"
  local label="com.collab-devcontainer.mounts.$(basename "$COLLAB_DC_TARGET_REPO")"
  local plist="$HOME/Library/LaunchAgents/${label}.plist"
  if [[ -f "$plist" ]]; then
    if launchctl print "gui/$(id -u)/${label}" >/dev/null 2>&1; then
      pass "auto-heal agent loaded ($label)"
    else
      warn "auto-heal plist exists but isn't loaded — launchctl bootstrap gui/$(id -u) $plist"
    fi
  else
    warn "no auto-heal agent — mounts won't recover on their own after a reboot (collab-devcontainer mounts --install-agent)"
  fi

  echo
  echo "## In-pod shell setup"
  if [[ -n "$dpod" ]]; then
    # `yolo` and friends are baked into the image at /etc/collab-devcontainer.sh.
    # An older image appended them to ~/.bashrc from postCreate, which a pod
    # recreate silently reverted — so check the image path specifically.
    if kc exec "$dpod" -- test -f /etc/collab-devcontainer.sh 2>/dev/null; then
      # Probe functionally, not just for definedness. `type yolo` passes on a
      # wrapper that is defined but cannot execute — which is exactly how a
      # broken `claude()` shipped once: the function existed, and every
      # invocation died with "env: 'command': No such file or directory".
      if kc exec "$dpod" -- bash -ic 'claude --version' >/dev/null 2>&1; then
        pass "shell setup baked into image ('claude'/'yolo' wrappers run)"
      else
        fail "/etc/collab-devcontainer.sh is present but 'claude' fails to run in an interactive shell — check the wrapper, then: collab-devcontainer rebuild"
      fi
    else
      warn "pod predates the baked-in shell setup ('yolo' is lost on every pod recreate) — collab-devcontainer rebuild"
    fi
  else
    warn "pod not running — can't check in-pod shell setup"
  fi

  echo
  echo "## Target repo & CLI"
  [[ -d "$COLLAB_DC_TARGET_REPO/.git" ]] && pass "git checkout: $COLLAB_DC_TARGET_REPO" || warn "$COLLAB_DC_TARGET_REPO is not a git checkout"
  [[ -f "$COLLAB_DC_TARGET_REPO/package.json" ]] && pass "package.json present" || fail "no package.json at $COLLAB_DC_TARGET_REPO"
  if [[ -L "$HOME/.local/bin/collab-devcontainer" ]]; then
    pass "~/.local/bin/collab-devcontainer installed"
  else
    warn "~/.local/bin/collab-devcontainer not installed (run ./install)"
  fi
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) pass "~/.local/bin in PATH" ;;
    *) warn "~/.local/bin not in PATH" ;;
  esac

  summary
}

# Report on one host mount, in two layers: is it live in the node, and does the
# running pod actually see it. Those can disagree — a pod created while the
# mount was down bound an empty dir and needs a recreate, not a remount.
# $3, when given, is an access label ("rw"/"ro") shown in the output only — it
# must never be folded into pod_path, which is `ls`'d inside the pod.
check_mount_path() {
  local host_path="$1" pod_path="$2" access="${3:-}"
  local shown="$pod_path${access:+ [$access]}"
  if ! mount_healthy "$host_path"; then
    if mount_live_in_node "$host_path"; then
      fail "STALE: $host_path — the node has a mount entry but no process serves it; every read returns EIO and the kubelet can't even start the container. Fix: collab-devcontainer mounts"
    elif [[ -n "$(mount_host_pids "$host_path")" ]]; then
      fail "DEAD: $host_path — the 'minikube mount' process is still running but the node mount is gone (orphan after a reboot / minikube restart). Fix: collab-devcontainer mounts"
    else
      warn "not mounted: $host_path — 'collab-devcontainer mounts' will start it"
    fi
    return
  fi

  # Live in the node. Now the end-to-end question: can the pod read it?
  local pod; pod="$(pod_name)"
  if [[ -z "$pod" ]]; then
    pass "mounted: $host_path -> $shown (pod not running; not verified in-pod)"
    return
  fi
  local verdict rc=0
  verdict="$(pod_mount_view "$pod" "$host_path" "$pod_path")" || rc=$?
  if (( rc == 0 )); then
    pass "mounted: $host_path -> $shown${verdict:+ [$verdict]}"
  elif node_can_read "$host_path"; then
    # The node reads it fine, so the mount is live and only the pod's bind is
    # stale — a remount underneath a running container is not re-delivered to it.
    fail "$pod_path: $verdict. Fix: collab-devcontainer restart"
    return
  else
    # The mount itself is bad. `restart` would recreate the pod onto the same
    # broken mount and fix nothing.
    fail "$pod_path: $verdict. Fix: collab-devcontainer mounts"
    return
  fi

  # Config says writable but the RUNNING pod still declares readOnly — the pod
  # predates the rw_paths change. A remount can't fix this; only re-applying the
  # manifest can, so point at restart rather than mounts.
  if [[ "$access" == rw ]] && pod_mount_is_readonly "$pod" "$pod_path"; then
    fail "$pod_path is in [mounts].rw_paths but the running pod mounts it read-only (pod predates the config change). Fix: collab-devcontainer restart"
  fi
}

check_service() {
  local svc="$1"
  if kc get service "$svc" >/dev/null 2>&1; then
    # Endpoints present means at least one ready backing pod.
    local eps; eps="$(kc get endpoints "$svc" -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null || true)"
    [[ -n "$eps" ]] && pass "service $svc has ready endpoints" || warn "service $svc exists but has no ready endpoints (is the DB pod up?)"
  else
    fail "service '$svc' missing in namespace $COLLAB_DC_NAMESPACE"
  fi
}

summary() {
  echo
  if (( DOCTOR_FAIL_COUNT > 0 )); then
    printf '%s%d FAIL%s, %d WARN\n' "$RED" "$DOCTOR_FAIL_COUNT" "$RESET" "$DOCTOR_WARN_COUNT"
    exit 1
  fi
  if (( DOCTOR_WARN_COUNT > 0 )); then
    printf '%s%d WARN%s, no failures\n' "$YELLOW" "$DOCTOR_WARN_COUNT" "$RESET"
  else
    printf '%sall checks passed%s\n' "$GREEN" "$RESET"
  fi
}
