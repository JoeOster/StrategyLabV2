// Stages and approves a real broker export, then reports what landed.
//
// Point DB_PATH at a COPY before running this against real files -- it writes.
// The figures it prints are meant to be checked against docs/IMPORTS.md's
// "State of play" table, which was verified against a live Fidelity screenshot.
//
//   DB_PATH=/tmp/t.db node scripts/verify-import.js 1 files/IRA_a.csv files/IRA_b.csv
import fs from "node:fs";
import path from "node:path";
import db from "../lib/db.js";
import { stageImport, approveBatch, getBatchPreview } from "../services/importService.js";

const [accountArg, ...fileArgs] = process.argv.slice(2);
if (!accountArg || fileArgs.length === 0) {
  console.error("usage: node scripts/verify-import.js <accountId> <file.csv> [file2.csv ...]");
  process.exit(1);
}

const accountId = Number(accountArg);
const files = fileArgs.map((f) => ({
  filename: path.basename(f),
  text: fs.readFileSync(f, "utf-8"),
}));

console.log(`DB: ${process.env.DB_PATH || "./data/strategy_lab.dev.db"}`);
console.log(`Account ${accountId}, files: ${files.map((f) => f.filename).join(", ")}\n`);

const staged = stageImport({ accountId, files });

console.log("--- staging ---");
console.log(`batch ${staged.batch.id} (${staged.batch.broker}), ${staged.batch.row_count} rows staged`);
console.log("reconcile:", staged.reconcile);
console.log("classified:", staged.counts);
console.log(`dropped: ${staged.dropped.length}`);
for (const d of staged.dropped) console.log(`   ${d.symbol} ${d.transactionDate} x${d.quantity} -- ${d.reason}`);
console.log("implied positions:", staged.impliedPositions);

console.log("\n--- approving ---");
const result = await approveBatch(staged.batch.id);
console.log(`written: ${result.written.length}, skipped as duplicate: ${result.skippedDuplicates.length}`);
console.log(`batch status: ${result.batch.status}`);

console.log("\n--- resulting open positions ---");
const positions = db
  .prepare(
    `SELECT s.symbol, SUM(t.quantity_remaining) AS shares, SUM(t.cost_basis * t.quantity_remaining / t.quantity) AS basis
       FROM transactions t JOIN securities s ON s.id = t.security_id
      WHERE t.account_id = ? AND t.transaction_type = 'BUY'
        AND t.quantity_remaining > 0 AND t.voided_at IS NULL
      GROUP BY s.symbol ORDER BY s.symbol`,
  )
  .all(accountId);
for (const p of positions) {
  console.log(`   ${p.symbol.padEnd(6)} ${String(p.shares).padStart(8)}  $${p.basis.toFixed(2)}`);
}
console.log(`   ${positions.length} positions, total basis $${positions.reduce((s, p) => s + p.basis, 0).toFixed(2)}`);

const negative = positions.filter((p) => p.shares < 0);
console.log(`\nnegative positions: ${negative.length}${negative.length ? " <-- BAD" : ""}`);

const rowCounts = db
  .prepare(
    `SELECT transaction_type, COUNT(*) AS n FROM transactions
      WHERE account_id = ? AND voided_at IS NULL GROUP BY transaction_type`,
  )
  .all(accountId);
console.log("transaction rows written:", Object.fromEntries(rowCounts.map((r) => [r.transaction_type, r.n])));

const flagged = db
  .prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND needs_review = 1 AND voided_at IS NULL",
  )
  .get(accountId).n;
console.log(`rows flagged needs_review: ${flagged}`);

console.log("\n--- staging row mapping ---");
const preview = getBatchPreview(staged.batch.id);
const mapped = preview.rows.filter((r) => r.matchedTransactionId != null).length;
console.log(`${mapped}/${preview.rows.length} staged rows mapped to a transaction`);
console.log("counts:", preview.counts);
