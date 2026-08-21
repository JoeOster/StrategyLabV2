// The write half of broker CSV import: staging, then approval.
//
// Everything upstream of this file (csv.js, the three broker parsers,
// reconcile.js, match.js) was built and verified against real exports before
// anything here existed, deliberately -- see docs/IMPORTS.md. This module adds
// the only part that touches the ledger.
//
// Two rules shape the whole thing:
//
//  1. Import is an AUDIT, not a loader. Manual entry is the primary path, so
//     most rows in a broker file are already recorded. Only rows classified
//     `new` are ever written. A `needs_review` row -- same trade, different
//     numbers -- is reported and never auto-applied, because silently
//     rewriting history to agree with a CSV is how a journal stops being
//     trustworthy.
//
//  2. A batch commits or it does not happen. A trial load that wrote every buy
//     and under half the sells left a database reading 235 positions and
//     $409,781 of cost basis against a real six positions and about $24,000 --
//     worse than empty, because every downstream total looked plausible.
import db, { withTransaction } from "../lib/db.js";
import * as fidelity from "./importers/fidelity.js";
import * as robinhood from "./importers/robinhood.js";
import * as etrade from "./importers/etrade.js";
import { disambiguateRefs } from "./importers/csv.js";
import { reconcile, impliedPositions } from "./importers/reconcile.js";
import { classify, summarize } from "./importers/match.js";
import { getOrCreateSecurity } from "./priceService.js";
import { TRANSFER_OUT_REASON } from "../lib/constants.js";
import { recordBuyWith, recordSellWith, recordDividendWith } from "./transactionsService.js";

const PARSERS = { fidelity, robinhood, etrade };

// Joined to brokers because the parser is selected by slug. Since v15 the
// brokerage is a row rather than a CHECK-constrained string on the account.
const getAccount = db.prepare(`
  SELECT a.*, b.slug AS broker, b.name AS broker_name, b.has_parser
  FROM accounts a JOIN brokers b ON b.id = a.broker_id
  WHERE a.id = ?
`);

// match.js compares on the economic facts of the trade, so the symbol has to
// come along rather than the security_id.
const getExistingForAccount = db.prepare(`
  SELECT t.id, t.transaction_type, t.transaction_date, t.quantity, t.price, t.external_ref,
         s.symbol
  FROM transactions t
  JOIN securities s ON s.id = t.security_id
  WHERE t.account_id = ? AND t.voided_at IS NULL
`);

const insertBatch = db.prepare(`
  INSERT INTO import_batches (account_id, broker, filename, row_count, status)
  VALUES (?, ?, ?, ?, 'pending') RETURNING *
`);
const insertRawRow = db.prepare(`
  INSERT INTO import_raw_rows (batch_id, raw_data, matched_transaction_id, reconciliation_status)
  VALUES (?, ?, ?, ?) RETURNING id
`);
const getBatch = db.prepare("SELECT * FROM import_batches WHERE id = ?");

// Ordered by id, which is insert order, which is reconcile order: buys before
// sells, chronologically. Replaying them in any other order breaks FIFO -- a
// sell would arrive before the lot it draws down and be rejected as an
// oversell.
const getRawRows = db.prepare("SELECT * FROM import_raw_rows WHERE batch_id = ? ORDER BY id");
const setRowMatch = db.prepare("UPDATE import_raw_rows SET matched_transaction_id = ? WHERE id = ?");
const setBatchStatus = db.prepare("UPDATE import_batches SET status = ? WHERE id = ?");

// Checked BEFORE any write. Attempting the insert and interpreting the
// constraint error instead is what produced the misleading "already present"
// count on the trial load: the violation was the sell fan-out colliding with
// itself, not a genuine duplicate.
const refAlreadyUsed = db.prepare(`
  SELECT 1 FROM transactions
  WHERE account_id = ? AND external_ref = ? AND voided_at IS NULL
`);

function parserFor(broker) {
  const parser = PARSERS[broker];
  if (!parser) {
    throw new Error(
      `No CSV parser for '${broker}'. Supported: ${Object.keys(PARSERS).join(", ")}.`,
    );
  }
  return parser;
}

/**
 * Parses and reconciles one or more files for an account, and stages the
 * result. Nothing reaches `transactions` here.
 *
 * Multiple files are reconciled TOGETHER rather than one at a time: the two
 * Fidelity IRA exports overlap, and a sell in the second file is often covered
 * by a buy in the first. Reconciling them separately orphans those sells and
 * the drop policy then discards real trades.
 *
 * @param {{accountId: number, files: Array<{filename: string, text: string}>}} input
 */
