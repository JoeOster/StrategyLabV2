// "Written but never read": finds schema columns that something stores and
// nothing consumes.
//
// This is the shape of BUG 10 (escape_price: stored by addWatchedItem, absent
// from getActiveWatching, so a stop-loss could not fire) and of the importer's
// needs_review plumbing. The failure is always silent -- the write succeeds,
// the read simply never happens -- so it cannot be caught by running the app.
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");

// --- every (table, column) in the schema -----------------------------------
const tables = new Map();
for (const m of schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
  const [, table, body] = m;
  const cols = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) continue;
    const cm = /^(\w+)\s+(INTEGER|TEXT|REAL|BLOB|NUMERIC)/i.exec(line);
    if (cm && !["UNIQUE", "CHECK", "PRIMARY", "FOREIGN", "CONSTRAINT"].includes(cm[1].toUpperCase())) {
      cols.push(cm[1]);
    }
  }
  tables.set(table, cols);
}

// --- all source we might read a column in ----------------------------------
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "data") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}
const files = walk(ROOT).filter((f) => !f.includes(`${path.sep}scripts${path.sep}`));
const sources = new Map(files.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, "utf8")]));

const snakeToCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

// A column counts as READ if it appears somewhere that is not an INSERT/UPDATE
// column list. Crude but effective: the bug shape is "appears only where it is
// written."
function classify(table, col) {
  const camel = snakeToCamel(col);
  const hits = [];
  for (const [file, src] of sources) {
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (line.includes(col) || new RegExp(`\\b${camel}\\b`).test(line)) {
        hits.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  if (hits.length === 0) return { status: "NEVER MENTIONED", hits };

  // Which hits look like reads rather than writes?
  const readHits = hits.filter((h) => {
    const t = h.text;
    if (/^\/\//.test(t)) return false; // a comment is not a read
    if (/^@?\w+[,:]?$/.test(t)) return false; // bare binding line in an INSERT
    if (/^(INSERT|VALUES|UPDATE|SET)\b/i.test(t)) return false;
    if (new RegExp(`^${camel}:`).test(t)) return false; // object literal key being written
    if (new RegExp(`^@${camel}\\b`).test(t)) return false;
    return true;
  });

  return { status: readHits.length > 0 ? "read" : "WRITE-ONLY", hits, readHits };
}

// Tables whose rows are read wholesale via SELECT * are still fine -- but the
// consumer has to name the column somewhere to use it, so the test holds.
const findings = [];
for (const [table, cols] of tables) {
  for (const col of cols) {
    const r = classify(table, col);
    if (r.status !== "read") findings.push({ table, col, ...r });
  }
}

console.log(`Scanned ${tables.size} tables, ${[...tables.values()].flat().length} columns, ${sources.size} source files.\n`);

const never = findings.filter((f) => f.status === "NEVER MENTIONED");
const writeOnly = findings.filter((f) => f.status === "WRITE-ONLY");

console.log(`=== NEVER MENTIONED IN CODE (${never.length}) ===`);
for (const f of never) console.log(`  ${f.table}.${f.col}`);

console.log(`\n=== WRITTEN BUT APPARENTLY NEVER READ (${writeOnly.length}) ===`);
for (const f of writeOnly) {
  console.log(`  ${f.table}.${f.col}`);
  for (const h of f.hits.slice(0, 4)) console.log(`      ${h.file}:${h.line}  ${h.text.slice(0, 92)}`);
}
