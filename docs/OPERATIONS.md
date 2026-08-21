# Operations

Schema migrations, backups, and the restore drill. Written 2026-08-21, when the
answer to a schema mismatch stopped being "delete your data directory".

---

## Migrations

Forward-only. Numbered SQL files in `migrations/`, a `schema_migrations` ledger
table, applied in order.

```bash
npm run db:migrate -- --status   # what would run, without running it
npm run db:migrate               # back up, then apply
```

A backup is taken **before** anything is applied, every time, into
`data/backups/pre-migration_<timestamp>.db`. If a migration fails, the database
is left at the last one that succeeded and the command prints the exact `cp` to
get back.

### Adding a migration

1. Write `migrations/0NN_short_description.sql`. The number is one above the
   last, with no gaps.
2. Make the same change in `schema.sql`, so a fresh `npm run db:init` produces
   an identical database.
3. Bump `SCHEMA_VERSION` in `lib/schemaVersion.js` to match `0NN`.

The offline suite enforces (1) and (3): versions must be contiguous and the
newest migration must equal `SCHEMA_VERSION`. Bumping the version without
writing the file is precisely how a database ends up structurally behind what
the code believes, so it fails the build rather than being noticed later.

### Baselining

A database built from `schema.sql` already contains every migration's effect.
Replaying them would fail on "table already exists", so the ledger is marked
instead:

```bash
npm run db:migrate -- --baseline
```

`init-db.js` and the offline suite both do this automatically. **Any other code
path that applies `schema.sql` directly must do it too.**

Baseline defaults to the version the database itself claims, not to
`SCHEMA_VERSION`. Those differ exactly when it matters — a hand-migrated v13
database baselined at the code's v14 would mark v14 as applied without its
tables existing, and that surfaces much later as a missing-table error.

### What it refuses

Migrations start at 012, so a database must already be at v11. Anything older
is refused with an explanation rather than migrated.

This was found by an actual restore drill, not by reasoning: a v7 backup was
cheerfully "migrated" to v14 and stamped current, because 012–014 applied fine
on top of it. The v8–v11 changes were simply absent, and the app then died on
startup with `table transactions has no column named needs_review`. Producing a
database that *claims* to be current and is not is worse than refusing.

---

## Backups

`deploy/backup-db.sh` runs nightly via a systemd timer, writes to the NAS, and
refuses to run if `/mnt/brain` is not mounted — an unmounted CIFS share is just
an empty local directory, and writing there would silently fill the NUC's disk
while reporting success.

`npm run db:migrate` takes its own backup independently, so a migration never
depends on the nightly having worked.

---

## The restore drill

**A backup you have never restored is a hypothesis.** Run this occasionally,
and definitely after any change to the backup script.

```bash
gunzip -c data/backups/strategylab_<date>.db.gz > /tmp/restore-test.db

# 1. Is the file sound?
DB_PATH=/tmp/restore-test.db node -e "import('./lib/db.js').then(m=>{const d=m.default;
  console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);
  console.log('fk violations:', d.prepare('PRAGMA foreign_key_check').all().length);
  console.log('accounts:', d.prepare('SELECT COUNT(*) n FROM accounts').get().n)})"

# 2. Does it need migrating, and can it be?
DB_PATH=/tmp/restore-test.db npm run db:migrate -- --status

# 3. Does the app actually boot against it?
DB_PATH=/tmp/restore-test.db PORT=3199 node server.js
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3199/api/accounts
```

Step 3 is the one that matters. Steps 1 and 2 passed on a backup that then
failed to boot — integrity was fine, the migration reported success, and the
server died on a missing column. Only starting it found that.

**Findings from the first drill (2026-08-21):**

- The nightly `.gz` backup then on disk was a **v7 snapshot with zero
  accounts**, taken at 09:30 before the current database was built at 13:52. It
  was not corrupt — it was simply from before the data existed. Worth knowing
  that the newest nightly is not automatically a useful restore target.
- The migration runner would have silently mis-migrated it. That guard now
  exists because of this drill.

---

## Merging a branch that carries a schema change

The live database is migrated separately from the code. For a database that was
hand-migrated before the runner existed:

```bash
npm run db:migrate -- --status     # will list files it already has, structurally
npm run db:migrate -- --baseline   # records what it already has, runs nothing
npm run db:migrate                 # applies only what is genuinely missing
```

Verified on a copy of the live v13 database: baseline recorded 012 and 013,
migrate applied only 014, and all six accounts survived.

Do it on a copy first. It costs a minute.

---

## The pre-commit hook

`deploy/githooks/pre-commit` runs the offline suite and blocks the commit if it
fails. Enabled with:

```bash
git config core.hooksPath deploy/githooks
```

Versioned rather than living in an untracked `.git/hooks`, so a fresh clone gets
it with one config command. Costs about four seconds per commit.

It exists because the suite was dead for weeks and nobody noticed: it threw
part-way through, 216 checks silently stopped running, and the last line of
output still looked normal. The exit code was correct the entire time — nothing
was reading it.

The suite also carries `MIN_EXPECTED_CHECKS`, asserted from a `process.on("exit")`
handler so it fires even when the suite throws. A run that does far fewer checks
than expected says so in words:

```
ABORTED: only 441 checks ran, expected at least 450.
The suite stopped early. Any passes above are NOT a clean run.
```

Raise that number as tests are added. Never lower it to make a run pass — if the
count dropped, something stopped running.

To bypass the hook deliberately: `git commit --no-verify`.

## Never copy a database file over a running instance

Learned the hard way during the plan-exits merge, 2026-08-21.

The move was: snapshot the branch database with `VACUUM INTO`, then `cp` it
over `data/strategy_lab.dev.db` in the main tree. The snapshot was fine. The
copy produced `database disk image is malformed`.

The reason is worth understanding, because the mistake looks harmless:

1. The service on 3113 was still running, holding the old file open **by
   inode**, in WAL mode.
2. `cp` truncates and rewrites that same inode. The running process's handle
   now points at entirely different content, and it has no idea.
3. Stopping the service made it checkpoint its old `-wal` into what it thought
   was its own database. It was not. Old pages landed in the new file.

The stale `-wal` and `-shm` left beside the file are the visible symptom;
the corruption is already done by then.

**The order that works:**

```bash
systemctl --user stop strategylab
rm -f data/strategy_lab.dev.db data/strategy_lab.dev.db-wal data/strategy_lab.dev.db-shm
cp /path/to/snapshot.db data/strategy_lab.dev.db
node -e "const {DatabaseSync}=require('node:sqlite');
         console.log(new DatabaseSync('./data/strategy_lab.dev.db')
           .prepare('PRAGMA integrity_check').get())"
systemctl --user start strategylab
```

Stop first, delete the sidecars explicitly rather than trusting them to be
gone, and run `integrity_check` before starting anything against it. The whole
sequence costs about ten seconds.

This cost nothing on the day because the file being overwritten was main's,
which held six accounts and no transactions, and the source snapshot was
untouched and could simply be re-copied. Against a database with real data in
it and no snapshot to fall back on, it is unrecoverable.
