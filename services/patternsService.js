// Patterns in your own trading, from your own ledger.
//
// This exists because of an accident. A research brief on KTOS mentioned in
// passing that there had been seven sells in 2026, every one at a loss,
// stepping down from $94.31 to $48.90, with no plan on record. Nothing in the
// app had ever said that, and nothing would have: the Orders tab shows what is
// held, the history shows what was done, and neither answers "what do I keep
// doing".
//
// Joe: "seeing patterns like that is what this is all about."
//
// So these are detectors over the trade ledger, and the rule they all follow
// is the one the rest of the app follows: STATE THE FACT, RECOMMEND NOTHING.
// "Your average loss is 19% larger than your average win" is arithmetic about
// what happened. "You should cut losses sooner" is advice, and this app has
// never given any. Every finding carries the evidence it was computed from so
// it can be checked rather than believed.
import db from "../lib/db.js";
import { listTransactions } from "./transactionsService.js";

/** Mean of an array, or null when there is nothing to average. */
function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Every closed sale with a realized figure, which is what all of this reads. */
function closedSales(holderId, { isPaperTrade = false } = {}) {
  return listTransactions(holderId, { isPaperTrade, type: "SELL" }).filter(
    (s) => !s.voided_at && s.realized_pnl != null,
  );
}

/**
 * Tickers sold at a loss again and again.
 *
 * The KTOS finding, generalised. One loss is a trade; seven in the same name is
 * a habit, and the ledger knows which is which while a human scrolling a
 * transaction list does not.
 *
 * Requires four or more sales so a single bad week cannot qualify, and 70% of
 * them at a loss so a name that was mostly profitable does not appear because
 * it ended badly.
 */
export function repeatedLosses(sales, { minSales = 4, lossRate = 0.7 } = {}) {
  const bySymbol = new Map();
  for (const s of sales) {
    if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, []);
    bySymbol.get(s.symbol).push(s);
  }

  return [...bySymbol.entries()]
    .map(([symbol, ss]) => {
      const losses = ss.filter((s) => s.realized_pnl < 0);
      return {
        symbol,
        sales: ss.length,
        losses: losses.length,
        lossRate: losses.length / ss.length,
        net: ss.reduce((a, s) => a + s.realized_pnl, 0),
        worst: Math.min(...ss.map((s) => s.realized_pnl)),
        first: ss.map((s) => s.transaction_date).sort()[0],
        last: ss.map((s) => s.transaction_date).sort().at(-1),
      };
    })
    .filter((r) => r.sales >= minSales && r.lossRate >= lossRate && r.net < 0)
    .sort((a, b) => a.net - b.net);
}

/**
 * How often you win, against how much you win when you do.
 *
 * These two numbers are only meaningful together. A 57% win rate sounds like an
 * edge until the average loss turns out to be larger than the average win, at
 * which point the edge is thinner than the hit rate suggests -- and the
 * arithmetic that matters is the product, not either half.
 */
export function winLossShape(sales) {
  const wins = sales.filter((s) => s.realized_pnl > 0).map((s) => s.realized_pnl);
  const losses = sales.filter((s) => s.realized_pnl < 0).map((s) => s.realized_pnl);
  if (wins.length + losses.length === 0) return null;

  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  const winRate = wins.length / (wins.length + losses.length);

  return {
    trades: wins.length + losses.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgWin,
    avgLoss,
    // Average win over average loss. Above 1 means wins are bigger; below 1
    // means losses are. Null rather than Infinity when there are no losses --
    // a ratio against nothing is not a ratio.
    payoffRatio: avgLoss != null && avgLoss !== 0 ? avgWin / Math.abs(avgLoss) : null,
    // What the two combine to per trade. This is the figure that decides
    // whether the pair is a profit, and neither half tells you on its own.
    expectancy:
      avgWin != null && avgLoss != null
        ? winRate * avgWin + (1 - winRate) * avgLoss
        : null,
    grossWins: wins.reduce((a, b) => a + b, 0),
    grossLosses: losses.reduce((a, b) => a + b, 0),
  };
}

/**
 * Whether winners and losers are held for different lengths of time.
 *
 * The textbook expectation is that people hold losers too long and cut winners
 * too early. It is worth COMPUTING rather than assuming, because a ledger that
 * contradicts the textbook is a more interesting finding than one that
 * confirms it, and either way the number belongs to this trader rather than to
 * a study of other people.
 */
