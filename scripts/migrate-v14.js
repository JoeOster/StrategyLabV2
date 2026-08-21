// In-place v13 -> v14 migration for the comparison instance.
//
// Additive apart from `alerts`, which needs a CHECK constraint that ALTER TABLE
// cannot add -- so that table is dropped and rebuilt from schema.sql verbatim.
// Safe only because it is empty; the script refuses otherwise rather than
// silently discarding alert history.
import fs from "node:fs";
import db from "../lib/db.js";
import { stampSchemaVersion } from "../lib/db.js";

const schema = fs.readFileSync("schema.sql", "utf8");

function ddl(name, type = "TABLE") {
  const re = new RegExp(`CREATE ${type} ${name} \\(([\\s\\S]*?)\\n\\);`);
  const m = re.exec(schema);
  if (!m) throw new Error(`Could not extract DDL for ${name}`);
  return m[0];
}

const existing = new Set(
  db.prepare("SELECT name FROM sqlite_master").all().map((r) => r.name),
);

const before = db.prepare("SELECT COUNT(*) n FROM alerts").get().n;
if (before !== 0) {
  console.error(`Refusing to run: alerts has ${before} rows and this migration rebuilds it.`);
  process.exit(1);
}

const steps = [];

if (!existing.has("plans")) steps.push(["create plans", ddl("plans")]);
if (!existing.has("plan_exits")) steps.push(["create plan_exits", ddl("plan_exits")]);

const txnCols = db.prepare("PRAGMA table_info(transactions)").all().map((c) => c.name);
if (!txnCols.includes("plan_id")) {
  steps.push([
    "add transactions.plan_id",
    "ALTER TABLE transactions ADD COLUMN plan_id INTEGER REFERENCES plans(id) ON DELETE SET NULL",
  ]);
}

const alertCols = db.prepare("PRAGMA table_info(alerts)").all().map((c) => c.name);
if (!alertCols.includes("plan_exit_id")) {
  steps.push(["drop alerts", "DROP TABLE alerts"]);
  steps.push(["recreate alerts", ddl("alerts")]);
}

for (const idx of [
  "idx_transactions_plan",
  "idx_plan_exits_pending",
  "idx_plans_open",
  "idx_alerts_plan_exit",
]) {
  if (!existing.has(idx)) {
    const m = new RegExp(`CREATE INDEX ${idx}[\\s\\S]*?;`).exec(schema);
    if (m) steps.push([`index ${idx}`, m[0]]);
  }
}

if (!existing.has("trg_plans_updated_at")) {
  const m = /CREATE TRIGGER trg_plans_updated_at[\s\S]*?END;/.exec(schema);
  if (m) steps.push(["trigger trg_plans_updated_at", m[0]]);
}

if (steps.length === 0) {
  console.log("Already at v14 structurally; nothing to do.");
} else {
  for (const [label, sql] of steps) {
    db.exec(sql);
    console.log(`  applied: ${label}`);
  }
}

stampSchemaVersion();

const after = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length;
console.log(`\ntables now: ${after}`);
console.log("accounts preserved:", db.prepare("SELECT COUNT(*) n FROM accounts").get().n);
console.log("transactions preserved:", db.prepare("SELECT COUNT(*) n FROM transactions").get().n);
console.log(
  "stamped version:",
  db.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get().value,
);
