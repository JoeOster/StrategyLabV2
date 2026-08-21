# Migration: Joe's PC -> Orchestrator NUC

Drafted 2026-08-20, replacing the "held off deliberately" placeholder in
`STATUS.md`'s "Deployment target" section. Every fact below was verified by
running it against the NUC on 2026-08-20, not inferred from that project's docs.

## Preconditions (all verified, none outstanding)

| Check | Result |
|---|---|
| Node version | `/usr/bin/node` = **v24.18.0**, a real system binary, not nvm |
| `node:sqlite` | present -- `DatabaseSync, StatementSync, Session, backup` |
| Native deps | **none** -- only `express` + `yahoo-finance2`, both pure JS |
| Yahoo egress | live quote `MSFT 481.15 USD` + 14-bar chart via `yahoo-finance2@3.15.3` |
| GitHub | reachable, `origin/main` HEAD = `91de3f4`, matches clean local tree |
| Port 3113 | free |
| systemd `--user` | `Linger=yes`, ~10 units already running |
| Timezone | host is UTC; `alertScheduler.js` pins `America/New_York` via `Intl`, and node is **full-icu** -- verified it renders ET correctly from a UTC host |
| Disk | 17G free; app is ~42MB incl. `node_modules` |
| RAM | 8GB -> 16GB (Crucial CT2KIT102464BF160B, DDR3L-1600 1.35V) |

Note the nvm/PATH gotcha `STATUS.md` warned about is **obsolete** -- node is on
the default PATH, so systemd needs no wrapper or PATH shim.

## Steps

1. **Clone.**
   ```
   cd ~ && git clone https://github.com/JoeOster/StrategyLabV2.git
   cd ~/StrategyLabV2 && npm install
   ```

2. **Copy `.env` over** -- it is gitignored on purpose, so keys never enter git
   and the clone has none. `DB_PATH=./data/strategy_lab.dev.db` is relative with
   forward slashes, so it is portable as-is; no edit needed. Run from the PC,
   after the clone exists:
   ```
   scp .env orchestrator:~/StrategyLabV2/.env
   ssh orchestrator "chmod 600 ~/StrategyLabV2/.env"
   ```

3. **Init a fresh DB.** Confirmed 2026-08-20: the PC's data is throwaway test
   data, so nothing is copied over. No WAL checkpoint, no file transfer.
   ```
   npm run db:init
   ```

4. **Install the unit.**
   ```
   cp deploy/strategylab.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now strategylab.service
   ```

5. **Verify.**
   ```
   systemctl --user status strategylab.service
   curl -s localhost:3113/api/summary | head -c 300
   ```
   Then open `http://<NUC-IP>:3113` from the PC browser.

## Backup: nightly DB snapshot -> NAS

**Target: `/mnt/brain/backups/strategylab/`** -- not `/mnt/documents`. That share is
mounted **read-only** (`ro` is hard-coded in `/etc/fstab`, verified empirically:
`touch` returns "Read-only file system"), and changing it needs root, which `joe`
does not have passwordless. `/mnt/brain` is already rw and already holds
`supabase_claude_training_*.sql.gz`, so DB dumps landing there is existing practice.
It also inherits the Synology Hyper Backup job (`/volume1/brain` -> Google Drive),
which means offsite protection for free.

6. **Install the backup timer.**
   ```
   cp deploy/strategylab-backup.{service,timer} ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now strategylab-backup.timer
   ```

7. **Verify the backup end to end** (do not wait for the timer):
   ```
   systemctl --user start strategylab-backup.service
   journalctl --user -u strategylab-backup.service -n 20 --no-pager
   ls -la /mnt/brain/backups/strategylab/
   ```

### Design notes

- **Hot backup, not `cp`.** `deploy/backup-db.sh` uses `node:sqlite`'s module-level
  `backup(db, dest)` -- verified on the NUC 2026-08-20, round-trips correctly under
  WAL. A plain `cp` can capture a torn write mid-transaction. The service never
  needs stopping. Note `sqlite3` (the CLI) is **not installed** on that box, and
  installing it would need sudo -- using `node:sqlite` sidesteps that entirely.
- **It refuses to run if the NAS is unmounted.** The CIFS mounts are `soft` +
  `_netdev`, so a dead NAS leaves `/mnt/brain` as an empty *local* directory.
  Writing there would fill the NUC's own disk while reporting success -- a fake
  backup is worse than none, because you would trust it. `mountpoint -q` guards this.
- **Staged locally, then copied.** Backup lands in `data/backups/` first (already
  gitignored via `data/`), gets gzipped, then copied to the NAS -- so a mid-write
  CIFS timeout cannot truncate the only copy.
- **Retention:** 14 on the NAS, 3 local.
- **Timing:** 09:30 UTC, ~50 min ahead of Hyper Backup's ~10:20-11:20 UTC window so
  each night goes offsite the same morning. `Persistent=true` covers missed slots.

## Post-move follow-ups

- ~~`npm run stop` / `npm run restart` are Windows-only~~ -- **done 2026-08-21**:
  `scripts/stop-server.ps1` and both npm scripts are removed. Use
  `systemctl --user restart strategylab`.
- **No auth, binds `0.0.0.0`.** Unchanged from the PC, and it has to stay
  LAN-reachable because the browser UI is used from the PC -- there is no
  reverse proxy on that box. This matches the existing `homepage` /
  `claude-training-web` pattern. If it ever needs locking down, follow
  `coursework-browser`'s HTTPS approach rather than binding loopback.
- **Fill in the HA webhook** (`Settings > General`): alert webhook URL + auth
  header. Still blocked on Joe picking a `notify.<target>` and pasting his own
  long-lived token -- see `ai_orchestrator/projects/strategylab-integration.md`.
- **Unblocked by this move:** the becca-companion stock panel can switch from
  Yahoo's unofficial endpoint to StrategyLab over loopback, and the bidirectional
  watchlist sync in that same doc's 2026-08-20 backlog entry becomes a same-box
  API call.
