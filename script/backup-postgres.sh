#!/bin/bash
# Nightly Postgres backup → squiredocs-db-backups (FR-023, SC-006).
#
# Hardening vs. the old script:
#   * NO `set -x` — the DB password never appears in traced output.
#   * NO runtime package install — pg_dump + AWS CLI v2 are baked into
#     Dockerfile.backup (AWS CLI, not s3cmd: it sends the checksum Object Lock needs).
#   * Password read from a MOUNTED FILE via PGPASSFILE — never on a command line
#     or in argv; pg_dump picks it up from libpq's ~/.pgpass mechanism.
#   * Timestamped filenames (full date+time) — a corrupt dump can never overwrite
#     a good one (the old `%j` day-of-year collided within a year).
#   * Uploads to squiredocs-db-backups (not the legacy shared earthquaketracksql).
#
# Runs NON-ROOT. Required env (set by the CronJob):
#   POSTGRES_HOST, POSTGRES_USER, POSTGRES_DATABASE
#   POSTGRES_PASSWORD_FILE  — path to a file containing ONLY the password
#   BACKUP_BUCKET           — target bucket (default squiredocs-db-backups)
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY — from the backup-writer-creds Secret
#   AWS_DEFAULT_REGION      — optional (default us-east-1)

set -eu
# pipefail: in `pg_dump | gzip`, a pg_dump failure (down DB, auth error, OOM kill
# mid-stream) makes the WHOLE pipeline non-zero so `set -e` aborts BEFORE the
# s3cmd upload — a truncated/partial dump can never reach the bucket and leave the
# freshness alarm falsely green. Runs under bash (Debian base has no ash; dash
# lacks pipefail) — the CronJob command and Dockerfile ENTRYPOINT both use bash.
set -o pipefail

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

# AWS credentials come from env (the backup-writer-creds Secret). AWS CLI v2 is
# used instead of s3cmd because it sends the checksum header the Object-Lock
# bucket requires on every PutObject (s3cmd sends none → 400 InvalidRequest).
: "${AWS_ACCESS_KEY_ID:?ERROR: AWS_ACCESS_KEY_ID not set (mount the backup-writer-creds Secret)}"
: "${AWS_SECRET_ACCESS_KEY:?ERROR: AWS_SECRET_ACCESS_KEY not set (mount the backup-writer-creds Secret)}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"

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

# aws s3 cp sends a CRC checksum by default, satisfying the bucket's Object-Lock
# requirement; SSE-KMS is applied by the bucket's default encryption.
aws s3 cp "$fn" "s3://${BACKUP_BUCKET}/${fn}"
echo "Uploaded s3://${BACKUP_BUCKET}/${fn}"
