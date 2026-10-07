#!/usr/bin/env bash
# cmd_mounts.sh — inspect, heal, and auto-heal the host mounts (drag-and-drop
# dirs + the repo's .git).
#
# Why this exists as its own command: `minikube mount` establishes one 9p mount
# in the node and never reconnects. A Mac reboot or `minikube stop/start` kills
# the in-node mount while the host process lingers as a healthy-looking orphan,
# so the pod quietly binds empty directories — no error anywhere. Healing needs
# to happen on a schedule, not only when someone runs `up`.
#
#   mounts                    heal anything that's down, then report
#   mounts --status           report only, change nothing
#   mounts --quiet            heal, print only on change/failure (used by launchd)
#   mounts --install-agent    install+load the LaunchAgent that heals on login
#                             and every couple of minutes thereafter
#   mounts --uninstall-agent  unload and remove it
#
# Deliberately does NOT call require_context: mounting talks to the minikube
# profile directly and touches no cluster, so auto-healing must keep working
# even when the user's kubectl context is pointed at production.

agent_label() { printf 'com.collab-devcontainer.mounts.%s' "$(basename "$COLLAB_DC_TARGET_REPO")"; }
agent_plist() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(agent_label)"; }
agent_log()   { printf '%s/Library/Logs/collab-devcontainer-mounts.log' "$HOME"; }

main() {
  local mode="heal"
  case "${1:-}" in
    --status)          mode="status" ;;
    --quiet)           mode="quiet" ;;
    --install-agent)   install_agent; return ;;
    --uninstall-agent) uninstall_agent; return ;;
    "")                mode="heal" ;;
    *) echo "collab-devcontainer mounts: unknown option '$1'" >&2; return 2 ;;
  esac

  local targets; targets="$(all_mount_paths)"
  if [[ -z "$targets" ]]; then
    [[ "$mode" == quiet ]] || echo "No host mounts configured ([mounts].host_paths empty, [git].mount_dotgit off)."
    return 0
  fi

  # Nothing to heal (or report) if the node isn't up. Quiet exit so the
  # LaunchAgent doesn't spam the log every interval while minikube is stopped.
  if ! minikube -p "$COLLAB_DC_CONTEXT" status </dev/null >/dev/null 2>&1; then
    [[ "$mode" == quiet ]] && return 0
    echo "minikube profile '$COLLAB_DC_CONTEXT' is not running — nothing to mount."
    return 0
  fi

  if [[ "$mode" == "status" ]]; then
    report_status <<<"$targets"
    return
  fi

  # In quiet mode only speak up when something was actually down or failed.
  if [[ "$mode" == "quiet" ]]; then
    local down=""
    while IFS= read -r p; do
      [[ -z "$p" ]] && continue
      mount_healthy "$p" || down+="$p"$'\n'
    done <<<"$targets"
    [[ -z "$down" ]] && return 0
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] healing dead mounts:"
    ensure_host_mounts <<<"$down"
    return
  fi

  echo "Host mounts (minikube profile '$COLLAB_DC_CONTEXT'):"
  ensure_host_mounts <<<"$targets" || true
  echo
  report_pod_visibility <<<"$targets"
}

# Report live/dead per path without changing anything.
report_status() {
  local p
  echo "Host mounts (minikube profile '$COLLAB_DC_CONTEXT'):"
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    if mount_healthy "$p"; then
      echo "  live: $p"
    elif mount_unreadable_in_node "$p" && [[ -n "$(mount_host_pids "$p")" ]]; then
      echo "  DEAD (served, but the node can't read it — host dir likely recreated): $p"
    elif mount_live_in_node "$p"; then
      echo "  DEAD (mount entry with no serving process; reads fail with EIO): $p"
    elif [[ -n "$(mount_host_pids "$p")" ]]; then
      echo "  DEAD (orphaned host process, node mount gone): $p"
    else
      echo "  DEAD (not mounted): $p"
    fi
  done
  echo
  report_pod_visibility
}

