#!/bin/bash
set -euo pipefail

# One-shot pg_dump | psql sync for the collab Postgres database.
# Used during the GKE -> k3s-wft-aws cutover.
#
# IMPORTANT: scale GKE collab-app to 0 BEFORE running this so no new writes
# arrive on the source side during the dump.
#
# Source:  gke_eqtgke_us-west1-a_juicy-snowflake / namespace=collab / deploy=collab-postgres
# Target:  k3s-wft-aws / namespace=collab / deploy=collab-postgres
# Database name (both): collab_db
#
# After import, REINDEXes the HNSW vector index.

SRC_CTX="gke_eqtgke_us-west1-a_juicy-snowflake"
DST_CTX="k3s-wft-aws"
NS="collab"
DB="collab_db"

DUMP_FILE="/tmp/collab_db-$(date +%Y%m%d-%H%M%S).sql"

# Get DB credentials from the postgres-secret (same on both sides since we copied it)
PG_USER=$(kubectl --context="$SRC_CTX" -n "$NS" get secret postgres-secret -o jsonpath='{.data.username}' | base64 -d)
PG_PASS=$(kubectl --context="$SRC_CTX" -n "$NS" get secret postgres-secret -o jsonpath='{.data.password}' | base64 -d)

echo "==> Dumping $SRC_CTX/$NS/$DB ..."
kubectl --context="$SRC_CTX" -n "$NS" exec deploy/collab-postgres -- \
  env PGPASSWORD="$PG_PASS" pg_dump -U "$PG_USER" -d "$DB" --no-owner --no-acl --clean --if-exists \
  > "$DUMP_FILE"

echo "    dump size: $(du -h "$DUMP_FILE" | cut -f1)  ->  $DUMP_FILE"

echo "==> Restoring into $DST_CTX/$NS/$DB ..."
kubectl --context="$DST_CTX" -n "$NS" exec -i deploy/collab-postgres -- \
  env PGPASSWORD="$PG_PASS" psql -U "$PG_USER" -d "$DB" -v ON_ERROR_STOP=0 \
  < "$DUMP_FILE" 2>&1 | tail -20

echo "==> Reindexing pgvector HNSW index (forces clean rebuild after import) ..."
kubectl --context="$DST_CTX" -n "$NS" exec deploy/collab-postgres -- \
  env PGPASSWORD="$PG_PASS" psql -U "$PG_USER" -d "$DB" -c \
  "REINDEX INDEX idx_embeddings_hnsw" 2>&1 || echo "    (HNSW reindex failed or index not present — non-fatal)"

echo "==> Row count parity check"
for ctx in "$SRC_CTX" "$DST_CTX"; do
  echo "--- $ctx ---"
  kubectl --context="$ctx" -n "$NS" exec deploy/collab-postgres -- \
    env PGPASSWORD="$PG_PASS" psql -U "$PG_USER" -d "$DB" -c "
      SELECT 'users' AS tbl, COUNT(*) FROM users
      UNION ALL SELECT 'documents', COUNT(*) FROM documents
      UNION ALL SELECT 'document_embeddings', COUNT(*) FROM document_embeddings
      UNION ALL SELECT 'yjs_updates', COUNT(*) FROM yjs_updates
      UNION ALL SELECT 'document_versions', COUNT(*) FROM document_versions
      UNION ALL SELECT 'chats', COUNT(*) FROM chats
    "
done

echo
echo "Done. Dump retained at $DUMP_FILE"
