#!/usr/bin/env bash
# Daily database + files backup. Add to crontab on the VPS:
#   15 4 * * * /opt/uniassist/deploy/backup.sh >> /var/log/uniassist-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=${BACKUP_DIR:-/var/backups/uniassist}
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date +%F-%H%M)
mkdir -p "$DEST"
docker compose exec -T postgres pg_dump -U uniassist -Fc uniassist > "$DEST/db-$STAMP.dump"
docker compose run --rm -T --no-deps --entrypoint tar app czf - -C /app data > "$DEST/data-$STAMP.tgz"
find "$DEST" -type f -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $STAMP"