export function stageImport({ accountId, files }) {
  const account = getAccount.get(accountId);
  if (!account) throw new Error("No such account.");
  if (!files?.length) throw new Error("No files supplied.");

  // has_parser is recorded on the brokerage, so an account held somewhere
  // without a parser fails here with a straight answer rather than at the
  // first malformed row.
  if (account.has_parser === 0) {
    throw new Error(
      `No CSV parser has been written for ${account.broker_name}. ` +
        `Supported: ${Object.keys(PARSERS).join(", ")}.`,
    );
  }
  const parser = parserFor(account.broker);

  const parsed = files.map((f) => ({ filename: f.filename, ...parser.parse(f.text) }));
  // Across ALL files at once: an identical pair split between two exports must
  // still get the same ordinals it would get from either export alone.
  const rows = disambiguateRefs(parsed.flatMap((p) => p.rows));
  const skipped = parsed.flatMap((p) => p.skipped ?? []);

  const { accepted, dropped, summary } = reconcile(rows);
  const existing = getExistingForAccount.all(accountId);
  const classified = classify(accepted, existing);

  return withTransaction(() => {
    const batch = insertBatch.get(
      accountId,
      account.broker,
      files.map((f) => f.filename).join(", "),
      accepted.length,
    );

    const staged = classified.map((c) => {
      const { id } = insertRawRow.get(
        batch.id,
        JSON.stringify({ normalized: c.row, raw: c.row.raw ?? null, differences: c.differences }),
        c.existing?.id ?? null,
        c.status,
      );
      return { id, status: c.status, row: c.row, existing: c.existing, differences: c.differences };
    });

    return {
      batch,
      staged,
      counts: summarize(classified),
      reconcile: summary,
      // Dropped rows are reported but not staged: `reconciliation_status` has
      // no 'dropped' value, and adding one is a schema change. They are never
      // silent -- an import that discards a third of a file says so here.
      dropped: dropped.map((d) => ({
        symbol: d.symbol,
        transactionDate: d.transactionDate,
        quantity: d.quantity,
        reason: d.dropReason,
      })),
      skipped,
      warnings: buildWarnings(accepted),
      impliedPositions: Object.fromEntries(impliedPositions(accepted)),
    };
  });
}

/**
 * Things the operator should look at before approving, as opposed to things
 * that were handled automatically.
 *
 * Transfers are the live one. A share transfer between accounts is stored as a
 * SELL because it has to draw lots down exactly like one, but it has no
 * proceeds -- so realized P&L skips it. That much is handled. What is NOT
 * handled is the other side: the shares arriving in the destination account
 * have no known cost basis, only a transfer value, and nothing reconciles the
 * two halves. Transfer support is thin and lightly exercised (six real rows,
 * one account close-out), so an import containing them is worth a second look
 * rather than a rubber stamp.
 */
function buildWarnings(accepted) {
  const warnings = [];

  const transfers = accepted.filter((r) => r.reviewReason === TRANSFER_OUT_REASON);
  if (transfers.length) {
    warnings.push({
      kind: "transfers",
      count: transfers.length,
      symbols: [...new Set(transfers.map((r) => r.symbol))].sort(),
      message:
        `${transfers.length} row(s) are share transfers out to another account, not sales. ` +
        "Positions are reduced correctly and realized P&L excludes them, but transfer " +
        "handling is thinly tested and the receiving side's cost basis is unknown. " +
        "Worth a code/number review before trusting P&L on these symbols.",
    });
  }

  return warnings;
}

/** Reads a staged batch back for the preview screen. */
export function getBatchPreview(batchId) {
  const batch = getBatch.get(batchId);
  if (!batch) throw new Error("No such import batch.");

  const rows = getRawRows.all(batchId).map((r) => ({
    id: r.id,
    status: r.reconciliation_status,
    matchedTransactionId: r.matched_transaction_id,
    ...JSON.parse(r.raw_data),
  }));

  const counts = { matched: 0, new: 0, duplicate: 0, needs_review: 0 };
  for (const r of rows) counts[r.status]++;
  return { batch, rows, counts };
}

