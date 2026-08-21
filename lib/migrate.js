// Forward-only schema migrations.
//
// Built because every schema change up to v14 was applied to the live database
// BY HAND, and `assertSchemaCurrent` told anyone who hit a mismatch to delete
// their data directory and rebuild. That advice is fine while the database is
// empty and catastrophic the day after the first real import -- which is the
// next thing this app is going to do.
//
// Deliberately small and forward-only. No down-migrations: reversing a schema
// change on a single-user journal is a fiction, and the honest recovery path is
// the backup this runner takes before it touches anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db, { withTransaction } from "./db.js";
import { SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./schemaVersion.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

/**
 * Its own table rather than a column on app_settings: "which migrations have
 * run" is a set, and squeezing a set into a single stamped integer is what made
 * the by-hand era possible in the first place. app_settings.schema_version
 * survives as a fast sanity check and is kept in step by this runner.
 */
function ensureMigrationsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

/** Migration files, in order. Named NNN_description.sql. */
export function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((file) => {
      const version = Number(file.split("_")[0]);
      return { version, name: file.replace(/\.sql$/, ""), file, path: path.join(MIGRATIONS_DIR, file) };
    })
    .sort((a, b) => a.version - b.version);
}

export function appliedVersions() {
  ensureMigrationsTable();
  return new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version));
}

export function pendingMigrations() {
  const applied = appliedVersions();
  return listMigrationFiles().filter((m) => !applied.has(m.version));
}

const recordStmt = () =>
  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)");

/**
 * Marks migrations at or below `version` as applied WITHOUT running them.
 *
 * For two cases that are really the same case: a database freshly built from
 * schema.sql (which already contains every change), and the existing databases
 * that were migrated by hand before this runner existed. Both are structurally
 * current; replaying the files against them would fail on "table already
 * exists" and, worse, a rebuild step could discard rows.
 */
export function baseline(version = null) {
  // Defaults to what the database itself claims, NOT to SCHEMA_VERSION. Those
  // differ exactly when it matters: a hand-migrated v13 database baselined at
  // the code's v14 would mark 014 as applied without its tables existing, and
  // the failure would surface much later as a missing-table error.
  version = version ?? startingVersion() ?? SCHEMA_VERSION;
  ensureMigrationsTable();
  const record = recordStmt();
  const marked = [];
  withTransaction(() => {
    for (const m of listMigrationFiles()) {
      if (m.version <= version) {
        record.run(m.version, m.name);
        marked.push(m.name);
      }
    }
  });
  return marked;
}

/**
 * Applies every pending migration, each inside its own transaction so a failure
 * leaves the database at the last good version rather than half-way through one.
 */
export function runPending({ onApply = () => {} } = {}) {
  ensureMigrationsTable();
  assertMigratable();
  const record = recordStmt();
  const applied = [];

  for (const m of pendingMigrations()) {
    const sql = fs.readFileSync(m.path, "utf8");
    withTransaction(() => {
      db.exec(sql);
      record.run(m.version, m.name);
    });
    applied.push(m);
    onApply(m);
  }

  if (applied.length > 0) {
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
  }
  return applied;
}

/**
 * The version this runner can start FROM: one below its earliest migration.
 *
 * Migrations begin at 012, so a database must already be at v11 to be
 * migratable. Anything older has changes (v8-v11) that no file here can apply.
 */
export function coversFrom() {
  const files = listMigrationFiles();
  return files.length ? files[0].version - 1 : null;
}

/** Where this database currently is: the ledger if present, else the old stamp. */
export function startingVersion() {
  const recorded = currentVersion();
  if (recorded != null) return recorded;
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SCHEMA_VERSION_KEY);
    return row?.value == null ? null : Number(row.value);
  } catch {
    return null;
  }
}

/**
 * Refuses to migrate a database older than the earliest migration.
 *
 * Found by an actual restore drill: a v7 backup was cheerfully "migrated" to
 * v14 and stamped current, because 012-014 applied cleanly on top of it. The
 * v8-v11 changes were simply absent, so the app then died on startup with
 * `table transactions has no column named needs_review` -- a raw SQLite error,
 * which is precisely what assertSchemaCurrent exists to prevent and which this
 * runner had just talked its way past.
 *
 * Silently producing a database that CLAIMS to be current and is not is worse
 * than refusing, so it refuses.
 */
export function assertMigratable() {
  const from = coversFrom();
  if (from == null) return;
  const at = startingVersion();
  if (at == null) {
    throw new Error(
      `This database has no recorded version, so there is no way to tell which migrations it needs. ` +
        `If it was built from the current schema.sql, baseline it: npm run db:migrate -- --baseline`,
    );
  }
  if (at < from) {
    throw new Error(
      `This database is at v${at}, but migrations only cover v${from} onward -- ` +
        `the changes between v${at} and v${from} have no migration files. ` +
        `Applying what is here would produce a database stamped v${SCHEMA_VERSION} that is missing columns, ` +
        `which fails later as a raw SQLite error. Rebuild it with npm run db:init, or bring it to v${from} by hand first.`,
    );
  }
}

/** Highest applied migration, or null on a database this runner has never seen. */
export function currentVersion() {
  ensureMigrationsTable();
  return db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v ?? null;
}
