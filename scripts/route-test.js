// Exercises the import routes over HTTP against a throwaway server.
import fs from "node:fs";

const BASE = process.env.BASE || "http://localhost:3199";
const read = (f) => ({ filename: f, text: fs.readFileSync(`files/${f}`, "utf-8") });

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

console.log("1. POST /api/imports  (stage the two IRA exports)");
const staged = await call("POST", "/api/imports", {
  accountId: 1,
  files: [read("IRA_a.csv"), read("IRA_b.csv")],
});
console.log(`   -> ${staged.status}`);
console.log(`   batch ${staged.json.batch.id}, ${staged.json.batch.row_count} rows, status ${staged.json.batch.status}`);
console.log(`   counts:`, staged.json.counts);
console.log(`   dropped: ${staged.json.dropped.length}, implied:`, staged.json.impliedPositions);

const batchId = staged.json.batch.id;

console.log("\n2. GET /api/imports/:id  (preview)");
const preview = await call("GET", `/api/imports/${batchId}`);
console.log(`   -> ${preview.status}, ${preview.json.rows.length} rows, counts:`, preview.json.counts);
console.log(`   first row:`, JSON.stringify(preview.json.rows[0]).slice(0, 160));

console.log("\n3. GET /api/imports/latest  (before approving)");
const before = await call("GET", "/api/imports/latest");
console.log(`   -> ${before.status}`);
for (const a of before.json.slice(0, 2)) console.log(`   `, a);

console.log("\n4. POST /api/imports/:id/approve");
const approved = await call("POST", `/api/imports/${batchId}/approve`, {});
console.log(`   -> ${approved.status}, written ${approved.json.written.length}, skipped ${approved.json.skippedDuplicates.length}, status ${approved.json.batch.status}`);

console.log("\n5. POST approve again  (should be refused)");
const again = await call("POST", `/api/imports/${batchId}/approve`, {});
console.log(`   -> ${again.status}`, again.json);

console.log("\n6. GET /api/imports/latest  (after approving)");
const after = await call("GET", "/api/imports/latest");
for (const a of after.json.slice(0, 2)) console.log(`   `, a);

console.log("\n7. GET /api/summary  (the whole point -- real positions)");
const summary = await call("GET", "/api/summary");
console.log(`   -> ${summary.status}`);
console.log(`   `, JSON.stringify(summary.json).slice(0, 400));

console.log("\n8. GET /api/imports/99999  (missing batch)");
console.log(`   ->`, (await call("GET", "/api/imports/99999")).status);

console.log("\n9. POST /api/imports with a bad account");
const bad = await call("POST", "/api/imports", { accountId: 999, files: [read("IRA_a.csv")] });
console.log(`   -> ${bad.status}`, bad.json);
