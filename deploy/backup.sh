#!/bin/sh
# G21 — Postgres backup (commercial-test stack). Usage: backup.sh [outfile]
# Dumps the moling_test database from the running postgres container.
set -e
CT=moling-test-postgres
OUT="${1:-/opt/moling-commercial-test/backups/moling_$(date +%Y%m%d_%H%M%S).dump}"
sudo mkdir -p "$(dirname "$OUT")"
sudo docker exec "$CT" pg_dump -U moling_test -d moling_test -Fc -f /tmp/moling_backup.dump
sudo docker cp "$CT":/tmp/moling_backup.dump "$OUT"
sudo docker exec "$CT" rm -f /tmp/moling_backup.dump
echo "BACKUP_OK $(du -h "$OUT" | cut -f1) -> $OUT"