export function holdingPeriods(sales) {
  const held = sales
    .filter((s) => s.linked_buy_date)
    .map((s) => ({
      days: Math.round(
        (Date.parse(`${s.transaction_date}T00:00:00Z`) -
          Date.parse(`${s.linked_buy_date}T00:00:00Z`)) /
          86400000,
      ),
      win: s.realized_pnl > 0,
    }))
    .filter((h) => Number.isFinite(h.days) && h.days >= 0);

  const winners = held.filter((h) => h.win).map((h) => h.days);
  const losers = held.filter((h) => !h.win).map((h) => h.days);
  if (winners.length === 0 || losers.length === 0) return null;

  const avgWinner = mean(winners);
  const avgLoser = mean(losers);

  return {
    winnerCount: winners.length,
    loserCount: losers.length,
    avgWinnerDays: avgWinner,
    avgLoserDays: avgLoser,
    // Positive: losers held longer than winners, the textbook pattern.
    // Negative: the opposite, which is what this ledger actually shows.
    differenceDays: avgLoser - avgWinner,
  };
}

/**
 * Positions opened and closed on the same day.
 *
 * Counted because it is a distinct activity from holding something, and mixing
 * the two hides both. Reported with its net result rather than as a count
 * alone: same-day trading being profitable and same-day trading being costly
 * are opposite findings and the number is the only thing that separates them.
 */
export function sameDayTrades(sales) {
  const same = sales.filter((s) => s.linked_buy_date === s.transaction_date);
  if (same.length === 0) return null;
  return {
    count: same.length,
    net: same.reduce((a, s) => a + s.realized_pnl, 0),
    wins: same.filter((s) => s.realized_pnl > 0).length,
    shareOfAllSales: same.length / sales.length,
    symbols: [...new Set(same.map((s) => s.symbol))].sort(),
  };
}

const unplannedStmt = db.prepare(`
  SELECT s.symbol, COUNT(*) AS lots, SUM(t.cost_basis) AS cost
  FROM transactions t
  JOIN securities s ON s.id = t.security_id
  WHERE t.holder_id = @holderId
    AND t.transaction_type = 'BUY'
    AND t.quantity_remaining > 0
    AND t.voided_at IS NULL
    AND t.is_paper_trade = @isPaperTrade
    AND t.plan_id IS NULL
  GROUP BY s.symbol
  ORDER BY cost DESC
`);

/**
 * Open positions with no plan attached.
 *
 * Not a criticism -- a trade can exist without a plan by explicit design, and
 * Joe said so. It is here because the app cannot measure what it was not told,
 * and every one of these is a position whose exit will be unmeasurable against
 * an intention that was never written down.
 */
export function unplannedPositions(holderId, { isPaperTrade = false } = {}) {
  const rows = unplannedStmt.all({ holderId, isPaperTrade: isPaperTrade ? 1 : 0 });
  return {
    symbols: rows.length,
    lots: rows.reduce((a, r) => a + r.lots, 0),
    cost: rows.reduce((a, r) => a + (r.cost ?? 0), 0),
    biggest: rows.slice(0, 5),
  };
}

/**
 * Everything above, over one holder's ledger.
 *
 * @param {number} holderId
 * @param {{isPaperTrade?: boolean}} [opts]
 */
export function patternReport(holderId, { isPaperTrade = false } = {}) {
  const sales = closedSales(holderId, { isPaperTrade });

  return {
    // Carried so every figure below can be read against the sample it came
    // from. A pattern over nine trades and one over five hundred deserve
    // different amounts of belief, and the report should not flatten that.
    sampleSize: sales.length,
    firstSale: sales.length ? sales.map((s) => s.transaction_date).sort()[0] : null,
    lastSale: sales.length ? sales.map((s) => s.transaction_date).sort().at(-1) : null,
    repeatedLosses: repeatedLosses(sales),
    winLoss: winLossShape(sales),
    holdingPeriods: holdingPeriods(sales),
    sameDay: sameDayTrades(sales),
    unplanned: unplannedPositions(holderId, { isPaperTrade }),
  };
}
