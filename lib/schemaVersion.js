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
export const SCHEMA_VERSION = 4;

export const SCHEMA_VERSION_KEY = "schema_version";
