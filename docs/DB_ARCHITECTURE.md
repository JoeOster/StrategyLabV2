# Strategy Lab V2 — Database Architecture

This document explains the schema in `schema.sql`: what each part is for, how it
maps to the modules (Dashboard, Orders, Imports, Journal), what data comes from
Yahoo/Finnhub vs. what you type in, and specifically what changed from the old
Strategy_Lab schema to address "the DB kept getting messy."

## Why it got messy before

Looking at the old `docs/database_schema.md`, three things caused most of the
drift:

1. **Raw ticker strings everywhere.** `transactions.ticker` and
   `watched_items.ticker` were free text. Nothing stopped `"NVDA"`, `"nvda "`,
   and `"NVDA.US"` from becoming three different rows for the same stock.
2. **No enforced enums.** `status`, `order_type`, `transaction_type` were just
   `TEXT` with a comment saying what values were expected. An agent (or a bug)
   could insert `"Bought"` instead of `"BUY"` and nothing would catch it until
   the UI silently failed to render that row.
3. **No idempotency on imports.** There was no unique key tying a transaction
   back to the broker's own record of it, so re-running a CSV import — which
   happened constantly during debugging — had no defense against duplicating
   rows.

A fourth, quieter problem: `advice_sources` was one wide table with
person/group/book fields all bolted on as nullable columns, so most rows were
mostly `NULL` and it was never obvious which fields mattered for which row.

## What changed

**1. `securities` is the one canonical ticker registry.**
Every other table references `security_id`, never a ticker string. A security
is unique per `(symbol, exchange_id)`, so the same symbol on two exchanges
can't collide, and a typo can't silently create a duplicate — inserting
`"NVDA"` twice on NASDAQ just fails the `UNIQUE` constraint.

**2. Every enum is a `CHECK` constraint.**
`transaction_type`, `order_type`, `status`, `asset_type`, `broker`,
`reconciliation_status` — all constrained at the database level. Verified this
directly: an insert with `transaction_type='YOLO'` is rejected by SQLite
itself, not caught later by application code (or not caught at all).

**3. Imports are idempotent by construction.**
`transactions` has `UNIQUE(account_id, external_ref)`. `external_ref` is
either the broker's own transaction ID (if the CSV has one) or a deterministic
fingerprint your import code computes from
`(account, ticker, date, type, qty, price)`. Re-importing the same CSV a
second time just hits the unique constraint and no-ops instead of duplicating
rows — confirmed with a test insert above.

Raw CSV rows never touch `transactions` directly. They land in
`import_raw_rows` first (tied to an `import_batches` record), get matched or
flagged `needs_review`, and only promote to a real `transactions` row once
reconciled. This is the "intelligent multi-step reconciliation" your old
README described, given an actual staging table instead of being all
in-memory during the import request.

**4. Cache data and user data are physically separate.**
`securities`, `quotes_cache`, `historical_prices`, `dividends`, `splits`, and
`api_usage_log` hold nothing you typed — it's all fetched from Yahoo/Finnhub.
You could `DELETE FROM historical_prices` and rebuild it from scratch with
zero risk to your holdings, journal, or transaction history. `account_holders`,
`accounts`, `advice_sources`, `watched_items`, `transactions`, and `strategies`
are the tables that are actually yours — nothing ever auto-purges them.

**5. `advice_sources` is narrow; type-specific fields moved out.**
The base table has only the fields every source has (name, type, url,
description). `advice_source_person_details`,
`advice_source_group_details`, and `advice_source_book_details` are 1:1
extension tables, so a "Book" row doesn't carry four empty person/group
columns and vice versa.

**6. Alerts are a durable log, not just a status flag.**
`watched_items.status = 'ALERT'` tells you the current state. The `alerts`
table records every time a price target was actually hit — `triggered_at`,
`trigger_price`, whether it was acknowledged. That's both your notification
history and the thing a future "hit me up" delivery mechanism (email/push)
reads from.

**7. API usage is tracked, not assumed.**
`api_usage_log` logs every outbound call to Yahoo or Finnhub. This is what
lets the price-polling service (the tiered watcher design from your old
`module-h-api.md` — watched items every ~2 min, static data twice daily,
company profiles overnight) self-throttle and stay inside Finnhub's 60/min
free tier instead of finding out the hard way, like with Polygon before.

## Mapping to your modules

- **Dashboard** — reads `transactions` (open BUY lots, `is_paper_trade = 0`)
  joined to `securities` + `quotes_cache` for live price/P&L. "Deeper
  research" pulls from `securities` (profile fields) plus a live Finnhub call,
  not stored data. Buy/sell from a card writes a new `transactions` row.

- **Orders** — `watched_items` where `is_paper_trade = 0`, `order_type` in
  `('BUY_LIMIT','SELL_LIMIT')`. The watcher polls `quotes_cache` for these
  specifically (highest priority), and a hit writes a row to `alerts`.

- **Imports** — `import_batches` → `import_raw_rows` → reconciled into
  `transactions`, scoped to one `accounts` row per broker/account.

- **Journal / Strategy Lab** — `watched_items` and `transactions` where
  `is_paper_trade = 1`, linked to `advice_sources` and `strategies`. Adding a
  book/guru as a source, logging a paper trade against it, and later
  "executing" it into a real transaction is `watched_item → transaction` with
  `watched_item_id` carried over as the link.

- **Settings** — `account_holders`, `accounts`, `advice_sources` CRUD, plus
  `app_settings` as a flexible key/value store for things like theme and
  default take-profit percentage.

## What this deliberately leaves out (Phase 2)

No tables for backtest runs, strategy rules extracted by AI, or trade
scoring yet — by design, since that's Phase 2. `historical_prices`,
`dividends`, and `splits` already capture what a backtester would need, and
`strategies` already has room to grow (e.g., a future `rules_json` column)
without changing anything that exists today.

## Verified

`schema.sql` was loaded into a real SQLite database and checked:
- All 21 tables create cleanly, `PRAGMA foreign_key_check` and
  `PRAGMA integrity_check` both pass.
- Duplicate `external_ref` on the same account is rejected (idempotent
  import).
- An invalid `transaction_type` is rejected (`CHECK` constraint works).
- Deleting a `security` that's still referenced by a transaction is blocked
  (`ON DELETE RESTRICT` works).
- Deleting an `account_holder` correctly cascades and cleans up their
  `accounts` and `transactions` (`ON DELETE CASCADE` works).
