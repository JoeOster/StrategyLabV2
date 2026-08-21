// Cash held in an account, and the account total that finally reconciles.
//
// Cash is mostly DERIVED. A buy spends it, a sell and a dividend add to it, and
// all of that is already in `transactions`. Only movements that cross the
// account boundary need storing -- contributions, withdrawals, and the opening
// balance of an account whose history predates the oldest statement to hand.
//
// The subtlety that makes this worth writing carefully: a share transfer
// between accounts is recorded as a SELL (out) or a BUY (in), because the
// position genuinely has to move. But NO MONEY CHANGED HANDS. Computing cash
// straight from the trade ledger would invent roughly $33,000 of balance from
// one 2025 account close-out. Both directions are flagged with a shared
// constant, and both are excluded here.
import db from "../lib/db.js";
import { TRANSFER_OUT_REASON, TRANSFER_IN_REASON } from "../lib/constants.js";

const insertCash = db.prepare(`
  INSERT INTO cash_transactions (account_id, transaction_date, kind, amount, external_ref, notes, source_code)
  VALUES (@accountId, @transactionDate, @kind, @amount, @externalRef, @notes, @sourceCode)
  RETURNING *
`);

const listCashStmt = db.prepare(`
  SELECT * FROM cash_transactions
  WHERE account_id = ? AND voided_at IS NULL
  ORDER BY transaction_date, id
`);

// DEPOSIT and OPENING_BALANCE add; WITHDRAWAL and FEE subtract. One rule.
const cashMovementStmt = db.prepare(`
  SELECT COALESCE(SUM(
    CASE kind
      WHEN 'DEPOSIT' THEN amount
      WHEN 'OPENING_BALANCE' THEN amount
      ELSE -amount
    END
  ), 0) AS v
  FROM cash_transactions
  WHERE account_id = @accountId AND voided_at IS NULL
    AND (@since IS NULL OR transaction_date >= @since)
`);

// Trades, but only those on or after the opening baseline.
//
// An OPENING_BALANCE says "this much cash was in the account on this date". It
// is a starting point, not a plug that back-solves history -- so only activity
// FROM that date onward may move it. Deriving cash from the whole trade ledger
// on top of an opening balance double-counts everything before it.
//
// The first attempt at this got it wrong and the result said so: it suggested
// an opening balance of $168,439.66 for an account worth $23,677, having
// reconstructed years of buys and sells whose transfer valuations are known to
// be approximate. A number that large from inputs that soft is not a
// reconciliation, it is a guess wearing a decimal point.
//
// Transfers are excluded regardless of date: they moved shares, not money.
const tradeCashStmt = db.prepare(`
  SELECT
    COALESCE(SUM(CASE
      WHEN transaction_type = 'BUY'
       AND (review_reason IS NULL OR review_reason <> @transferIn)
      THEN -(quantity * price + fees) END), 0) AS spent,
    COALESCE(SUM(CASE
      WHEN transaction_type = 'SELL'
       AND (review_reason IS NULL OR review_reason <> @transferOut)
      THEN (quantity * price - fees) END), 0) AS received,
    COALESCE(SUM(CASE WHEN transaction_type = 'DIVIDEND' THEN price END), 0) AS income
  FROM transactions
  WHERE account_id = @accountId AND voided_at IS NULL AND is_paper_trade = 0
    AND (@since IS NULL OR transaction_date >= @since)
`);

/**
 * What the account holds in cash.
 *
 * @returns {{balance: number, fromMovements: number, fromTrades: number,
 *            spent: number, received: number, income: number}}
 */
export function cashBalance(accountId) {
  // Everything is measured from the opening baseline, if one exists. Without
  // one, cash is derived from the whole ledger -- which is only meaningful for
  // an account whose entire history has been imported.
  const opening = listCashStmt.all(accountId).find((r) => r.kind === "OPENING_BALANCE");
  const since = opening ? opening.transaction_date : null;

  const movements = cashMovementStmt.get({ accountId, since }).v;
  const t = tradeCashStmt.get({
    accountId,
    since,
    transferIn: TRANSFER_IN_REASON,
    transferOut: TRANSFER_OUT_REASON,
  });
  const fromTrades = t.spent + t.received + t.income;
  return {
    // No opening balance means this figure ASSUMES the account began empty and
    // that every movement since is present in the ledger. For an account whose
    // history predates the oldest statement to hand, that is false -- and a
    // derived balance shown as flatly as a verified one is the exact shape of
    // wrong number this codebase keeps producing. Callers must surface it.
    isDerived: !opening,
    openingBalance: opening ? opening.amount : null,
    openingDate: since,
    balance: movements + fromTrades,
    fromMovements: movements,
    fromTrades,
    spent: t.spent,
    received: t.received,
    income: t.income,
  };
}

export function listCashTransactions(accountId) {
  return listCashStmt.all(accountId);
}

/**
 * Records a cash movement.
 *
 * @param {{accountId: number, kind: string, amount: number,
 *          transactionDate?: string, notes?: string, externalRef?: string}} input
 */
export function recordCash(input) {
  const kind = String(input.kind ?? "").toUpperCase();
  if (!["DEPOSIT", "WITHDRAWAL", "OPENING_BALANCE", "FEE"].includes(kind)) {
    throw new Error("kind must be DEPOSIT, WITHDRAWAL, OPENING_BALANCE or FEE.");
  }
  const amount = Number(input.amount);
  // Positive always. Direction is carried by `kind`, never by the sign -- two
  // sources of truth about direction eventually disagree.
  if (!(amount > 0)) throw new Error("Amount must be greater than zero.");

  // One opening balance per account. A second would silently double the
  // starting position, and the whole point of the kind is that it is the
  // account's beginning.
  if (kind === "OPENING_BALANCE") {
    const existing = listCashStmt
      .all(input.accountId)
      .find((r) => r.kind === "OPENING_BALANCE");
    if (existing) {
      throw new Error(
        `This account already has an opening balance of ${existing.amount} dated ${existing.transaction_date}.`,
      );
    }
  }

  return insertCash.get({
    accountId: input.accountId,
    transactionDate: input.transactionDate || new Date().toISOString().slice(0, 10),
    kind,
    amount,
    externalRef: input.externalRef ?? null,
    notes: input.notes ?? null,
    sourceCode: input.sourceCode ?? null,
  });
}

const voidCashStmt = db.prepare(
  `UPDATE cash_transactions SET voided_at = datetime('now'), void_reason = ?
     WHERE id = ? AND voided_at IS NULL`,
);

/** Voided rather than deleted, the same rule the trade ledger follows. */
export function voidCash(id, reason = null) {
  return { voided: voidCashStmt.run(reason, id).changes };
}

/**
 * The opening balance that would make an account reconcile to a known total.
 *
 * Answers "Fidelity says this account is worth $23,677.51 -- what was in it
 * before my statements begin?" without requiring every historical contribution
 * to be reconstructed. Returned as a suggestion for a human to accept, never
 * written automatically: it is a plug, and a plug recorded silently is
 * indistinguishable later from evidence.
 */
export function suggestOpeningBalance(accountId, knownAccountTotal, positionsMarketValue) {
  const impliedCash = knownAccountTotal - positionsMarketValue;
  return {
    impliedCash,
    // Dated TODAY, so nothing before it is re-derived. Reconstructing the
    // account's whole history to back into a starting figure produces a number
    // built on transfer valuations that are approximate by construction.
    suggestedAsOf: new Date().toISOString().slice(0, 10),
    openingBalance: impliedCash,
  };
}
