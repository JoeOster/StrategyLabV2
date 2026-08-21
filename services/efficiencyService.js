// Execution efficiency: what the plan said, what actually happened, and the
// gap between them.
//
// This is the first thing in the app that is an OUTPUT rather than plumbing,
// and it is the question Joe asked first: a Telegram call says buy at $10, the
// fill is $9.95, the sell signal goes out at $10.75 and gets missed. How well
// is the plan being executed?
//
// It is deliberately NOT "how good is this source". That needs hundreds of
// trades before the noise settles. Execution gap needs a handful, because it
// compares each trade against its OWN stated plan rather than against the
// market -- so it is the report that becomes useful soonest, and the one that
// can be acted on. A source that calls well but is executed badly and a source
// that calls badly look identical in a returns table, and completely different
// here.
//
// Three moments are measurable, and only three:
//
//   ENTRY   a BUY_LIMIT names a ceiling; the fill lands somewhere.
//   EXIT    a rung names a price; the sale lands somewhere.
//   SKIPPED a rung fired and was declined on judgement. The plan said act.
//
// Everything else -- whether the thesis was any good, whether the market
// cooperated -- is a different question and is not answered here.
import db from "../lib/db.js";

// One sign convention throughout, or the totals are meaningless: POSITIVE
// ALWAYS MEANS BETTER THAN PLANNED. Buying below the ceiling is positive;
// selling above the target is positive. Both mean "you beat your own plan",
// which is the only reading under which a total spanning entries and exits
// means anything at all.
const CONVENTION = "positive means better than the plan";

// The bound the plan actually named. A take-profit says "at or above
// price_low"; a stop says "at or below price_high". Comparing against
// trigger_price instead would measure how quickly the poller noticed, not how
// well the plan was followed.
const PLANNED_PRICE_SQL =
  "CASE e.kind WHEN 'TAKE_PROFIT' THEN e.price_low ELSE e.price_high END";

// LEFT JOIN to the transaction: a rung can fire and be declined, leaving no
// sale and no fill price. Those rows are the point, not noise -- "the plan
// said sell and I did not" is a finding, and dropping it would flatter the
// report by counting only the occasions the plan was followed.
const exitEventsQuery = db.prepare(`
  SELECT
    a.id                AS alert_id,
    a.triggered_at,
    a.trigger_price,
    a.resolution,
    a.decline_kind,
    e.id                AS rung_id,
    e.kind              AS rung_kind,
    e.quantity          AS rung_quantity,
    ${PLANNED_PRICE_SQL} AS planned_price,
    p.id                AS plan_id,
    p.status            AS plan_status,
    s.symbol,
    src.id              AS source_id,
    src.name            AS source_name,
    strat.id            AS strategy_id,
    strat.title         AS strategy_title,
    t.id                AS transaction_id,
    t.price             AS actual_price,
    t.quantity          AS actual_quantity,
    t.transaction_date  AS actual_date,
    t.is_paper_trade
  FROM alerts a
  JOIN plan_exits e              ON e.id = a.plan_exit_id
  JOIN plans p                   ON p.id = e.plan_id
  JOIN securities s              ON s.id = p.security_id
  LEFT JOIN advice_sources src   ON src.id = p.source_id
  LEFT JOIN strategies strat     ON strat.id = p.strategy_id
  LEFT JOIN transactions t       ON t.id = a.resulting_transaction_id AND t.voided_at IS NULL
  WHERE p.holder_id = @holderId
    AND a.plan_exit_id IS NOT NULL
  ORDER BY a.triggered_at DESC, a.id DESC
`);

// The link is `transactions.watched_item_id` -- the buy knows which watch it
// came from. A buy with no watch behind it had no stated entry price, so it is
// correctly absent here rather than counted as a zero gap. Counting it would
// dilute the average towards zero with trades that were never measured.
const entryEventsQuery = db.prepare(`
  SELECT
    t.id                AS transaction_id,
    t.transaction_date  AS actual_date,
    t.price             AS actual_price,
    t.quantity          AS actual_quantity,
    t.is_paper_trade,
    w.id                AS watched_item_id,
    w.buy_price_high    AS planned_price,
    w.buy_price_low     AS planned_floor,
    s.symbol,
    src.id              AS source_id,
    src.name            AS source_name,
    strat.id            AS strategy_id,
    strat.title         AS strategy_title
  FROM transactions t
  JOIN watched_items w           ON w.id = t.watched_item_id
  JOIN securities s              ON s.id = t.security_id
  LEFT JOIN advice_sources src   ON src.id = COALESCE(t.source_id, w.source_id)
  LEFT JOIN strategies strat     ON strat.id = t.strategy_id
  WHERE t.holder_id = @holderId
    AND t.transaction_type = 'BUY'
    AND t.voided_at IS NULL
    AND w.order_type = 'BUY_LIMIT'
    AND w.buy_price_high IS NOT NULL
  ORDER BY t.transaction_date DESC, t.id DESC
`);

