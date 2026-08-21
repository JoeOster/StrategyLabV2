// Single shared SQLite connection using Node's built-in `node:sqlite` module
// -- zero native dependencies. This replaced an earlier better-sqlite3-based
// version specifically because better-sqlite3 needs a compiled native
// binary, and on a Windows machine without the "Desktop development with
// C++" Visual Studio workload installed, node-gyp has nothing to fall back
// on. node:sqlite ships inside the Node binary itself, so there's nothing
// to compile, ever -- including after future Node upgrades.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { SCHEMA_VERSION, SCHEMA_VERSION_KEY } from "./schemaVersion.js";

try {
  process.loadEnvFile(); // loads .env if present
} catch {
  // no .env file present -- fine, fall back to whatever's already set
}

const DB_PATH = process.env.DB_PATH || "./data/strategy_lab.dev.db";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH, {
  enableForeignKeyConstraints: true, // this is node:sqlite's default; explicit for clarity
  timeout: 5000, // wait up to 5s on a lock instead of failing immediately
});
db.exec("PRAGMA journal_mode = WAL");

export default db;

/**
 * Stamps the current SCHEMA_VERSION into app_settings. Called by
 * scripts/init-db.js right after applying schema.sql.
 */
export function stampSchemaVersion() {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(SCHEMA_VERSION_KEY, String(SCHEMA_VERSION));
}

/**
 * Verifies the database on disk was built from the current schema.sql, and
 * exits with an actionable message if not. Without this, a stale DB surfaces
 * as a raw SQLite error ("no such table: watchlists", "CHECK constraint
 * failed: order_type IN (...)") that gives no hint the real fix is to
 * re-init. Call this at app startup, after the schema is known to exist.
 */
export function assertSchemaCurrent() {
  let found = null;
  try {
    found = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(SCHEMA_VERSION_KEY)?.value;
  } catch {
    // app_settings itself doesn't exist -- DB was never initialized at all.
    found = null;
  }

  if (found === String(SCHEMA_VERSION)) return;

  // The remedy this used to print was "delete the data directory and rebuild".
  // That was true when there was no migration runner and the database was
  // empty; it would have been a data-loss instruction the day after the first
  // real import. Now the ordinary answer is to migrate, and a rebuild is only
  // suggested for a database that was never initialised at all.
  const hasSchema = (() => {
    try {
      return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='transactions'").get() != null;
    } catch {
      return false;
    }
  })();

  if (hasSchema) {
    console.error(
      [
        "",
        "  Database schema is out of date.",
        found == null
          ? "  It predates version tracking."
          : `  It is at version ${found}; this code expects version ${SCHEMA_VERSION}.`,
        "",
        `  DB file: ${DB_PATH}`,
        "",
        "  Migrate it -- your data is preserved, and a backup is taken first:",
        "",
        "    npm run db:migrate",
        "",
        "  To see what would run without running it:",
        "",
        "    npm run db:migrate -- --status",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.error(
    [
      "",
      "  This database has never been initialised -- there are no tables.",
      "",
      `  DB file: ${DB_PATH}`,
      "",
      "    npm run db:init",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

// node:sqlite has no db.transaction() convenience wrapper like
// better-sqlite3 did. This is the manual equivalent -- every multi-statement
// write in the app goes through here so a failure partway through can't
// leave the DB half-updated.
//
// Re-entrant, because an import batch has to commit or roll back as ONE unit
// while being built out of recordBuy/recordSell calls that each already open
// a transaction of their own. SQLite has no nested BEGIN, so inner levels use
// SAVEPOINTs instead. Without this, a mid-batch failure leaves a partially
// written ledger -- which is worse than an empty one, because every total
// downstream reads as plausible and is wrong (see docs/IMPORTS.md, the trial
// load that produced 235 positions against a real six).
let txDepth = 0;

export function withTransaction(fn) {
  const savepoint = txDepth > 0 ? `sp_${txDepth}` : null;
  txDepth += 1;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : "BEGIN");
  try {
    const result = fn();
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (err) {
    // RELEASE after ROLLBACK TO: rolling back to a savepoint leaves it on the
    // stack, so without the release the name leaks and the depth counter and
    // SQLite's actual state drift apart.
    db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
    throw err;
  } finally {
    txDepth -= 1;
  }
}
