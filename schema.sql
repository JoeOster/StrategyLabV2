-- ============================================================================
-- Strategy Lab V2 -- Database Schema (SQLite)
-- ============================================================================
-- Design goals (see docs/DB_ARCHITECTURE.md for the full rationale):
--   1. Every relationship is a real foreign key with an explicit ON DELETE rule.
--   2. Every enum-like text column has a CHECK constraint. No silent typos.
--   3. "Cache" data (anything fetched from Yahoo/Finnhub) lives in its own
--      tables and can be wiped and rebuilt at any time without touching
--      anything the user typed in. "User" data never gets auto-deleted.
--   4. Tickers are never stored as raw free text in user-data tables --
--      everything points at securities.id, so a bad symbol can't silently
--      create three different rows for the same stock.
--   5. Every table has created_at (and updated_at where rows get edited).
--   6. Imports are idempotent: re-importing the same CSV can never create
--      duplicate transactions.
--
-- Run with: sqlite3 strategy_lab.db < schema.sql
-- Requires: PRAGMA foreign_keys = ON;  (must be set by the app on every
--           connection -- SQLite does not persist this setting in the file)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- SECTION 0: Reference & Market Data Cache
-- Everything in this section is derived from Yahoo Finance / Finnhub (or a
-- future provider). Nothing here is hand-entered by the user. Safe to
-- TRUNCATE and re-fetch at any time -- no user data lives in this section.
-- ============================================================================