/** Division that yields null rather than NaN or Infinity. */
function ratio(numerator, denominator) {
  if (numerator == null || denominator == null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  if (Math.abs(denominator) < 1e-12) return null;
  return numerator / denominator;
}

/**
 * One exit rung, scored.
 *
 * `followed` is the discipline question and needs no prices at all, which is
 * why it is kept separate from the gap. A rung declined as 'invalid' does NOT
 * count against discipline: that decline says the rung itself was wrong, not
 * that the plan was ignored. Conflating the two would penalise correcting a
 * mistake, and the decline_kind distinction exists precisely so this report
 * can tell them apart.
 */
export function scoreExit(row) {
  const skipped = row.resolution === "declined" && row.decline_kind === "judgement";
  const followed = row.resolution === "accepted";

  // A gap needs both a stated plan and a fill. A declined rung has no fill,
  // and a rung with no bound on the side it fired from has no stated price.
  const hasGap = followed && row.actual_price != null && row.planned_price != null;

  // Selling: more than planned is better. The convention holds across both
  // rung kinds -- a stop that filled ABOVE its level also beat the plan.
  const gapPerShare = hasGap ? row.actual_price - row.planned_price : null;
  const quantity = row.actual_quantity ?? row.rung_quantity ?? null;

  // The gap above answers Joe's question directly -- the signal said $10.75,
  // what did I actually get -- but on its own it can flatter badly. A
  // take-profit set at $50 while the stock trades at $90 fires the instant it
  // is checked and scores as +80% "better than plan", which is arithmetically
  // true and says nothing about execution. It says the rung was stale.
  //
  // So the gap is decomposed into the two things that actually produced it:
  //
  //   OVERSHOOT  trigger - planned. How far past the level the price already
  //              was when the rung fired. Polling granularity, overnight gaps,
  //              and rungs set behind the market. Not a discipline measure.
  //   SLIPPAGE   actual - trigger. Between being told and acting. THIS is the
  //              part that is actually yours, and the part Joe described:
  //              "the sell signal goes out and I miss it".
  //
  // They sum to the gap exactly, so nothing is hidden by reporting all three.
  // A paper leg has slippage of zero by construction -- alertsService records
  // it at trigger_price -- which is the point: the paper leg is the
  // mechanically-followed baseline the real leg gets measured against.
  const overshootPerShare =
    row.trigger_price != null && row.planned_price != null
      ? row.trigger_price - row.planned_price
      : null;
  const slippagePerShare =
    hasGap && row.trigger_price != null ? row.actual_price - row.trigger_price : null;

  return {
    kind: "EXIT",
    alertId: row.alert_id,
    planId: row.plan_id,
    rungId: row.rung_id,
    rungKind: row.rung_kind,
    symbol: row.symbol,
    sourceId: row.source_id,
    sourceName: row.source_name,
    strategyId: row.strategy_id,
    strategyTitle: row.strategy_title,
    isPaperTrade: !!row.is_paper_trade,
    triggeredAt: row.triggered_at,
    triggerPrice: row.trigger_price,
    plannedPrice: row.planned_price,
    actualPrice: row.actual_price ?? null,
    actualDate: row.actual_date ?? null,
    quantity,
    resolution: row.resolution ?? null,
    declineKind: row.decline_kind ?? null,
    followed,
    skipped,
    // Fired, and nobody has answered it yet. Neither followed nor skipped:
    // defaulting it either way would let an unanswered alert quietly improve
    // or damage the discipline figure depending on which default was picked.
    pending: row.resolution == null,
    gapPerShare,
    gapTotal: hasGap && quantity != null ? gapPerShare * quantity : null,
    gapPercent: hasGap ? ratio(gapPerShare, row.planned_price) : null,
    overshootPerShare,
    overshootTotal:
      overshootPerShare != null && quantity != null ? overshootPerShare * quantity : null,
    slippagePerShare,
    slippageTotal:
      slippagePerShare != null && quantity != null ? slippagePerShare * quantity : null,
    slippagePercent: ratio(slippagePerShare, row.trigger_price),
    // A rung whose level was already far behind the market when it fired was
    // not really a plan being followed. Flagged rather than excluded: dropping
    // the row would hide it, and the whole point is that a stale ladder is
    // something to notice and fix.
    stale:
      overshootPerShare != null &&
      row.planned_price != null &&
      Math.abs(ratio(overshootPerShare, row.planned_price) ?? 0) > 0.05,
    // What the plan asked for and did not get. Notional, not realized: the
    // shares were not sold, so no gain or loss exists yet. This is the size of
    // the decision, not its outcome.
    notionalSkipped:
      skipped && row.planned_price != null ? row.planned_price * (row.rung_quantity ?? 0) : null,
  };
}

/** One entry, scored. Buying BELOW the stated ceiling beats the plan. */
export function scoreEntry(row) {
  const gapPerShare =
    row.actual_price != null && row.planned_price != null
      ? row.planned_price - row.actual_price
      : null;

  // A BUY_LIMIT can name a BAND, not just a ceiling, and the gap above measures
  // only against the ceiling -- so a fill at the floor scores as a large win
  // when it was squarely within what the plan asked for. Reporting whether the
  // fill landed inside the band keeps that distinction available instead of
  // letting a wide band quietly inflate the entry figures.
  //
  // Null when no floor was set, which is most of them: a one-sided limit has no
  // band to be inside or outside of, and false would be a claim.
  const withinPlannedBand =
    row.planned_floor == null || row.actual_price == null
      ? null
      : row.actual_price >= row.planned_floor && row.actual_price <= row.planned_price;

  return {
    kind: "ENTRY",
    transactionId: row.transaction_id,
    watchedItemId: row.watched_item_id,
    symbol: row.symbol,
    sourceId: row.source_id,
    sourceName: row.source_name,
    strategyId: row.strategy_id,
    strategyTitle: row.strategy_title,
    isPaperTrade: !!row.is_paper_trade,
    plannedPrice: row.planned_price,
    plannedFloor: row.planned_floor ?? null,
    withinPlannedBand,
    actualPrice: row.actual_price,
    actualDate: row.actual_date,
    quantity: row.actual_quantity,
    // An entry is followed by definition -- the buy exists because the plan
    // was acted on. The real entry-side discipline question is "did I buy when
    // it triggered", which is about watches that never became trades. That is
    // a different query, and is reported as not-yet-built rather than folded
    // in here as a silent zero.
    followed: true,
    skipped: false,
    pending: false,
    gapPerShare,
    gapTotal: gapPerShare != null ? gapPerShare * row.actual_quantity : null,
    gapPercent: ratio(gapPerShare, row.planned_price),
    // An entry has no alert behind it in this query, so there is no trigger
    // price to split the gap around. Null rather than zero: "not measured" and
    // "measured, and it was nothing" are different claims, and the aggregate
    // below counts only what was genuinely measured.
    overshootPerShare: null,
    overshootTotal: null,
    slippagePerShare: null,
    slippageTotal: null,
    slippagePercent: null,
    stale: false,
    notionalSkipped: null,
  };
}

// Entry alerts: a BUY_LIMIT reached its band. The other half of discipline,
// and the more commonly failed one.
//
// The exit side asks "the signal fired and did I sell well". This asks "the
// signal fired and did I buy AT ALL". Missing an entry leaves no trace
// anywhere else in the app -- there is no position, no P&L row, nothing to
// notice later. An idea that was never acted on and an idea that was never had
// look identical in every other view, which is exactly why this needs its own
// query rather than being inferred.
//
// Accepting an entry alert records intent and nothing more: the trade runs
// through Journal's Execute, which collects a real fill. So "accepted" and
// "bought" are genuinely different states, and the gap between them --
// said yes, never did it -- is worth seeing on its own.
const entryAlertsQuery = db.prepare(`
  SELECT
    a.id                AS alert_id,
    a.triggered_at,
    a.trigger_price,
    a.resolution,
    a.decline_kind,
    w.id                AS watched_item_id,
    w.buy_price_high    AS planned_price,
    w.buy_price_low     AS planned_floor,
    w.is_paper_trade,
    s.symbol,
    src.id              AS source_id,
    src.name            AS source_name,
    strat.id            AS strategy_id,
    strat.title         AS strategy_title,
    -- The earliest buy made against this watch on or after the alert. A buy
    -- BEFORE it belongs to an earlier round and must not count as acting on
    -- this one, or a single old purchase would mark every later alert as
    -- followed.
    (SELECT t.id FROM transactions t
      WHERE t.watched_item_id = w.id AND t.transaction_type = 'BUY'
        AND t.voided_at IS NULL AND t.transaction_date >= date(a.triggered_at)
      ORDER BY t.transaction_date, t.id LIMIT 1) AS bought_id
  FROM alerts a
  JOIN watched_items w           ON w.id = a.watched_item_id
  JOIN securities s              ON s.id = w.security_id
  LEFT JOIN advice_sources src   ON src.id = w.source_id
  LEFT JOIN strategies strat     ON strat.id = w.strategy_id
  WHERE w.holder_id = @holderId
    AND a.watched_item_id IS NOT NULL
    AND a.trigger_reason = 'BUY'
  ORDER BY a.triggered_at DESC, a.id DESC
`);

/**
 * One entry alert, scored for discipline.
 *
 * Deliberately carries no price gap. The gap on a buy that DID happen is
 * already measured by scoreEntry, from the trade itself. Measuring it here too
 * would double-count every executed entry in the totals.
 */
export function scoreEntryAlert(row) {
  const bought = row.bought_id != null;
  const skipped = row.resolution === "declined" && row.decline_kind === "judgement";

  return {
    kind: "ENTRY_ALERT",
    alertId: row.alert_id,
    watchedItemId: row.watched_item_id,
    symbol: row.symbol,
    sourceId: row.source_id,
    sourceName: row.source_name,
    strategyId: row.strategy_id,
    strategyTitle: row.strategy_title,
    isPaperTrade: !!row.is_paper_trade,
    triggeredAt: row.triggered_at,
    triggerPrice: row.trigger_price,
    plannedPrice: row.planned_price,
    plannedFloor: row.planned_floor ?? null,
    actualPrice: null,
    actualDate: null,
    quantity: null,
    resolution: row.resolution ?? null,
    declineKind: row.decline_kind ?? null,
    // Followed means BOUGHT, not "said yes". Accepting an entry alert records
    // intent; the purchase is a separate act, and intent that never became a
    // purchase is the failure this whole query exists to surface.
    followed: bought,
    skipped,
    pending: row.resolution == null,
    // Said yes and never did it. Distinct from declining, which is a decision,
    // and from an unanswered alert, which is not yet one. This is the state
    // that leaves no trace anywhere else in the app.
    acceptedNotBought: row.resolution === "accepted" && !bought,
    gapPerShare: null,
    gapTotal: null,
    gapPercent: null,
    overshootPerShare: null,
    overshootTotal: null,
    slippagePerShare: null,
    slippageTotal: null,
    slippagePercent: null,
    stale: false,
    // What the plan asked to be bought, in dollars, and was not. Notional --
    // no position exists, so there is no gain or loss, only the size of the
    // decision not taken.
    notionalSkipped:
      !bought && (skipped || row.resolution === "accepted") && row.planned_price != null
        ? row.planned_price
        : null,
  };
}

/**
 * Aggregates scored events.
 *
 * Every figure carries its own N. One lucky trade at 100% is not a 100% hit
 * rate, and a report that does not say so invites exactly that reading -- which
 * matters more here than usual, because this report becomes useful at a sample
 * size small enough to be badly misleading.
 */
function aggregate(events) {
  const scored = events.filter((e) => e.gapTotal != null);
  const withPercent = events.filter((e) => e.gapPercent != null);
  // Pending alerts are excluded from the denominator: an unanswered alert is
  // not yet a decision, and counting it as either would be an invention.
  const decided = events.filter((e) => e.followed || e.skipped);
  const followed = decided.filter((e) => e.followed).length;

  const gapTotal = scored.reduce((sum, e) => sum + e.gapTotal, 0);
  const beat = scored.filter((e) => e.gapTotal > 0).length;

  const withSlippage = events.filter((e) => e.slippageTotal != null);
  const slippageTotal = withSlippage.reduce((sum, e) => sum + e.slippageTotal, 0);
  const withOvershoot = events.filter((e) => e.overshootTotal != null);

  return {
    events: events.length,
    scoredEvents: scored.length,
    gapTotal: scored.length ? gapTotal : null,
    gapAverage: scored.length ? gapTotal / scored.length : null,
    // The half of the gap that is actually yours: what happened between the
    // alert firing and the sale being made.
    slippageEvents: withSlippage.length,
    slippageTotal: withSlippage.length ? slippageTotal : null,
    slippageAverage: withSlippage.length ? slippageTotal / withSlippage.length : null,
    // The half that is not: how far past the level the price already was.
    overshootTotal: withOvershoot.length
      ? withOvershoot.reduce((sum, e) => sum + e.overshootTotal, 0)
      : null,
    // Rungs whose level was well behind the market by the time they fired.
    // A high count here means the ladders need maintenance, not that
    // execution is good -- and without it those rungs silently inflate every
    // figure above.
    staleCount: events.filter((e) => e.stale).length,
    gapPercentAverage: withPercent.length
      ? withPercent.reduce((sum, e) => sum + e.gapPercent, 0) / withPercent.length
      : null,
    beatPlanCount: scored.length ? beat : null,
    beatPlanRate: scored.length ? beat / scored.length : null,
    decidedEvents: decided.length,
    followedCount: decided.length ? followed : null,
    followedRate: decided.length ? followed / decided.length : null,
    skippedCount: decided.filter((e) => e.skipped).length,
    // Entry alerts accepted and never acted on. Counted separately from
    // skipped: declining is a decision, this is a decision that evaporated.
    acceptedNotBoughtCount: events.filter((e) => e.acceptedNotBought).length,
    notionalSkipped: events.reduce((sum, e) => sum + (e.notionalSkipped ?? 0), 0),
    pendingCount: events.filter((e) => e.pending).length,
  };
}

/** Groups scored events by a key, aggregating each group. */
function groupBy(events, keyFn, labelFn) {
  const groups = new Map();
  for (const e of events) {
    const key = keyFn(e) ?? 0;
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(e), events: [] });
    groups.get(key).events.push(e);
  }
  return [...groups.values()]
    .map((g) => ({ key: g.key, label: g.label, ...aggregate(g.events) }))
    .sort((a, b) => b.events - a.events);
}

