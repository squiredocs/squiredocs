#!/bin/sh
# Squire Docs install script.
#
#   curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "Ada" --email "ada@example.com"
#
# Creates ./squire-docs, downloads the release files (compose.yml, squire,
# env.example, SHA256SUMS), verifies them against SHA256SUMS, writes .env with
# SQUIRE_VERSION and a unique COMPOSE_PROJECT_NAME (plus SQUIRE_PORT when set),
# starts the stack with docker compose up -d --wait, runs ./squire doctor, and
# prints a claim link as the only line on stdout. Progress and errors go to
# stderr, so `sh install.sh ... | tail -n 1` is the link.
# It never prompts and never reads stdin. It installs only into a new or empty
# folder, so it never overwrites or removes files it did not create.
#
# Run again on a folder that already holds an installation (it has
# compose.yml), it resumes: it downloads, writes, and removes nothing there,
# and runs the same start, doctor, and link steps. On a claimed instance the
# link signs the owner in. It never upgrades; when a newer release exists it
# prints the upgrade command.
#
# Options:
#   --dir PATH       install folder, new or empty, or an existing installation
#                    to start again (default ./squire-docs)
#   --version X.Y.Z  release to install, no leading v (default: the latest release)
#   --name NAME      owner name, prefilled on the claim page
#   --email EMAIL    owner email, prefilled on the claim page
#   --help           show usage
#
# Environment:
#   SQUIRE_INSTALL_ASSET_URL  base URL the four release files are downloaded from
#                             (default https://github.com/$REPOSITORY/releases/download/v<version>).
#                             CI points it at assets built in the same run. It changes nothing else.
#   SQUIRE_PORT               host port (default 3910), as in compose.yml; when set
#                             it is also written to .env so later commands keep it
#
# Requires Docker Compose 2.24 or later, a running Docker daemon, curl, od, and
# sha256sum or shasum.
#
# Plain HTTP is supported only on localhost. To expose an instance to other
# machines, put a TLS-terminating proxy in front of it and set an https APP_URL
# in .env.
#
# Above main there are only assignments and function definitions; everything
# runs from main, called on the last line, so a download cut short at a line
# boundary runs nothing.
#
# Source: https://github.com/squiredocs/squiredocs/blob/main/distribution/self-host/install.sh

REPOSITORY='squiredocs/squiredocs'
MIN_COMPOSE_MINOR=24

usage() {
  cat >&2 <<'EOF'
Usage: sh install.sh [--dir PATH] [--version X.Y.Z] [--name NAME] [--email EMAIL]

Installs Squire Docs with Docker Compose and prints a claim link.

  --dir PATH       install folder, new or empty (default ./squire-docs).
                   An existing installation is started again, unchanged.
  --version X.Y.Z  release to install, without a leading v (default: latest)
  --name NAME      owner name, prefilled on the claim page
  --email EMAIL    owner email, prefilled on the claim page
  --help           show this help
EOF
}

say() {
  printf '%s\n' "$*" >&2
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage_error() {
  printf 'Error: %s Run: sh install.sh --help\n' "$1" >&2
  exit 2
}

# ── State for cleanup ───────────────────────────────────────────────────────
# The folder is always one this run created or found empty, so removing the
# files it created never touches a file the user had. A resumed installation
# (RESUME=1) is never cleaned up: this run created nothing in it.
DIR=''
DIR_CREATED=0
CREATED=''
STARTED=0
RESUME=0
UP_LOG=''
CLAIM_LOG=''

cleanup() {
  rc=$?
  if [ -n "$UP_LOG" ]; then rm -f "$UP_LOG"; fi
  if [ -n "$CLAIM_LOG" ]; then rm -f "$CLAIM_LOG"; fi
  if [ "$rc" -ne 0 ] && [ "$STARTED" = 0 ] && [ "$RESUME" = 0 ] && [ -n "$DIR" ]; then
    for f in $CREATED; do
      rm -f "$DIR/$f"
    done
    if [ "$DIR_CREATED" = 1 ]; then
      rmdir "$DIR" 2>/dev/null || true
    fi
  fi
  exit "$rc"
}

created() {
  CREATED="$CREATED $1"
}

need_value() {
  if [ "$2" -lt 2 ]; then usage_error "$1 needs a value."; fi
}

is_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

# True when the folder has no entries, hidden ones included.
dir_is_empty() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then return 1; fi
  done
  return 0
}

