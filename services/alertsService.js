// Deciding what to do about an alert, as opposed to merely silencing it.
//
// `acknowledged_at` means "stop showing me this" and says nothing about what
// was decided. The decision is the interesting part, and it is what the whole
// app is for:
//
//   * Accepting an exit rung records the sale. On a PAPER position that is the
//     plan followed mechanically -- the benchmark. On a REAL one the price is
//     supplied by the user, because this app never invents a trade that did not
//     happen.
//   * DECLINING is data. "The plan said sell at $10.75, I passed, it later fell
//     to $9" is precisely the execution gap being measured. And declining an
//     ENTRY alert is "they called it, I passed" -- the skipped-call record that
//     separates a source's real hit rate from the user's own filter.
//
// Acting late costs nothing. The alert froze `trigger_price` and `triggered_at`
// when it fired, so accepting three days afterwards still records the values
// that were true at the moment the plan said to act. That is what makes an
// asynchronous queue honest rather than a source of drift.
import db, { withTransaction } from "../lib/db.js";
import { recordSell } from "./transactionsService.js";
import { closePlanIfExhausted } from "./plansService.js";

// Ownership resolves through either parent -- an alert belongs to a watched
// item (an entry plan) or to a plan_exit rung (an exit plan), never both.
const listAlertsStmt = db.prepare(`
  SELECT a.*,
         COALESCE(ws.symbol, ps.symbol)        AS symbol,
         e.kind                                AS rung_kind,
         e.quantity                            AS rung_quantity,
         e.price_low, e.price_high,
         p.id                                  AS plan_id,
         w.order_type                          AS watch_order_type,
         src.name                              AS source_name,
         strat.title                           AS strategy_title,
         (SELECT MAX(t.is_paper_trade) FROM transactions t
           WHERE t.plan_id = p.id AND t.transaction_type = 'BUY' AND t.voided_at IS NULL) AS plan_is_paper,
         (SELECT t.account_id FROM transactions t
           WHERE t.plan_id = p.id AND t.transaction_type = 'BUY' AND t.voided_at IS NULL
           ORDER BY t.transaction_date, t.id LIMIT 1)                                     AS plan_account_id
  FROM alerts a
  LEFT JOIN watched_items w ON w.id = a.watched_item_id
  LEFT JOIN securities ws   ON ws.id = w.security_id
  LEFT JOIN plan_exits e    ON e.id = a.plan_exit_id
  LEFT JOIN plans p         ON p.id = e.plan_id
  LEFT JOIN securities ps   ON ps.id = p.security_id
  LEFT JOIN advice_sources src   ON src.id = COALESCE(p.source_id, w.source_id)
  LEFT JOIN strategies strat     ON strat.id = COALESCE(p.strategy_id, w.strategy_id)
  WHERE COALESCE(w.holder_id, p.holder_id) = @holderId
    AND (@unresolvedOnly = 0 OR a.resolution IS NULL)
  ORDER BY a.resolution IS NOT NULL, a.triggered_at DESC
  LIMIT @limit
`);

const getAlertStmt = db.prepare(`
  SELECT a.*, COALESCE(w.holder_id, p.holder_id) AS holder_id,
         COALESCE(ws.symbol, ps.symbol) AS symbol,
         e.kind AS rung_kind, e.quantity AS rung_quantity, e.plan_id,
         (SELECT MAX(t.is_paper_trade) FROM transactions t
           WHERE t.plan_id = p.id AND t.transaction_type = 'BUY' AND t.voided_at IS NULL) AS plan_is_paper,
         (SELECT t.account_id FROM transactions t
           WHERE t.plan_id = p.id AND t.transaction_type = 'BUY' AND t.voided_at IS NULL
           ORDER BY t.transaction_date, t.id LIMIT 1)                                     AS plan_account_id
  FROM alerts a
  LEFT JOIN watched_items w ON w.id = a.watched_item_id
  LEFT JOIN securities ws   ON ws.id = w.security_id
  LEFT JOIN plan_exits e    ON e.id = a.plan_exit_id
  LEFT JOIN plans p         ON p.id = e.plan_id
  LEFT JOIN securities ps   ON ps.id = p.security_id
  WHERE a.id = ?
`);

const resolveStmt = db.prepare(`
  UPDATE alerts SET
    resolution = @resolution,
    resolved_at = datetime('now'),
    resolution_note = @note,
    decline_kind = @declineKind,
    resulting_transaction_id = @transactionId,
    acknowledged_at = COALESCE(acknowledged_at, datetime('now'))
  WHERE id = @id
`);

/**
 * @param {number} holderId
 * @param {{unresolvedOnly?: boolean, limit?: number}} opts
 */
