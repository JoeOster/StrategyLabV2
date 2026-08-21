// Exit plans: the thesis a position was opened under, and the ladder of rungs
// for getting back out of it.
//
// A plan is ONE ENTRY THESIS covering one or more lots. Exits belong here
// rather than on a lot or on a position, and both of those alternatives are
// wrong in ways specific to this app:
//
//   * Not a position (holder+security). Buying one ticker twice on two
//     different sources' recommendations is TWO theses. A position-level
//     ladder merges them and destroys the attribution -- which is the entire
//     point of the app.
//   * Not a single lot. Scaling into ONE thesis with two buys a week apart is
//     one ladder, not two; per-lot ladders would collectively oversell.
//
// A rung firing raises an ALERT. It never sells. This app is a journal and
// does not touch money -- auto-selling would fabricate a trade that never
// happened, and the gap between "the rung said sell 50 at $110" and "you
// actually sold 50 at $109.20 two days later" is the measurement the whole
// feature exists to produce. Closing that gap automatically would erase it.
import db, { withTransaction } from "../lib/db.js";

const insertPlan = db.prepare(`
  INSERT INTO plans (holder_id, security_id, source_id, strategy_id, notes)
  VALUES (@holderId, @securityId, @sourceId, @strategyId, @notes)
  RETURNING *
`);

const getPlanStmt = db.prepare("SELECT * FROM plans WHERE id = ? AND holder_id = ?");

const insertExit = db.prepare(`
  INSERT INTO plan_exits (plan_id, kind, sequence, quantity, price_low, price_high)
  VALUES (@planId, @kind, @sequence, @quantity, @priceLow, @priceHigh)
  RETURNING *
`);

const listExitsStmt = db.prepare(
  "SELECT * FROM plan_exits WHERE plan_id = ? ORDER BY sequence, id",
);

const attachTradeStmt = db.prepare(
  "UPDATE transactions SET plan_id = ? WHERE id = ? AND holder_id = ? AND plan_id IS NULL",
);

const detachTradeStmt = db.prepare(
  "UPDATE transactions SET plan_id = NULL WHERE id = ? AND holder_id = ?",
);

const getTradeStmt = db.prepare(
  "SELECT * FROM transactions WHERE id = ? AND holder_id = ? AND voided_at IS NULL",
);

// The lots a plan covers, and what is still held in them. Only BUYs: a SELL
// draws a lot down rather than adding to the thesis.
const planLotsStmt = db.prepare(`
  SELECT * FROM transactions
  WHERE plan_id = ? AND transaction_type = 'BUY' AND voided_at IS NULL
  ORDER BY transaction_date, id
`);

const setExitStatus = db.prepare(
  "UPDATE plan_exits SET status = ?, hit_at = ? WHERE id = ?",
);

const setPlanStatus = db.prepare("UPDATE plans SET status = ? WHERE id = ?");

/** Shares still held across every lot in the plan. */
export function planRemainingQuantity(planId) {
  return planLotsStmt.all(planId).reduce((sum, lot) => sum + (lot.quantity_remaining ?? 0), 0);
}

/** Shares already spoken for by rungs that have not fired or been cancelled. */
export function planCommittedQuantity(planId, { excludeExitId = null } = {}) {
  return listExitsStmt
    .all(planId)
    .filter((e) => e.status === "pending" && e.id !== excludeExitId)
    .reduce((sum, e) => sum + e.quantity, 0);
}

/**
 * Creates a plan and attaches an opening trade to it.
 *
 * source/strategy are inherited from that trade rather than asked for again:
 * the thesis is why the trade was made, and the trade already records it.
 */
