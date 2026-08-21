// Breaks the IRA's realized P&L down far enough to say whether it is real.
import db from "../lib/db.js";

const ACCOUNT = Number(process.argv[2] || 1);

const sells = db
  .prepare(
    `SELECT t.id, s.symbol, t.transaction_date, t.quantity, t.price, t.fees, t.cost_basis,
            t.linked_buy_id, t.needs_review, t.review_reason,
            b.transaction_date AS buy_date, b.price AS buy_price,
            b.needs_review AS buy_needs_review, b.review_reason AS buy_review_reason,
            b.notes AS buy_notes
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       LEFT JOIN transactions b ON b.id = t.linked_buy_id
      WHERE t.account_id = ? AND t.transaction_type = 'SELL' AND t.voided_at IS NULL`,
  )
  .all(ACCOUNT)
  .map((r) => ({ ...r, pnl: r.quantity * r.price - (r.fees || 0) - (r.cost_basis ?? 0) }));

const total = sells.reduce((s, r) => s + r.pnl, 0);
console.log(`${sells.length} sell rows, total realized P&L $${total.toFixed(2)}\n`);

console.log("--- by symbol ---");
const bySymbol = new Map();
for (const r of sells) {
  const e = bySymbol.get(r.symbol) ?? { pnl: 0, rows: 0, proceeds: 0, cost: 0 };
  e.pnl += r.pnl;
  e.rows += 1;
  e.proceeds += r.quantity * r.price - (r.fees || 0);
  e.cost += r.cost_basis ?? 0;
  bySymbol.set(r.symbol, e);
}
const sorted = [...bySymbol].sort((a, b) => a[1].pnl - b[1].pnl);
for (const [sym, e] of sorted) {
  console.log(
    `   ${sym.padEnd(7)} ${String(e.rows).padStart(3)} rows  proceeds $${e.proceeds.toFixed(2).padStart(12)}  cost $${e.cost.toFixed(2).padStart(12)}  pnl $${e.pnl.toFixed(2).padStart(12)}`,
  );
}

console.log("\n--- how much comes from lots whose cost basis was extrapolated? ---");
const flagged = sells.filter((r) => r.buy_needs_review === 1);
const flaggedPnl = flagged.reduce((s, r) => s + r.pnl, 0);
console.log(`   ${flagged.length} of ${sells.length} sell rows draw on a flagged lot`);
console.log(`   their realized P&L: $${flaggedPnl.toFixed(2)}  (${((flaggedPnl / total) * 100).toFixed(1)}% of total)`);
for (const r of flagged.slice(0, 8)) {
  console.log(
    `      ${r.symbol.padEnd(6)} sold ${r.quantity} @ $${r.price} vs lot @ $${r.buy_price} (${r.buy_date})  pnl $${r.pnl.toFixed(2)}`,
  );
  if (r.buy_review_reason) console.log(`         lot flagged: ${r.buy_review_reason.slice(0, 120)}`);
}

console.log("\n--- five biggest single-row losses ---");
for (const r of [...sells].sort((a, b) => a.pnl - b.pnl).slice(0, 5)) {
  console.log(
    `   ${r.symbol.padEnd(7)} ${r.transaction_date}  sold ${r.quantity} @ $${r.price}` +
      `  cost $${(r.cost_basis ?? 0).toFixed(2)}  pnl $${r.pnl.toFixed(2)}`,
  );
  console.log(`      lot: ${r.buy_date} @ $${r.buy_price}${r.buy_needs_review ? "  [FLAGGED]" : ""}`);
}

console.log("\n--- sanity: does proceeds - cost reconcile against raw cash flows? ---");
const cash = db
  .prepare(
    `SELECT transaction_type,
            SUM(quantity * price) AS gross, SUM(fees) AS fees, COUNT(*) AS n
       FROM transactions WHERE account_id = ? AND voided_at IS NULL
      GROUP BY transaction_type`,
  )
  .all(ACCOUNT);
for (const c of cash) {
  console.log(`   ${c.transaction_type.padEnd(9)} ${String(c.n).padStart(4)} rows  gross $${c.gross.toFixed(2)}  fees $${(c.fees ?? 0).toFixed(2)}`);
}

const openBasis = db
  .prepare(
    `SELECT SUM(cost_basis * quantity_remaining / quantity) AS basis
       FROM transactions WHERE account_id = ? AND transaction_type = 'BUY'
        AND quantity_remaining > 0 AND voided_at IS NULL`,
  )
  .get(ACCOUNT).basis;

const buys = cash.find((c) => c.transaction_type === "BUY");
const sellsCash = cash.find((c) => c.transaction_type === "SELL");
console.log(`\n   total spent on buys      $${buys.gross.toFixed(2)}`);
console.log(`   total received from sells $${sellsCash.gross.toFixed(2)}`);
console.log(`   still held (cost basis)   $${openBasis.toFixed(2)}`);
console.log(
  `   sells - (buys - stillHeld) = $${(sellsCash.gross - (buys.gross - openBasis)).toFixed(2)}   <-- should be ~ realized P&L`,
);