latest_version() {
  curl -fsSI "https://github.com/$REPOSITORY/releases/latest" </dev/null 2>/dev/null \
    | tr -d '\r' \
    | sed -n 's#^[Ll]ocation:.*/releases/tag/v\{0,1\}\([^/ ]*\)$#\1#p' \
    | head -n 1
}

# True when release $1 is newer than release $2 (both X.Y.Z, optionally with
# a -prerelease tag, which sorts before the release it precedes).
version_newer() {
  vn_a=${1%%-*}
  vn_b=${2%%-*}
  for vn_i in 1 2 3; do
    vn_x=$(printf '%s\n' "$vn_a" | cut -d. -f"$vn_i")
    vn_y=$(printf '%s\n' "$vn_b" | cut -d. -f"$vn_i")
    if [ "$vn_x" -gt "$vn_y" ]; then return 0; fi
    if [ "$vn_x" -lt "$vn_y" ]; then return 1; fi
  done
  case "$1" in *-*) return 1 ;; esac
  case "$2" in *-*) return 0 ;; esac
  return 1
}

# The release an existing installation runs: SQUIRE_VERSION in its .env, else
# the default its compose.yml names. Prints nothing when neither is a release.
installed_version() {
  iv=''
  if [ -f "$1/.env" ]; then
    iv=$(sed -n 's/^ *SQUIRE_VERSION *= *//p' "$1/.env" </dev/null | head -n 1 | tr -d "\"' \r")
  fi
  if [ -z "$iv" ]; then
    iv=$(sed -n 's/.*\${SQUIRE_VERSION:-\([^}]*\)}.*/\1/p' "$1/compose.yml" </dev/null | head -n 1)
  fi
  if is_version "$iv"; then printf '%s\n' "$iv"; fi
  return 0
}

# The host port an existing installation uses: SQUIRE_PORT in its .env, else 3910.
installed_port() {
  ip=''
  if [ -f "$1/.env" ]; then
    ip=$(sed -n 's/^ *SQUIRE_PORT *= *//p' "$1/.env" </dev/null | head -n 1 | tr -d "\"' \r")
  fi
  case "$ip" in
    ''|*[!0-9]*) ip=3910 ;;
  esac
  printf '%s\n' "$ip"
}

# When the docker compose output in file $1 shows that an image could not be
# downloaded, prints the registry's reason, shortened, and succeeds.
pull_failure() {
  pf_line=$(grep -Ei 'unauthorized|denied|manifest unknown|not found|toomanyrequests|too many requests|dial tcp|no such host|i/o timeout|TLS handshake timeout|connection refused|connection reset|network is unreachable|Client\.Timeout' "$1" </dev/null | head -n 1)
  if [ -z "$pf_line" ]; then return 1; fi
  printf '%s\n' "$pf_line" \
    | sed -e 's/^[^A-Za-z0-9]*[A-Za-z0-9_.-]\{1,\} \{1,\}Error \{1,\}//' \
          -e 's/^ *//' \
          -e 's/^Error response from daemon: //' \
    | cut -c1-200
}