# End-to-end check: does the running pod actually see content at these paths?
# This is what ultimately matters — the node mount table can be right while the
# pod bound an empty dir before the mount existed. Skipped when the pod isn't
# running or the kubectl context isn't the sandbox's.
report_pod_visibility() {
  local pod ctx p
  ctx="$(kubectl config current-context 2>/dev/null || true)"
  if [[ "$ctx" != "$COLLAB_DC_CONTEXT" ]]; then
    echo "(skipping in-pod check: kubectl context is '${ctx:-none}', not '$COLLAB_DC_CONTEXT')"
    return 0
  fi
  pod="$(pod_name)"
  if [[ -z "$pod" ]]; then
    echo "(skipping in-pod check: no $COLLAB_DC_DEPLOYMENT pod running)"
    return 0
  fi
  echo "In-pod visibility ($pod):"
  local targets; targets="$(all_mount_paths)"
  local pod_path verdict bad=0
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    pod_path="$(pod_path_for "$p")"
    verdict="$(pod_mount_view "$pod" "$p" "$pod_path")" || bad=1
    echo "  $verdict: $pod_path"
  done <<<"$targets"
  if (( bad )); then
    echo
    echo "Fix: collab-devcontainer restart   (rebinds the pod onto the live mounts)"
  fi
}

# Install a LaunchAgent that heals mounts at login and every AGENT_INTERVAL
# seconds. This is the piece that makes recovery automatic after a reboot:
# minikube typically isn't running yet at login, so a one-shot at login isn't
# enough — the periodic tick catches the mounts once the node comes back.
install_agent() {
  local plist; plist="$(agent_plist)"
  local label; label="$(agent_label)"
  local log;   log="$(agent_log)"
  local interval=120

  # launchd gives the job a minimal PATH; minikube/kubectl live in Homebrew or
  # ~/.local/bin. Derive the real directories from where they are right now.
  local bindirs="/usr/bin:/bin:/usr/sbin:/sbin" b d
  for b in minikube kubectl mutagen docker; do
    d="$(command -v "$b" 2>/dev/null)" || continue
    [[ -n "$d" ]] && bindirs="$(dirname "$d"):$bindirs"
  done
  bindirs="$(printf '%s' "$bindirs" | tr ':' '\n' | awk 'NF && !seen[$0]++' | paste -sd: -)"

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${COLLAB_DC_TOOL_DIR}/bin/collab-devcontainer</string>
    <string>mounts</string>
    <string>--quiet</string>
  </array>
  <!-- Config is discovered by walking up from CWD, so pin it to the repo. -->
  <key>WorkingDirectory</key>
  <string>${COLLAB_DC_TARGET_REPO}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${bindirs}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Essential. The minikube mount processes are long-lived children this job
       spawns and leaves running; without AbandonProcessGroup launchd SIGKILLs
       the whole process group the moment the job exits, so every heal would
       establish the mount and then immediately tear it down again.
       (No backticks in this comment: the heredoc that writes this plist is
       unquoted, so it would run them as command substitutions.) -->
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StartInterval</key>
  <integer>${interval}</integer>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
EOF

  # bootout first so a re-install picks up plist changes.
  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
    echo "Installed and loaded LaunchAgent: $label"
  else
    echo "Wrote $plist, but 'launchctl bootstrap' failed." >&2
    echo "Load it manually: launchctl bootstrap gui/$(id -u) $plist" >&2
    return 1
  fi
  echo "  plist:    $plist"
  echo "  repo:     $COLLAB_DC_TARGET_REPO"
  echo "  interval: every ${interval}s, plus at login"
  echo "  log:      $log"
  echo
  echo "Mounts now re-establish themselves automatically after a reboot or"
  echo "'minikube stop/start'. Remove with: collab-devcontainer mounts --uninstall-agent"
}

uninstall_agent() {
  local plist; plist="$(agent_plist)"
  local label; label="$(agent_label)"
  launchctl bootout "gui/$(id -u)/${label}" >/dev/null 2>&1 || true
  if [[ -f "$plist" ]]; then
    rm -f "$plist"
    echo "Removed LaunchAgent: $label"
  else
    echo "No LaunchAgent installed for $COLLAB_DC_TARGET_REPO."
  fi
}
