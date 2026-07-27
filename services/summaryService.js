// A single compact snapshot of "how are things", shaped for an ambient
// display rather than for the app's own UI.
//
// Built for Prime_Dashboard (see ai_orchestrator/projects/prime-dashboard.md):
// a Claude Agent SDK service on the Orchestrator NUC serves an always-on TV
// page, and portfolio state is one of its data sources. That consumer wants a
// handful of headline numbers it can poll cheaply -- not the full per-lot
// payload `/api/positions` returns.
//
// Deliberately read-only and stored-data-only: no provider calls, so polling
// this can never burn API budget or block on a slow upstream.
import db from "../lib/db.js";
import { listOpenPositions, getPortfolioSummary } from "./transactionsService.js";

const activeAlertCount = db.prepare(`
  SELECT COUNT(*) AS n FROM watched_items
  WHERE holder_id = ? AND status = 'ALERT'
`);

const recentAlerts = db.prepare(`
  SELECT a.triggered_at, a.trigger_price, a.message, s.symbol
  FROM alerts a
  JOIN watched_items w ON w.id = a.watched_item_id
  JOIN securities s ON s.id = w.security_id
  WHERE w.holder_id = ? AND a.acknowledged_at IS NULL
  ORDER BY a.triggered_at DESC
  LIMIT ?
`);

const watchedCount = db.prepare(`
  SELECT COUNT(*) AS n FROM watched_items
  WHERE holder_id = ? AND status IN ('WATCHING','ALERT')
`);

const quoteFreshness = db.prepare(`
  SELECT MIN(q.fetched_at) AS oldest, MAX(q.fetched_at) AS newest
  FROM quotes_cache q
  WHERE q.security_id IN (
    SELECT security_id FROM transactions
    WHERE holder_id = ? AND transaction_type = 'BUY' AND quantity_remaining > 0
    UNION
    SELECT security_id FROM watched_items
    WHERE holder_id = ? AND status IN ('WATCHING','ALERT')
  )
`);

/**
 * @param {number} holderId
 * @param {{moverLimit?: number, alertLimit?: number}} opts
 */
export function getDashboardSummary(holderId, opts = {}) {
  const moverLimit = opts.moverLimit ?? 5;
  const alertLimit = opts.alertLimit ?? 5;

  const positions = listOpenPositions(holderId);
  const portfolio = getPortfolioSummary(holderId);

  // Roll lots up to one entry per ticker -- a display shows "NVDA", not
  // "NVDA lot 1, NVDA lot 2".
  const byTicker = new Map();
  for (const p of positions) {
    const existing = byTicker.get(p.symbol) ?? {
      symbol: p.symbol,
      name: p.security_name,
      lastPrice: p.last_price,
      prevClose: p.prev_close,
      shares: 0,
      marketValue: 0,
      costBasis: 0,
      unrealizedPnl: 0,
    };
    existing.shares += p.quantity_remaining;
    existing.marketValue += p.market_value ?? 0;
    existing.costBasis += p.cost_basis;
    existing.unrealizedPnl += p.unrealized_pnl ?? 0;
    byTicker.set(p.symbol, existing);
  }

  // Today's move: what changed since yesterday's close, which is the number
  // an ambient display is usually asking for. Distinct from unrealized P&L,
  // which is measured against what you paid.
  let dayChange = 0;
  let dayChangeBase = 0;
  const tickers = [...byTicker.values()].map((t) => {
    const hasQuote = t.lastPrice != null && t.prevClose != null && t.prevClose !== 0;
    const perShare = hasQuote ? t.lastPrice - t.prevClose : null;
    const tickerDayChange = perShare != null ? perShare * t.shares : null;
    if (tickerDayChange != null) {
      dayChange += tickerDayChange;
      dayChangeBase += t.prevClose * t.shares;
    }
    return {
      ...t,
      dayChange: tickerDayChange,
      dayChangePercent: hasQuote ? (perShare / t.prevClose) * 100 : null,
      unrealizedPnlPercent: t.costBasis > 0 ? (t.unrealizedPnl / t.costBasis) * 100 : null,
    };
  });

  // Biggest absolute percentage moves first, so a big drop is as visible as
  // a big gain -- an ambient display shouldn't bury bad news.
  const topMovers = tickers
    .filter((t) => t.dayChangePercent != null)
    .sort((a, b) => Math.abs(b.dayChangePercent) - Math.abs(a.dayChangePercent))
    .slice(0, moverLimit);

  const freshness = quoteFreshness.get(holderId, holderId) ?? {};

  return {
    asOf: new Date().toISOString(),
    portfolio: {
      positionCount: portfolio.positionCount,
      tickerCount: byTicker.size,
      totalCost: portfolio.totalCost,
      totalValue: portfolio.totalValue,
      unrealizedPnl: portfolio.unrealizedPnl,
      unrealizedPnlPercent: portfolio.unrealizedPnlPercent,
      realizedPnl: portfolio.realizedPnl,
      dividendIncome: portfolio.dividendIncome,
      totalReturn: portfolio.totalReturn,
      dayChange: dayChangeBase > 0 ? dayChange : null,
      dayChangePercent: dayChangeBase > 0 ? (dayChange / dayChangeBase) * 100 : null,
    },
    topMovers,
    alerts: {
      activeCount: activeAlertCount.get(holderId)?.n ?? 0,
      unacknowledged: recentAlerts.all(holderId, alertLimit),
    },
    watchlist: { activeCount: watchedCount.get(holderId)?.n ?? 0 },
    // Lets a consumer show "prices as of ..." or grey out when stale, rather
    // than presenting old numbers as if they were live.
    quotes: {
      oldestFetchedAt: freshness.oldest ?? null,
      newestFetchedAt: freshness.newest ?? null,
    },
  };
}