export function listAlerts(holderId, { unresolvedOnly = false, limit = 200 } = {}) {
  return listAlertsStmt
    .all({ holderId, unresolvedOnly: unresolvedOnly ? 1 : 0, limit })
    .map((a) => ({
      ...a,
      // An exit rung is actionable: accepting it records a sale. An entry alert
      // is a decision about whether the idea was taken, and the trade itself
      // goes through Journal's Execute, which collects a real fill.
      kind: a.plan_exit_id ? "exit" : "entry",
      isPaper: a.plan_is_paper === 1,
    }));
}

export function getAlert(id) {
  return getAlertStmt.get(id) ?? null;
}

/**
 * Records a decision, and for an accepted exit rung, the sale it implies.
 *
 * @param {number} holderId
 * @param {number} alertId
 * @param {object} input
 * @param {'accepted'|'declined'} input.resolution
 * @param {'invalid'|'judgement'} [input.declineKind] required in spirit on a
 *   decline: 'invalid' says the rung was wrong (and cancels it), 'judgement'
 *   says it was right and you chose otherwise. Defaults to 'judgement', the
 *   commoner and more conservative reading -- it leaves the rung's history
 *   intact rather than erasing a fired level.
 * @param {string} [input.note] why -- often the whole story on a decline
 * @param {number} [input.fillPrice] REQUIRED to accept a real exit rung.
 *   Omitted on a paper one, where the trigger price IS the answer.
 * @param {string} [input.fillDate]
 */
export async function resolveAlert(holderId, alertId, input = {}) {
  const alert = getAlert(alertId);
  if (!alert) throw new Error("Alert not found.");
  if (alert.holder_id !== holderId) throw new Error("Alert not found.");
  if (alert.resolution) {
    throw new Error(`This alert was already ${alert.resolution}.`);
  }

  const resolution = input.resolution === "declined" ? "declined" : "accepted";
  const note = input.note ? String(input.note).trim() || null : null;

  // Declining never writes a trade, whatever kind of alert it is. The record of
  // the decision IS the point -- and WHICH decline it was matters more than the
  // fact of it.
  if (resolution === "declined") {
    const declineKind = input.declineKind === "invalid" ? "invalid" : "judgement";
    withTransaction(() => {
      resolveStmt.run({ id: alertId, resolution, note, declineKind, transactionId: null });

      // An invalid rung should not have fired at all, so it must not sit in the
      // record as `hit` -- that would count against adherence for a level that
      // was simply wrong. Cancelled instead, which also stops it firing again.
      if (declineKind === "invalid" && alert.plan_exit_id) {
        db.prepare("UPDATE plan_exits SET status = 'cancelled', hit_at = NULL WHERE id = ?").run(
          alert.plan_exit_id,
        );
      }
    });
    return { resolution, declineKind, transaction: null };
  }

  // Accepting an entry alert records that the idea was taken. It does not
  // create the trade: that runs through Journal's Execute, which collects a
  // real fill price rather than assuming the target was met.
  if (!alert.plan_exit_id) {
    resolveStmt.run({ id: alertId, resolution, note, declineKind: null, transactionId: null });
    return { resolution, transaction: null, needsExecute: true };
  }

  const isPaper = alert.plan_is_paper === 1;

  // A real sale needs the price that was actually got. Refused rather than
  // defaulted to the trigger price, because silently recording the ideal as
  // though it were real would erase the exact gap being measured.
  if (!isPaper && input.fillPrice == null) {
    throw new Error(
      "This is a real position -- give the price you actually sold at. " +
        "Recording the trigger price as if it were the fill would erase the execution gap.",
    );
  }

  const price = isPaper ? alert.trigger_price : Number(input.fillPrice);
  if (!(price >= 0)) throw new Error("Fill price must be zero or greater.");

  // Defaults to the day the rung fired, not today. Accepting late must not
  // move the trade -- that is the whole reason the alert froze its details.
  const date = input.fillDate || String(alert.triggered_at).slice(0, 10);

  const sale = await recordSell({
    holderId,
    accountId: alert.plan_account_id ?? null,
    symbol: alert.symbol,
    transactionDate: date,
    quantity: alert.rung_quantity,
    price,
    isPaperTrade: isPaper,
    notes: isPaper
      ? `Plan followed mechanically: ${alert.rung_kind} rung at $${alert.trigger_price}.`
      : `Recorded from a ${alert.rung_kind} rung that fired at $${alert.trigger_price}.`,
  });

  const transactionId = sale.sells[0]?.id ?? null;

  withTransaction(() => {
    resolveStmt.run({ id: alertId, resolution, note, declineKind: null, transactionId });
  });

  // A thesis with nothing left to sell is finished, and leaving it open would
  // keep evaluating rungs against a position that no longer exists.
  if (alert.plan_id) closePlanIfExhausted(alert.plan_id);

  return { resolution, transaction: sale, transactionId, isPaper };
}

/** How many still need a decision -- the badge on the tab. */
export const countUnresolved = (holderId) =>
  listAlerts(holderId, { unresolvedOnly: true, limit: 1000 }).length;
