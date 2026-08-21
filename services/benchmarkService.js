// Benchmark: what the market did over the same days you were holding.
//
// The problem this exists to solve. "This source returned 8%" cannot be
// judged without "the market did 11% over the same holding period." Across
// different periods the comparison is worse than useless: a mediocre source
// measured through a bull run beats a good one measured through chop, and
// ranking sources on raw return would systematically reward whoever happened
// to be active in the better months. Since ranking sources is the entire point
// of this app, that confound has to be removed before any source table means
// anything at all.
//
// The measure is per ROUND TRIP, matched day for day. For each closed lot:
// what the trade returned, and what the benchmark returned between the same
// two dates. The difference is the part attributable to the idea rather than
// to the weather.
import db from "../lib/db.js";
import { getGeneralSettings } from "./settingsService.js";
import { TRANSFER_OUT_REASON } from "../lib/constants.js";

/**
 * The benchmark ticker.
 *
 * Configurable because the right yardstick depends on what is being measured
 * -- SPY for broad equity, QQQ if the ideas are all large-cap tech -- and
 * because a hard-coded one would quietly misrepresent a portfolio it does not
 * resemble.
 */
export function benchmarkSymbol() {
  const configured = getGeneralSettings().benchmark_symbol;
  return (configured || "SPY").trim().toUpperCase();
}

const securityBySymbol = db.prepare("SELECT id, symbol FROM securities WHERE symbol = ?");

// Closes on or before a date, nearest first. Markets shut at weekends and on
// holidays, so an exact-date lookup would return nothing for a trade dated a
// Saturday -- and a missing benchmark silently drops the round trip from the
// comparison. Walking backwards to the last session on or before the date is
// what a person means by "what was it worth then".
const closeOnOrBefore = db.prepare(`
  SELECT date, close FROM historical_prices
  WHERE security_id = @securityId AND date <= @date
  ORDER BY date DESC
  LIMIT 1
`);

const historyCoverage = db.prepare(`
  SELECT COUNT(*) AS bars, MIN(date) AS first_date, MAX(date) AS last_date
  FROM historical_prices WHERE security_id = ?
`);

/**
 * What the benchmark returned between two dates, as a fraction.
 *
 * @returns {number|null} null when the history does not cover the window.
 *   Null rather than zero on purpose: "the benchmark did nothing" and "we do
 *   not know what the benchmark did" are opposite claims, and averaging the
 *   second in as the first would drag every comparison towards flattering.
 */
export function benchmarkReturn(from, to, { securityId } = {}) {
  const id = securityId ?? securityBySymbol.get(benchmarkSymbol())?.id;
  if (id == null) return null;

  const start = closeOnOrBefore.get({ securityId: id, date: from });
  const end = closeOnOrBefore.get({ securityId: id, date: to });
  if (!start || !end) return null;
  if (!(start.close > 0)) return null;
  // Both dates resolved to the same session -- a same-day round trip, or a
  // window entirely inside one weekend. There is no measurable market move to
  // compare against, which is not the same as a move of zero.
  if (start.date === end.date) return null;

  return (end.close - start.close) / start.close;
}

/** Whether there is enough history to compare against, and what is there. */
export function benchmarkCoverage() {
  const symbol = benchmarkSymbol();
  const security = securityBySymbol.get(symbol);
  if (!security) {
    return { symbol, securityId: null, bars: 0, firstDate: null, lastDate: null, usable: false };
  }
  const c = historyCoverage.get(security.id);
  return {
    symbol,
    securityId: security.id,
    bars: c.bars,
    firstDate: c.first_date,
    lastDate: c.last_date,
    usable: c.bars > 1,
  };
}

