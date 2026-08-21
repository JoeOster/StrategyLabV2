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
-- The firms accounts are held with. A TABLE, not a CHECK constraint: this is a
-- list of companies, which is data. As an enum it was structure, and adding one
-- meant a schema migration -- v11 exists for no reason other than allowing
-- 'schwab' and 'tradestation'.
CREATE TABLE brokers (
  id          INTEGER PRIMARY KEY,
  -- Stable machine key. MUST match the BROKER constant exported by the matching
  -- parser in services/importers/, because importService picks a parser by this
  -- value. Renaming a brokerage changes `name`, never `slug`.
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL UNIQUE,
  -- Whether a CSV parser exists for it. Recorded rather than inferred at import
  -- time: an account can be held with a brokerage long before anyone writes a
  -- parser, and the import screen should say so rather than fail at upload.
  has_parser  INTEGER NOT NULL DEFAULT 0 CHECK (has_parser IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY,
  holder_id       INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE RESTRICT,
  -- The brokerage's own number for it. Nullable, because an account can be
  -- registered before its number is to hand and a wrong number is worse than
  -- none -- the import matches files like History_for_Account_266356256.csv on
  -- this, so a guess would attach a statement to the wrong account.
  --
  -- A column rather than part of the nickname. It used to live inside strings
  -- like "Rollover IRA (146518557)", which is data hiding in a display label.
  account_number  TEXT,
  account_type    TEXT,                   -- 'brokerage', 'roth_ira', 'ira', etc.
  nickname        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
  -- An alert comes from ONE of two places, never both:
  --   watched_item_id -- a plan to get IN was reached (entry band)
  --   plan_exit_id    -- a rung of a plan to get OUT was reached
  -- Kept in one table rather than two because everything downstream reads
  -- alerts as a single stream: the bell, the acknowledge endpoints, and the
  -- Home Assistant webhook. Two tables would mean polling and merging both,
  -- and forgetting one of them is the kind of omission this codebase has
  -- already paid for twice.
  watched_item_id   INTEGER REFERENCES watched_items(id) ON DELETE CASCADE,
  plan_exit_id      INTEGER REFERENCES plan_exits(id) ON DELETE CASCADE,
  triggered_at      TEXT NOT NULL DEFAULT (datetime('now')),
  trigger_price     REAL NOT NULL,
  -- WHICH level was crossed: 'STOP' | 'BUY' | 'TAKE_PROFIT' | 'TAKE_PROFIT_2'.
  --
  -- A column rather than something to read back out of `message`, because this
  -- is outcome data, not display text. The whole point of the app is judging
  -- how reliable a source or methodology turned out to be, and an idea that hit
  -- its stop is the opposite result from one that hit its take-profit -- so
  -- "how did source X's ideas end up?" has to be a GROUP BY, not a text search.
  -- Nullable: rows written before this column existed have no answer, and
  -- guessing one from prose would invent data.
  trigger_reason    TEXT CHECK (trigger_reason IN ('STOP','BUY','TAKE_PROFIT','TAKE_PROFIT_2')),
  message           TEXT,
  acknowledged_at   TEXT,
  -- Exactly one parent. Enforced here rather than trusted to the service layer,
  -- because an alert belonging to neither is invisible in every query that
  -- joins, and an alert belonging to both would be counted twice.
  CHECK ((watched_item_id IS NOT NULL) <> (plan_exit_id IS NOT NULL))
);

-- ============================================================================
-- SECTION 4: Transactions & CSV Imports
-- ============================================================================

-- A plan is ONE ENTRY THESIS: the reason a position was opened, and the rules
-- for getting back out of it. It owns the exit ladder.
--
-- Why exits hang off this and not off a transaction or a position:
--
--  * Not a position (holder+security). Buying one ticker twice on two different
--    sources' recommendations is TWO theses. A position-level ladder merges
--    them and destroys the attribution -- which is the entire purpose of this
--    app. transactions.source_id exists per row precisely to keep them apart.
--  * Not a single lot. Scaling into ONE thesis with two buys a week apart is
--    one ladder, not two; per-lot ladders would collectively oversell.
--
-- So: one plan, one thesis, one or more lots, one ladder. In the common case
-- (buy once, sell all) a plan is a single lot with a single rung, and the
-- distinction costs nothing.
--
-- Deliberately NOT the larger `plans` redesign discussed in V2_BACKLOG.md --
-- this does not absorb watchlist membership or journal ideas. It owns exits and
-- groups lots. It is, however, the natural seed for that later.
CREATE TABLE plans (
  id            INTEGER PRIMARY KEY,
  holder_id     INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  security_id   INTEGER NOT NULL REFERENCES securities(id) ON DELETE RESTRICT,
  -- Inherited from the opening trade, and both nullable: a trade can exist with
  -- no plan, and a plan can exist with nobody to credit. A whim trade that
  -- still carries a stop is a normal thing, not a degraded one.
  source_id     INTEGER REFERENCES advice_sources(id) ON DELETE SET NULL,
  strategy_id   INTEGER REFERENCES strategies(id) ON DELETE SET NULL,
  -- 'closed' means the thesis is done -- rungs exhausted, or the position sold
  -- out. 'cancelled' means abandoned with the position possibly still open.
  status        TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','closed','cancelled')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One rung of an exit ladder: "sell THIS MUCH when price is in THIS BAND".
--
-- Rows, not columns, because partial sells need a quantity per target and
-- take_profit_2_low/high was already the start of a ladder that would have
-- grown a _3 and a _4, each with its own branch in the evaluator. That
-- accretion is what made the second take-profit unreachable in practice
-- (docs/BUGS.md #10).
CREATE TABLE plan_exits (
  id            INTEGER PRIMARY KEY,
  plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  -- A stop is just a rung. One evaluation path, no special case.
  kind          TEXT NOT NULL CHECK (kind IN ('TAKE_PROFIT','STOP')),
  sequence      INTEGER NOT NULL DEFAULT 0,   -- display/ladder order
  quantity      REAL NOT NULL CHECK (quantity > 0),
  -- A band, same convention as watched_items' existing targets. The rung fires
  -- when the price sits inside it, so an open end is simply NULL:
  --   TAKE_PROFIT at 110 or better -> price_low = 110, price_high = NULL
  --   STOP at 90 or worse          -> price_low = NULL, price_high = 90
  -- One predicate covers both directions, which is what collapses the old
  -- four-case triggerReason into "which rung was crossed".
  price_low     REAL,
  price_high    REAL,
  status        TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','hit','cancelled')),
  hit_at        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- An unbounded rung would fire on every price forever.
  CHECK (price_low IS NOT NULL OR price_high IS NOT NULL)
);

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
  -- The thesis this lot belongs to, if any. Nullable on purpose: a trade can
  -- exist with no plan, no source and no strategy -- someone bought something
  -- without writing anything down first, which is a normal trade rather than a
  -- degraded one. Trades sharing a plan_id were scaled into under one thesis
  -- and share one exit ladder.
  plan_id             INTEGER REFERENCES plans(id) ON DELETE SET NULL,
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
CREATE INDEX idx_accounts_broker              ON accounts(broker_id);
CREATE INDEX idx_accounts_number              ON accounts(account_number);
CREATE INDEX idx_transactions_plan            ON transactions(plan_id);
-- The evaluator's hot query is "every pending rung of an open plan".
CREATE INDEX idx_plan_exits_pending
  ON plan_exits (plan_id) WHERE status = 'pending';
CREATE INDEX idx_plans_open ON plans (holder_id) WHERE status = 'open';
CREATE INDEX idx_alerts_plan_exit ON alerts(plan_exit_id);

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

CREATE TRIGGER trg_plans_updated_at
AFTER UPDATE ON plans
BEGIN
  UPDATE plans SET updated_at = datetime('now') WHERE id = NEW.id;
END;
