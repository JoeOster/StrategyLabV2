// Reference data every database needs, regardless of how it was created.
//
// Extracted because this has now bitten twice. `scripts/init-db.js` seeds and
// baselines; the offline suite applies `schema.sql` directly and did neither,
// so it ended up with a structurally correct database missing the rows the app
// assumes exist. The first time it was the migration ledger; the second was
// brokerages.
//
// Anything that applies schema.sql calls this. No exceptions, or it happens a
// third time.
import db from "./db.js";
import { withTransaction } from "./db.js";

export const SEED_EXCHANGES = [
  { code: "NASDAQ", name: "Nasdaq", timezone: "America/New_York" },
  { code: "NYSE", name: "New York Stock Exchange", timezone: "America/New_York" },
];

// The brokerages the app ships knowing about. `slug` MUST match the BROKER
// constant of the matching parser in services/importers/ -- importService picks
// a parser by it -- so a slug is permanent even when a name changes.
//
// has_parser records whether such a file exists. It is not a promise about the
// future: schwab and tradestation are here because accounts exist with them,
// unfunded, and the import screen should say plainly that no parser is written
// rather than failing at the first row.
export const SEED_BROKERS = [
  { slug: "fidelity", name: "Fidelity", has_parser: 1 },
  { slug: "etrade", name: "E*TRADE", has_parser: 1 },
  { slug: "robinhood", name: "Robinhood", has_parser: 1 },
  { slug: "schwab", name: "Schwab", has_parser: 0 },
  { slug: "tradestation", name: "TradeStation", has_parser: 0 },
  { slug: "other", name: "Other", has_parser: 0 },
];

/**
 * Idempotent. INSERT OR IGNORE throughout, so running it against a database
 * that already has these rows is a no-op rather than an error -- which is what
 * makes it safe to call from every creation path.
 *
 * @param {{ defaultWatchlistName?: string }} opts
 */
export function seedReferenceData({ defaultWatchlistName = null } = {}) {
  const insertExchange = db.prepare(
    "INSERT OR IGNORE INTO exchanges (code, name, timezone) VALUES (@code, @name, @timezone)",
  );
  const insertBroker = db.prepare(
    "INSERT OR IGNORE INTO brokers (slug, name, has_parser) VALUES (@slug, @name, @has_parser)",
  );

  return withTransaction(() => {
    for (const row of SEED_EXCHANGES) insertExchange.run(row);
    for (const row of SEED_BROKERS) insertBroker.run(row);

    // The default holder and their first list, so the app is usable at once --
    // without them you would have to create a list before adding a ticker.
    db.prepare(
      "INSERT OR IGNORE INTO account_holders (id, name, is_default) VALUES (1, 'Me', 1)",
    ).run();
    if (defaultWatchlistName) {
      db.prepare(
        "INSERT OR IGNORE INTO watchlists (holder_id, name, sort_order) VALUES (1, ?, 0)",
      ).run(defaultWatchlistName);
    }

    return { exchanges: SEED_EXCHANGES.length, brokers: SEED_BROKERS.length };
  });
}
