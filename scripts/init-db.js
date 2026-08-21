// Applies schema.sql to the DB at DB_PATH. Safe to re-run: every statement
// in schema.sql is a CREATE TABLE/INDEX/TRIGGER, so re-running against an
// already-initialized DB just fails loudly on "table already exists"
// instead of silently corrupting anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db, { withTransaction, stampSchemaVersion } from "../lib/db.js";
import { SCHEMA_VERSION } from "../lib/schemaVersion.js";
// Imported from lib/constants.js, NOT from the service -- see that file for
// why importing a service here would break init.
import { DEFAULT_WATCHLIST_NAME } from "../lib/constants.js";
import { baseline } from "../lib/migrate.js";
import { seedReferenceData } from "../lib/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

// Seed a couple of exchanges up front -- everything else (securities,
// holders, accounts) gets created on demand as you actually use the app.

try {
  db.exec(schema);
  console.log(`Schema applied to ${process.env.DB_PATH || "./data/strategy_lab.dev.db"}`);

  // One shared seed for every path that creates a database -- see lib/seed.js
  // for why this is not inlined here any more.
  const seeded = seedReferenceData({ defaultWatchlistName: DEFAULT_WATCHLIST_NAME });
  console.log(`Seeded ${seeded.exchanges} exchanges and ${seeded.brokers} brokerages.`);
  console.log(`Seeded default holder and \"${DEFAULT_WATCHLIST_NAME}\" list.`);

  // schema.sql already contains every migration's effect, so they are recorded
  // as applied rather than replayed -- replaying them here would fail on
  // "table already exists" and a rebuild step could discard rows.
  const baselined = baseline();
  console.log(`Baselined ${baselined.length} migration(s) as already applied.`);

  stampSchemaVersion();
  console.log(`Stamped schema version ${SCHEMA_VERSION}.`);
} catch (err) {
  console.error("Schema init failed:", err.message);
  process.exit(1);
}