// Every closed round trip: a SELL joined to the BUY it drew from.
//
// TWO THINGS HERE ARE NOT OBVIOUS, and getting either wrong produces a
// plausible number rather than an error.
//
// First, a transfer out is a SELL for lot accounting and nothing else. The
// shares move to another account; there are no proceeds and no gain. Six such
// rows from one Fidelity close-out fabricated -$20,950 of "loss" when this app
// first computed realized P&L, and the identical mistake made here produced
// -$16,502 against a true +$4,448 -- the same ~$21k, in the same direction,
// which reads as a bad year rather than a bug. computeRealizedPnl already
// excludes them; so must this.
//
// Second, the SELL row carries its OWN cost_basis, set at sell time to the
// cost of exactly the shares sold. Re-deriving it from the parent lot is not
// merely redundant: after a split the lot's quantity is rescaled while its
// cost_basis deliberately is not, so a per-share cost computed from the buy
// drifts from what the sale actually gave up.
const roundTripsQuery = db.prepare(`
  SELECT
    sell.id                AS sell_id,
    sell.transaction_date  AS sell_date,
    sell.price             AS sell_price,
    sell.quantity          AS quantity,
    sell.fees              AS sell_fees,
    sell.cost_basis        AS sold_cost_basis,
    sell.is_paper_trade,
    buy.id                 AS buy_id,
    buy.transaction_date   AS buy_date,
    s.symbol,
    -- Attribution follows the SELL where it has one and falls back to the
    -- BUY's, because a sale inherits its lot's thesis when nothing overrides.
    COALESCE(sell.source_id, buy.source_id)     AS source_id,
    COALESCE(sellsrc.name, buysrc.name)         AS source_name,
    COALESCE(sell.strategy_id, buy.strategy_id) AS strategy_id,
    COALESCE(sellstrat.title, buystrat.title)   AS strategy_title,
    COALESCE(sell.plan_id, buy.plan_id)         AS plan_id
  FROM transactions sell
  JOIN transactions buy          ON buy.id = sell.linked_buy_id
  JOIN securities s              ON s.id = sell.security_id
  LEFT JOIN advice_sources sellsrc  ON sellsrc.id = sell.source_id
  LEFT JOIN advice_sources buysrc   ON buysrc.id = buy.source_id
  LEFT JOIN strategies sellstrat    ON sellstrat.id = sell.strategy_id
  LEFT JOIN strategies buystrat     ON buystrat.id = buy.strategy_id
  WHERE sell.holder_id = @holderId
    AND sell.transaction_type = 'SELL'
    AND sell.voided_at IS NULL
    AND buy.voided_at IS NULL
    AND (sell.review_reason IS NULL OR sell.review_reason <> @transferOut)
  ORDER BY sell.transaction_date DESC, sell.id DESC
`);

