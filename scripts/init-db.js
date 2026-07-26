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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, "..", "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

// Seed a couple of exchanges up front -- everything else (securities,
// holders, accounts) gets created on demand as you actually use the app.
const SEED_EXCHANGES = [
  { code: "NASDAQ", name: "Nasdaq", timezone: "America/New_York" },
  { code: "NYSE", name: "New York Stock Exchange", timezone: "America/New_York" },
];

try {
  db.exec(schema);
  console.log(`Schema applied to ${process.env.DB_PATH || "./data/strategy_lab.dev.db"}`);

  const insertExchange = db.prepare(
    "INSERT OR IGNORE INTO exchanges (code, name, timezone) VALUES (@code, @name, @timezone)",
  );
  withTransaction(() => {
    for (const row of SEED_EXCHANGES) insertExchange.run(row);
  });
  console.log(`Seeded ${SEED_EXCHANGES.length} exchanges.`);

  // Seed the default holder and their first watchlist so the app is usable
  // immediately -- without this you'd have to create a list before adding a
  // first ticker.
  withTransaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO account_holders (id, name, is_default) VALUES (1, 'Me', 1)",
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO watchlists (holder_id, name, sort_order) VALUES (1, ?, 0)",
    ).run(DEFAULT_WATCHLIST_NAME);
  });
  console.log(`Seeded default holder and "${DEFAULT_WATCHLIST_NAME}" list.`);

  stampSchemaVersion();
  console.log(`Stamped schema version ${SCHEMA_VERSION}.`);
} catch (err) {
  console.error("Schema init failed:", err.message);
  process.exit(1);
}
