-- migrate:no-transaction
--
-- v14 -> v15: brokerages become data, and an account gets its number.
--
-- Two problems with one cause. `accounts.broker` was a CHECK-constrained enum,
-- so adding a brokerage meant a schema migration -- v11 was exactly that, added
-- purely to allow 'schwab' and 'tradestation'. A list of the firms you hold
-- accounts with is data, not structure.
--
-- And an account had nowhere to record its number, so the numbers were smuggled
-- into the nickname: "Rollover IRA (146518557)". That is data hiding in a
-- display label. It also has a concrete cost -- the monthly import cannot match
-- `History_for_Account_266356256.csv` to an account without it.
--
-- Needs foreign_keys OFF because `accounts` is rebuilt to drop the CHECK, and
-- transactions/import_batches reference it.

CREATE TABLE brokers (
  id          INTEGER PRIMARY KEY,
  -- Stable machine key. MUST match the BROKER constant exported by the matching
  -- parser in services/importers/, because importService selects a parser by
  -- this value. Renaming a broker changes `name`, never `slug`.
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  -- Whether a CSV parser exists. Not a guess at import time: 'other' and any
  -- future brokerage can hold accounts long before anyone writes a parser, and
  -- the import screen should say so rather than failing at upload.
  has_parser  INTEGER NOT NULL DEFAULT 0 CHECK (has_parser IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO brokers (slug, name, has_parser) VALUES
  ('fidelity',     'Fidelity',     1),
  ('etrade',       'E*TRADE',      1),
  ('robinhood',    'Robinhood',    1),
  ('schwab',       'Schwab',       0),
  ('tradestation', 'TradeStation', 0),
  ('other',        'Other',        0);

CREATE TABLE accounts_v15 (
  id              INTEGER PRIMARY KEY,
  holder_id       INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE RESTRICT,
  -- Nullable: an account can be registered before its number is to hand, and a
  -- wrong number is worse than none for import matching.
  account_number  TEXT,
  account_type    TEXT,
  nickname        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO accounts_v15 (id, holder_id, broker_id, account_number, account_type, nickname, created_at)
  SELECT a.id, a.holder_id, b.id, NULL, a.account_type, a.nickname, a.created_at
  FROM accounts a
  JOIN brokers b ON b.slug = a.broker;

-- Lift the account numbers already written into nicknames, e.g.
-- "Rollover IRA (146518557)" -> account_number 146518557, nickname "Rollover IRA".
-- Only where the pattern is unambiguous: a parenthesised run of digits at the
-- end. Anything else is left alone rather than guessed at.
UPDATE accounts_v15
   SET account_number = trim(replace(replace(substr(nickname, instr(nickname, '(')), '(', ''), ')', '')),
       nickname       = trim(substr(nickname, 1, instr(nickname, '(') - 1))
 WHERE instr(nickname, '(') > 1
   AND nickname LIKE '%)'
   AND trim(replace(replace(substr(nickname, instr(nickname, '(')), '(', ''), ')', '')) GLOB '[0-9]*';

DROP TABLE accounts;
ALTER TABLE accounts_v15 RENAME TO accounts;

CREATE INDEX idx_accounts_broker ON accounts(broker_id);
CREATE INDEX idx_accounts_number ON accounts(account_number);
