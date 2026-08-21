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

/**
 * Reason stamped on a share transfer OUT to another account.
 *
 * Such a row is stored as a SELL because it must draw lots down exactly like
 * one -- FIFO, position reduction, void filter, all of it. But it has no
 * proceeds, so counting it as a disposal invents a gain or loss that never
 * happened. Realized P&L skips rows carrying this reason.
 *
 * It lives here, rather than as a string literal in each place, so the parser
 * that writes it and the P&L that reads it cannot drift apart. Changing the
 * wording is safe; changing it in only one of the two would not be.
 */
export const TRANSFER_OUT_REASON =
  "Transferred out to another account -- position reduced, but this is not a sale and has no realized gain/loss.";
