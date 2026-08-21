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
export const SCHEMA_VERSION = 11;

export const SCHEMA_VERSION_KEY = "schema_version";
