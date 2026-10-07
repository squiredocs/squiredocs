#!/bin/sh
# Squire Docs install script.
#
#   curl -fsSL https://squiredocs.com/install.sh | sh -s -- --name "Ada" --email "ada@example.com"
#
# Creates ./squire-docs, downloads the release files (compose.yml, squire,
# env.example, SHA256SUMS), verifies them against SHA256SUMS, writes .env with
# SQUIRE_VERSION, starts the stack with docker compose up -d --wait, runs
# ./squire doctor, and prints a claim link as the only line on stdout. Progress
# and errors go to stderr, so `sh install.sh ... | tail -n 1` is the link.
# It never prompts and never reads stdin.
#
# Options:
#   --dir PATH       install folder (default ./squire-docs)
#   --version X.Y.Z  release to install, no leading v (default: the latest release)
#   --name NAME      owner name, prefilled on the claim page
#   --email EMAIL    owner email, prefilled on the claim page
#   --help           show usage
#
# Environment:
#   SQUIRE_INSTALL_ASSET_URL  base URL the four release files are downloaded from
#                             (default https://github.com/<REPOSITORY>/releases/download/v<version>).
#                             CI points it at assets built in the same run. It changes nothing else.
#   SQUIRE_PORT               host port (default 3910), as in compose.yml
#
# Requires Docker Compose 2.24 or later, a running Docker daemon, curl, and
# sha256sum or shasum.
#
# Plain HTTP is supported only on localhost. To expose an instance to other
# machines, put a TLS-terminating proxy in front of it and set an https APP_URL
# in .env.
#
# Source: https://github.com/<org>/<repo>/blob/main/distribution/self-host/install.sh

set -eu

REPOSITORY='<org>/<repo>'
MIN_COMPOSE_MINOR=24

usage() {
  cat >&2 <<'EOF'
Usage: sh install.sh [--dir PATH] [--version X.Y.Z] [--name NAME] [--email EMAIL]

Installs Squire Docs with Docker Compose and prints a claim link.

  --dir PATH       install folder (default ./squire-docs)
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
DIR=''
DIR_CREATED=0
CREATED=''
STARTED=0
UP_LOG=''

cleanup() {
  rc=$?
  if [ -n "$UP_LOG" ]; then rm -f "$UP_LOG"; fi
  if [ "$rc" -ne 0 ] && [ "$STARTED" = 0 ] && [ -n "$DIR" ]; then
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

# ── Flags ───────────────────────────────────────────────────────────────────
OPT_DIR='./squire-docs'
OPT_VERSION=''
OPT_NAME=''
OPT_EMAIL=''
HAVE_NAME=0
HAVE_EMAIL=0

need_value() {
  if [ "$2" -lt 2 ]; then usage_error "$1 needs a value."; fi
}

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

is_version() {
  printf '%s\n' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
}

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

# ── Prerequisites ───────────────────────────────────────────────────────────
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

# ── Version ─────────────────────────────────────────────────────────────────
latest_version() {
  curl -fsSI "https://github.com/$REPOSITORY/releases/latest" </dev/null 2>/dev/null \
    | tr -d '\r' \
    | sed -n 's#^[Ll]ocation:.*/releases/tag/v\{0,1\}\([^/ ]*\)$#\1#p' \
    | head -n 1
}

# ── Folder ──────────────────────────────────────────────────────────────────
if [ -f "$OPT_DIR/compose.yml" ]; then
  dir_abs=$(cd "$OPT_DIR" && pwd)
  example=''
  latest=$(latest_version || true)
  if [ -n "$latest" ] && is_version "$latest"; then example=", for example $latest"; fi
  say "Squire Docs is already installed in $dir_abs."
  say "To upgrade, set SQUIRE_VERSION in $dir_abs/.env to the new release$example, then run:"
  say "  cd $dir_abs && docker compose pull && docker compose up -d --wait"
  exit 1
fi

trap cleanup EXIT
trap 'exit 1' INT TERM HUP

if [ -d "$OPT_DIR" ]; then
  DIR=$(cd "$OPT_DIR" && pwd)
else
  mkdir -p "$OPT_DIR" || die "Could not create $OPT_DIR. Choose a writable folder with --dir."
  DIR_CREATED=1
  DIR=$(cd "$OPT_DIR" && pwd)
fi

if [ -n "$OPT_VERSION" ]; then
  VERSION=$OPT_VERSION
else
  VERSION=$(latest_version || true)
  if [ -z "$VERSION" ] || ! is_version "$VERSION"; then
    die "Could not find the latest Squire Docs release at https://github.com/$REPOSITORY/releases/latest. Pass the release to install with --version X.Y.Z."
  fi
fi

say "Installing Squire Docs $VERSION in $DIR"

# ── Download and verify ─────────────────────────────────────────────────────
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
printf 'SQUIRE_VERSION=%s\n' "$VERSION" > "$DIR/.env"
say "Downloaded and verified compose.yml, squire, and .env.example."

# ── Start ───────────────────────────────────────────────────────────────────
# From here on nothing is removed on failure: the folder is an installation.
STARTED=1
PORT=${SQUIRE_PORT:-3910}
UP_LOG=$(mktemp)
say "Starting Squire Docs (docker compose up -d --wait). The first start pulls the images and can take a few minutes."
if ! (cd "$DIR" && docker compose up -d --wait) </dev/null >"$UP_LOG" 2>&1; then
  cat "$UP_LOG" >&2
  if grep -Eqi 'port is already allocated|address already in use' "$UP_LOG"; then
    die "Port $PORT is in use. Set SQUIRE_PORT in $DIR/.env and run docker compose up -d --wait again."
  fi
  die "Squire Docs did not start. Read the app log with: cd $DIR && docker compose logs app"
fi
cat "$UP_LOG" >&2

say "Checking the instance (./squire doctor)."
if ! (cd "$DIR" && ./squire doctor) </dev/null >&2; then
  die "squire doctor reported a problem (above). Fix the failed check, then run ./squire claim-link in $DIR."
fi

# ── Claim link ──────────────────────────────────────────────────────────────
set -- claim-link
if [ "$HAVE_NAME" = 1 ]; then set -- "$@" --name "$OPT_NAME"; fi
if [ "$HAVE_EMAIL" = 1 ]; then set -- "$@" --email "$OPT_EMAIL"; fi
if ! link=$(cd "$DIR" && ./squire "$@" </dev/null); then
  die "Could not mint a claim link. Run it yourself: cd $DIR && ./squire claim-link"
fi
link_lines=$(printf '%s\n' "$link" | grep -c . || true)
if [ "$link_lines" != 1 ] || ! printf '%s\n' "$link" | grep -Eq '^https?://[^ ]+/claim#[A-Za-z0-9_-]+$'; then
  die "squire claim-link did not print a claim link. Run it yourself: cd $DIR && ./squire claim-link"
fi

say ""
say "Squire Docs is running at http://localhost:$PORT in $DIR."
say "Open the claim link below, check your name and email, and click Continue."
say "Stop it with: cd $DIR && docker compose down (never down -v, which deletes every document)."
say "Plain HTTP is supported only on localhost. To expose this instance, put a TLS-terminating proxy in front of it and set an https APP_URL in .env."
printf '%s\n' "$link"
