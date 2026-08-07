#!/usr/bin/env bash
# common.sh — shared helpers for collab-devcontainer subcommands.
# Sourced by bin/collab-devcontainer; not a standalone script.

COLLAB_DC_SCHEMA_VERSION_SUPPORTED=1

# Walk up from CWD looking for a config. Sets COLLAB_DC_CONFIG_FILE and
# COLLAB_DC_TARGET_REPO. Returns 1 if not found. Lookup order:
#   1. <ancestor>/collab-devcontainer.toml — in-repo, tracked
#   2. <ancestor>/.git found → ~/.config/collab-devcontainer/<basename>.toml
# (2) lets the tool work against any branch / worktree / fresh clone without
# requiring the toml on every checkout.
find_target_repo() {
  local dir
  dir="$(pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/collab-devcontainer.toml" ]]; then
      COLLAB_DC_CONFIG_FILE="$dir/collab-devcontainer.toml"
      COLLAB_DC_TARGET_REPO="$dir"
      return 0
    fi
    if [[ -d "$dir/.git" ]] || [[ -f "$dir/.git" ]]; then
      local host_config="$HOME/.config/collab-devcontainer/$(basename "$dir").toml"
      if [[ -f "$host_config" ]]; then
        COLLAB_DC_CONFIG_FILE="$host_config"
        COLLAB_DC_TARGET_REPO="$dir"
        return 0
      fi
      return 1
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Read a string value from a toml file. Handles `key = "value"` and bare
# `key = value` lines, ignores trailing comments and surrounding whitespace/
# quotes. Limited: no multi-line strings, arrays, or nested tables — sufficient
# for this tool's flat schema.
toml_get() {
  local file="$1" section="$2" key="$3"
  awk -v section="[$section]" -v key="$key" '
    /^[ \t]*#/ { next }
    $0 == section { in_section=1; next }
    /^\[/ { in_section=0; next }
    in_section && $0 ~ "^[ \t]*"key"[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, "")
      sub(/[ \t]*#.*$/, "")
      gsub(/^[ \t"]+|[ \t"]+$/, "")
      print
      exit
    }
  ' "$file"
}

# Expand a leading ~ to $HOME.
expand_tilde() {
  local p="$1"
  if [[ "$p" == "~" ]]; then printf '%s' "$HOME"
  elif [[ "${p:0:2}" == "~/" ]]; then printf '%s%s' "$HOME" "${p:1}"
  else printf '%s' "$p"; fi
}

load_config() {
  if ! find_target_repo; then
    cat >&2 <<EOF
collab-devcontainer: no collab-devcontainer.toml found in this directory or any
ancestor. Run from inside the collab repo, or scaffold a host fallback at
~/.config/collab-devcontainer/<repo-basename>.toml.
EOF
    exit 2
  fi
  parse_config strict
}

# Like load_config but tolerant of missing keys so doctor can report on them.
load_config_lenient() {
  if ! find_target_repo; then
    COLLAB_DC_CONFIG_FILE=""
    COLLAB_DC_TARGET_REPO=""
    return 0
  fi
  parse_config lenient
}

parse_config() {
  local mode="${1:-strict}"
  local f="$COLLAB_DC_CONFIG_FILE"

  # schema_version is a top-level key (before any [section]).
  local schema_version
  schema_version="$(awk -v key="schema_version" '
    /^[ \t]*#/ { next }
    /^\[/ { exit }
    $0 ~ "^[ \t]*"key"[ \t]*=" {
      sub(/^[^=]*=[ \t]*/, ""); sub(/[ \t]*#.*$/, ""); gsub(/^[ \t"]+|[ \t"]+$/, ""); print; exit
    }
  ' "$f")"
  if [[ -z "$schema_version" ]]; then
    [[ "$mode" == "strict" ]] && die "schema_version missing from $f"
  elif [[ "$schema_version" != "$COLLAB_DC_SCHEMA_VERSION_SUPPORTED" ]]; then
    [[ "$mode" == "strict" ]] && die "schema_version=$schema_version in $f, this tool supports $COLLAB_DC_SCHEMA_VERSION_SUPPORTED"
  fi
  COLLAB_DC_SCHEMA_VERSION="$schema_version"

  COLLAB_DC_TARGET_NAME="$(toml_get "$f" target name)"
  COLLAB_DC_WORKSPACE_MOUNT="$(toml_get "$f" target workspace_mount)"

  COLLAB_DC_CONTEXT="$(toml_get "$f" minikube context)"
  COLLAB_DC_NAMESPACE="$(toml_get "$f" minikube namespace)"
  COLLAB_DC_DEPLOYMENT="$(toml_get "$f" minikube deployment)"
  COLLAB_DC_PG_SERVICE="$(toml_get "$f" minikube postgres_service)"
  COLLAB_DC_PG_PORT="$(toml_get "$f" minikube postgres_port)"
  COLLAB_DC_REDIS_SERVICE="$(toml_get "$f" minikube redis_service)"
  COLLAB_DC_REDIS_PORT="$(toml_get "$f" minikube redis_port)"

  COLLAB_DC_IMAGE="$(toml_get "$f" image name)"
  COLLAB_DC_MUTAGEN_SYNC="$(toml_get "$f" mutagen sync_name)"
  # Comma-separated host dirs bound into the pod for drag-and-drop (screenshots).
  COLLAB_DC_MOUNT_PATHS="$(toml_get "$f" mounts host_paths)"
  # Same, but bound read-write — for host repos you want to edit from the pod.
  COLLAB_DC_MOUNT_RW_PATHS="$(toml_get "$f" mounts rw_paths)"
  # Mount the host repo's .git into the pod (rw) so in-pod git works.
  COLLAB_DC_MOUNT_DOTGIT="$(toml_get "$f" git mount_dotgit)"

  local session_dir
  session_dir="$(toml_get "$f" claude session_dir)"
  if [[ -z "$session_dir" && -n "${COLLAB_DC_WORKSPACE_MOUNT:-}" ]]; then
    # Claude Code names per-project session dirs by replacing / with - in cwd.
    session_dir="~/.claude/projects/$(printf '%s' "$COLLAB_DC_WORKSPACE_MOUNT" | tr '/' '-')"
  fi
  COLLAB_DC_CLAUDE_SESSION_DIR="$(expand_tilde "$session_dir")"

  # Defaults.
  : "${COLLAB_DC_WORKSPACE_MOUNT:=/local-dev}"
  : "${COLLAB_DC_CONTEXT:=minikube}"
  : "${COLLAB_DC_NAMESPACE:=collab}"
  : "${COLLAB_DC_DEPLOYMENT:=app-dev}"
  : "${COLLAB_DC_PG_SERVICE:=collab-postgres}"
  : "${COLLAB_DC_PG_PORT:=5432}"
  : "${COLLAB_DC_REDIS_SERVICE:=collab-redis}"
  : "${COLLAB_DC_REDIS_PORT:=6379}"
  : "${COLLAB_DC_IMAGE:=collab-dev:latest}"
  : "${COLLAB_DC_MUTAGEN_SYNC:=app-sync}"

  if [[ "$mode" == "strict" ]]; then
    [[ -n "$COLLAB_DC_TARGET_NAME" ]]     || die "target.name missing from $f"
    [[ -n "$COLLAB_DC_WORKSPACE_MOUNT" ]] || die "target.workspace_mount missing from $f"
  fi

  export COLLAB_DC_CONFIG_FILE COLLAB_DC_TARGET_REPO COLLAB_DC_TARGET_NAME \
         COLLAB_DC_WORKSPACE_MOUNT COLLAB_DC_CONTEXT COLLAB_DC_NAMESPACE \
         COLLAB_DC_DEPLOYMENT COLLAB_DC_PG_SERVICE COLLAB_DC_PG_PORT \
         COLLAB_DC_REDIS_SERVICE COLLAB_DC_REDIS_PORT COLLAB_DC_IMAGE \
         COLLAB_DC_MUTAGEN_SYNC COLLAB_DC_MOUNT_PATHS COLLAB_DC_MOUNT_RW_PATHS \
         COLLAB_DC_MOUNT_DOTGIT \
         COLLAB_DC_CLAUDE_SESSION_DIR COLLAB_DC_SCHEMA_VERSION
}

# Split a comma-separated toml path list into one path per line: trims, expands
# a leading ~, strips a trailing slash, and keeps only directories that exist.
split_path_list() {
  local raw="$1" p
  local -a out=()
  local oldifs="$IFS"; IFS=','
  for p in $raw; do
    IFS="$oldifs"
    p="${p#"${p%%[![:space:]]*}"}"; p="${p%"${p##*[![:space:]]}"}"  # trim
    [[ -z "$p" ]] && continue
    p="$(expand_tilde "$p")"
    p="${p%/}"
    [[ -d "$p" ]] && out+=( "$p" )
    IFS=','
  done
  IFS="$oldifs"
  printf '%s\n' ${out[@]+"${out[@]}"} | awk 'NF'
}

# Resolve the host directories to bind into the pod (one per line): the
# read-write [mounts].rw_paths, the read-only [mounts].host_paths, then the
# auto-detected macOS drop zones (see auto_mount_paths). Same absolute path is
# used inside the pod, so a dragged file path — or a path you `cd` to — resolves
# verbatim. Finally drops any path nested under another (mounting both a parent
# and its child shadows the child), and de-dupes.
#
# rw_paths come FIRST so that when the same dir is listed in both, the surviving
# de-duped entry is the one path_is_rw agrees with. (It matches on the string,
# so order is belt-and-braces — but a future ordering-sensitive caller shouldn't
# have to rediscover this.)
resolved_mount_paths() {
  { split_path_list "${COLLAB_DC_MOUNT_RW_PATHS:-}"
    split_path_list "${COLLAB_DC_MOUNT_PATHS:-}"
    auto_mount_paths
  } | awk 'NF && !seen[$0]++' | drop_nested_paths
}

# True when a resolved mount path is configured read-write. Only an exact match
# counts: an ancestor of an rw path must NOT inherit write access, or adding
# `~/dev/foo` to rw_paths while `~/dev` sits in host_paths would quietly make
# every repo under ~/dev writable from the pod.
path_is_rw() {
  local p="$1" q
  while IFS= read -r q; do
    [[ "$q" == "$p" ]] && return 0
  done < <(split_path_list "${COLLAB_DC_MOUNT_RW_PATHS:-}")
  return 1
}

# Configured rw paths that did NOT survive resolution because they're nested
# inside another mounted path. The surviving ancestor is mounted read-only, so
# the pod silently gets no write access — worth saying out loud rather than
# leaving the user to discover it as a permission error mid-edit.
shadowed_rw_paths() {
  local resolved; resolved="$(resolved_mount_paths)"
  local p
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    grep -qxF "$p" <<<"$resolved" || printf '%s\n' "$p"
  done < <(split_path_list "${COLLAB_DC_MOUNT_RW_PATHS:-}")
}

# Auto-detected macOS locations a dragged-in file can come from, one per line.
# These are NOT in the toml because they're machine- and session-specific:
#
#   * the configured screenshot destination (com.apple.screencapture location);
#     unset means ~/Desktop, which host_paths already covers.
#   * $TMPDIR/TemporaryItems — where a screenshot lives BEFORE it lands. The
#     floating thumbnail's file is at
#     TemporaryItems/NSIRD_screencaptureui_*/Screenshot*.png, and dragging that
#     thumbnail hands over a path that exists nowhere else on disk.
#   * /private/tmp, which some apps use to stage drag promises.
#
# Deliberately NOT the whole $TMPDIR (/var/folders/<x>/<y>/T), even though it is
# the parent of TemporaryItems and other drop paths. minikube's 9p server can't
# serve it: a top-level listing fails with "Unknown error 526" (thousands of
# entries), and — worse — nothing under TemporaryItems is reachable through it at
# all, not even a file just created there. Mounted directly, TemporaryItems works
# perfectly. Mount the specific staging dirs, not their giant parent.
#
# Non-macOS hosts get nothing (getconf DARWIN_* fails), which is correct.
auto_mount_paths() {
  local -a auto=()
  local loc t
  if command -v defaults >/dev/null 2>&1; then
    loc="$(defaults read com.apple.screencapture location 2>/dev/null || true)"
    if [[ -n "$loc" ]]; then
      loc="$(expand_tilde "$loc")"; loc="${loc%/}"
      [[ -d "$loc" ]] && auto+=( "$loc" )
    fi
  fi
  if command -v getconf >/dev/null 2>&1; then
    t="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null || true)"
    [[ -n "$t" && -d "${t}TemporaryItems" ]] && auto+=( "${t}TemporaryItems" )
  fi
  [[ -d /private/tmp ]] && auto+=( /private/tmp )
  printf '%s\n' ${auto[@]+"${auto[@]}"}
}

# Filter stdin (one path per line): drop any path that lives under another path
# in the list. Mounting /a and /a/b both is redundant — the /a mount already
# exposes /a/b, and a second 9p mount on top of it just shadows the first.
drop_nested_paths() {
  awk '
    { paths[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        nested = 0
        for (j = 1; j <= NR; j++) {
          if (i != j && index(paths[i], paths[j] "/") == 1) { nested = 1; break }
        }
        if (!nested) print paths[i]
      }
    }
  '
}

# ---------------------------------------------------------------------------
# Host mounts (drag-and-drop dirs + the repo's .git)
#
# `minikube mount` is a long-lived host process that establishes ONE 9p mount
# inside the node and never reconnects. When the node goes away — a Mac reboot,
# `minikube stop/start`, a VM crash — the in-node mount dies but the host
# process lingers, healthy-looking, forever. That orphan is why mounts "don't
# come up after a restart": every liveness check here used to be `pgrep`, which
# the orphan satisfies, so `up` skipped remounting and `doctor` reported PASS
# while the pod saw empty directories.
#
# So liveness is read from the node's mount table, never from the process list.
# ---------------------------------------------------------------------------

# The node's mount table, fetched once per CLI run (an `minikube ssh` round-trip
# is ~1s; every path is checked against this one snapshot). Set
# COLLAB_DC_MOUNT_TABLE_STALE=1 to force a refetch after remounting.
node_mount_table() {
  if [[ -z "${COLLAB_DC_MOUNT_TABLE+x}" || "${COLLAB_DC_MOUNT_TABLE_STALE:-0}" == 1 ]]; then
    # </dev/null matters: this runs inside `while read` loops, and `minikube ssh`
    # would otherwise swallow the caller's stdin and truncate the iteration.
    COLLAB_DC_MOUNT_TABLE="$(minikube -p "$COLLAB_DC_CONTEXT" ssh -- mount </dev/null 2>/dev/null || true)"
    COLLAB_DC_MOUNT_TABLE_STALE=0
  fi
  printf '%s' "$COLLAB_DC_MOUNT_TABLE"
}

# True when the node actually has a live 9p mount at this path. Ground truth.
# Note we do NOT probe with `minikube ssh -- ls <path>`: the mounts are made
# --uid 0 --gid 0, and `minikube ssh` lands as the unprivileged `docker` user,
# so a healthy mount returns "Permission denied" there. The pod runs as root and
# reads it fine. The mount table is the honest signal.
mount_live_in_node() {
  local p="$1"
  grep -qF " on ${p} type 9p" <<<"$(node_mount_table)"
}

# Single-quote a string for safe interpolation into a remote shell command.
# Each embedded ' becomes '\'' — the standard close/escape/reopen dance. The
# quote is held in a variable because writing the pattern and replacement
# inline is unreadable and easy to get subtly wrong.
shq() {
  local s="$1" q="'"
  s="${s//$q/$q\\$q$q}"
  printf '%s%s%s' "$q" "$s" "$q"
}

# PIDs of `minikube mount` host processes for this exact path (usually 0 or 1).
#
# The path is matched with a literal bash comparison, never interpolated into
# the pgrep pattern. A path holding ERE metacharacters — the screenshot location
# is user-settable, so "~/Screen Shots (work)" is entirely possible — would
# otherwise never match, leaving mount_healthy permanently false and making
# every heal force-unmount and remount a perfectly good mount. At 120s intervals
# that would blind the pod indefinitely.
mount_host_pids() {
  local p="$1" line pid
  while IFS= read -r line; do
    pid="${line%% *}"
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    [[ "$line" == *" ${p}:${p}" ]] && printf '%s\n' "$pid"
  done < <(pgrep -fl "minikube .*mount " 2>/dev/null || true)
  return 0
}

# Kill the orphaned host process for a path, if any, so a fresh `minikube mount`
# can take over. Without this the new mount races the zombie for the same target.
reap_orphan_mount() {
  local p="$1" pids
  pids="$(mount_host_pids "$p")"
  [[ -z "$pids" ]] && return 0
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  sleep 1
  pids="$(mount_host_pids "$p")"
  # shellcheck disable=SC2086
  [[ -n "$pids" ]] && kill -9 $pids 2>/dev/null || true
  return 0
}

# Force the node to drop a mount entry at this path. Needed for the *reverse*
# orphan: the mount is listed in the node's table but no host process serves it
# any more, so every stat/read through it fails with EIO. That state is worse
# than a missing mount — the kubelet refuses to create the container at all
# ("invalid mount config ... input/output error"), so the pod never starts.
force_unmount_in_node() {
  local p="$1"
  minikube -p "$COLLAB_DC_CONTEXT" ssh -- "sudo umount -l $(shq "$p")" </dev/null >/dev/null 2>&1 || true
  COLLAB_DC_MOUNT_TABLE_STALE=1
}

# A path is only healthy when the node has a mount entry AND a host process is
# still serving it. Checking just one of the two misses a failure mode in each
# direction: a process without a mount (the classic post-reboot orphan) and a
# mount without a process (a stale entry that returns EIO on every access).
mount_healthy() {
  local p="$1"
  mount_live_in_node "$p" && [[ -n "$(mount_host_pids "$p")" ]]
}

# Start a `minikube mount host:host` for one path, replacing any orphan first.
# --uid/--gid 0 so the root pod user can read the files.
start_host_mount() {
  local p="$1"
  reap_orphan_mount "$p"
  # Clear any stale entry first; mounting on top of one inherits its EIO.
  mount_live_in_node "$p" && force_unmount_in_node "$p"
  # </dev/null for the same reason as node_mount_table: called from a read loop.
  minikube -p "$COLLAB_DC_CONTEXT" mount --uid 0 --gid 0 "${p}:${p}" </dev/null >/dev/null 2>&1 &
  disown || true
}

# Host paths currently served by a `minikube mount` process, one per line.
#
# Parses forward from the fixed prefix this tool always uses, rather than
# splitting the last whitespace-delimited field — a mount path containing a
# space would otherwise parse to garbage and drive wrong reap decisions. The
# argument is `host:target` with host == target, so everything up to the first
# ':' is the path (paths don't contain ':').
active_mount_paths() {
  local line rest
  while IFS= read -r line; do
    rest="${line#* mount }"
    [[ "$rest" == "$line" ]] && continue
    rest="${rest#--uid 0 --gid 0 }"
    [[ "$rest" == *:* ]] || continue
    printf '%s\n' "${rest%%:*}"
  done < <(pgrep -fl "minikube .*mount " 2>/dev/null || true)
  return 0
}

# Tear down mounts that are nested strictly inside one of the desired paths.
# When the desired set changes (we now mount all of $TMPDIR rather than just
# $TMPDIR/TemporaryItems) the old child mount keeps running, and a 9p mount
# stacked inside another one leaves the pod's bind of the parent empty. Only
# strictly-nested paths are reaped, so unrelated `minikube mount` processes —
# other repos' .git mounts on the same machine — are never touched.
reap_nested_mounts() {
  local -a desired=( "$@" )
  local a p
  while IFS= read -r a; do
    [[ -z "$a" ]] && continue
    for p in ${desired[@]+"${desired[@]}"}; do
      if [[ "$a" != "$p" && "$a" == "$p"/* ]]; then
        echo "  removing nested stale mount: $a (now covered by $p)"
        reap_orphan_mount "$a"
        minikube -p "$COLLAB_DC_CONTEXT" ssh -- "sudo umount $(shq "$a")" </dev/null >/dev/null 2>&1 || true
        COLLAB_DC_MOUNT_TABLE_STALE=1
        break
      fi
    done
  done < <(active_mount_paths)
}

# Serialize mount mutation between the LaunchAgent's 120s tick and whatever the
# user is running. Without it both can see "unhealthy" and both call
# start_host_mount: the second reaps the first's fresh process and unmounts its
# fresh mount. State still converges, but if a pod creation interleaves — pod
# binds mount epoch A while the other side is replacing it with epoch B — the
# result is a blind pod that every health check reports as fine.
#
# mkdir is the atomic primitive here (macOS has no flock(1)). A lock older than
# the timeout is treated as abandoned, so a killed process can't wedge it.
#
# The name is keyed on the MINIKUBE PROFILE, not on this tool, because the
# resource being protected is the node's mount table — which is shared by every
# devcontainer CLI pointed at the same profile. wft-devcontainer configures the
# same drop dirs as this one (~/Desktop, ~/Downloads, $TMPDIR/TemporaryItems,
# /private/tmp) and installs its own LaunchAgent on the same 120s tick; a
# tool-scoped lock let both heal the same path at once and reap each other's
# fresh mount. Any sibling tool using this name interlocks with us for free.
#
# Resolved lazily, not at source time: COLLAB_DC_CONTEXT is only set once
# load_config has run, so a top-level assignment would bake in the default
# profile and silently stop interlocking for anyone on a non-default one.
mount_lock_dir() {
  local t="${TMPDIR:-/tmp}"
  printf '%s/devcontainer-mounts.%s.lock' "${t%/}" "${COLLAB_DC_CONTEXT:-minikube}"
}
COLLAB_DC_LOCK_HELD=0

acquire_mount_lock() {
  local waited=0 age
  COLLAB_DC_LOCK_DIR="$(mount_lock_dir)"
  while ! mkdir "$COLLAB_DC_LOCK_DIR" 2>/dev/null; do
    # Steal a stale lock (>180s) — longer than the slowest legitimate heal.
    age="$(( $(date +%s) - $(stat -f %m "$COLLAB_DC_LOCK_DIR" 2>/dev/null || date +%s) ))"
    if (( age > 180 )); then
      rm -rf "$COLLAB_DC_LOCK_DIR" 2>/dev/null || true
      continue
    fi
    (( waited >= 60 )) && return 1
    sleep 1
    waited=$((waited + 1))
  done
  COLLAB_DC_LOCK_HELD=1
  # Release on any exit path, including the `exec` in enter_pod_shell.
  trap 'release_mount_lock' EXIT INT TERM
  return 0
}

release_mount_lock() {
  (( COLLAB_DC_LOCK_HELD )) || return 0
  rm -rf "$COLLAB_DC_LOCK_DIR" 2>/dev/null || true
  COLLAB_DC_LOCK_HELD=0
}

# Ensure every configured host path is mounted in the node, healing dead ones.
# Reads paths on stdin, one per line. Returns 1 if any path failed to come up.
#
# Pods bind these via hostPath with mountPropagation: HostToContainer, so a mount
# established here propagates into an ALREADY-RUNNING pod — healing does not
# require a pod recreate.
ensure_host_mounts() {
  local p rc=0
  local -a started=() want=()
  while IFS= read -r p; do
    [[ -n "$p" ]] && want+=( "$p" )
  done
  (( ${#want[@]} )) || return 0

  if ! acquire_mount_lock; then
    echo "  another collab-devcontainer is already working on the mounts; skipping." >&2
    return 0
  fi

  reap_nested_mounts ${want[@]+"${want[@]}"}

  for p in "${want[@]}"; do
    if mount_healthy "$p"; then
      echo "  ok: $p"
    else
      if mount_live_in_node "$p"; then
        echo "  stale (mount entry with no serving process — reads fail with EIO): $p — remounting..."
      elif [[ -n "$(mount_host_pids "$p")" ]]; then
        echo "  stale (orphaned mount process, node mount is gone): $p — remounting..."
      else
        echo "  mounting: $p"
      fi
      start_host_mount "$p"
      started+=( "$p" )
    fi
  done

  if (( ${#started[@]} == 0 )); then
    release_mount_lock
    return 0
  fi

  # Verify the new mounts actually landed rather than assuming. 9p setup takes a
  # few seconds; poll the node's mount table instead of a fixed sleep.
  local tries=0 pending
  while (( tries < 15 )); do
    sleep 1
    COLLAB_DC_MOUNT_TABLE_STALE=1
    pending=()
    for p in "${started[@]}"; do
      mount_healthy "$p" || pending+=( "$p" )
    done
    (( ${#pending[@]} == 0 )) && break
    tries=$((tries + 1))
  done

  for p in ${pending[@]+"${pending[@]}"}; do
    echo "  WARNING: $p did not come up — the pod will see an empty directory there." >&2
    rc=1
  done
  release_mount_lock
  return $rc
}

# Every host path that should be mounted: the drag-and-drop dirs plus the repo's
# .git (when enabled). One per line. Used by up, restart, mounts, and doctor so
# they can't drift apart.
all_mount_paths() {
  local mounts; mounts="$(resolved_mount_paths)"
  local host_git=""
  dotgit_enabled && host_git="$COLLAB_DC_TARGET_REPO/.git"
  # Nesting is re-checked across the COMBINED set, not just within the
  # drag-and-drop dirs. If a configured drop dir is an ancestor of the repo
  # (someone adding ~/dev to host_paths), .git would be both desired and nested,
  # and reap_nested_mounts would kill and remount it on every heal cycle.
  printf '%s\n%s\n' "$mounts" "$host_git" | awk 'NF && !seen[$0]++' | drop_nested_paths
}

# True when [git].mount_dotgit is set truthy AND the target repo has a real .git
# directory. A .git *file* (a submodule or linked-worktree pointer) is skipped:
# the actual gitdir lives elsewhere and would need its own mount. Used by cmd_up
# (to mount it) and cmd_doctor (to report on it).
dotgit_enabled() {
  case "$(printf '%s' "${COLLAB_DC_MOUNT_DOTGIT:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) [[ -d "$COLLAB_DC_TARGET_REPO/.git" ]] ;;
    *) return 1 ;;
  esac
}

die() {
  printf 'collab-devcontainer: %s\n' "$*" >&2
  exit 1
}

# kubectl pinned to the configured context + namespace. Pinning --context means
# we never accidentally act on a production cluster, even if the user's current
# context points elsewhere.
kc() {
  kubectl --context "$COLLAB_DC_CONTEXT" -n "$COLLAB_DC_NAMESPACE" "$@"
}

# Refuse to run unless the *current* kubectl context matches the configured one.
# We pin --context in kc(), but the reused collab scripts (mutagen.sh,
# port-forward.sh) use the current context — so guard it explicitly.
require_context() {
  local current
  current="$(kubectl config current-context 2>/dev/null || true)"
  if [[ "$current" != "$COLLAB_DC_CONTEXT" ]]; then
    die "current kubectl context is '${current:-none}', expected '$COLLAB_DC_CONTEXT'. Switch with: kubectl config use-context $COLLAB_DC_CONTEXT"
  fi
}

# Point docker at Minikube's daemon for the duration of the calling shell.
minikube_docker_env() {
  eval "$(minikube -p "$COLLAB_DC_CONTEXT" docker-env)"
}

# Name of the currently-running sandbox pod (empty if none).
#
# Must filter on phase and take the NEWEST match. `.items[0]` is not safe: during
# a Recreate rollout both the terminating old pod and the new one are listed, in
# arbitrary order, so callers would intermittently get the dying pod — which
# shows up as "cannot exec into a container in a completed pod" and as a Mutagen
# sync left pointing at a dead container.
pod_name() {
  kc get pods -l "app=$COLLAB_DC_DEPLOYMENT" \
     --field-selector=status.phase=Running \
     --sort-by=.metadata.creationTimestamp \
     -o jsonpath='{.items[-1:].metadata.name}' 2>/dev/null || true
}

# Exec an interactive bash shell into the pod. Unlike `docker exec`, `kubectl
# exec` has no -w/-e flags: the working dir comes from the pod's workingDir
# (/local-dev), and terminal-identification env vars (so in-pod Claude detects
# iTerm2 for Shift+Enter) are passed as an `env VAR=val ...` command prefix.
# Only forwards vars that are actually set. `exec`s, so it replaces the CLI.
enter_pod_shell() {
  local pod="$1" v
  local env_args=()
  for v in TERM_PROGRAM TERM_PROGRAM_VERSION ITERM_SESSION_ID \
           LC_TERMINAL LC_TERMINAL_VERSION COLORTERM; do
    [[ -n "${!v:-}" ]] && env_args+=( "$v=${!v}" )
  done
  # ${arr[@]+"${arr[@]}"} is the bash-3.2-safe (macOS) empty-array expansion.
  # Inline the kubectl invocation (not the kc() function): `exec` replaces the
  # process with a real binary and can't exec a shell function.
  exec kubectl --context "$COLLAB_DC_CONTEXT" -n "$COLLAB_DC_NAMESPACE" \
    exec -it "$pod" -- env ${env_args[@]+"${env_args[@]}"} bash
}

# Docker container ID of the pod's `app` container. Minikube uses the docker
# runtime (the same assumption collab's mutagen.sh / builddockerdev.sh make), so
# containerID comes back as docker://<id>; strip the scheme.
app_container_id() {
  local pod="$1" cid
  cid="$(kc get pod "$pod" -o jsonpath='{.status.containerStatuses[?(@.name=="app")].containerID}' 2>/dev/null || true)"
  cid="${cid#docker://}"; cid="${cid#containerd://}"
  printf '%s' "$cid"
}

# True if the Mutagen sync session exists. Avoids `mutagen sync list | grep -q`:
# under `set -o pipefail`, grep -q's early exit SIGPIPEs mutagen, so the pipeline
# reports failure exactly when the match IS found. Capture first, then grep a
# here-string (no pipe, no SIGPIPE).
sync_active() {
  command -v mutagen >/dev/null 2>&1 || return 1
  local out; out="$(mutagen sync list 2>/dev/null || true)"
  grep -q -- "$COLLAB_DC_MUTAGEN_SYNC" <<<"$out"
}

# True if the existing sync session actually points at THIS pod's app container.
# `sync_active` alone is not enough: the session survives the container it was
# created against, so after a pod recreate a sync named app-sync still exists,
# reports itself fine, and syncs into a dead container — leaving /local-dev
# empty in the new pod with no error anywhere.
sync_targets_pod() {
  local pod="$1" cid out
  command -v mutagen >/dev/null 2>&1 || return 1
  cid="$(app_container_id "$pod")"
  [[ -z "$cid" ]] && return 1
  out="$(mutagen sync list "$COLLAB_DC_MUTAGEN_SYNC" 2>/dev/null || true)"
  grep -q "docker://${cid}/" <<<"$out"
}

# Create (or refresh) the Mutagen sync against the pod's `app` container. The CLI
# owns this rather than calling collab's script/mutagen.sh because the isolated
# installer sidecar makes the pod multi-container, which breaks that script's
# `docker ps | grep app-dev` lookup. The sync produced is identical in name,
# ignores, and target (/local-dev, two-way-safe), so it's interchangeable with
# the manual flow's sync. Crucially, NO npm install happens here — deps install
# in the no-secrets installer container (see cmd_install_deps.sh).
ensure_sync() {
  local pod="$1"
  if ! command -v mutagen >/dev/null 2>&1; then
    echo "WARNING: mutagen not installed; install it (https://mutagen.io) to sync local edits into the pod." >&2
    return 0
  fi
  local cid; cid="$(app_container_id "$pod")"
  if [[ -z "$cid" ]]; then
    echo "WARNING: could not resolve the app container ID; skipping Mutagen sync." >&2
    return 0
  fi
  if sync_active; then
    mutagen sync terminate "$COLLAB_DC_MUTAGEN_SYNC" >/dev/null 2>&1 || true
  fi
  echo "Creating Mutagen sync '$COLLAB_DC_MUTAGEN_SYNC' against the app container..."
  if ! (
    cd "$COLLAB_DC_TARGET_REPO"
    eval "$(minikube -p "$COLLAB_DC_CONTEXT" docker-env)"
    mutagen sync create . "docker://$cid/local-dev" \
      --ignore=node_modules/,client/node_modules/,.git/,client/dist/,data/,log/ \
      --ignore-vcs --sync-mode=two-way-safe --name="$COLLAB_DC_MUTAGEN_SYNC"
  ); then
    echo "WARNING: mutagen sync create failed; local edits won't reach the pod." >&2
    return 0
  fi
  # Block until the initial transfer settles so npm ci sees package*.json.
  mutagen sync flush "$COLLAB_DC_MUTAGEN_SYNC" >/dev/null 2>&1 || true
}

# Where a host path appears inside the pod. Same absolute path for the
# drag-and-drop dirs (so a dragged path resolves verbatim); the repo's .git is
# the exception — it maps to <workspace>/.git.
pod_path_for() {
  local p="$1"
  if [[ "$p" == "$COLLAB_DC_TARGET_REPO/.git" ]]; then
    printf '%s/.git' "$COLLAB_DC_WORKSPACE_MOUNT"
  else
    printf '%s' "$p"
  fi
}

# End-to-end check: can the pod actually read what's at this host path? Prints a
# human-readable verdict; returns 0 when the mount is usable.
#
# Probes for specific entries taken from the host rather than counting a
# directory listing. Listing is the wrong instrument: a big $TMPDIR (thousands of
# entries) overflows 9p's readdir and fails with "Unknown error 526" while the
# mount is perfectly healthy for opening files — which is all a dragged-in path
# needs. Counting entries reported that working mount as broken.
pod_mount_view() {
  local pod="$1" host_path="$2" pod_path="$3" rc=0

  # Distinguish three outcomes inside the pod, because they need different
  # fixes and a plain entry count conflates them:
  #   3 = the path can't be read at all. A 9p mount gone bad returns EIO
  #       ("Unknown error 526") on every access while still looking mounted —
  #       the kubelet even refuses to start a container on it. Needs a remount.
  #   4 = readable but empty. The pod bound the path before the mount existed.
  #       Needs a pod rebind, not a remount.
  #   0 = content visible.
  kc exec "$pod" -- sh -c 'out=$(ls -A "$1" 2>/dev/null) || exit 3; [ -n "$out" ] || exit 4; exit 0' \
     _ "$pod_path" >/dev/null 2>&1 || rc=$?

  case "$rc" in
    0) printf 'ok'; return 0 ;;
    3) printf 'UNREADABLE (mount is bad — reads return EIO; needs a remount)'; return 1 ;;
    4)
      # Empty is only a fault if the host has something to show.
      if [[ -z "$(ls -A "$host_path" 2>/dev/null | head -1 || true)" ]]; then
        printf 'ok (host dir is empty)'
        return 0
      fi
      printf 'EMPTY IN POD (host has content; the pod bound this path before the mount existed)'
      return 1
      ;;
    *) printf 'UNKNOWN (could not probe the pod)'; return 1 ;;
  esac
}

# True when the RUNNING pod declares this mountPath read-only. Used to catch a
# pod whose spec predates a [mounts].rw_paths change: the 9p mount is fine and
# the dir is readable, so every other check passes, but writes fail with EROFS.
# jsonpath omits readOnly entirely when it's false, so an empty result means
# writable.
pod_mount_is_readonly() {
  local pod="$1" pod_path="$2" ro
  [[ -z "$pod" ]] && return 1
  ro="$(kc get pod "$pod" -o jsonpath="{range .spec.containers[?(@.name=='app')].volumeMounts[?(@.mountPath=='${pod_path}')]}{.readOnly}{end}" 2>/dev/null || true)"
  [[ "$ro" == "true" ]]
}

# True when the pod can't see one or more of its host mounts. Happens whenever
# the pod started while a mount was down — after a reboot the kubelet often
# recreates the pod before the mounts are back. mountPropagation re-delivers a
# mount that simply reappeared, but NOT one that was unmounted and remounted
# underneath a running container, so this has to be checked rather than assumed.
# Judged only against paths the pod actually DECLARES a volumeMount for. A
# desired path the pod never declared isn't a broken mount — it's a stale pod
# spec, which a rebind can't fix and which would otherwise make every `shell`
# trigger another pointless restart.
pod_is_blind_to_mounts() {
  local pod="$1" p
  [[ -z "$pod" ]] && return 1
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    pod_mount_view "$pod" "$p" "$(pod_path_for "$p")" >/dev/null || return 0
  done < <(pod_declared_mount_paths "$pod")
  return 1
}

# Rebind the pod onto the live mounts if it can't see them. Called from the
# user-facing entry points (up, shell) rather than from the background LaunchAgent:
# recreating the pod interrupts whatever is running inside it, so it happens when
# the user is present, not on a timer.
ensure_pod_binding() {
  local pod="$1"
  pod_is_blind_to_mounts "$pod" || return 0
  echo
  echo "The pod can't see its host mounts — it started before they were up."
  echo "Recreating it so .git and the drag-and-drop dirs resolve..."
  "$COLLAB_DC_TOOL_DIR/bin/collab-devcontainer" restart </dev/null
}

# Render a manifest to stdout: substitute __IMAGE__/__NAMESPACE__ and splice the
# generated hostPath blocks into the __EXTRA_VOLUME_MOUNTS__ / __EXTRA_VOLUMES__
# placeholder lines. Pure bash on purpose — passing multi-line blocks through
# sed/awk -v isn't portable (BSD awk on macOS rejects newlines in -v values).
render_manifest() {
  local file="$1" line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//__IMAGE__/$COLLAB_DC_IMAGE}"
    line="${line//__NAMESPACE__/$COLLAB_DC_NAMESPACE}"
    case "$line" in
      *__EXTRA_VOLUME_MOUNTS__*) [[ -n "${EXTRA_MOUNTS:-}" ]] && printf '%s\n' "$EXTRA_MOUNTS" ;;
      *__EXTRA_VOLUMES__*)       [[ -n "${EXTRA_VOLUMES:-}" ]] && printf '%s\n' "$EXTRA_VOLUMES" ;;
      *)                         printf '%s\n' "$line" ;;
    esac
  done < "$file"
}

apply_manifest() {
  render_manifest "$1" | kc apply -f -
}

# Build the YAML blocks injected for each host mount path (read on stdin, one
# per line). volumeMounts entries indent 12 spaces; volumes entries 8 spaces —
# matching k8s/app-dev.yaml. HostToContainer propagation so the container picks
# up the minikube 9p mount even if it (re)connects after the pod starts.
#
# Read-only by default — a drop dir only has to be readable, and the pod is the
# less-trusted side. Paths listed in [mounts].rw_paths are emitted writable
# instead, for host repos you want to edit from inside the pod. The 9p mount
# itself is always read-write (`minikube mount --uid 0 --gid 0`), so readOnly on
# the volumeMount is the only thing enforcing this.
build_mount_blocks() {
  EXTRA_MOUNTS=""; EXTRA_VOLUMES=""
  local i=0 p name ro
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    name="hostmount-$i"
    ro="              readOnly: true"$'\n'
    path_is_rw "$p" && ro=""
    EXTRA_MOUNTS+="            - name: ${name}"$'\n'"              mountPath: ${p}"$'\n'"${ro}""              mountPropagation: HostToContainer"$'\n'
    EXTRA_VOLUMES+="        - name: ${name}"$'\n'"          hostPath:"$'\n'"            path: ${p}"$'\n'"            type: DirectoryOrCreate"$'\n'
    i=$((i+1))
  done
  EXTRA_MOUNTS="${EXTRA_MOUNTS%$'\n'}"; EXTRA_VOLUMES="${EXTRA_VOLUMES%$'\n'}"
  export EXTRA_MOUNTS EXTRA_VOLUMES
}

# Append the .git bind-mount to EXTRA_MOUNTS/EXTRA_VOLUMES (call AFTER
# build_mount_blocks, which initializes them). Unlike the drag-and-drop mounts,
# this maps the host .git to a DIFFERENT in-pod path (<workspace>/.git) and is
# read-write so commits/fetches/index writes work. Same 12/8-space indentation
# and HostToContainer propagation as build_mount_blocks; DirectoryOrCreate to
# match those blocks (re-run `up` if the 9p mount ever drops out).
append_dotgit_mount() {
  local host_git="$1" pod_git="$2" nl=$'\n'
  local m="            - name: gitdir${nl}              mountPath: ${pod_git}${nl}              mountPropagation: HostToContainer"
  local v="        - name: gitdir${nl}          hostPath:${nl}            path: ${host_git}${nl}            type: DirectoryOrCreate"
  EXTRA_MOUNTS="${EXTRA_MOUNTS:+${EXTRA_MOUNTS}${nl}}${m}"
  EXTRA_VOLUMES="${EXTRA_VOLUMES:+${EXTRA_VOLUMES}${nl}}${v}"
  export EXTRA_MOUNTS EXTRA_VOLUMES
}

# Render and apply the pod manifest with the CURRENT desired mount set, then the
# PVC. Shared by `up` and `restart` so they can't disagree about what the pod
# declares — `restart` used to only `rollout restart`, which reuses the existing
# pod template. That mattered: when a path joins the desired set after the last
# `up` (TemporaryItems only exists once a screenshot has been taken, and is gone
# again after a reboot), the pod had no volumeMount for it, so the blindness
# check fired, `restart` couldn't fix it, and every later `shell` restarted the
# pod forever. Re-applying the manifest is what actually resolves that.
apply_pod_manifest() {
  local mounts; mounts="$(resolved_mount_paths)"
  local shadowed p; shadowed="$(shadowed_rw_paths)"
  if [[ -n "$shadowed" ]]; then
    while IFS= read -r p; do
      echo "WARNING: [mounts].rw_paths entry '$p' is nested inside another mounted path;" >&2
      echo "         the pod gets the read-only ancestor instead. Un-nest it to make it writable." >&2
    done <<<"$shadowed"
  fi
  build_mount_blocks <<<"$mounts"
  if dotgit_enabled; then
    append_dotgit_mount "$COLLAB_DC_TARGET_REPO/.git" "$COLLAB_DC_WORKSPACE_MOUNT/.git"
  fi
  apply_manifest "$COLLAB_DC_TOOL_DIR/k8s/claude-pvc.yaml"
  apply_manifest "$COLLAB_DC_TOOL_DIR/k8s/app-dev.yaml"
}

# The host paths the RUNNING pod actually declares a volumeMount for, one per
# line, expressed as host paths. Blindness must be judged against this, not
# against the desired set: a desired path the pod never declared is not a broken
# mount, it's a stale pod spec, and only a manifest re-apply can fix it.
pod_declared_mount_paths() {
  local pod="$1" mp
  [[ -z "$pod" ]] && return 0
  mp="$(kc get pod "$pod" -o jsonpath='{range .spec.containers[?(@.name=="app")].volumeMounts[*]}{.mountPath}{"\n"}{end}' 2>/dev/null || true)"
  local p pod_path
  while IFS= read -r p; do
    [[ -z "$p" ]] && continue
    pod_path="$(pod_path_for "$p")"
    grep -qxF "$pod_path" <<<"$mp" && printf '%s\n' "$p"
  done < <(all_mount_paths)
  return 0
}

# Copy host Claude config into the pod's /root/.claude (on the PVC). Portable,
# low-risk items only: skills/, plugins/, and the status-line script.
# settings.json, hooks, and permission rules are intentionally NOT copied — they
# carry host-specific paths/commands (and host allow-rules) that shouldn't leak
# into the pod. The status-line script only renders if the pod's settings.json
# points statusLine.command at it (see README).
seed_claude_config() {
  local pod="$1" item
  [[ -d "$HOME/.claude" ]] || return 0
  local copied=()
  for item in skills plugins statusline-command.sh; do
    if [[ -e "$HOME/.claude/$item" ]]; then
      if kc cp "$HOME/.claude/$item" "$pod:/root/.claude/$item" 2>/dev/null; then
        copied+=( "$item" )
      fi
    fi
  done
  # Keep the status-line script executable so Claude can run it.
  if [[ -f "$HOME/.claude/statusline-command.sh" ]]; then
    kc exec "$pod" -- chmod +x /root/.claude/statusline-command.sh 2>/dev/null || true
  fi
  if (( ${#copied[@]} )); then
    echo "Seeded host Claude config into pod: ${copied[*]}"
  fi
  return 0
}

# Copy postcreate.sh into the pod and run it. Idempotent — every path that
# produces a (re)created pod calls this, so the pod is never half-configured.
run_postcreate() {
  local pod="$1"
  echo "Running postCreate..."
  kc cp "$COLLAB_DC_TOOL_DIR/lib/postcreate.sh" "$pod:/tmp/collab-postcreate.sh"
  kc exec "$pod" -- bash /tmp/collab-postcreate.sh
}

exec_cmd() {
  local cmd="$1"; shift
  # shellcheck disable=SC1090
  source "$COLLAB_DC_TOOL_DIR/lib/${cmd}.sh"
  main "$@"
}
