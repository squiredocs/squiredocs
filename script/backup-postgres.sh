#!/bin/sh
# Nightly Postgres backup → squiredocs-db-backups (FR-023, SC-006).
#
# Hardening vs. the old script:
#   * NO `set -x` — the DB password never appears in traced output.
#   * NO runtime `apk add` — pg_dump/s3cmd are baked into Dockerfile.backup.
#   * Password read from a MOUNTED FILE via PGPASSFILE — never on a command line
#     or in argv; pg_dump/s3cmd pick it up from libpq's ~/.pgpass mechanism.
#   * Timestamped filenames (full date+time) — a corrupt dump can never overwrite
#     a good one (the old `%j` day-of-year collided within a year).
#   * Uploads to squiredocs-db-backups (not the legacy shared earthquaketracksql).
#
# Runs NON-ROOT. Required env (set by the CronJob):
#   POSTGRES_HOST, POSTGRES_USER, POSTGRES_DATABASE
#   POSTGRES_PASSWORD_FILE  — path to a file containing ONLY the password
#   BACKUP_BUCKET           — target bucket (default squiredocs-db-backups)
# s3cmd config is mounted at /etc/s3cmd/s3cfg (from the backup-s3cmd SOPS Secret).

set -eu

POSTGRES_PORT="${POSTGRES_PORT:-5432}"
BACKUP_BUCKET="${BACKUP_BUCKET:-squiredocs-db-backups}"

if [ ! -r "${POSTGRES_PASSWORD_FILE:-}" ]; then
  echo "ERROR: POSTGRES_PASSWORD_FILE is unset or not readable." >&2
  exit 1
fi

# Build a libpq PGPASSFILE (.pgpass format) in a private temp file, mode 0600.
# The password comes from the mounted file and is written only to this 0600 file
# — never to argv, an env var visible in `ps`, or traced output.
PGPASSFILE="$(mktemp)"
export PGPASSFILE
chmod 600 "$PGPASSFILE"
cleanup() { rm -f "$PGPASSFILE"; }
trap cleanup EXIT INT TERM
printf '%s:%s:%s:%s:%s\n' \
  "$POSTGRES_HOST" "$POSTGRES_PORT" "$POSTGRES_DATABASE" "$POSTGRES_USER" \
  "$(cat "$POSTGRES_PASSWORD_FILE")" > "$PGPASSFILE"

# s3cmd config from the mounted Secret (writable HOME may not exist for the
# non-root user, so point s3cmd at the mount explicitly).
S3CFG="/etc/s3cmd/s3cfg"
if [ ! -r "$S3CFG" ]; then
  echo "ERROR: s3cmd config not found at $S3CFG (mount the backup-s3cmd Secret)." >&2
  exit 1
fi

# Full date+time + host + arch → unique, sortable, non-colliding filename.
fn="collab-postgres-$(hostname)-$(uname -m)-$(date -u '+%Y%m%dT%H%M%SZ').sql.gz"
echo "Backup filename: $fn"

workdir="$(mktemp -d)"
trap 'rm -f "$PGPASSFILE"; rm -rf "$workdir"' EXIT INT TERM
cd "$workdir"

# pg_dump reads the password from PGPASSFILE only (never a prompt flag, never
# PGPASSWORD, never argv).
pg_dump -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER" -d "$POSTGRES_DATABASE" \
  | gzip > "$fn"

s3cmd --config "$S3CFG" put "$fn" "s3://${BACKUP_BUCKET}/"
echo "Uploaded s3://${BACKUP_BUCKET}/${fn}"
