// Everything the Dashboard's expanded card view needs about one ticker.
// Reads only from what's already stored -- no live provider calls -- so
// opening a card is instant and costs nothing. Freshness comes from the
// existing Refresh Prices / Refresh History actions.
import db from "../lib/db.js";

const getSecurityBySymbol = db.prepare(`
  SELECT s.*, e.code AS exchange_code, e.name AS exchange_name,
         q.last_price, q.prev_close, q.open_price, q.day_high, q.day_low,
         q.volume, q.as_of AS quote_as_of, q.source AS quote_source,
         q.fetched_at AS quote_fetched_at
  FROM securities s
  LEFT JOIN exchanges e ON e.id = s.exchange_id
  LEFT JOIN quotes_cache q ON q.security_id = s.id
  WHERE s.symbol = ?
`);

const getPriceSeries = db.prepare(`
  SELECT date, close, high, low, volume
  FROM historical_prices
  WHERE security_id = ? AND date >= ?
  ORDER BY date
`);

const getRangeStats = db.prepare(`
  SELECT MIN(low) AS low_52w, MAX(high) AS high_52w, COUNT(*) AS bar_count,
         MIN(date) AS first_date, MAX(date) AS last_date
  FROM historical_prices
  WHERE security_id = ? AND date >= ?
`);

const getLotsForSymbol = db.prepare(`
  SELECT t.id AS lot_id, t.transaction_date, t.quantity, t.quantity_remaining,
         t.price AS entry_price, t.cost_basis, t.fees, t.notes,
         src.name AS source_name
  FROM transactions t
  LEFT JOIN advice_sources src ON src.id = t.source_id
  WHERE t.holder_id = ? AND t.security_id = ?
    AND t.transaction_type = 'BUY' AND t.quantity_remaining > 0 AND t.voided_at IS NULL
  ORDER BY t.transaction_date
`);

const getTradeHistoryForSymbol = db.prepare(`
  SELECT t.id, t.transaction_type, t.transaction_date, t.quantity, t.price,
         t.fees, t.cost_basis, t.linked_buy_id, src.name AS source_name
  FROM transactions t
  LEFT JOIN advice_sources src ON src.id = t.source_id
  WHERE t.holder_id = ? AND t.security_id = ? AND t.voided_at IS NULL
  ORDER BY t.transaction_date DESC, t.id DESC
`);

const getWatchedForSymbol = db.prepare(`
  SELECT w.id, w.order_type, w.status, w.buy_price_high, w.take_profit_low,
         w.notes, wl.name AS watchlist_name
  FROM watched_items w
  JOIN watchlists wl ON wl.id = w.watchlist_id
  WHERE w.holder_id = ? AND w.security_id = ?
    AND w.status IN ('WATCHING','ALERT')
`);

const getDividendsForSecurity = db.prepare(`
  SELECT ex_date, amount FROM dividends
  WHERE security_id = ? ORDER BY ex_date DESC LIMIT 8
`);

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * @param {number} holderId
 * @param {string} symbol
 * @param {{seriesDays?: number}} opts how much price history to return for the chart
 * @returns {object|null} null if the ticker isn't known to the app at all
 */
export function getTickerDetail(holderId, symbol, opts = {}) {
  const upper = String(symbol || "").trim().toUpperCase();
  const security = getSecurityBySymbol.get(upper);
  if (!security) return null;

  const seriesDays = opts.seriesDays ?? 180;
  const series = getPriceSeries.all(security.id, isoDaysAgo(seriesDays));
  const range = getRangeStats.get(security.id, isoDaysAgo(365));

  const lots = getLotsForSymbol.all(holderId, security.id).map((lot) => {
    const costPerShare = lot.cost_basis / lot.quantity;
    const costBasis = costPerShare * lot.quantity_remaining;
    const marketValue =
      security.last_price != null ? security.last_price * lot.quantity_remaining : null;
    return {
      ...lot,
      cost_per_share: costPerShare,
      remaining_cost_basis: costBasis,
      market_value: marketValue,
      unrealized_pnl: marketValue != null ? marketValue - costBasis : null,
    };
  });

  const trades = getTradeHistoryForSymbol.all(holderId, security.id).map((t) => ({
    ...t,
    realized_pnl:
      t.transaction_type === "SELL"
        ? t.quantity * t.price - (t.fees || 0) - (t.cost_basis ?? 0)
        : null,
  }));

  const totalShares = lots.reduce((sum, l) => sum + l.quantity_remaining, 0);
  const totalCost = lots.reduce((sum, l) => sum + l.remaining_cost_basis, 0);
  const totalValue = security.last_price != null ? security.last_price * totalShares : null;

  // Where the current price sits inside the 52-week range, 0..100. Handy as a
  // one-glance "is this near its highs or lows" signal on the card.
  let rangePosition = null;
  if (
    security.last_price != null &&
    range?.low_52w != null &&
    range?.high_52w != null &&
    range.high_52w > range.low_52w
  ) {
    rangePosition =
      ((security.last_price - range.low_52w) / (range.high_52w - range.low_52w)) * 100;
  }

  return {
    security: {
      id: security.id,
      symbol: security.symbol,
      name: security.name,
      sector: security.sector,
      industry: security.industry,
      currency: security.currency,
      description: security.description,
      logo_url: security.logo_url,
      exchange_code: security.exchange_code,
      exchange_name: security.exchange_name,
    },
    quote: {
      last_price: security.last_price,
      prev_close: security.prev_close,
      open_price: security.open_price,
      day_high: security.day_high,
      day_low: security.day_low,
      volume: security.volume,
      as_of: security.quote_as_of,
      source: security.quote_source,
      fetched_at: security.quote_fetched_at,
      change:
        security.last_price != null && security.prev_close != null
          ? security.last_price - security.prev_close
          : null,
      change_percent:
        security.last_price != null && security.prev_close != null && security.prev_close !== 0
          ? ((security.last_price - security.prev_close) / security.prev_close) * 100
          : null,
    },
    range: {
      low_52w: range?.low_52w ?? null,
      high_52w: range?.high_52w ?? null,
      position_percent: rangePosition,
      bar_count: range?.bar_count ?? 0,
      first_date: range?.first_date ?? null,
      last_date: range?.last_date ?? null,
    },
    series,
    position: {
      total_shares: totalShares,
      total_cost: totalCost,
      total_value: totalValue,
      unrealized_pnl: totalValue != null ? totalValue - totalCost : null,
      unrealized_pnl_percent:
        totalValue != null && totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null,
      lots,
    },
    trades,
    watchedItems: getWatchedForSymbol.all(holderId, security.id),
    dividends: getDividendsForSecurity.all(security.id),
  };
}
