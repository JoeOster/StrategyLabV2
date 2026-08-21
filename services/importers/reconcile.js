// Decides which normalized import rows can actually become transactions.
//
// The problem this solves: broker exports have a start date, so a position
// opened before that window shows up as a SELL with no matching BUY. Feeding
// that to StrategyLab's FIFO accounting would either be rejected as an oversell
// or, worse, quietly produce a negative holding and nonsense realized P&L.
//
// Policy (Joe, 2026-08-21): if there is no corresponding buy and no way to
// extrapolate a buy price, drop the row. This is a research and journalling
// tool, explicitly not used for tax purposes, so an incomplete-but-consistent
// ledger beats a complete-but-wrong one. Drops are always counted and returned,
// never silent -- an import that discards a third of a file should say so.
//
// Note a transfer IN is deliberately NOT a drop: it carries a quantity and a
// transfer value, so a per-share price can be extrapolated. It is kept and
// flagged for review instead, because that value is what the shares were worth
// on arrival rather than what was paid for them.

/**
 * @param {Array} rows normalized rows from a parser
 * @returns {{accepted: Array, dropped: Array, summary: object}}
 */
export function reconcile(rows) {
  // Buys before sells within the same date. Brokers list same-day activity in
  // arbitrary order, and taking file order at face value orphans sells whose
  // covering buy sits one line below them (real case: IONQ 2026-01-21).
  const order = { BUY: 0, DIVIDEND: 1, SELL: 2 };
  const sorted = [...rows].sort(
    (a, b) =>
      a.transactionDate.localeCompare(b.transactionDate) ||
      (order[a.transactionType] ?? 9) - (order[b.transactionType] ?? 9)
  );

  const openBySymbol = new Map(); // symbol -> shares available
  const accepted = [];
  const dropped = [];

  for (const row of sorted) {
    if (row.transactionType === "BUY") {
      openBySymbol.set(row.symbol, (openBySymbol.get(row.symbol) ?? 0) + row.quantity);
      accepted.push(row);
      continue;
    }
    if (row.transactionType === "DIVIDEND") {
      accepted.push(row); // income, no share movement, nothing to match
      continue;
    }

    // SELL
    const available = openBySymbol.get(row.symbol) ?? 0;
    if (available <= 1e-9) {
      dropped.push({ ...row, dropReason: "No matching buy in the export window -- the opening purchase predates it." });
      continue;
    }
    if (row.quantity - available > 1e-9) {
      // Partially covered: keep the part the data supports rather than
      // discarding a real sale wholesale, and record the shortfall.
      const shortfall = row.quantity - available;
      accepted.push({
        ...row,
        quantity: available,
        notes: [row.notes, `Quantity reduced from ${row.quantity} to ${available}: ${shortfall} shares had no matching buy in the export window.`]
          .filter(Boolean)
          .join(" "),
        needsReview: true,
      });
      dropped.push({ ...row, quantity: shortfall, dropReason: `Partial: ${shortfall} of ${row.quantity} shares had no matching buy.` });
      openBySymbol.set(row.symbol, 0);
      continue;
    }
    openBySymbol.set(row.symbol, available - row.quantity);
    accepted.push(row);
  }

  const droppedBySymbol = {};
  for (const d of dropped) droppedBySymbol[d.symbol] = (droppedBySymbol[d.symbol] ?? 0) + 1;

  return {
    accepted,
    dropped,
    summary: {
      in: rows.length,
      accepted: accepted.length,
      dropped: dropped.length,
      needsReview: accepted.filter((r) => r.needsReview).length,
      droppedBySymbol,
    },
  };
}

/** Net share position implied by accepted rows -- used to verify an import. */
export function impliedPositions(accepted) {
  const net = new Map();
  for (const r of accepted) {
    if (r.transactionType === "DIVIDEND") continue;
    net.set(r.symbol, (net.get(r.symbol) ?? 0) + (r.transactionType === "BUY" ? r.quantity : -r.quantity));
  }
  return new Map([...net].filter(([, q]) => Math.abs(q) > 1e-9).sort((a, b) => a[0].localeCompare(b[0])));
}