export function createPlanForTrade(holderId, tradeId, { notes = null } = {}) {
  return withTransaction(() => {
    const trade = getTradeStmt.get(tradeId, holderId);
    if (!trade) throw new Error("Trade not found.");
    if (trade.transaction_type !== "BUY") {
      throw new Error("A plan is opened by a BUY -- that is what creates the position to exit.");
    }
    if (trade.plan_id) throw new Error("This trade already belongs to a plan.");

    const plan = insertPlan.get({
      holderId,
      securityId: trade.security_id,
      sourceId: trade.source_id ?? null,
      strategyId: trade.strategy_id ?? null,
      notes,
    });
    attachTradeStmt.run(plan.id, trade.id, holderId);
    return plan;
  });
}

/**
 * Adds a lot to an existing thesis -- scaling in.
 *
 * Refuses a different security outright: a plan is a thesis about one thing,
 * and silently mixing tickers would make every quantity check meaningless.
 */
export function attachTradeToPlan(holderId, planId, tradeId) {
  return withTransaction(() => {
    const plan = getPlanStmt.get(planId, holderId);
    if (!plan) throw new Error("Plan not found.");
    const trade = getTradeStmt.get(tradeId, holderId);
    if (!trade) throw new Error("Trade not found.");
    if (trade.security_id !== plan.security_id) {
      throw new Error("That trade is for a different security than this plan.");
    }
    if (trade.plan_id === planId) return { attached: 0, plan };
    if (trade.plan_id) throw new Error("That trade already belongs to another plan.");
    return { attached: attachTradeStmt.run(planId, tradeId, holderId).changes, plan };
  });
}

export function detachTradeFromPlan(holderId, tradeId) {
  return { detached: detachTradeStmt.run(tradeId, holderId).changes };
}

/**
 * Adds a rung.
 *
 * The band convention matches watched_items' existing targets, and an open end
 * is simply null -- a TAKE_PROFIT at 110-or-better is {low: 110, high: null},
 * a STOP at 90-or-worse is {low: null, high: 90}. One predicate then covers
 * both directions, which is what lets a stop be an ordinary rung instead of a
 * special case.
 */
export function addExit(holderId, planId, input) {
  return withTransaction(() => {
    const plan = getPlanStmt.get(planId, holderId);
    if (!plan) throw new Error("Plan not found.");
    if (plan.status !== "open") throw new Error(`This plan is ${plan.status}.`);

    const kind = input.kind === "STOP" ? "STOP" : "TAKE_PROFIT";
    const quantity = Number(input.quantity);
    if (!(quantity > 0)) throw new Error("Rung quantity must be greater than zero.");

    const priceLow = input.priceLow == null || input.priceLow === "" ? null : Number(input.priceLow);
    const priceHigh = input.priceHigh == null || input.priceHigh === "" ? null : Number(input.priceHigh);
    if (priceLow == null && priceHigh == null) {
      throw new Error("A rung needs at least one price bound, or it would fire on any price.");
    }
    if (priceLow != null && priceHigh != null && priceLow > priceHigh) {
      throw new Error("The low bound of a rung cannot be above its high bound.");
    }

    // Oversell guard. Rungs are instructions to sell, and a ladder promising
    // more shares than the plan holds would fire an alert that cannot be
    // honoured -- which reads as the app being wrong rather than the ladder.
    const held = planRemainingQuantity(planId);
    const committed = planCommittedQuantity(planId);
    if (committed + quantity > held + 1e-9) {
      throw new Error(
        `This plan holds ${held} share(s) and ${committed} are already committed to other rungs; ` +
          `a rung for ${quantity} would oversell it.`,
      );
    }

    const sequence =
      input.sequence != null
        ? Number(input.sequence)
        : listExitsStmt.all(planId).length;

    return insertExit.get({ planId, kind, sequence, quantity, priceLow, priceHigh });
  });
}

export function listExits(planId) {
  return listExitsStmt.all(planId);
}

