#!/bin/sh
# G21 — Postgres restore drill into a scratch DB (non-destructive round-trip).
# Restores the given .dump into moling_restore_drill, counts tables, then drops.
# Usage: restore-drill.sh /path/to/backup.dump
set -e
CT=moling-test-postgres
DUMP="${1:?usage: restore-drill.sh <dumpfile>}"
DB=moling_restore_drill
sudo docker cp "$DUMP" "$CT":/tmp/moling_restore.dump
sudo docker exec "$CT" psql -U moling_test -d moling_test -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true
sudo docker exec "$CT" createdb -U moling_test "$DB"
sudo docker exec "$CT" pg_restore -U moling_test -d "$DB" --no-owner --no-privileges /tmp/moling_restore.dump >/dev/null 2>&1
TBL=$(sudo docker exec "$CT" psql -U moling_test -d "$DB" -t -A -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
echo "RESTORE_OK tables=$TBL"
# schema_migrations head must survive the round trip
HEAD=$(sudo docker exec "$CT" psql -U moling_test -d "$DB" -t -A -c "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
echo "MIGRATION_HEAD=$HEAD"
sudo docker exec "$CT" psql -U moling_test -d moling_test -c "DROP DATABASE IF EXISTS $DB" >/dev/null
sudo docker exec "$CT" rm -f /tmp/moling_restore.dump
echo "DRILL_DONE"