CREATE TABLE exchanges (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,     -- e.g. 'NASDAQ', 'NYSE', 'TSX'
  name          TEXT NOT NULL,
  mic           TEXT,                     -- ISO 10383 Market Identifier Code, if known
  timezone      TEXT,                     -- e.g. 'America/New_York'
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The canonical registry of every ticker the app knows about. All other
-- tables reference security_id, never a raw ticker string.
CREATE TABLE securities (
  id            INTEGER PRIMARY KEY,
  symbol        TEXT NOT NULL,            -- e.g. 'NVDA'
  exchange_id   INTEGER REFERENCES exchanges(id) ON DELETE SET NULL,
  asset_type    TEXT NOT NULL DEFAULT 'stock'
                  CHECK (asset_type IN ('stock','etf','crypto','mutual_fund','bond','option','cash')),
  name          TEXT,                     -- company/fund name
  currency      TEXT,                     -- 'USD', 'CAD', etc.
  sector        TEXT,
  industry      TEXT,
  logo_url      TEXT,
  description   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  data_source   TEXT,                     -- 'yahoo' | 'finnhub' | 'manual'
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  profile_updated_at TEXT,                -- last time company_profile fields were refreshed
  -- Subsumed by the UNIQUE idx_securities_symbol index (see SECTION 6) and
  -- kept only because dropping a table constraint means rebuilding the table.
  -- On its own this never worked: exchange_id is NULL for almost every row,
  -- and NULLs do not compare equal.
  UNIQUE (symbol, exchange_id)
);

-- One row per security: the latest known price. Upserted by the high-priority
-- watcher every ~2 min for anything actively watched, less often for
-- everything else. This is what Dashboard cards read -- never a join across
-- historical_prices.
CREATE TABLE quotes_cache (
  security_id   INTEGER PRIMARY KEY REFERENCES securities(id) ON DELETE CASCADE,
  last_price    REAL,
  prev_close    REAL,
  open_price    REAL,
  day_high      REAL,
  day_low       REAL,
  volume        INTEGER,
  as_of         TEXT,                     -- exchange timestamp of the quote itself
  source        TEXT CHECK (source IN ('yahoo','finnhub','manual')),
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- End-of-day history, used for charting and (later) backtesting.
CREATE TABLE historical_prices (
  id            INTEGER PRIMARY KEY,
  security_id   INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,            -- 'YYYY-MM-DD'
  open          REAL,
  high          REAL,
  low           REAL,
  close         REAL NOT NULL,
  adj_close     REAL,
  volume        INTEGER,
  source        TEXT CHECK (source IN ('yahoo','finnhub')),
  UNIQUE (security_id, date)
);

CREATE TABLE dividends (
  id            INTEGER PRIMARY KEY,
  security_id   INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  ex_date       TEXT NOT NULL,
  pay_date      TEXT,
  amount        REAL NOT NULL,
  source        TEXT CHECK (source IN ('yahoo','finnhub')),
  UNIQUE (security_id, ex_date)
);

CREATE TABLE splits (
  id            INTEGER PRIMARY KEY,
  security_id   INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  split_date    TEXT NOT NULL,
  ratio         TEXT NOT NULL,            -- store as text, e.g. '2:1', to avoid float rounding
  source        TEXT CHECK (source IN ('yahoo','finnhub')),
  UNIQUE (security_id, split_date)
);

-- Tracks every outbound call to a market data provider so the app can
-- self-throttle and stay inside free-tier limits (this is what killed the
-- earlier attempts -- Polygon 5/min, Alpha Vantage 25/day, etc.).
CREATE TABLE api_usage_log (
  id            INTEGER PRIMARY KEY,
  -- Every services/providers/* wrapper logs through withUsageLog(), so this
  -- list must include every provider that exists. 'openlibrary' was missing,
  -- which meant every ISBN lookup died on this constraint rather than working
  -- -- the feature had never run successfully. Adding a provider wrapper
  -- without adding it here is the trap; the CHECK fails at call time, not at
  -- startup, so it looks like the provider is broken rather than the schema.
  provider      TEXT NOT NULL CHECK (provider IN ('yahoo','finnhub','openlibrary','googlebooks')),
  endpoint      TEXT NOT NULL,
  called_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status_code   INTEGER,
  note          TEXT
);

-- ============================================================================
-- SECTION 1: Account Holders & Brokerage Accounts
-- User-entered data. Never auto-purged.
-- ============================================================================

CREATE TABLE account_holders (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A holder can have multiple brokerage accounts (Fidelity, E-Trade,
-- Robinhood, ...). CSV imports and transactions are tied to one account.
CREATE TABLE accounts (
  id            INTEGER PRIMARY KEY,
  holder_id     INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  -- Add a broker here BEFORE opening an account with them. This CHECK fails
  -- at insert time, not at startup, so a missing broker looks like "creating
  -- accounts is broken" rather than "the schema is stale" -- the same trap that
  -- made ISBN lookup appear broken for weeks (see lib/schemaVersion.js v8).
  -- schwab and tradestation are listed ahead of use: both accounts exist but
  -- are unfunded and unused as of 2026-08-21. A CSV parser for each is still
  -- future work; 'other' is the fallback until then.
  broker        TEXT NOT NULL CHECK (broker IN ('fidelity','etrade','robinhood','schwab','tradestation','other')),
  account_type  TEXT,                     -- 'brokerage', 'roth_ira', 'ira', etc.
  nickname      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- SECTION 2: Advice Sources & Strategy Lab
-- Base table stays narrow; type-specific fields live in their own 1:1
-- extension tables instead of one wide table full of nulls.
-- ============================================================================

CREATE TABLE advice_sources (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('person','group','book','website')),
  url           TEXT,
  description   TEXT,
  image_path    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE advice_source_person_details (
  source_id     INTEGER PRIMARY KEY REFERENCES advice_sources(id) ON DELETE CASCADE,
  email         TEXT,
  phone         TEXT,
  app_type      TEXT,                     -- e.g. 'Discord', 'Telegram'
  app_handle    TEXT
);

CREATE TABLE advice_source_group_details (
  source_id         INTEGER PRIMARY KEY REFERENCES advice_sources(id) ON DELETE CASCADE,
  primary_contact   TEXT,
  email             TEXT,
  phone             TEXT,
  app_type          TEXT,
  app_handle        TEXT
);

CREATE TABLE advice_source_book_details (
  source_id     INTEGER PRIMARY KEY REFERENCES advice_sources(id) ON DELETE CASCADE,
  author        TEXT,
  isbn          TEXT,
  -- Newline-separated link lists for now. Actual file upload / PDF storage is
  -- deliberately deferred; these hold references until that's built.
  websites      TEXT,
  pdfs          TEXT
);

CREATE TABLE advice_source_website_details (
  source_id     INTEGER PRIMARY KEY REFERENCES advice_sources(id) ON DELETE CASCADE,
  websites      TEXT,
  pdfs          TEXT
);

-- Which holder follows which source (a source can be shared across holders).
CREATE TABLE source_subscriptions (
  id            INTEGER PRIMARY KEY,
  holder_id     INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES advice_sources(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (holder_id, source_id)
);

-- A named strategy/rule (e.g. "Buy the dip"). Source-independent: the same
-- strategy can be mentioned by multiple sources (a book AND a podcast AND a
-- person), each with its own chapter/page/notes -- see strategy_sources
-- below. Phase 2 AI extraction can populate a future `rules_json` column here
-- without changing this table's shape.
CREATE TABLE strategies (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Many-to-many: which source(s) mention/teach this strategy, and the
-- source-specific pointer to it (a book's chapter/page, a podcast episode
-- note, etc. -- lives here, not on strategies, since it's only meaningful in
-- the context of one particular source).
CREATE TABLE strategy_sources (
  id            INTEGER PRIMARY KEY,
  strategy_id   INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  source_id     INTEGER NOT NULL REFERENCES advice_sources(id) ON DELETE CASCADE,
  chapter       TEXT,
  page_number   INTEGER,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (strategy_id, source_id)
);

-- ============================================================================
-- SECTION 3: Watchlists, Watched Items (Orders tab + Strategy Lab ideas) & Alerts
-- Unified watched_items table, same as the old design got right: is_paper_trade
-- is the only thing that distinguishes a real watched limit order from a
-- hypothetical Strategy Lab idea.
-- ============================================================================

-- Named groupings for the watchlist UI (e.g. "Tech", "Dip Buys"). One list
-- per item, not tags -- keeps the UI a simple set of tabs/sections instead
-- of needing a filtering model. Every holder gets a "General" list
-- auto-created the first time they add a ticker without picking one
-- (see watchlistService.getOrCreateDefaultWatchlist).
CREATE TABLE watchlists (
  id            INTEGER PRIMARY KEY,
  holder_id     INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (holder_id, name)
);

CREATE TABLE watched_items (
  id                  INTEGER PRIMARY KEY,
  holder_id           INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  watchlist_id        INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE RESTRICT,
  security_id         INTEGER NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
  source_id           INTEGER REFERENCES advice_sources(id) ON DELETE SET NULL,
  strategy_id         INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  is_paper_trade      INTEGER NOT NULL DEFAULT 0 CHECK (is_paper_trade IN (0,1)),
  -- WATCH: just tracking the ticker, no price target, never triggers an alert.
  order_type          TEXT NOT NULL CHECK (order_type IN ('BUY_LIMIT','SELL_LIMIT','WATCH')),
  quantity            REAL,
  buy_price_low       REAL,
  buy_price_high      REAL,
  take_profit_low     REAL,
  take_profit_high    REAL,
  take_profit_2_low   REAL,
  take_profit_2_high  REAL,
  escape_price        REAL,
  status              TEXT NOT NULL DEFAULT 'WATCHING'
                         CHECK (status IN ('WATCHING','ALERT','EXECUTED','CANCELLED','EXPIRED')),
  expiration_date     TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Durable log of every time a watched item's price target was hit. The
-- `status='ALERT'` flag on watched_items tells you current state; this table
-- tells you history (and is what "hit me up" notifications get sent from).
CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY,
  watched_item_id   INTEGER NOT NULL REFERENCES watched_items(id) ON DELETE CASCADE,
  triggered_at      TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_price     REAL NOT NULL,
  message           TEXT,
  acknowledged_at   TEXT
);

-- ============================================================================
-- SECTION 4: Transactions & CSV Imports
-- ============================================================================

CREATE TABLE transactions (
  id                  INTEGER PRIMARY KEY,
  holder_id           INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  account_id          INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  security_id         INTEGER NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
  watched_item_id     INTEGER REFERENCES watched_items(id) ON DELETE SET NULL,
  source_id           INTEGER REFERENCES advice_sources(id) ON DELETE SET NULL,
  strategy_id         INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  is_paper_trade      INTEGER NOT NULL DEFAULT 0 CHECK (is_paper_trade IN (0,1)),
  transaction_type    TEXT NOT NULL CHECK (transaction_type IN ('BUY','SELL','DIVIDEND','SPLIT_ADJ')),
  transaction_date    TEXT NOT NULL,
  quantity            REAL NOT NULL,
  price               REAL NOT NULL,
  fees                REAL NOT NULL DEFAULT 0,
  cost_basis          REAL,               -- set at BUY time
  quantity_remaining  REAL,               -- open-lot tracking for BUYs
  linked_buy_id       INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  import_batch_id     INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  external_ref        TEXT,               -- broker's own txn id, or a computed fingerprint
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  -- Orders are never hard-deleted. A mistaken entry is *voided*, which keeps the
  -- audit trail intact; "sold" is not a delete either -- that is a separate SELL
  -- row drawing the lot down via quantity_remaining. Every read path filters
  -- `voided_at IS NULL`.
  voided_at           TEXT,
  void_reason         TEXT,
  -- Data-quality flag, for rows whose numbers are not fully supported by the
  -- source they came from. Set by the CSV importer when a value had to be
  -- extrapolated rather than read -- chiefly shares transferred in from
  -- another account, where the export gives a transfer *value* but not what
  -- was actually paid, so cost basis (and therefore unrealized P&L) is an
  -- approximation.
  --
  -- Deliberately a column rather than a note: the whole point is being able to
  -- ask "what did we extrapolate?" later and fix it once the real records turn
  -- up. `import_raw_rows.reconciliation_status` cannot answer that, because it
  -- describes the staging row, not the transaction that came out of it.
  --
  -- review_resolved_at is stamped when the real figures replace the estimate,
  -- keeping the fact that it *was* estimated rather than erasing it -- same
  -- reasoning as voided_at above.
  needs_review        INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  review_reason       TEXT,
  review_resolved_at  TEXT
);

-- Partial: the interesting query is always "what still needs reconciling",
-- which is a small slice of a table that will grow without bound.
CREATE INDEX idx_transactions_needs_review
  ON transactions (holder_id)
  WHERE needs_review = 1 AND review_resolved_at IS NULL;

-- Partial unique, replacing the old table-level UNIQUE (account_id, external_ref):
-- a voided row must NOT keep its external_ref slot, or re-importing a broker CSV
-- containing that transaction would silently no-op instead of re-adding it.
CREATE UNIQUE INDEX idx_transactions_external_ref
  ON transactions (account_id, external_ref)
  WHERE voided_at IS NULL;

CREATE TABLE import_batches (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  broker        TEXT NOT NULL,
  filename      TEXT,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  row_count     INTEGER,
  status        TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','reconciled','failed'))
);

-- Staging area for the CSV reconciliation workflow: every raw row from the
-- broker file lands here first. Nothing touches `transactions` until a row
-- is matched/approved, so a bad import can never corrupt the ledger.
CREATE TABLE import_raw_rows (
  id                      INTEGER PRIMARY KEY,
  batch_id                INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  raw_data                TEXT NOT NULL,   -- JSON blob of the original CSV row
  matched_transaction_id  INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  reconciliation_status   TEXT NOT NULL DEFAULT 'new'
                             CHECK (reconciliation_status IN ('matched','new','duplicate','needs_review')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- SECTION 5: Settings
-- ============================================================================

CREATE TABLE app_settings (
  id            INTEGER PRIMARY KEY,
  key           TEXT NOT NULL UNIQUE,
  value         TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- SECTION 6: Indexes
-- ============================================================================

-- UNIQUE, not just an index. `UNIQUE (symbol, exchange_id)` on the table above
-- does not constrain what this app actually does: most callers pass no
-- exchange, exchange_id is then NULL, and SQLite treats every NULL as distinct
-- -- so that constraint permits unlimited duplicate rows for the same ticker.
-- The app reads securities by symbol alone and takes the first match, so a
-- duplicate does not error, it just hides whatever is attached to the other row.
--
-- Uniqueness on symbol alone matches how the app genuinely behaves. It forgoes
-- listing one ticker on two exchanges, which nothing here supports anyway:
-- there is one lookup path and it is by symbol. (BUG 6)
CREATE UNIQUE INDEX idx_securities_symbol    ON securities(symbol);
CREATE INDEX idx_historical_prices_security   ON historical_prices(security_id, date);
CREATE INDEX idx_dividends_security           ON dividends(security_id);
CREATE INDEX idx_watched_items_holder_status  ON watched_items(holder_id, status);
CREATE INDEX idx_watched_items_watchlist      ON watched_items(watchlist_id);
CREATE INDEX idx_watched_items_security       ON watched_items(security_id);
CREATE INDEX idx_watchlists_holder            ON watchlists(holder_id);
CREATE INDEX idx_alerts_watched_item          ON alerts(watched_item_id);
CREATE INDEX idx_transactions_holder          ON transactions(holder_id);
CREATE INDEX idx_transactions_security        ON transactions(security_id);
CREATE INDEX idx_transactions_account_date    ON transactions(account_id, transaction_date);
CREATE INDEX idx_import_raw_rows_batch        ON import_raw_rows(batch_id, reconciliation_status);
CREATE INDEX idx_strategy_sources_strategy    ON strategy_sources(strategy_id);
CREATE INDEX idx_strategy_sources_source      ON strategy_sources(source_id);

-- ============================================================================
-- SECTION 7: updated_at triggers (SQLite has no ON UPDATE clause like MySQL)
-- ============================================================================

CREATE TRIGGER trg_advice_sources_updated_at
AFTER UPDATE ON advice_sources
BEGIN
  UPDATE advice_sources SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_watched_items_updated_at
AFTER UPDATE ON watched_items
BEGIN
  UPDATE watched_items SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_app_settings_updated_at
AFTER UPDATE ON app_settings
BEGIN
  UPDATE app_settings SET updated_at = datetime('now') WHERE id = NEW.id;
END;
