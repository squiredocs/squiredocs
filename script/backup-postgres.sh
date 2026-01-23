#!/bin/bash
# This script performs the PostgreSQL backup and uploads it to S3.

set -o pipefail # Exit if any command in a pipeline fails
set -x # Print commands and their arguments as they are executed
set -e # Exit immediately if a command exits with a non-zero status

# Install PostgreSQL client tools if not already installed
if ! command -v pg_dump &> /dev/null; then
    echo "Installing PostgreSQL client tools..."
    # Add PostgreSQL official repository to get version 16
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | apt-key add - && echo "deb http://apt.postgresql.org/pub/repos/apt/ bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update && apt-get install -y postgresql-client-16
fi

# Ensure the s3cmd configuration is linked
# This is necessary for s3cmd to find its configuration file.
# The s3cfg file is mounted from a ConfigMap to /etc/s3cmd/s3cfg
# Remove existing symlink if it exists to handle container restarts
rm -f /root/.s3cfg
ln -s /etc/s3cmd/s3cfg /root/.s3cfg

# Define the filename with hostname, architecture, and day of year.
# Using command substitution to get dynamic parts of the filename.
fn="collab-postgres-$(hostname)-$(uname -m)-$(date '+%j').sql.gz"

# Echo the filename immediately after assignment to verify
echo "Generated filename (after assignment): \"$fn\""

# Create the backup directory if it doesn't exist and change into it.
# Chain commands using && for sequential execution.
mkdir -p /var/sql_backups && cd /var/sql_backups

# Echo the filename again just before it's used in the pipe
echo "Generated filename (before use in pipe): \"$fn\""

# Perform the pg_dump, gzip it, and save to the file.
# Using environment variables for database connection
# Pipe the output of pg_dump to gzip, and redirect the output to the file named by $fn.
# Using double quotes around $fn to handle potential spaces or special characters in the filename.
PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h $POSTGRES_HOST -U $POSTGRES_USER -d $POSTGRES_DATABASE | gzip > "$fn"

# Upload the gzipped file to the S3 bucket.
# Using double quotes around $fn for consistency and safety.
s3cmd put "$fn" s3://earthquaketracksql/

# Optional: Add a cleanup step if you want to remove the local backup file after upload
# rm "$fn"
