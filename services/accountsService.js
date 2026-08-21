// Brokerage accounts. The table has existed since schema v1 but nothing ever
// created a row -- there was no route and no service -- which blocked imports
// entirely, since `import_batches.account_id` is NOT NULL.
//
// Deliberately thin: an account is reference data (which broker, which login,
// what to call it), not something with derived values. The interesting numbers
// all live on `transactions` and are computed there.
import db from "../lib/db.js";

// Must stay in step with the CHECK constraint on accounts.broker in schema.sql.
// schwab (thinkorswim) and tradestation are listed ahead of use -- both accounts
// exist but are unfunded as of 2026-08-21.
const BROKERS = new Set(["fidelity", "etrade", "robinhood", "schwab", "tradestation", "other"]);

const insertAccount = db.prepare(`
  INSERT INTO accounts (holder_id, broker, account_type, nickname)
  VALUES (@holderId, @broker, @accountType, @nickname)
  RETURNING *
`);

// Two different dates, because they answer two different questions and are
// routinely far apart: how current the *data* is, versus when an import last
// ran. An import done yesterday may only have carried data through last month.
//
// `last_transaction_date` is what tells you what to download next time -- see
// docs/IMPORTS.md on why it should be presented as a floor to start *before*
// rather than an exact boundary.
const listAccountsStmt = db.prepare(`
  SELECT
    a.*,
    (SELECT COUNT(*) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL)                     AS transaction_count,
    (SELECT MAX(t.transaction_date) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL)                     AS last_transaction_date,
    (SELECT MIN(t.transaction_date) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL)                     AS first_transaction_date,
    (SELECT MAX(b.imported_at) FROM import_batches b WHERE b.account_id = a.id) AS last_imported_at,
    (SELECT COUNT(*) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL
        AND t.needs_review = 1 AND t.review_resolved_at IS NULL)             AS needs_review_count
  FROM accounts a
  WHERE a.holder_id = ?
  ORDER BY a.broker, a.nickname
`);

const getAccountStmt = db.prepare("SELECT * FROM accounts WHERE id = ? AND holder_id = ?");

const updateAccountStmt = db.prepare(`
  UPDATE accounts SET
    broker       = COALESCE(@broker, broker),
    account_type = COALESCE(@accountType, account_type),
    nickname     = COALESCE(@nickname, nickname)
  WHERE id = @id AND holder_id = @holderId
  RETURNING *
`);

/** @returns {Array} accounts with import-currency fields attached */
export function listAccounts(holderId) {
  return listAccountsStmt.all(holderId);
}

export function getAccount(holderId, id) {
  return getAccountStmt.get(id, holderId) ?? null;
}

export function createAccount(holderId, { broker, accountType = null, nickname = null } = {}) {
  const b = String(broker ?? "").trim().toLowerCase();
  if (!BROKERS.has(b)) {
    // Named explicitly rather than left to the CHECK constraint: a constraint
    // failure surfaces as an opaque SQLite error at insert time, which is the
    // exact trap that made ISBN lookup look broken for weeks (see
    // lib/schemaVersion.js v8).
    throw new Error(`broker must be one of: ${[...BROKERS].join(", ")}`);
  }
  return insertAccount.get({
    holderId,
    broker: b,
    accountType: accountType ? String(accountType).trim() : null,
    nickname: nickname ? String(nickname).trim() : null,
  });
}

export function updateAccount(holderId, id, patch = {}) {
  const b = patch.broker == null ? null : String(patch.broker).trim().toLowerCase();
  if (b !== null && !BROKERS.has(b)) throw new Error(`broker must be one of: ${[...BROKERS].join(", ")}`);
  const row = updateAccountStmt.get({
    id,
    holderId,
    broker: b,
    accountType: patch.accountType ?? null,
    nickname: patch.nickname ?? null,
  });
  if (!row) throw new Error("Account not found.");
  return row;
}

/**
 * Accounts are never deleted here. `transactions.account_id` is
 * ON DELETE SET NULL, so removing one would orphan its trades into a nameless
 * pool rather than removing them -- the same "an order is never deleted"
 * reasoning that governs transactions themselves. Rename it instead.
 */
