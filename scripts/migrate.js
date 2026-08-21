// npm run db:migrate -- applies pending schema migrations.
//
// Takes a backup FIRST, unconditionally. The whole reason this exists is that
// the previous answer to a schema mismatch was "delete your data directory",
// and a migration runner that can itself lose data would be no better.
import fs from "node:fs";
import path from "node:path";
import db from "../lib/db.js";
import {
  pendingMigrations, runPending, currentVersion, baseline, assertMigratable, startingVersion, coversFrom,
} from "../lib/migrate.js";
import { SCHEMA_VERSION } from "../lib/schemaVersion.js";

const DB_PATH = process.env.DB_PATH || "./data/strategy_lab.dev.db";
const args = new Set(process.argv.slice(2));

if (args.has("--baseline") || process.argv.slice(2).some((a) => a.startsWith("--baseline="))) {
  const at = args.has("--baseline") ? null : null;
  const explicit = process.argv.slice(2).find((a) => /^--baseline=\d+$/.test(a));
  const marked = baseline(explicit ? Number(explicit.split("=")[1]) : at);
  console.log(`Baselined ${marked.length} migration(s) as already applied:`);
  for (const m of marked) console.log(`   ${m}`);
  console.log("\nNothing was run. Use this only on a database already built from schema.sql.");
  process.exit(0);
}

// Checked before anything is printed as "pending", so an unmigratable database
// gets an explanation rather than a list it cannot act on.
try {
  assertMigratable();
} catch (err) {
  console.error(`\n  Cannot migrate ${DB_PATH}\n`);
  console.error(`  ${err.message}\n`);
  process.exit(1);
}

const pending = pendingMigrations();

if (args.has("--status")) {
  console.log(`Database: ${DB_PATH}`);
  console.log(`Applied through: ${currentVersion() ?? "(none recorded)"}`);
  console.log(`Code expects:    v${SCHEMA_VERSION}`);
  console.log(pending.length === 0 ? "\nUp to date." : `\n${pending.length} pending:`);
  for (const m of pending) console.log(`   ${m.name}`);
  process.exit(0);
}

if (pending.length === 0) {
  console.log(`Up to date -- applied through ${currentVersion() ?? "(none)"}, code expects v${SCHEMA_VERSION}.`);
  process.exit(0);
}

console.log(`${pending.length} pending migration(s) for ${DB_PATH}:`);
for (const m of pending) console.log(`   ${m.name}`);

// Backup before touching anything. VACUUM INTO rather than a file copy so the
// WAL is included -- a plain copy of a WAL-mode database can miss recent
// commits entirely, which is a backup that looks fine and is not.
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
const backupDir = path.join(path.dirname(DB_PATH), "backups");
fs.mkdirSync(backupDir, { recursive: true });

// Never overwrite an existing backup, even one from a second ago. VACUUM INTO
// refuses to write over a file, which is the right instinct -- but it surfaces
// as a raw SQLite error that stops the migration, so the collision is resolved
// here instead of being hit.
let backupPath = path.join(backupDir, `pre-migration_${stamp}.db`);
for (let n = 2; fs.existsSync(backupPath); n += 1) {
  backupPath = path.join(backupDir, `pre-migration_${stamp}_${n}.db`);
}
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`\nBacked up to ${backupPath}`);

try {
  const applied = runPending({ onApply: (m) => console.log(`   applied ${m.name}`) });
  console.log(`\nApplied ${applied.length} migration(s). Now at v${SCHEMA_VERSION}.`);
} catch (err) {
  console.error(`\nMigration failed: ${err.message}`);
  console.error(`The database is at the last migration that succeeded.`);
  console.error(`To go back to where you started:\n   cp ${backupPath} ${DB_PATH}`);
  process.exit(1);
}