/** Days between two ISO dates. */
function daysBetween(from, to) {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Scores one round trip against the benchmark over the same days.
 *
 * Exported for testing: every rule here can be got subtly wrong in a way that
 * still yields a plausible percentage, which is the failure mode this project
 * keeps meeting.
 */
export function scoreRoundTrip(row, benchmarkFn) {
  // The cost of exactly these shares, as recorded on the sale itself, and the
  // proceeds net of fees. Identical to what computeRealizedPnl does, on
  // purpose: two different realized-P&L formulas in one codebase is how a
  // report ends up quietly disagreeing with the portfolio strip.
  const cost = row.sold_cost_basis ?? null;
  const proceeds = row.quantity * row.sell_price - (row.sell_fees ?? 0);
  const realizedPnl = cost == null ? null : proceeds - cost;

  const tradeReturn = cost != null && cost > 0 ? realizedPnl / cost : null;
  const costPerShare = cost != null && row.quantity > 0 ? cost / row.quantity : null;

  const marketReturn = benchmarkFn(row.buy_date, row.sell_date);

  return {
    sellId: row.sell_id,
    buyId: row.buy_id,
    symbol: row.symbol,
    buyDate: row.buy_date,
    sellDate: row.sell_date,
    heldDays: daysBetween(row.buy_date, row.sell_date),
    quantity: row.quantity,
    costPerShare,
    sellPrice: row.sell_price,
    isPaperTrade: !!row.is_paper_trade,
    sourceId: row.source_id,
    sourceName: row.source_name,
    strategyId: row.strategy_id,
    strategyTitle: row.strategy_title,
    planId: row.plan_id,
    realizedPnl,
    tradeReturn,
    marketReturn,
    // The number the app exists to produce: return minus what simply holding
    // the market over the identical days would have given. Null the moment
    // either half is unknown -- an excess return computed against a missing
    // benchmark is just the raw return wearing a more authoritative label.
    excessReturn: tradeReturn != null && marketReturn != null ? tradeReturn - marketReturn : null,
  };
}

/** Aggregates scored round trips. Every figure carries its own N. */
function aggregate(trips) {
  const withReturn = trips.filter((t) => t.tradeReturn != null);
  const withExcess = trips.filter((t) => t.excessReturn != null);
  const mean = (rows, key) =>
    rows.length ? rows.reduce((sum, r) => sum + r[key], 0) / rows.length : null;

  return {
    trips: trips.length,
    // Round trips whose benchmark window could not be resolved. Reported
    // rather than hidden: if this is most of them, the comparison below is
    // built on a handful of trades and the reader needs to know that.
    unbenchmarked: trips.length - withExcess.length,
    scoredTrips: withReturn.length,
    benchmarkedTrips: withExcess.length,
    realizedPnl: withReturn.length
      ? withReturn.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0)
      : null,
    // These three are ALL computed over the benchmarked subset so that they
    // reconcile: return minus market equals excess, exactly. Averaged over
    // different denominators they do not subtract, and three figures shown
    // side by side that fail to subtract will be tried by any reader and will
    // destroy their trust in the whole table. That is what this did first:
    // +0.76% return, +0.43% market, +0.08% excess.
    averageReturn: mean(withExcess, "tradeReturn"),
    averageMarketReturn: mean(withExcess, "marketReturn"),
    averageExcessReturn: mean(withExcess, "excessReturn"),
    // The average over EVERY scored round trip, including those with no
    // benchmark window. Kept separate and labelled rather than folded in,
    // because it answers a different question and is on a different sample.
    averageReturnAllTrips: mean(withReturn, "tradeReturn"),
    beatMarketCount: withExcess.length ? withExcess.filter((t) => t.excessReturn > 0).length : null,
    beatMarketRate: withExcess.length
      ? withExcess.filter((t) => t.excessReturn > 0).length / withExcess.length
      : null,
    averageHeldDays: mean(
      trips.filter((t) => t.heldDays != null),
      "heldDays",
    ),
  };
}

function groupBy(trips, keyFn, labelFn) {
  const groups = new Map();
  for (const t of trips) {
    const key = keyFn(t) ?? 0;
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(t), trips: [] });
    groups.get(key).trips.push(t);
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, label: g.label, ...aggregate(g.trips) }))
    .sort((a, b) => b.trips - a.trips);
}

/**
 * Source and strategy performance against the market over matched days.
 *
 * @param {number} holderId
 * @param {{isPaperTrade?: boolean|null, limit?: number}} [opts]
 */
export function benchmarkReport(holderId, { isPaperTrade = null, limit = 500 } = {}) {
  const coverage = benchmarkCoverage();
  // Resolved once and closed over, so a report covering hundreds of round
  // trips does not re-read the setting and re-look-up the security per row.
  const fn = coverage.usable
    ? (from, to) => benchmarkReturn(from, to, { securityId: coverage.securityId })
    : () => null;

  const trips = roundTripsQuery
    .all({ holderId, transferOut: TRANSFER_OUT_REASON })
    .map((row) => scoreRoundTrip(row, fn))
    .filter((t) => isPaperTrade == null || t.isPaperTrade === isPaperTrade);

  return {
    benchmark: coverage,
    overall: aggregate(trips),
    bySource: groupBy(trips, (t) => t.sourceId, (t) => t.sourceName ?? "No source"),
    byStrategy: groupBy(trips, (t) => t.strategyId, (t) => t.strategyTitle ?? "No strategy"),
    // Capped for payload size. The aggregates above are computed over ALL
    // round trips, not just these -- the cap affects the evidence list only,
    // and says so rather than quietly truncating.
    trips: trips.slice(0, limit),
    tripsTruncated: Math.max(0, trips.length - limit),
  };
}
