-- v18 -> v19: cash.
--
-- Fidelity says the Rollover IRA is worth $23,677.51. The app said $18,892.72
-- and every position agreed to within thirteen dollars of price drift. The
-- whole difference was $4,797.73 sitting in the money market sweep, which the
-- app had nowhere to put.
--
-- Cash is mostly DERIVED, not stored: a buy spends it, a sell and a dividend
-- add to it, and all of that is already in `transactions`. What is missing is
-- only the movements that cross the account boundary -- contributions,
-- withdrawals, and the opening balance of an account whose earlier history
-- predates any statement on hand. That is what this table holds.
CREATE TABLE cash_transactions (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  transaction_date  TEXT NOT NULL,
  -- DEPOSIT and OPENING_BALANCE add; WITHDRAWAL and FEE subtract. ONE rule for
  -- direction, with no exceptions -- an ADJUSTMENT kind that could go either way
  -- was considered and dropped, because it would have meant amount is positive
  -- except sometimes, and two rules about sign eventually disagree.
  --
  -- DEPOSIT/WITHDRAWAL are real movements. OPENING_BALANCE is the honest way to
  -- start an account whose history begins before the oldest statement you have:
  -- it says "this much was already here" rather than inventing deposits that
  -- cannot be evidenced.
  kind              TEXT NOT NULL
                       CHECK (kind IN ('DEPOSIT','WITHDRAWAL','OPENING_BALANCE','FEE')),
  -- Always positive. Direction comes from `kind`, the same convention
  -- transactions uses for BUY/SELL -- a signed amount plus a kind gives two
  -- sources of truth about direction and they eventually disagree.
  amount            REAL NOT NULL CHECK (amount > 0),
  external_ref      TEXT,
  notes             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  voided_at         TEXT,
  void_reason       TEXT
);

CREATE INDEX idx_cash_account ON cash_transactions(account_id, transaction_date);

-- Same partial-unique convention as transactions: re-importing a statement
-- that contains a movement already recorded must be a no-op, and a voided row
-- must not keep its slot.
CREATE UNIQUE INDEX idx_cash_external_ref
  ON cash_transactions (account_id, external_ref)
  WHERE voided_at IS NULL;
