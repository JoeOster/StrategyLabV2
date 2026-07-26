// Stamps the current SCHEMA_VERSION onto an existing database WITHOUT
// rebuilding it.
//
// Only use this when you know the database already matches the current
// schema.sql -- e.g. it was built before version stamping existed, or you
// applied a change by hand. If the schema genuinely differs, stamping it
// just hides the mismatch and you'll get confusing SQLite errors later
// instead of the clear startup message. When in doubt, rebuild instead:
//   Remove-Item -Recurse -Force data ; npm run db:init
import db, { stampSchemaVersion } from "../lib/db.js";
import { SCHEMA_VERSION } from "../lib/schemaVersion.js";

const EXPECTED_TABLES = [
  "watchlists",
  "watched_items",
  "securities",
  "quotes_cache",
  "historical_prices",
  "app_settings",
  "advice_source_website_details", // added in schema v4
];

const found = new Set(
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name),
);

const missing = EXPECTED_TABLES.filter((t) => !found.has(t));
if (missing.length > 0) {
  console.error(
    `\n  Refusing to stamp: this database is missing ${missing.join(", ")}.` +
      `\n  It does not match the current schema. Rebuild it instead:` +
      `\n    Remove-Item -Recurse -Force data` +
      `\n    npm run db:init\n`,
  );
  process.exit(1);
}

// Spot-check the newest constraint too -- table presence alone wouldn't
// catch an older watched_items that predates the WATCH order type.
const watchedItemsSql = db
  .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='watched_items'")
  .get().sql;
if (!watchedItemsSql.includes("'WATCH'")) {
  console.error(
    `\n  Refusing to stamp: watched_items.order_type does not allow 'WATCH',` +
      `\n  so this database predates the current schema. Rebuild it instead:` +
      `\n    Remove-Item -Recurse -Force data` +
      `\n    npm run db:init\n`,
  );
  process.exit(1);
}

stampSchemaVersion();
console.log(`Stamped existing database as schema version ${SCHEMA_VERSION}.`);
console.log("Structure checks passed — no data was modified.");