# The image: line of service $2 in compose file $1.
service_image() {
  awk -v svc="$2" '
    /^[^ #]/ { cur = "" }
    /^  [A-Za-z0-9_.-]+:[ \t]*$/ { cur = $1; sub(/:$/, "", cur); next }
    cur == svc && /^    image:/ { sub(/^    image:[ \t]*/, ""); print; exit }
  ' "$1" </dev/null
}

# The image docker compose could not download, for folder $1 and compose
# output file $2: the image of the service the output names (" app Error
# ..."), else the app's. The release in it is $3 when set, else the default
# compose.yml carries.
failed_image() {
  fimg_svc=$(sed -n 's/^[^A-Za-z0-9]*\([A-Za-z0-9_.-]\{1,\}\) \{1,\}Error .*/\1/p' "$2" </dev/null | head -n 1)
  fimg=''
  if [ -n "$fimg_svc" ]; then fimg=$(service_image "$1/compose.yml" "$fimg_svc"); fi
  if [ -z "$fimg" ]; then fimg=$(service_image "$1/compose.yml" app); fi
  if [ -n "$3" ]; then
    printf '%s\n' "$fimg" | sed 's/\${SQUIRE_VERSION:-[^}]*}/'"$3"'/'
  else
    printf '%s\n' "$fimg" | sed 's/\${SQUIRE_VERSION:-\([^}]*\)}/\1/'
  fi
}

# The squire CLI in the app container, run from the install folder: the
# ./squire wrapper when it is there, else the command it wraps.
squire_cli() {
  if [ -x ./squire ]; then ./squire "$@"; else docker compose exec -T app squire "$@"; fi
}

main() {
  set -eu

  # ── Flags ─────────────────────────────────────────────────────────────────
  OPT_DIR='./squire-docs'
  OPT_VERSION=''
  OPT_NAME=''
  OPT_EMAIL=''
  HAVE_NAME=0
  HAVE_EMAIL=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --dir)
        need_value "$1" $#
        OPT_DIR=$2
        shift 2
        ;;
      --version)
        need_value "$1" $#
        OPT_VERSION=$2
        shift 2
        ;;
      --name)
        need_value "$1" $#
        OPT_NAME=$2
        HAVE_NAME=1
        shift 2
        ;;
      --email)
        need_value "$1" $#
        OPT_EMAIL=$2
        HAVE_EMAIL=1
        shift 2
        ;;
      --*)
        usage_error "Unknown option $1."
        ;;
      *)
        usage_error "Unexpected argument $1."
        ;;
    esac
  done

  if [ -z "$OPT_DIR" ]; then usage_error "--dir needs a value."; fi

  if [ -n "$OPT_VERSION" ]; then
    case "$OPT_VERSION" in
      v*) usage_error "--version takes X.Y.Z without a leading v, for example --version ${OPT_VERSION#v}." ;;
    esac
    if ! is_version "$OPT_VERSION"; then
      usage_error "--version $OPT_VERSION is not X.Y.Z, for example --version 1.2.3."
    fi
  fi

  case "$REPOSITORY" in
    *'<'*)
      die "This install script has not been released yet. Watch https://squiredocs.com/documentation/self-hosting for the first release."
      ;;
  esac

  OPT_PORT=${SQUIRE_PORT:-}
  if [ -n "$OPT_PORT" ]; then
    case "$OPT_PORT" in
      *[!0-9]*) die "SQUIRE_PORT=$OPT_PORT is not a port number. Set it to a free port from 1 to 65535, or unset it to use 3910." ;;
    esac
    if [ "${#OPT_PORT}" -gt 5 ] || [ "$OPT_PORT" -lt 1 ] || [ "$OPT_PORT" -gt 65535 ]; then
      die "SQUIRE_PORT=$OPT_PORT is not a port number. Set it to a free port from 1 to 65535, or unset it to use 3910."
    fi
  fi

  # ── Prerequisites ─────────────────────────────────────────────────────────
  COMPOSE_HELP='Install Docker Desktop, or Docker Engine with the Compose plugin: https://docs.docker.com/compose/install/'

  if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed. $COMPOSE_HELP"
  fi
  if ! compose_version=$(docker compose version --short 2>/dev/null </dev/null); then
    die "Docker Compose v2 is not available (docker compose version failed). $COMPOSE_HELP"
  fi
  compose_version=$(printf '%s\n' "$compose_version" | head -n 1 | sed 's/^v//')
  compose_major=$(printf '%s\n' "$compose_version" | cut -d. -f1)
  compose_minor=$(printf '%s\n' "$compose_version" | cut -d. -f2)
  case "$compose_major$compose_minor" in
    ''|*[!0-9]*)
      die "Could not read the Docker Compose version from \"$compose_version\". Squire Docs needs Docker Compose 2.24 or later. $COMPOSE_HELP"
      ;;
  esac
  if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt "$MIN_COMPOSE_MINOR" ]; }; then
    die "Found Docker Compose $compose_version. Squire Docs needs Docker Compose 2.24 or later. Update Docker Desktop or the Compose plugin: https://docs.docker.com/compose/install/"
  fi
  if ! docker info >/dev/null 2>&1 </dev/null; then
    die "Docker is not running. Start Docker Desktop or the docker service, then run this script again."
  fi
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is not installed. Install curl with your package manager, then run this script again."
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    SUM='sha256sum'
  elif command -v shasum >/dev/null 2>&1; then
    SUM='shasum -a 256'
  else
    die "Neither sha256sum nor shasum is installed, and the release files are never used unverified. Install coreutils (sha256sum) or perl (shasum), then run this script again."
  fi

  # ── Folder ────────────────────────────────────────────────────────────────
  # A folder with compose.yml is an installation: this run resumes it and
  # never downloads, writes, or removes anything in it.
  if [ -f "$OPT_DIR/compose.yml" ]; then
    RESUME=1
  elif [ -e "$OPT_DIR" ] || [ -L "$OPT_DIR" ]; then
    if [ ! -d "$OPT_DIR" ]; then
      die "$OPT_DIR exists and is not a folder. Choose a new or empty folder with --dir."
    fi
    if ! dir_is_empty "$OPT_DIR"; then
      dir_abs=$(cd "$OPT_DIR" && pwd)
      die "$dir_abs is not empty. Squire Docs installs only into a new or empty folder, so it never overwrites your files. Choose another folder with --dir."
    fi
  fi

  trap cleanup EXIT
  trap 'exit 1' INT TERM HUP

  LATEST=''
  if [ "$RESUME" = 1 ]; then
    # ── Existing installation ───────────────────────────────────────────────
    DIR=$(cd "$OPT_DIR" && pwd)
    VERSION=$(installed_version "$DIR")
    if [ -n "$VERSION" ]; then
      say "Squire Docs $VERSION is already installed in $DIR. Starting it again; nothing in the folder is downloaded or changed."
    else
      say "Squire Docs is already installed in $DIR. Starting it again; nothing in the folder is downloaded or changed."
    fi
    if [ -n "$OPT_VERSION" ]; then
      if [ "$OPT_VERSION" != "$VERSION" ]; then
        say "--version $OPT_VERSION was not applied: the installer never changes the release of an existing installation${VERSION:+, which runs $VERSION}."
        say "To switch to $OPT_VERSION, set SQUIRE_VERSION=$OPT_VERSION in $DIR/.env, then run:"
        say "  cd $DIR && docker compose pull && docker compose up -d --wait"
      fi
    elif [ -n "$VERSION" ]; then
      latest=$(latest_version || true)
      if is_version "$latest" && version_newer "$latest" "$VERSION"; then LATEST=$latest; fi
    fi
    if [ -n "$OPT_PORT" ]; then PORT=$OPT_PORT; else PORT=$(installed_port "$DIR"); fi
  else
    # ── New installation ────────────────────────────────────────────────────
    if [ -d "$OPT_DIR" ]; then
      DIR=$(cd "$OPT_DIR" && pwd)
    else
      mkdir -p "$OPT_DIR" || die "Could not create $OPT_DIR. Choose a writable folder with --dir."
      DIR_CREATED=1
      DIR=$(cd "$OPT_DIR" && pwd)
    fi

    # ── Version ───────────────────────────────────────────────────────────────
    if [ -n "$OPT_VERSION" ]; then
      VERSION=$OPT_VERSION
    else
      VERSION=$(latest_version || true)
      if [ -z "$VERSION" ] || ! is_version "$VERSION"; then
        die "Could not find the latest Squire Docs release at https://github.com/$REPOSITORY/releases/latest. Pass the release to install with --version X.Y.Z."
      fi
    fi

    # A unique Compose project per install, so two installs never share
    # containers or volumes even when their folders have the same name.
    suffix=$(od -An -N4 -tx1 /dev/urandom </dev/null 2>/dev/null | tr -d ' \n')
    case "$suffix" in
      [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
      *) die "Could not read /dev/urandom with od to name the Compose project. Install od (coreutils), then run this script again." ;;
    esac
    PROJECT="squire-docs-$suffix"

    say "Installing Squire Docs $VERSION in $DIR"

    # ── Download and verify ───────────────────────────────────────────────────
    ASSET_URL=${SQUIRE_INSTALL_ASSET_URL:-https://github.com/$REPOSITORY/releases/download/v$VERSION}
    ASSET_URL=${ASSET_URL%/}

    for name in SHA256SUMS compose.yml squire env.example; do
      created "$name"
      if ! curl -fsSL -o "$DIR/$name" "$ASSET_URL/$name" </dev/null; then
        die "Could not download $name for Squire Docs $VERSION from $ASSET_URL/$name. Check that release v$VERSION exists and has its files, or pass another release with --version."
      fi
    done

    for name in compose.yml squire env.example; do
      expected=$(sed -n "s/^\([0-9a-fA-F]\{64\}\)  \*\{0,1\}$name\$/\1/p" "$DIR/SHA256SUMS" | head -n 1)
      if [ -z "$expected" ]; then
        die "SHA256SUMS for Squire Docs $VERSION does not list $name. The release is incomplete; nothing was started. Pass another release with --version."
      fi
      # SUM is a command plus its flags ('shasum -a 256'), split on purpose.
      # shellcheck disable=SC2086
      actual=$(cd "$DIR" && $SUM "$name" | cut -d' ' -f1)
      if [ "$actual" != "$expected" ]; then
        die "Checksum mismatch for $name (expected $expected, got $actual). The download was removed and nothing was started. Run this script again; if it fails again, report it at https://github.com/$REPOSITORY/issues."
      fi
    done

    created .env.example
    mv "$DIR/env.example" "$DIR/.env.example"
    chmod +x "$DIR/squire"
    created .env
    {
      printf 'SQUIRE_VERSION=%s\n' "$VERSION"
      printf 'COMPOSE_PROJECT_NAME=%s\n' "$PROJECT"
      if [ -n "$OPT_PORT" ]; then printf 'SQUIRE_PORT=%s\n' "$OPT_PORT"; fi
    } > "$DIR/.env"
    say "Downloaded and verified compose.yml, squire, and .env.example."
    PORT=${OPT_PORT:-3910}
  fi

  # ── Start ─────────────────────────────────────────────────────────────────
  # Every docker compose and ./squire call runs in $DIR, where compose reads
  # .env and so the project name and port. From here on nothing is removed on
  # failure: the folder is an installation, and running the installer again
  # resumes it.
  STARTED=1
  UP_LOG=$(mktemp)
  say "Starting Squire Docs (docker compose up -d --wait). The first start pulls the images and can take a few minutes."
  if ! (cd "$DIR" && docker compose up -d --wait) </dev/null >"$UP_LOG" 2>&1; then
    cat "$UP_LOG" >&2
    if grep -Eqi 'port is already allocated|address already in use' "$UP_LOG"; then
      die "Port $PORT is in use. Set SQUIRE_PORT in $DIR/.env and run docker compose up -d --wait again."
    fi
    if reason=$(pull_failure "$UP_LOG"); then
      image=$(failed_image "$DIR" "$UP_LOG" "$VERSION")
      die "Could not download the image ${image:-for Squire Docs} (the registry said: $reason). Your install folder is fine. Run the same install command again; it picks up where it left off."
    fi
    die "Squire Docs did not start. Running the same install command again picks up where it left off. To find the cause, read the app log with: cd $DIR && docker compose logs app"
  fi
  cat "$UP_LOG" >&2

  say "Checking the instance (./squire doctor)."
  if ! (cd "$DIR" && squire_cli doctor) </dev/null >&2; then
    die "squire doctor reported a problem (above). Fix the failed check, then run ./squire claim-link in $DIR, or run the same install command again."
  fi

  # ── Claim link ────────────────────────────────────────────────────────────
  # On a claimed instance claim-link prints a sign-in link for the owner
  # instead, and says so on stderr.
  set -- claim-link
  if [ "$HAVE_NAME" = 1 ]; then set -- "$@" --name "$OPT_NAME"; fi
  if [ "$HAVE_EMAIL" = 1 ]; then set -- "$@" --email "$OPT_EMAIL"; fi
  CLAIM_LOG=$(mktemp)
  if ! link=$(cd "$DIR" && squire_cli "$@" </dev/null 2>"$CLAIM_LOG"); then
    cat "$CLAIM_LOG" >&2
    die "Could not mint a claim link. Run it yourself: cd $DIR && ./squire claim-link"
  fi
  cat "$CLAIM_LOG" >&2
  link_lines=$(printf '%s\n' "$link" | grep -c . || true)
  if [ "$link_lines" != 1 ] || ! printf '%s\n' "$link" | grep -Eq '^https?://[^ ]+/claim#[A-Za-z0-9_-]+$'; then
    die "squire claim-link did not print a claim link. Run it yourself: cd $DIR && ./squire claim-link"
  fi
  SIGNIN=0
  if grep -q 'already has an owner' "$CLAIM_LOG"; then SIGNIN=1; fi

  say ""
  say "Squire Docs is running at http://localhost:$PORT in $DIR."
  if [ "$SIGNIN" = 1 ]; then
    say "Open the sign-in link below to sign in as the owner."
  else
    say "Open the claim link below, check your name and email, and click Continue."
  fi
  say "The link works once and expires in 15 minutes. For a new one, run: cd $DIR && ./squire claim-link"
  say "Stop it with: cd $DIR && docker compose down (never down -v, which deletes every document)."
  say "Plain HTTP is supported only on localhost. To expose this instance, put a TLS-terminating proxy in front of it and set an https APP_URL in .env."
  if [ -n "$LATEST" ]; then
    say "Squire Docs $LATEST is available. This installation runs $VERSION. To upgrade, set SQUIRE_VERSION=$LATEST in $DIR/.env, then run:"
    say "  cd $DIR && docker compose pull && docker compose up -d --wait"
  fi
  printf '%s\n' "$link"
}

{ main "$@"; }
