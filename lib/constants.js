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

/**
 * Reason stamped on a share transfer IN from another account.
 *
 * The mirror of TRANSFER_OUT_REASON, and shared for the same reason: the cash
 * ledger must exclude BOTH directions. A transfer out is recorded as a SELL
 * because the position must be drawn down, and a transfer in as a BUY -- but
 * neither moved any money. Computing cash straight from the trade ledger would
 * fabricate roughly $33,000 of phantom balance from one account close-out.
 */
export const TRANSFER_IN_REASON =
  "Transferred in from another account -- cost basis unknown (Amount is transfer value, not purchase price).";
