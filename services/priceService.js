// Provider-agnostic layer that everything else in the app talks to. Nothing
// outside this file (and providers/*) should ever import yahoo-finance2 or
// call fetch() against Finnhub directly -- that's the "no inline fetch"
// anti-pattern from the old dev guidelines, and it's the reason a future
// provider swap or rate-limit fix would otherwise mean hunting through the
// whole codebase.
import db, { withTransaction } from "../lib/db.js";
import * as yahoo from "./providers/yahooProvider.js";
import * as finnhub from "./providers/finnhubProvider.js";

const PROVIDERS = { yahoo, finnhub };

const getExchange = db.prepare("SELECT id FROM exchanges WHERE code = ?");
const insertExchange = db.prepare(
  "INSERT INTO exchanges (code, name) VALUES (@code, @name) RETURNING id",
);
// Two separate lookups rather than one query with a tri-state NULL match:
// SQL's `NULL = NULL` is never true, so a single query trying to handle
// "caller cares about exchange" and "caller doesn't" in one WHERE clause
// silently fails to find existing rows in the common case (caller just
// passes a ticker, no exchange). Most callers won't specify an exchange, so
// that path needs to actually work.
const getSecurityByExchange = db.prepare(
  "SELECT * FROM securities WHERE symbol = ? AND exchange_id = ?",
);
const getSecurityAnySymbol = db.prepare(
  "SELECT * FROM securities WHERE symbol = ? ORDER BY id LIMIT 1",
);
const insertSecurity = db.prepare(`
  INSERT INTO securities (symbol, exchange_id, name, currency, sector, industry, logo_url, description, data_source, profile_updated_at)
  VALUES (@symbol, @exchangeId, @name, @currency, @sector, @industry, @logoUrl, @description, @dataSource, datetime('now'))
  RETURNING *
`);

function resolveExchangeId(exchangeCode) {
  if (!exchangeCode) return null;
  const existing = getExchange.get(exchangeCode);
  if (existing) return existing.id;
  return insertExchange.get({ code: exchangeCode, name: exchangeCode }).id;
}

// Turns a Yahoo/Finnhub exchange name ('NasdaqGS', 'NYQ', etc.) into one of
// our clean exchange codes. Falls back to storing whatever we got rather
// than silently dropping it -- an unmapped code is a data-cleanliness bug
// to go fix, not a reason to lose the security's exchange entirely.
const EXCHANGE_ALIASES = {
  NMS: "NASDAQ", NGM: "NASDAQ", NCM: "NASDAQ", NasdaqGS: "NASDAQ", NasdaqGM: "NASDAQ",
  NYQ: "NYSE", NYSE: "NYSE",
};
function normalizeExchangeCode(raw) {
  if (!raw) return null;
  return EXCHANGE_ALIASES[raw] ?? raw;
}

/**
 * Finds a security by symbol, or creates it by pulling a profile from
 * Yahoo. This is the only place a new ticker enters the database, so it's
 * the one spot that has to get exchange/name/sector right.
 * @param {string} symbol
 * @param {{exchangeCode?: string}} opts
 */
export async function getOrCreateSecurity(symbol, opts = {}) {
  const upperSymbol = symbol.trim().toUpperCase();
  let exchangeId = resolveExchangeId(opts.exchangeCode ?? null);

  const existing = exchangeId != null
    ? getSecurityByExchange.get(upperSymbol, exchangeId)
    : getSecurityAnySymbol.get(upperSymbol);
  if (existing) return existing;

  // Tagged so callers can tell a genuine symbol-resolution failure (an
  // upstream provider problem, worth a 502) from every other error they used
  // to relabel as one -- a stale watchlistId, a missing sourceId (BUG 12).
  let profile;
  try {
    profile = await yahoo.getProfile(upperSymbol);
  } catch (err) {
    err.code = "SYMBOL_LOOKUP_FAILED";
    err.symbol = upperSymbol;
    throw err;
  }

  const resolvedExchangeCode = normalizeExchangeCode(profile.exchange);
  if (!exchangeId && resolvedExchangeCode) {
    exchangeId = resolveExchangeId(resolvedExchangeCode);
  }

  return insertSecurity.get({
    symbol: upperSymbol,
    exchangeId,
    name: profile.name,
    currency: profile.currency,
    sector: profile.sector,
    industry: profile.industry,
    logoUrl: profile.logoUrl,
    description: profile.description,
    dataSource: "yahoo",
  });
}

