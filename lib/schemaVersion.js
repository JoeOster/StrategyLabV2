// Bump this by 1 every time schema.sql changes in a way that would break an
// existing database (new table, new column, changed CHECK constraint...).
// `npm run db:init` stamps this value into app_settings; server.js checks it
// on startup and refuses to run against a stale DB.
//
// History:
//   1 - initial schema
//   2 - added `watchlists` table + watched_items.watchlist_id
//   3 - added 'WATCH' to the watched_items.order_type CHECK constraint
//   4 - settings support: group contact fields, book/website link lists
//   5 - strategies decoupled from a single source: dropped strategies.source_id/
//       chapter/page_number, added strategy_sources many-to-many join table
//   6 - added transactions.strategy_id (mirrors transactions.source_id), for
//       the Paper Trade tab and optional strategy-tagging on real Orders too
//   7 - transactions.voided_at/void_reason: orders are voided, never deleted.
//       UNIQUE(account_id, external_ref) became a partial index over non-voided rows
//   8 - api_usage_log.provider CHECK now includes 'openlibrary'. It only
//       allowed yahoo/finnhub, so every ISBN lookup failed on the constraint
//   9 - api_usage_log.provider CHECK now includes 'googlebooks', for the
//       Google Books ISBN fallback (979-8 / Amazon KDP range)
//  10 - transactions.needs_review / review_reason / review_resolved_at, so
//       imported rows with extrapolated cost basis can be found and fixed later
//  11 - accounts.broker CHECK gains 'schwab' and 'tradestation', listed ahead
//       of use so opening those accounts does not hit a stale constraint
//  12 - idx_securities_symbol became UNIQUE. The table's UNIQUE(symbol,
//       exchange_id) never constrained anything in practice, because
//       exchange_id is NULL for almost every row and NULLs do not compare
//       equal -- so concurrent (or merely repeated) adds of the same ticker
//       could create duplicate securities rows silently
//  13 - alerts.trigger_reason: which level a price crossed (stop vs take-profit
//       vs entry). Needed to attribute outcomes to a source -- an idea that hit
//       its stop is the opposite result from one that hit its target, and that
//       has to be queryable rather than parsed out of the message text
//  14 - plans + plan_exits: a trade can now carry an exit ladder owned by the
//       thesis that opened it. transactions.plan_id links a lot to its thesis;
//       alerts.plan_exit_id lets a fired rung raise an alert on the same stream
//       as an entry alert, with a CHECK that an alert has exactly one parent
//  15 - brokers table replaces the accounts.broker CHECK enum, so adding a
//       brokerage is a row rather than a migration (v11 existed only to add
//       two of them); plus accounts.account_number, which the monthly import
//       needs to match a statement file to an account and which had been
//       living inside the nickname string
//  16 - alerts.resolution/resolved_at/resolution_note/resulting_transaction_id:
//       an alert can be accepted or declined rather than merely silenced, and
//       declining is data -- a passed-on entry call is what separates a
//       source's hit rate from the user's own filter
//  17 - dropped notification_cooldown_minutes, a Settings control that was
//       saved and read back correctly and consumed by nothing at all
export const SCHEMA_VERSION = 17;

export const SCHEMA_VERSION_KEY = "schema_version";
