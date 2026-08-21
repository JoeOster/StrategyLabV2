#!/usr/bin/env bash
# Nightly hot backup of the StrategyLab SQLite DB to the NAS.
# Installed as strategylab-backup.service/.timer (user-level systemd).
set -euo pipefail

REPO="${REPO:-$HOME/StrategyLabV2}"
NAS_DIR="/mnt/brain/backups/strategylab"
STAGE="$REPO/data/backups"
KEEP_NAS=14
KEEP_LOCAL=3
STAMP="$(date -u +%F)"

cd "$REPO"

# The CIFS mount is `soft` + `_netdev`. If the NAS is down or the mount dropped,
# /mnt/brain is just an empty LOCAL directory -- writing there would quietly fill
# the NUC's own disk and report success, which is worse than no backup because it
# looks like one. Refuse to run instead.
mountpoint -q /mnt/brain || {
  echo "FATAL: /mnt/brain is not mounted -- refusing to write a fake backup" >&2
  exit 1
}

mkdir -p "$STAGE" "$NAS_DIR"
OUT="$STAGE/strategylab_${STAMP}.db"

# Hot backup via node:sqlite's backup(). WAL-safe and needs no service stop --
# a plain `cp` can capture a torn write mid-transaction.
OUT="$OUT" node --input-type=module -e '
import { DatabaseSync, backup } from "node:sqlite";
try { process.loadEnvFile(); } catch { /* no .env -- fall back to defaults */ }
const src = process.env.DB_PATH || "./data/strategy_lab.dev.db";
const db = new DatabaseSync(src);
await backup(db, process.env.OUT);
db.close();
'

gzip -f "$OUT"
cp "$OUT.gz" "$NAS_DIR/"

# Retention. `ls -1t` newest-first; drop everything past the keep count.
ls -1t "$NAS_DIR"/strategylab_*.db.gz 2>/dev/null | tail -n +$((KEEP_NAS + 1))   | xargs -r rm -f
ls -1t "$STAGE"/strategylab_*.db.gz   2>/dev/null | tail -n +$((KEEP_LOCAL + 1)) | xargs -r rm -f

echo "OK: $NAS_DIR/strategylab_${STAMP}.db.gz ($(du -h "$NAS_DIR/strategylab_${STAMP}.db.gz" | cut -f1))"