const upsertQuote = db.prepare(`
  INSERT INTO quotes_cache (security_id, last_price, prev_close, open_price, day_high, day_low, volume, as_of, source, fetched_at)
  VALUES (@securityId, @price, @prevClose, @open, @dayHigh, @dayLow, @volume, @asOf, @source, datetime('now'))
  ON CONFLICT(security_id) DO UPDATE SET
    last_price = excluded.last_price,
    prev_close = excluded.prev_close,
    open_price = excluded.open_price,
    day_high = excluded.day_high,
    day_low = excluded.day_low,
    volume = excluded.volume,
    as_of = excluded.as_of,
    source = excluded.source,
    fetched_at = excluded.fetched_at
`);

/**
 * Refreshes quotes_cache for one security. Defaults to Yahoo (free, no
 * budget concerns for a personal watchlist-sized ticker list); pass
 * `{ provider: 'finnhub' }` for a true real-time top-up on something you're
 * actively watching right now.
 * @param {number} securityId
 * @param {string} symbol
 * @param {{provider?: 'yahoo'|'finnhub'}} opts
 */
export async function refreshQuote(securityId, symbol, opts = {}) {
  const provider = PROVIDERS[opts.provider ?? "yahoo"];
  const quote = await provider.getQuote(symbol);
  upsertQuote.run({
    securityId,
    price: quote.price,
    prevClose: quote.prevClose,
    open: quote.open,
    dayHigh: quote.dayHigh,
    dayLow: quote.dayLow,
    volume: quote.volume,
    asOf: quote.asOf,
    source: opts.provider ?? "yahoo",
  });
  return quote;
}

const insertHistorical = db.prepare(`
  INSERT OR IGNORE INTO historical_prices (security_id, date, open, high, low, close, adj_close, volume, source)
  VALUES (@securityId, @date, @open, @high, @low, @close, @adjClose, @volume, 'yahoo')
`);

const getLastBarDate = db.prepare(
  "SELECT MAX(date) AS last_date, COUNT(*) AS bar_count FROM historical_prices WHERE security_id = ?",
);

/**
 * How far back a security's stored history currently goes.
 * @returns {{lastDate: string|null, barCount: number}}
 */
export function getHistoryCoverage(securityId) {
  const row = getLastBarDate.get(securityId);
  return { lastDate: row?.last_date ?? null, barCount: row?.bar_count ?? 0 };
}

/**
 * Backfills daily OHLCV history for charting/backtesting. Idempotent --
 * relies on the UNIQUE(security_id, date) constraint, so re-running it just
 * fills in gaps instead of duplicating rows.
 */
export async function backfillHistorical(securityId, symbol, range = {}) {
  const rows = await yahoo.getHistorical(symbol, range);
  withTransaction(() => {
    for (const row of rows) insertHistorical.run({ securityId, ...row });
  });
  return rows.length;
}

const insertDividend = db.prepare(`
  INSERT OR IGNORE INTO dividends (security_id, ex_date, amount, source)
  VALUES (@securityId, @exDate, @amount, 'yahoo')
`);
const insertSplit = db.prepare(`
  INSERT OR IGNORE INTO splits (security_id, split_date, ratio, source)
  VALUES (@securityId, @splitDate, @ratio, 'yahoo')
`);

/**
 * @returns {{dividendCount: number, splitCount: number, newSplits: Array<{splitDate: string, ratio: string}>}}
 *   `newSplits` is the subset that was ACTUALLY new (not already in the
 *   `splits` cache table) -- `INSERT OR IGNORE` plus `UNIQUE(security_id,
 *   split_date)` means re-running this over the same range is safe to check
 *   against, so callers can trigger split-adjustment logic exactly once per
 *   real split event rather than every time this function happens to run.
 */
export async function backfillDividendsSplits(securityId, symbol, range = {}) {
  const { dividends, splits } = await yahoo.getDividendsAndSplits(symbol, range);
  const newSplits = [];
  withTransaction(() => {
    for (const d of dividends) insertDividend.run({ securityId, ...d });
    for (const s of splits) {
      const result = insertSplit.run({ securityId, ...s });
      if (result.changes > 0) newSplits.push(s);
    }
  });
  return { dividendCount: dividends.length, splitCount: splits.length, newSplits };
}
