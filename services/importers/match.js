// Classifies parsed CSV rows against what is already in the ledger.
//
// This exists because CSV import is an AUDIT, not a loader (docs/IMPORTS.md).
// Manual entry is the primary path, so an import is mostly looking at trades
// that are already recorded, and its job is to find the ones that are missing
// or wrong -- not to load everything again.
//
// Matching therefore cannot rely on `external_ref`: that fingerprint is derived
// from a CSV row, and a hand-entered transaction has none. Comparing on it
// would classify every manual entry as `new` and duplicate the entire ledger.
// So rows are matched on the economic facts of the trade instead.

// Trade date vs settlement date differ by a day or two, and an entry typed from
// memory can be a day out. Matching on exact dates would flag correct entries
// as discrepancies, and a report full of false positives gets ignored -- which
// is worse than no report.
const DATE_TOLERANCE_DAYS = 3;

// Brokers round differently and fractional shares carry float noise. Wide
// enough to absorb that, tight enough that a real typo still shows: 79.94 vs
// 79.49 is a 0.56% difference and is caught.
const PRICE_TOLERANCE_REL = 0.001; // 0.1%
const PRICE_TOLERANCE_ABS = 0.01;
const QTY_TOLERANCE = 1e-6;

const daysApart = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

const priceClose = (a, b) => {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= Math.max(PRICE_TOLERANCE_ABS, Math.abs(b) * PRICE_TOLERANCE_REL);
};

const qtyClose = (a, b) => Math.abs(a - b) <= Math.max(QTY_TOLERANCE, Math.abs(b) * QTY_TOLERANCE);

/**
 * @param {Array} rows normalized rows from a parser (post-reconcile)
 * @param {Array} existing non-voided transactions already in this account
 * @returns {Array} one classification per row
 */
export function classify(rows, existing) {
  // An existing transaction may only satisfy one CSV row. Without this, two
  // genuine same-day trades in the same symbol both match the single entry
  // that was recorded, and the second silently looks accounted for.
  const claimed = new Set();
  const byRef = new Map();
  for (const t of existing) if (t.external_ref) byRef.set(t.external_ref, t);

  return rows.map((row) => {
    // 1. Same file, or a file already imported. The fingerprint is reliable
    //    here precisely because both sides came from an export.
    const prior = byRef.get(row.externalRef);
    if (prior && !claimed.has(prior.id)) {
      claimed.add(prior.id);
      return { row, status: "duplicate", existing: prior, differences: [] };
    }

    const candidates = existing.filter(
      (t) =>
        !claimed.has(t.id) &&
        t.symbol === row.symbol &&
        t.transaction_type === row.transactionType &&
        daysApart(t.transaction_date, row.transactionDate) <= DATE_TOLERANCE_DAYS
    );
    if (candidates.length === 0) return { row, status: "new", existing: null, differences: [] };

    // Prefer the closest date, so two nearby trades pair off sensibly rather
    // than by table order.
    candidates.sort((a, b) => daysApart(a.transaction_date, row.transactionDate) - daysApart(b.transaction_date, row.transactionDate));

    const exact = candidates.find((t) => qtyClose(t.quantity, row.quantity) && priceClose(t.price, row.price));
    if (exact) {
      claimed.add(exact.id);
      return { row, status: "matched", existing: exact, differences: [] };
    }

    // Same trade, different numbers -- the case this whole feature exists for.
    // Reported, never auto-applied: a price discrepancy might be the broker
    // rather than the typist, and silently rewriting history to agree with a
    // CSV is how a journal stops being trustworthy.
    const near = candidates[0];
    claimed.add(near.id);
    const differences = [];
    if (!qtyClose(near.quantity, row.quantity))
      differences.push({ field: "quantity", ledger: near.quantity, broker: row.quantity });
    if (!priceClose(near.price, row.price))
      differences.push({ field: "price", ledger: near.price, broker: row.price });
    if (near.transaction_date !== row.transactionDate)
      differences.push({ field: "transaction_date", ledger: near.transaction_date, broker: row.transactionDate });
    return { row, status: "needs_review", existing: near, differences };
  });
}

/** Counts by status, for the import summary screen. */
export function summarize(classified) {
  const counts = { matched: 0, new: 0, duplicate: 0, needs_review: 0 };
  for (const c of classified) counts[c.status]++;
  return counts;
}
