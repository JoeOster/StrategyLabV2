// Shared constants with NO database dependency.
//
// This file exists specifically so scripts/init-db.js can reference these
// without importing a service module. Service modules call db.prepare() at
// module scope, and static imports are hoisted -- so importing one from
// init-db.js would try to prepare statements against tables that don't exist
// yet, failing with "no such table" before the schema is ever applied.

/** Name of the watchlist every holder starts with. */
export const DEFAULT_WATCHLIST_NAME = "Tickers to Watch";

/**
 * Sentinel id for the virtual "Orders" watchlist (every ticker currently
 * held). A string so it can never collide with a real numeric list id.
 */
export const ORDERS_LIST_ID = "orders";
