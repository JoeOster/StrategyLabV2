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

  const detail =
    found == null
      ? "the database has no schema version recorded (it predates version tracking, or was never initialized)"
      : `the database is at schema version ${found}, but this code expects version ${SCHEMA_VERSION}`;

  console.error(
    [
      "",
      "  Database schema is out of date.",
      `  ${detail}.`,
      "",
      `  DB file: ${DB_PATH}`,
      "",
      "  There is no migration system yet, so the fix is to rebuild the database.",
      "  This DESTROYS existing data -- fine during early development, not once",
      "  you have real positions or journal entries you care about.",
      "",
      "  PowerShell:",
      "    Remove-Item -Recurse -Force data",
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
export function withTransaction(fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