/**
 * The report.
 *
 * @param {number} holderId
 * @param {{isPaperTrade?: boolean|null}} [opts] paper/real filter; null means
 *   both, which is the honest default. Paper and real are the same thing in
 *   this app by explicit decision, and the execution gap is exactly as
 *   meaningful on a paper leg -- arguably more so, since the paper leg follows
 *   the plan mechanically and is therefore the baseline the real leg is being
 *   measured against.
 */
export function efficiencyReport(holderId, { isPaperTrade = null } = {}) {
  const wanted = (e) => isPaperTrade == null || e.isPaperTrade === isPaperTrade;

  const exits = exitEventsQuery.all({ holderId }).map(scoreExit).filter(wanted);
  const entries = entryEventsQuery.all({ holderId }).map(scoreEntry).filter(wanted);
  const entryAlerts = entryAlertsQuery.all({ holderId }).map(scoreEntryAlert).filter(wanted);

  // Entry ALERTS carry no price gap -- the gap on a buy that happened is
  // already measured from the trade itself by scoreEntry. Including them in
  // the gap totals would double-count every executed entry; including them in
  // the DISCIPLINE totals is the entire point. aggregate() handles both
  // correctly because it counts gaps and decisions from separate subsets.
  const all = [...exits, ...entries, ...entryAlerts];

  return {
    convention: CONVENTION,
    exits: aggregate(exits),
    entries: aggregate(entries),
    entryAlerts: aggregate(entryAlerts),
    overall: aggregate(all),
    bySource: groupBy(all, (e) => e.sourceId, (e) => e.sourceName ?? "No source"),
    byStrategy: groupBy(all, (e) => e.strategyId, (e) => e.strategyTitle ?? "No strategy"),
    events: all,
  };
}