export function cancelExit(holderId, planId, exitId) {
  return withTransaction(() => {
    const plan = getPlanStmt.get(planId, holderId);
    if (!plan) throw new Error("Plan not found.");
    const rung = listExitsStmt.all(planId).find((e) => e.id === Number(exitId));
    if (!rung) throw new Error("Rung not found on this plan.");
    if (rung.status === "hit") {
      // Cancelling a fired rung would erase the record that it fired, which is
      // the datapoint the whole feature exists to capture.
      throw new Error("That rung has already fired; its alert is part of the record.");
    }
    setExitStatus.run("cancelled", null, rung.id);
    return { cancelled: 1 };
  });
}

/** Full picture for one plan: the thesis, its lots, its ladder, what is left. */
export function getPlan(holderId, planId) {
  const plan = getPlanStmt.get(planId, holderId);
  if (!plan) throw new Error("Plan not found.");
  const lots = planLotsStmt.all(planId);
  const exits = listExitsStmt.all(planId);
  const held = planRemainingQuantity(planId);
  return {
    plan,
    lots,
    exits,
    heldQuantity: held,
    committedQuantity: planCommittedQuantity(planId),
    uncommittedQuantity: held - planCommittedQuantity(planId),
  };
}

const listPlansStmt = db.prepare(`
  SELECT p.*, s.symbol, s.name AS security_name,
         src.name AS source_name, strat.title AS strategy_title,
         (SELECT COUNT(*) FROM plan_exits e WHERE e.plan_id = p.id AND e.status = 'pending') AS pending_exits,
         (SELECT COUNT(*) FROM plan_exits e WHERE e.plan_id = p.id AND e.status = 'hit') AS hit_exits
  FROM plans p
  JOIN securities s ON s.id = p.security_id
  LEFT JOIN advice_sources src ON src.id = p.source_id
  LEFT JOIN strategies strat ON strat.id = p.strategy_id
  WHERE p.holder_id = @holderId
    AND (@status IS NULL OR p.status = @status)
  ORDER BY p.created_at DESC, p.id DESC
`);

export function listPlans(holderId, { status = null } = {}) {
  return listPlansStmt.all({ holderId, status }).map((p) => ({
    ...p,
    heldQuantity: planRemainingQuantity(p.id),
  }));
}

/**
 * Closes a plan whose position is gone.
 *
 * Called after a sell rather than on a timer: a thesis with nothing left to
 * sell is finished, and leaving it open would keep evaluating rungs against a
 * position that no longer exists.
 */
export function closePlanIfExhausted(planId) {
  return withTransaction(() => {
    if (planRemainingQuantity(planId) > 1e-9) return { closed: 0 };
    setPlanStatus.run("closed", planId);
    // Pending rungs on a sold-out plan can never fire. Cancelled rather than
    // left pending, so "what was still outstanding" stays answerable.
    for (const rung of listExitsStmt.all(planId)) {
      if (rung.status === "pending") setExitStatus.run("cancelled", null, rung.id);
    }
    return { closed: 1 };
  });
}

/** Marks a rung as fired. The alert itself is written by the caller. */
export function markExitHit(exitId, when = null) {
  setExitStatus.run("hit", when ?? new Date().toISOString().slice(0, 19).replace("T", " "), exitId);
}

/**
 * Does this price cross this rung?
 *
 * Exported and pure so it can be unit-tested with plain objects, same as
 * watchlistService's isTriggered -- this is the part most worth getting right
 * and cheapest to verify in isolation.
 */
export function exitTriggered(rung, price) {
  if (rung.status !== "pending") return false;
  if (rung.price_low != null && price < rung.price_low) return false;
  if (rung.price_high != null && price > rung.price_high) return false;
  return true;
}

/** Every pending rung on an open plan, with the symbol needed to price it. */
export const pendingExitsQuery = db.prepare(`
  SELECT e.*, p.holder_id, p.security_id, s.symbol
  FROM plan_exits e
  JOIN plans p ON p.id = e.plan_id
  JOIN securities s ON s.id = p.security_id
  WHERE e.status = 'pending' AND p.status = 'open'
  ORDER BY e.plan_id, e.sequence, e.id
`);

export function listPendingExits() {
  return pendingExitsQuery.all();
}