/**
 * Writes the approved rows of a staged batch into `transactions`.
 *
 * Only rows classified `new` are eligible; `rowIds` narrows that set further
 * (a checkbox cleared on the preview screen), it cannot widen it to matched or
 * needs_review rows.
 *
 * Async only because securities have to be resolved first -- see the comment
 * on the resolve loop.
 */
export async function approveBatch(batchId, { rowIds = null } = {}) {
  const batch = getBatch.get(batchId);
  if (!batch) throw new Error("No such import batch.");
  if (batch.status === "reconciled") throw new Error("This batch has already been approved.");

  const account = getAccount.get(batch.account_id);
  const wanted = rowIds == null ? null : new Set(rowIds.map(Number));

  const eligible = getRawRows
    .all(batchId)
    .filter((r) => r.reconciliation_status === "new")
    .filter((r) => wanted == null || wanted.has(r.id))
    .map((r) => ({ id: r.id, ...JSON.parse(r.raw_data) }));

  // Duplicate check up front, against the ledger as it stands. Anything caught
  // here is reported as a skip rather than attempted and rescued.
  const toWrite = [];
  const skippedDuplicates = [];
  for (const r of eligible) {
    if (refAlreadyUsed.get(batch.account_id, r.normalized.externalRef)) {
      skippedDuplicates.push({ rowId: r.id, externalRef: r.normalized.externalRef });
    } else {
      toWrite.push(r);
    }
  }

  // Resolve every symbol BEFORE opening the transaction. getOrCreateSecurity
  // does network I/O, and withTransaction takes a synchronous function --
  // awaiting inside it would let the transaction commit before the awaited
  // half ran, which is not atomicity, it only looks like it.
  const securities = new Map();
  for (const symbol of new Set(toWrite.map((r) => r.normalized.symbol))) {
    securities.set(symbol, await getOrCreateSecurity(symbol));
  }

  return withTransaction(() => {
    const written = [];

    for (const r of toWrite) {
      const n = r.normalized;
      const input = {
        holderId: account.holder_id,
        accountId: batch.account_id,
        transactionDate: n.transactionDate,
        quantity: n.quantity,
        price: n.price,
        fees: n.fees ?? 0,
        externalRef: n.externalRef,
        importBatchId: batch.id,
        notes: n.notes ?? null,
        // The flag and its reason travel with the row: the whole point is
        // being able to ask "what did we extrapolate?" later and fix it once
        // the real records turn up.
        needsReview: n.needsReview ? 1 : 0,
        reviewReason: n.reviewReason ?? (n.needsReview ? n.notes : null),
      };
      const security = securities.get(n.symbol);

      let txnId;
      if (n.transactionType === "BUY") {
        txnId = recordBuyWith(security, input).id;
      } else if (n.transactionType === "SELL") {
        // The fan-out writes one row per lot consumed; the first carries the
        // external_ref and is the one this staging row maps to.
        txnId = recordSellWith(security, input).sells[0].id;
      } else {
        txnId = recordDividendWith(security, { ...input, amount: n.price }).id;
      }

      setRowMatch.run(txnId, r.id);
      written.push({ rowId: r.id, transactionId: txnId, symbol: n.symbol, type: n.transactionType });
    }

    setBatchStatus.run("reconciled", batch.id);
    return { batch: getBatch.get(batch.id), written, skippedDuplicates };
  });
}

/**
 * How current each account's imported data is. Two different questions, both
 * worth showing: how recent the DATA is, and when an import last RAN.
 *
 * Presented as a floor to download from *before*, not a boundary to start at.
 * Overlapping exports are already safe -- external_ref fingerprinting plus the
 * partial unique index make a re-import a no-op -- whereas a gap silently
 * loses transactions and manufactures orphaned sells. Overlap costs nothing;
 * a gap costs data.
 */
const latestImportedStmt = db.prepare(`
  SELECT a.id AS account_id, a.nickname, a.account_number, b.name AS broker,
         (SELECT MAX(t.transaction_date) FROM transactions t
           WHERE t.account_id = a.id AND t.voided_at IS NULL) AS latest_transaction_date,
         (SELECT MAX(b.imported_at) FROM import_batches b
           WHERE b.account_id = a.id AND b.status = 'reconciled') AS last_imported_at
  FROM accounts a
  JOIN brokers b ON b.id = a.broker_id
  ORDER BY a.id
`);

export function latestImportedPerAccount() {
  return latestImportedStmt.all();
}
