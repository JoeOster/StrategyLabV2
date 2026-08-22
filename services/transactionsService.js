// Executed trades: buys, sells, dividends -- and the lot accounting that
// turns them into open positions and realized P&L.
//
// The model, matching the old app's "logged against specific buy lots":
//   - A BUY creates one lot. `quantity_remaining` starts at the full
//     quantity and is drawn down as it gets sold.
//   - A SELL is allocated against one or more open lots (FIFO by default).
//     Selling 100 shares that span three lots writes THREE sell rows, each
//     with its own `linked_buy_id`. That keeps every sell traceable to the
//     exact lot it came from, which is what makes per-lot realized P&L and
//     holding periods computable at all.
//   - Realized P&L is derived, not stored: a stored copy would silently go
//     stale if a buy price were ever corrected.
import db, { withTransaction } from "../lib/db.js";
import { getOrCreateSecurity } from "./priceService.js";
import { TRANSFER_OUT_REASON } from "../lib/constants.js";
import { cashBalance } from "./cashService.js";

const insertTransaction = db.prepare(`
  INSERT INTO transactions (
    holder_id, account_id, security_id, watched_item_id, source_id, strategy_id, is_paper_trade,
    import_batch_id,
    transaction_type, transaction_date, quantity, price, fees, cost_basis,
    quantity_remaining, linked_buy_id, external_ref, notes,
    needs_review, review_reason, plan_id, promoted_from_id
  ) VALUES (
    @holderId, @accountId, @securityId, @watchedItemId, @sourceId, @strategyId, @isPaperTrade,
    @importBatchId,
    @transactionType, @transactionDate, @quantity, @price, @fees, @costBasis,
    @quantityRemaining, @linkedBuyId, @externalRef, @notes,
    @needsReview, @reviewReason, @planId, @promotedFromId
  ) RETURNING *
`);

// node:sqlite requires every named parameter to be supplied, so a new optional
// column would otherwise mean touching every insert call site and hoping none
// was missed. Defaulting here means only the paths that actually set a review
// flag have to mention it.
const insertTxn = (params) =>
  insertTransaction.get({
    needsReview: 0,
    reviewReason: null,
    importBatchId: null,
    planId: null,
    promotedFromId: null,
    ...params,
  });

// --- Stock splits --------------------------------------------------------
// A split is a market event, not something a user logs -- it arrives via
// priceService.backfillDividendsSplits() writing new rows into the (cache,
// holder-agnostic) `splits` table. This section is what turns "a split
// happened" into "every open lot for that security, for every holder,
// actually reflects it." See docs/V2_BACKLOG.md's multi-agent design note
// for the class of bug this closes (adj_close/dividends double-counting is
// the *other* half of that same lesson, for the future backtester).

const getSplitsForSecurity = db.prepare(
  "SELECT split_date, ratio FROM splits WHERE security_id = ? AND split_date > ? ORDER BY split_date",
);
const getOpenLotsForSplit = db.prepare(`
  SELECT * FROM transactions
  WHERE security_id = ? AND transaction_type = 'BUY' AND quantity_remaining > 0
    AND transaction_date < ? AND voided_at IS NULL
  ORDER BY transaction_date, id
`);
const rescaleLot = db.prepare(
  "UPDATE transactions SET quantity = ?, quantity_remaining = ? WHERE id = ?",
);

function parseSplitRatio(ratioText) {
  const [numerator, denominator] = String(ratioText).split(":").map(Number);
  if (!(numerator > 0) || !(denominator > 0)) {
    throw new Error(`Unparseable split ratio: "${ratioText}"`);
  }
  return numerator / denominator;
}

/**
 * Rescales one open lot for a stock split and logs a SPLIT_ADJ audit row.
 * `cost_basis` (total dollars) is deliberately left untouched -- a split
 * doesn't change what was paid, only how many shares that payment is spread
 * across. Per-share cost (cost_basis / quantity, computed everywhere it's
 * needed, e.g. listOpenPositions) adjusts correctly as a side effect of
 * quantity changing.
 * @returns {object} the lot with its quantity/quantity_remaining updated,
 *   for compounding multiple splits in sequence without re-reading the DB.
 */
function rescaleLotForSplit(lot, splitDate, ratioText) {
  const multiplier = parseSplitRatio(ratioText);
  const newQuantity = lot.quantity * multiplier;
  const newQuantityRemaining = lot.quantity_remaining * multiplier;
  rescaleLot.run(newQuantity, newQuantityRemaining, lot.id);
  insertTxn({
    holderId: lot.holder_id,
    accountId: lot.account_id,
    securityId: lot.security_id,
    watchedItemId: null,
    sourceId: lot.source_id,
    strategyId: lot.strategy_id,
    isPaperTrade: lot.is_paper_trade,
    transactionType: "SPLIT_ADJ",
    transactionDate: splitDate,
    // Resulting share count, not the delta -- keeps `quantity` a plain
    // positive count on every row (matches BUY/SELL) instead of needing a
    // signed "shares added/removed" convention for reverse splits.
    quantity: newQuantityRemaining,
    price: 0,
    fees: 0,
    costBasis: null,
    quantityRemaining: null,
    linkedBuyId: lot.id,
    externalRef: null,
    notes:
      `Split ${ratioText} applied to lot #${lot.id}: ` +
      `${lot.quantity_remaining} -> ${newQuantityRemaining} share(s) remaining ` +
      `(lot size ${lot.quantity} -> ${newQuantity}).`,
  });
  return { ...lot, quantity: newQuantity, quantity_remaining: newQuantityRemaining };
}

/**
 * Applies a newly-discovered stock split to every currently open BUY lot for
 * a security, across ALL holders -- a split is a market event, not scoped to
 * one holder's view. Only lots opened before the split date are touched; a
 * lot bought on/after the split already reflects post-split share counts,
 * and a lot that's already fully sold has nothing left to rescale.
 *
 * Call this once per genuinely new row discovered in the `splits` cache
 * table (see priceService.backfillDividendsSplits's `newSplits` return) --
 * idempotent as long as callers only pass splits that are actually new,
 * since a lot's own state only ever reflects a given split once.
 * @param {number} securityId
 * @param {string} splitDate 'YYYY-MM-DD'
 * @param {string} ratioText e.g. '2:1'
 * @returns {{lotsAdjusted: number}}
 */
export function applySplitToOpenLots(securityId, splitDate, ratioText) {
  return withTransaction(() => {
    const lots = getOpenLotsForSplit.all(securityId, splitDate);
    for (const lot of lots) rescaleLotForSplit(lot, splitDate, ratioText);
    return { lotsAdjusted: lots.length };
  });
}

/**
 * Cheap input checks shared by the async entry points and the sync cores
 * below. Deliberately run in both: the async wrapper validates before the
 * network round trip so a bad quantity fails immediately, and the core
 * validates again because the importer calls it directly.
 */
function validateTradeInput(input) {
  const quantity = Number(input.quantity);
  const price = Number(input.price);
  const fees = Number(input.fees ?? 0);
  if (!(quantity > 0)) throw new Error("Quantity must be greater than zero");
  if (!(price >= 0)) throw new Error("Price must be zero or greater");
  return { quantity, price, fees };
}

/**
 * Logs an executed BUY, creating a new open lot.
 * @param {object} input
 * @param {number} input.holderId
 * @param {string} input.symbol
 * @param {string} input.transactionDate 'YYYY-MM-DD'
 * @param {number} input.quantity
 * @param {number} input.price per share
 * @param {number} [input.fees=0]
 */
export async function recordBuy(input) {
  validateTradeInput(input);
  const security = await getOrCreateSecurity(input.symbol, { exchangeCode: input.exchangeCode });
  return recordBuyWith(security, input);
}

/**
 * The synchronous half of recordBuy, taking an already-resolved security.
 *
 * Split out so a batch import can hold ONE transaction open across many
 * writes. getOrCreateSecurity does network I/O, and withTransaction takes a
 * synchronous function -- awaiting inside it would let the transaction close
 * before the awaited half ever ran, which is not atomicity, it just looks
 * like it. The importer resolves every symbol up front and then calls this.
 * See docs/IMPORTS.md.
 */
export function recordBuyWith(security, input) {
  const { quantity, price, fees } = validateTradeInput(input);

  return withTransaction(() => {
    const buy = insertTxn({
      holderId: input.holderId,
      accountId: input.accountId ?? null,
      securityId: security.id,
      watchedItemId: input.watchedItemId ?? null,
      sourceId: input.sourceId ?? null,
      strategyId: input.strategyId ?? null,
      isPaperTrade: input.isPaperTrade ? 1 : 0,
      transactionType: "BUY",
      transactionDate: input.transactionDate,
      quantity,
      price,
      fees,
      // Fees are folded into cost basis so P&L reflects what the trade
      // actually cost, not just the sticker price.
      costBasis: quantity * price + fees,
      quantityRemaining: quantity,
      linkedBuyId: null,
      externalRef: input.externalRef ?? null,
      importBatchId: input.importBatchId ?? null,
      needsReview: input.needsReview ? 1 : 0,
      reviewReason: input.reviewReason ?? null,
      notes: input.notes ?? null,
      planId: input.planId ?? null,
      promotedFromId: input.promotedFromId ?? null,
    });

    // Catch up a backdated entry: if this stock already split, on record,
    // since the date being logged (e.g. entering a real trade from before
    // this app tracked it), apply those splits to the new lot right away
    // instead of leaving it stuck at pre-split share counts until the next
    // live-discovered split walks past it.
    let lot = buy;
    for (const split of getSplitsForSecurity.all(security.id, buy.transaction_date)) {
      lot = rescaleLotForSplit(lot, split.split_date, split.ratio);
    }

    return lot === buy ? buy : getTransaction.get(buy.id, buy.holder_id);
  });
}

// Account-scoped. Shares held at one brokerage cannot be sold by another, so a
// sale must draw only from lots in its own account.
//
// Without the scope this was not merely an attribution problem, it was wrong:
// in a two-account test, selling 100 from account B emptied account A, left B
// still showing 100 shares it no longer held, and reported realized P&L of
// $1,500 instead of $500 because it used A's cost basis. The SELL row was
// labelled account B while drawing down A's lot, so the two accounts' books
// contradicted each other.
//
// `IS` rather than `=` so a NULL accountId means "do not filter" instead of
// matching nothing.
const getOpenLots = db.prepare(`
  SELECT * FROM transactions
  WHERE holder_id = @holderId AND security_id = @securityId
    AND transaction_type = 'BUY' AND quantity_remaining > 0
    AND is_paper_trade = @isPaperTrade AND voided_at IS NULL
    AND (@accountId IS NULL OR account_id IS @accountId)
    -- Thesis scope, same NULL-means-everything convention as accountId above.
    -- Constraining here makes a plan-scoped sale FIFO *within* the thesis
    -- rather than across the whole holding.
    AND (@planId IS NULL OR plan_id IS @planId)
  ORDER BY transaction_date, id
`);

// Snapped to exactly zero when the remainder lands within float noise of it.
// Repeated FIFO subtraction accumulates error, so a lot that has been sold out
// completely can be left holding ~1e-14 shares -- and every open-position read
// filters on `quantity_remaining > 0`, which that satisfies. The symptom is a
// fully-closed holding sitting in the portfolio at 0.00 shares and $0.00,
// which is how a real 507-row import produced eight positions instead of six.
// 1e-9 matches the epsilon reconcile.js already uses for the same reason.
const reduceLot = db.prepare(`
  UPDATE transactions
     SET quantity_remaining = CASE
           WHEN ABS(quantity_remaining - ?) < 1e-9 THEN 0
           ELSE quantity_remaining - ?
         END
   WHERE id = ?
`);

/**
 * Logs an executed SELL, drawing down open lots oldest-first (FIFO) unless a
 * specific lot is named via `lotId`.
 *
 * Refuses to sell more than is held -- an oversell means the data is wrong
 * somewhere, and silently allowing it would produce negative phantom
 * positions that quietly corrupt every downstream total.
 *
 * @returns {{sells: Array, totalProceeds: number, realizedPnl: number}}
 */
export async function recordSell(input) {
  validateTradeInput(input);
  const security = await getOrCreateSecurity(input.symbol, { exchangeCode: input.exchangeCode });
  return recordSellWith(security, input);
}

/** The synchronous half of recordSell -- see recordBuyWith for why. */
export function recordSellWith(security, input) {
  const { quantity, price, fees } = validateTradeInput(input);
  const isPaperTrade = input.isPaperTrade ? 1 : 0;

  return withTransaction(() => {
    const planId = input.planId == null ? null : Number(input.planId);
    // Set only on the import path, where ambiguity is flagged rather than refused.
    let ambiguousPlans = null;

    let lots = getOpenLots.all({
      holderId: input.holderId,
      securityId: security.id,
      isPaperTrade,
      accountId: input.accountId ?? null,
      planId,
    });
    if (planId != null && lots.length === 0) {
      throw new Error(
        `That plan holds no open ${security.symbol} lots to sell from.`,
      );
    }

    // No account named, and the holding spans several. Guessing would pick the
    // oldest lot regardless of where it is held, which is how the bug above
    // happened. Ask instead -- this app asks rather than assumes.
    if (input.accountId == null) {
      const accounts = new Set(lots.map((lot) => lot.account_id));
      if (accounts.size > 1) {
        throw new Error(
          `${security.symbol} is held in more than one account. ` +
            `Say which account this sale is from -- selling from the wrong one corrupts both.`,
        );
      }
    }

    // Narrow to a named lot FIRST. Naming a lot is the most specific
    // instruction available -- more specific than naming a thesis -- so the
    // ambiguity guard below must judge what is actually being sold, not the
    // whole holding. Ordered the other way, selling one explicitly chosen lot
    // was refused as ambiguous, which is the opposite of true.
    if (input.lotId) {
      lots = lots.filter((lot) => lot.id === Number(input.lotId));
      if (lots.length === 0) throw new Error("That lot is not open, or does not belong to you.");
    }

    // The same problem one axis over, and it is the more damaging one.
    //
    // FIFO across the whole holding is right for COST BASIS -- it is what a
    // broker does and what a 1099 will say. It is wrong for ATTRIBUTION. If a
    // Telegram call and a book pattern both hold RKLB, selling "the Telegram
    // shares" draws down whichever lot is older, so the book's thesis quietly
    // loses shares it still believes it owns. The position maths stays correct
    // and the attribution -- the entire point of this app -- silently rots.
    //
    // It also breaks the ladder: planRemainingQuantity() counts a plan's own
    // lots, so a plan can report shares another plan's sale already consumed,
    // and the oversell guard on new rungs under-protects by exactly that much.
    //
    // Untagged lots count as their own bucket. "Some shares are under a thesis
    // and some are not" is precisely as ambiguous as two named theses.
    if (planId == null) {
      const buckets = new Set(lots.map((lot) => lot.plan_id ?? 0));
      if (buckets.size > 1) {
        const named = [...new Set(lots.map((lot) => lot.plan_id).filter(Boolean))];
        if (input.importBatchId) {
          // A broker CSV cannot say which thesis a sale served -- the broker
          // has never heard of theses. Refusing would dead-end the monthly
          // audit over a question the file cannot answer, so this allocates
          // FIFO as a broker would and flags the row instead. The judgement is
          // deferred to a human, not skipped.
          ambiguousPlans = named;
        } else {
          throw new Error(
            `${security.symbol} is held under ${buckets.size} different theses` +
              `${named.length ? ` (plan ${named.join(", plan ")}${buckets.has(0) ? ", plus untagged lots" : ""})` : ""}. ` +
              `Say which plan this sale belongs to -- selling from the wrong thesis corrupts the attribution, ` +
              `which is the thing this app exists to measure.`,
          );
        }
      }
    }

    const available = lots.reduce((sum, lot) => sum + lot.quantity_remaining, 0);
    if (available < quantity) {
      throw new Error(
        `Cannot sell ${quantity} share(s) of ${security.symbol}: only ${available} held${input.lotId ? " in that lot" : ""}.`,
      );
    }

    // Fees are spread across the generated sell rows in proportion to how
    // much of the sale each covers, so a multi-lot sell doesn't dump the
    // whole commission onto the first lot.
    const sells = [];
    let remainingToSell = quantity;
    let realizedPnl = 0;

    for (const lot of lots) {
      if (remainingToSell <= 0) break;
      const take = Math.min(lot.quantity_remaining, remainingToSell);
      const feeShare = fees * (take / quantity);
      // Per-share cost for this lot, fees included.
      const lotCostPerShare = lot.cost_basis / lot.quantity;
      const proceeds = take * price - feeShare;
      const costOfSold = take * lotCostPerShare;

      const sell = insertTxn({
        holderId: input.holderId,
        accountId: input.accountId ?? lot.account_id ?? null,
        securityId: security.id,
        watchedItemId: input.watchedItemId ?? null,
        sourceId: input.sourceId ?? lot.source_id ?? null,
        strategyId: input.strategyId ?? lot.strategy_id ?? null,
        isPaperTrade,
        transactionType: "SELL",
        transactionDate: input.transactionDate,
        quantity: take,
        price,
        fees: feeShare,
        costBasis: costOfSold,
        quantityRemaining: null,
        linkedBuyId: lot.id,
        // Only the FIRST row of the fan-out carries the ref. A sale spanning
        // three lots writes three rows, and the partial
        // UNIQUE (account_id, external_ref) index rejects all but the first
        // -- which is exactly how a trial import landed every buy and under
        // half the sells (docs/IMPORTS.md). The constraint is meant to mean
        // "this broker row has been imported", not "this database row".
        externalRef: sells.length === 0 ? (input.externalRef ?? null) : null,
        importBatchId: input.importBatchId ?? null,
        // An ambiguous imported sale is flagged rather than refused, so it
        // surfaces in the monthly audit with the question still answerable.
        needsReview: input.needsReview || ambiguousPlans ? 1 : 0,
        reviewReason:
          input.reviewReason ??
          (ambiguousPlans
            ? `Allocated FIFO across theses: this holding spans plan ${ambiguousPlans.join(", plan ")}` +
              ` and the broker file cannot say which one the sale served.`
            : null),
        notes: input.notes ?? null,
        // Which thesis actually gave up the shares. Recorded per fan-out row
        // because a single sale can legitimately span lots -- and, on the
        // import path above, lots belonging to different plans. Without this
        // the attribution exists only in the buy rows, and a report asking
        // "what did this source return" has to guess at the sell side.
        planId: lot.plan_id ?? null,
      });

      reduceLot.run(take, take, lot.id);
      sells.push(sell);
      realizedPnl += proceeds - costOfSold;
      remainingToSell -= take;
    }

    return { sells, totalProceeds: quantity * price - fees, realizedPnl };
  });
}

/** Dividends aren't tied to a lot -- they're standalone income rows. */
export async function recordDividend(input) {
  const amount = Number(input.amount ?? input.price);
  if (!(amount > 0)) throw new Error("Dividend amount must be greater than zero");
  const security = await getOrCreateSecurity(input.symbol, { exchangeCode: input.exchangeCode });
  return recordDividendWith(security, input);
}

/** The synchronous half of recordDividend -- see recordBuyWith for why. */
export function recordDividendWith(security, input) {
  const amount = Number(input.amount ?? input.price);
  if (!(amount > 0)) throw new Error("Dividend amount must be greater than zero");

  return insertTxn({
    holderId: input.holderId,
    accountId: input.accountId ?? null,
    securityId: security.id,
    watchedItemId: null,
    sourceId: input.sourceId ?? null,
    strategyId: input.strategyId ?? null,
    isPaperTrade: input.isPaperTrade ? 1 : 0,
    transactionType: "DIVIDEND",
    transactionDate: input.transactionDate,
    quantity: Number(input.quantity ?? 0),
    price: amount,
    fees: 0,
    costBasis: null,
    quantityRemaining: null,
    linkedBuyId: null,
    externalRef: input.externalRef ?? null,
    importBatchId: input.importBatchId ?? null,
    needsReview: input.needsReview ? 1 : 0,
    reviewReason: input.reviewReason ?? null,
    notes: input.notes ?? null,
  });
}

const openPositionsQuery = db.prepare(`
  SELECT
    t.id AS lot_id, t.transaction_date, t.quantity AS original_quantity,
    t.quantity_remaining, t.price AS entry_price, t.cost_basis AS original_cost_basis,
    t.fees, t.notes, t.account_id, t.is_paper_trade,
    s.id AS security_id, s.symbol, s.name AS security_name,
    e.code AS exchange_code,
    q.last_price, q.prev_close, q.fetched_at AS quote_fetched_at,
    src.name AS source_name, strat.title AS strategy_title,
    -- Which account this lot is in. Carried on every row so an all-accounts
    -- view can say whose position it is -- otherwise two identical-looking
    -- RKLB rows give no clue that they are in different brokerages.
    acc.account_number, br.slug AS broker_slug, br.name AS broker_name,
    -- Which thesis owns this lot. The sell form needs it to say so before the
    -- server has to refuse an ambiguous sale -- an error is a worse way to
    -- learn that a holding spans two theses than simply being shown it.
    t.plan_id, pl.notes AS plan_notes,
    plsrc.name AS plan_source_name, plstrat.title AS plan_strategy_title
  FROM transactions t
  JOIN securities s ON s.id = t.security_id
  LEFT JOIN plans pl ON pl.id = t.plan_id
  LEFT JOIN advice_sources plsrc ON plsrc.id = pl.source_id
  LEFT JOIN strategies plstrat ON plstrat.id = pl.strategy_id
  LEFT JOIN accounts acc ON acc.id = t.account_id
  LEFT JOIN brokers br ON br.id = acc.broker_id
  LEFT JOIN exchanges e ON e.id = s.exchange_id
  LEFT JOIN quotes_cache q ON q.security_id = t.security_id
  LEFT JOIN advice_sources src ON src.id = t.source_id
  LEFT JOIN strategies strat ON strat.id = t.strategy_id
  WHERE t.holder_id = @holderId
    AND t.transaction_type = 'BUY'
    AND t.quantity_remaining > 0
    AND t.is_paper_trade = @isPaperTrade
    AND t.voided_at IS NULL
    -- Account scope. NULL means every account, which is the default view; a
    -- number narrows to one. IS rather than = so the NULL case does not
    -- silently match nothing.
    AND (@accountId IS NULL OR t.account_id IS @accountId)
  ORDER BY s.symbol, t.transaction_date
`);

/**
 * Open position lots with live valuation. One row per lot (not per ticker) so
 * the entry price and holding period of each purchase stay visible -- that's
 * the distinction the old app's "position lot" cards were built around.
 */
export function listOpenPositions(holderId, { isPaperTrade = false, accountId = null } = {}) {
  return openPositionsQuery
    .all({ holderId, isPaperTrade: isPaperTrade ? 1 : 0, accountId })
    .map((row) => {
    // Cost basis of the *remaining* shares, not the original purchase.
    const costPerShare = row.original_cost_basis / row.original_quantity;
    const costBasis = costPerShare * row.quantity_remaining;
    const marketValue = row.last_price != null ? row.last_price * row.quantity_remaining : null;
    const unrealizedPnl = marketValue != null ? marketValue - costBasis : null;
    return {
      ...row,
      cost_per_share: costPerShare,
      cost_basis: costBasis,
      market_value: marketValue,
      unrealized_pnl: unrealizedPnl,
      unrealized_pnl_percent:
        unrealizedPnl != null && costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : null,
      days_held: daysBetween(row.transaction_date, new Date()),
    };
  });
}

function daysBetween(dateStr, now) {
  const then = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 86400000));
}

const transactionsQuery = db.prepare(`
  SELECT
    t.*, s.symbol, s.name AS security_name, e.code AS exchange_code,
    src.name AS source_name, strat.title AS strategy_title,
    buy.price AS linked_buy_price, buy.transaction_date AS linked_buy_date,
    buy.cost_basis AS linked_buy_cost_basis, buy.quantity AS linked_buy_quantity
  FROM transactions t
  JOIN securities s ON s.id = t.security_id
  LEFT JOIN exchanges e ON e.id = s.exchange_id
  LEFT JOIN advice_sources src ON src.id = t.source_id
  LEFT JOIN strategies strat ON strat.id = t.strategy_id
  LEFT JOIN transactions buy ON buy.id = t.linked_buy_id
  WHERE t.holder_id = @holderId
    AND (@isPaperTrade IS NULL OR t.is_paper_trade = @isPaperTrade)
    AND (@symbol IS NULL OR s.symbol = @symbol)
    AND (@startDate IS NULL OR t.transaction_date >= @startDate)
    AND (@endDate IS NULL OR t.transaction_date <= @endDate)
    AND (@type IS NULL OR t.transaction_type = @type)
    AND (@includeVoided = 1 OR t.voided_at IS NULL)
    AND (@needsReviewOnly = 0 OR (t.needs_review = 1 AND t.review_resolved_at IS NULL))
    -- Account scope, same convention as the positions query: NULL is every
    -- account, a number narrows to one.
    AND (@accountId IS NULL OR t.account_id IS @accountId)
  ORDER BY t.transaction_date DESC, t.id DESC
`);

/**
 * Full transaction history. Realized P&L is computed per SELL row from the
 * lot it was linked to.
 */
export function listTransactions(holderId, filters = {}) {
  return transactionsQuery
    .all({
      holderId,
      isPaperTrade: filters.isPaperTrade == null ? null : filters.isPaperTrade ? 1 : 0,
      symbol: filters.symbol ? String(filters.symbol).trim().toUpperCase() : null,
      startDate: filters.startDate || null,
      endDate: filters.endDate || null,
      type: filters.type || null,
      includeVoided: filters.includeVoided ? 1 : 0,
      needsReviewOnly: filters.needsReviewOnly ? 1 : 0,
      accountId: filters.accountId ?? null,
    })
    .map((row) => ({ ...row, realized_pnl: computeRealizedPnl(row), total: computeTotal(row) }));
}

function computeRealizedPnl(row) {
  if (row.transaction_type !== "SELL" || row.linked_buy_id == null) return null;

  // A transfer out is a SELL for lot accounting and nothing else: the shares
  // move to another account, so there are no proceeds and no gain or loss.
  // Six such rows -- a Fidelity account close-out on 2025-03-28 -- fabricated
  // -$20,950 of "loss" and flipped the IRA from +$6,205 to -$14,745. Nothing
  // threw; the total was simply wrong, and wrong in the direction that looks
  // like a bad year rather than a bug.
  //
  // Matched on review_reason, which resolveReview deliberately preserves, via
  // a constant shared with the parser that writes it.
  if (row.review_reason === TRANSFER_OUT_REASON) return null;
  const proceeds = row.quantity * row.price - (row.fees || 0);
  // cost_basis on a SELL row is the cost of exactly the shares sold, set at
  // sell time -- so this doesn't need to re-derive it from the parent lot.
  return proceeds - (row.cost_basis ?? 0);
}

function computeTotal(row) {
  if (row.transaction_type === "DIVIDEND") return row.price;
  if (row.transaction_type === "SELL") return row.quantity * row.price - (row.fees || 0);
  return row.quantity * row.price + (row.fees || 0);
}

/**
 * Portfolio-level roll-up for the header strip.
 *
 * A position with no quote makes market value UNKNOWN, not equal to cost. This
 * used to fall back to `p.cost_basis`, so an unpriced portfolio displayed a
 * market value identical to its cost and unrealized P&L of exactly $0.00 --
 * a specific, confident, wrong claim rather than an absence.
 *
 * It confused the app's own author on the first real import: the ledger said
 * $21,850.70 market value against $21,850.70 cost while Fidelity said
 * $18,879.78. Every underlying row was right; only the roll-up lied.
 *
 * So the totals now cover the priced positions and say how many they are.
 * `unpricedCount > 0` means the market figures are partial, and the UI is
 * expected to say so rather than present them as the whole picture.
 */
export function getPortfolioSummary(holderId, { isPaperTrade = false, accountId = null } = {}) {
  const positions = listOpenPositions(holderId, { isPaperTrade, accountId });
  const totalCost = positions.reduce((sum, p) => sum + p.cost_basis, 0);

  const priced = positions.filter((p) => p.market_value != null);
  const unpricedCount = positions.length - priced.length;

  // Cost is summed over the SAME positions as value, or the comparison is
  // between different sets and the difference is meaningless.
  const pricedCost = priced.reduce((sum, p) => sum + p.cost_basis, 0);
  const pricedValue = priced.reduce((sum, p) => sum + p.market_value, 0);

  // Three distinct cases, and they must not collapse into each other:
  //   no positions at all      -> worth exactly zero, which IS known
  //   positions, none priced   -> unknown, and null says so
  //   positions, some priced   -> a partial figure, flagged by unpricedCount
  //
  // The middle case is why this is not simply a sum. The first case matters for
  // a funded account holding only cash: its total is the cash, and returning
  // null there would hide a figure that is perfectly well known.
  const totalValue = positions.length === 0 ? 0 : priced.length > 0 ? pricedValue : null;
  const unrealized = positions.length === 0 ? 0 : priced.length > 0 ? pricedValue - pricedCost : null;

  // Scoped the same way as the positions above, or the strip would show one
  // account's holdings beside every account's realized P&L.
  const realized = listTransactions(holderId, { isPaperTrade, accountId, type: "SELL" }).reduce(
    (sum, t) => sum + (t.realized_pnl ?? 0),
    0,
  );
  const dividends = listTransactions(holderId, { isPaperTrade, accountId, type: "DIVIDEND" }).reduce(
    (sum, t) => sum + t.price,
    0,
  );

  return {
    // Lots, not holdings. Three purchases of MRVL are three rows here because
    // each keeps its own entry price, holding period and thesis -- that is the
    // whole point of the per-lot model. But it is NOT what a broker means by
    // "positions", and labelling it so read as 8 holdings against Fidelity's 6.
    lotCount: positions.length,
    // Distinct securities. This is what a broker calls a position, and what
    // the summary strip should show.
    positionCount: new Set(positions.map((p) => p.security_id)).size,
    totalCost,
    totalValue,
    // How much of the picture the market figures actually cover.
    pricedCount: priced.length,
    unpricedCount,
    unrealizedPnl: unrealized,
    unrealizedPnlPercent:
      unrealized != null && pricedCost > 0 ? (unrealized / pricedCost) * 100 : null,
    realizedPnl: realized,
    // Cash and the account total are only meaningful for ONE account: summing
    // balances across accounts would produce a figure no statement shows.
    cash: accountId != null ? cashBalance(accountId).balance : null,
    // Flagged, not hidden: a derived balance is usually right and always worth
    // knowing about, but it must not read as verified.
    cashIsDerived: accountId != null ? cashBalance(accountId).isDerived : null,
    // Only when EVERY position is priced. An account total built on a market
    // value covering one holding in three is not an account total, it is a
    // fragment with a confident label.
    accountTotal:
      accountId != null && totalValue != null && unpricedCount === 0
        ? totalValue + cashBalance(accountId).balance
        : null,
    dividendIncome: dividends,
    // Everything banked, versus what is still on paper. Unrealized is omitted
    // rather than assumed zero when nothing is priced.
    totalReturn: realized + dividends + (unrealized ?? 0),
  };
}

const getTransaction = db.prepare("SELECT * FROM transactions WHERE id = ? AND holder_id = ?");

/**
 * One transaction, scoped to its holder.
 *
 * Exported because the CSV audit needs to read a row before and after applying
 * a correction, to report what actually changed. The holder scope is not
 * decoration: every read path in this app is holder-scoped, and a getter that
 * quietly is not would be the one place a stray id could cross the boundary.
 */
export function getTransactionById(holderId, id) {
  return getTransaction.get(id, holderId) ?? null;
}
const voidTransactionStmt = db.prepare(
  `UPDATE transactions SET voided_at = datetime('now'), void_reason = ?
     WHERE id = ? AND holder_id = ? AND voided_at IS NULL`,
);
const restoreLot = db.prepare(
  "UPDATE transactions SET quantity_remaining = quantity_remaining + ? WHERE id = ?",
);

const updateBuyStmt = db.prepare(`
  UPDATE transactions SET
    transaction_date = @transactionDate, quantity = @quantity, price = @price,
    fees = @fees, cost_basis = @costBasis, quantity_remaining = @quantityRemaining,
    source_id = @sourceId, strategy_id = @strategyId, notes = @notes
  WHERE id = @id AND holder_id = @holderId
`);

const updateSellStmt = db.prepare(`
  UPDATE transactions SET
    transaction_date = @transactionDate, quantity = @quantity, price = @price,
    fees = @fees, cost_basis = @costBasis, source_id = @sourceId,
    strategy_id = @strategyId, notes = @notes
  WHERE id = @id AND holder_id = @holderId
`);

const updateDividendStmt = db.prepare(`
  UPDATE transactions SET
    transaction_date = @transactionDate, price = @price,
    source_id = @sourceId, strategy_id = @strategyId, notes = @notes
  WHERE id = @id AND holder_id = @holderId
`);

const getLinkedSells = db.prepare(
  "SELECT id, quantity FROM transactions WHERE linked_buy_id = ? AND transaction_type = 'SELL' AND voided_at IS NULL",
);
const setSellCostBasis = db.prepare("UPDATE transactions SET cost_basis = ? WHERE id = ?");

/**
 * Edits an existing transaction, keeping lot accounting consistent.
 *
 * Rules, and why:
 *  - **Type can't change.** Turning a BUY into a SELL would invalidate every
 *    lot link pointing at it. Delete and re-enter instead.
 *  - **A BUY's quantity can only change while none of it has been sold.**
 *    Otherwise the shares drawn down by existing sells might no longer exist.
 *  - **Changing a BUY's price or fees recomputes the cost basis of every sell
 *    linked to it**, so correcting a typo'd purchase price fixes the realized
 *    P&L of past sales instead of leaving the books internally inconsistent.
 *  - **A SELL's quantity re-allocates against its lot**: the old amount is
 *    returned first, then the new amount is taken, so an increase is rejected
 *    if the lot can't cover it.
 *
 * @param {number} holderId
 * @param {number} id
 * @param {object} patch fields to change; omitted fields keep current values
 */
export function updateTransaction(holderId, id, patch = {}) {
  return withTransaction(() => {
    const txn = getTransaction.get(id, holderId);
    if (!txn) throw new Error("Transaction not found.");
    if (txn.voided_at) throw new Error("This transaction is voided and can't be edited.");

    if (patch.transactionType && patch.transactionType !== txn.transaction_type) {
      throw new Error(
        "A transaction's type can't be changed. Delete it and enter a new one instead.",
      );
    }

    const transactionDate = patch.transactionDate ?? txn.transaction_date;
    const sourceId = patch.sourceId === undefined ? txn.source_id : (patch.sourceId ?? null);
    const strategyId = patch.strategyId === undefined ? txn.strategy_id : (patch.strategyId ?? null);
    const notes = patch.notes === undefined ? txn.notes : (patch.notes ?? null);

    if (txn.transaction_type === "DIVIDEND") {
      const amount = patch.amount != null ? Number(patch.amount) : Number(patch.price ?? txn.price);
      if (!(amount > 0)) throw new Error("Dividend amount must be greater than zero.");
      updateDividendStmt.run({ id, holderId, transactionDate, price: amount, sourceId, strategyId, notes });
      return getTransaction.get(id, holderId);
    }

    const quantity = patch.quantity != null ? Number(patch.quantity) : txn.quantity;
    const price = patch.price != null ? Number(patch.price) : txn.price;
    const fees = patch.fees != null ? Number(patch.fees) : txn.fees;
    if (!(quantity > 0)) throw new Error("Quantity must be greater than zero.");
    if (!(price >= 0)) throw new Error("Price must be zero or greater.");

    if (txn.transaction_type === "BUY") {
      const soldSoFar = txn.quantity - txn.quantity_remaining;
      if (quantity !== txn.quantity && soldSoFar > 0) {
        throw new Error(
          `Can't change the quantity: ${soldSoFar} of these shares have already been sold. Delete the matching sell(s) first.`,
        );
      }

      const costBasis = quantity * price + fees;
      updateBuyStmt.run({
        id,
        holderId,
        transactionDate,
        quantity,
        price,
        fees,
        costBasis,
        // Untouched by definition when quantity changes; otherwise preserve
        // whatever has already been drawn down.
        quantityRemaining: quantity === txn.quantity ? txn.quantity_remaining : quantity,
        sourceId,
        strategyId,
        notes,
      });

      // Keep already-recorded sells honest about what these shares cost.
      const newCostPerShare = costBasis / quantity;
      for (const sell of getLinkedSells.all(id)) {
        setSellCostBasis.run(sell.quantity * newCostPerShare, sell.id);
      }
      return getTransaction.get(id, holderId);
    }

    // SELL: re-allocate against the parent lot.
    const lot = txn.linked_buy_id ? getTransaction.get(txn.linked_buy_id, holderId) : null;
    if (!lot) throw new Error("This sale's original purchase is missing; delete it instead.");

    if (quantity !== txn.quantity) {
      const availableAfterRestore = lot.quantity_remaining + txn.quantity;
      if (quantity > availableAfterRestore) {
        throw new Error(
          `Can't sell ${quantity} share(s): that lot only holds ${availableAfterRestore}.`,
        );
      }
      // Restore the old draw, then take the new one.
      restoreLot.run(txn.quantity, lot.id);
      reduceLot.run(quantity, quantity, lot.id);
    }

    const lotCostPerShare = lot.cost_basis / lot.quantity;
    updateSellStmt.run({
      id,
      holderId,
      transactionDate,
      quantity,
      price,
      fees,
      costBasis: quantity * lotCostPerShare,
      sourceId,
      strategyId,
      notes,
    });
    return getTransaction.get(id, holderId);
  });
}

/**
 * Deletes a transaction, restoring lot state so the books stay consistent:
 * removing a SELL puts its shares back on the lot it drew from. Deleting a
 * BUY is refused once any of it has been sold, since that would orphan the
 * sell rows pointing at it.
 */
/**
 * Voids a transaction. **Orders are never hard-deleted** -- the row stays so the
 * audit trail survives; every read path filters `voided_at IS NULL`, so a voided
 * order stops affecting positions, FIFO, holdings and quote refresh immediately.
 *
 * Note this is for *mistaken entry*, not for selling. Selling is already a
 * separate SELL row drawing the lot down via quantity_remaining -- a fully sold
 * BUY keeps its row with quantity_remaining = 0 and is not voided.
 *
 * The two guards from the old delete path are kept deliberately:
 *  - voiding a SELL returns its shares to the lot it came from
 *  - a BUY can't be voided once any of it has been sold (void the sells first),
 *    otherwise the drawn-down shares would refer to a lot that no longer counts
 */
const resolveReviewStmt = db.prepare(
  `UPDATE transactions SET review_resolved_at = datetime('now'),
     review_reason = COALESCE(?, review_reason)
     WHERE id = ? AND holder_id = ? AND needs_review = 1 AND review_resolved_at IS NULL`,
);

/**
 * Marks an extrapolated row as reconciled against real records. Deliberately
 * does NOT clear needs_review: the row was estimated once, and erasing that
 * loses the audit trail. review_resolved_at is what removes it from the
 * outstanding list -- the same pattern as voided_at.
 *
 * Correcting the actual figures is a separate updateTransaction() call; this
 * only records that the reconciliation happened.
 */
export function resolveReview(holderId, id, note = null) {
  const trimmed = note == null ? null : String(note).trim() || null;
  return { resolved: resolveReviewStmt.run(trimmed, id, holderId).changes };
}

export function voidTransaction(holderId, id, reason = null) {
  return withTransaction(() => {
    const txn = getTransaction.get(id, holderId);
    if (!txn) return { voided: 0 };
    if (txn.voided_at) throw new Error("This transaction is already voided.");

    // Checked before any mutation so a rejected void changes nothing.
    if (txn.transaction_type === "BUY" && txn.quantity_remaining < txn.quantity) {
      throw new Error(
        "This purchase has already been partly or fully sold. Void the matching sell(s) first.",
      );
    }

    if (txn.transaction_type === "SELL" && txn.linked_buy_id != null) {
      restoreLot.run(txn.quantity, txn.linked_buy_id);
    }

    const trimmed = reason == null ? null : String(reason).trim() || null;
    return {
      voided: voidTransactionStmt.run(trimmed, id, holderId).changes,
      transaction: txn,
    };
  });
}

const setRealStmt = db.prepare("UPDATE transactions SET is_paper_trade = 0 WHERE id = ?");

/**
 * Records that a paper trade was actually taken, WITHOUT destroying it.
 *
 * This used to flip `is_paper_trade` from 1 to 0 on the same row. Nothing was
 * copied, so the moment a paper trade was promoted there was no longer any
 * record it had ever been paper -- same id, same price, same date,
 * reclassified.
 *
 * That erased the comparison this app exists to make. The paper leg is the
 * plan followed perfectly: entered at the price the idea named, exiting when
 * its rung says so. The real leg is what actually happened -- a later entry, a
 * worse fill, an exit that got missed. The DIVERGENCE between them is the
 * measurement, and flipping one row into the other destroyed it before it
 * could be taken.
 *
 * So promotion now creates a NEW real transaction and leaves the paper one
 * open and running. Both legs live, linked by `promoted_from_id`.
 *
 * **A fill price is required.** Defaulting it to the paper price would record
 * the ideal as though it were real and erase the entry gap in the same motion
 * -- which is exactly what resolveAlert refuses to do on the exit side, for
 * exactly the same reason. The number is a fact the user knows; the app should
 * ask for it rather than invent it.
 *
 * @param {number} holderId
 * @param {number} id the paper BUY being promoted
 * @param {{fillPrice: number, fillDate?: string, quantity?: number,
 *          accountId?: number, fees?: number, notes?: string}} input
 */
export function promotePaperTrade(holderId, id, input = {}) {
  return withTransaction(() => {
    const paper = getTransaction.get(id, holderId);
    if (!paper) throw new Error("Transaction not found.");
    if (paper.voided_at) throw new Error("This transaction is voided and can't be promoted.");
    if (!paper.is_paper_trade) {
      throw new Error("This is already a real transaction, not a paper trade.");
    }
    if (paper.transaction_type !== "BUY") {
      throw new Error("Only a paper BUY can be promoted -- it's what opens the position.");
    }

    const fillPrice = Number(input.fillPrice);
    if (!(fillPrice >= 0)) {
      throw new Error(
        "Give the price you actually paid. Recording the paper price as the real fill would " +
          "erase the entry gap, which is the thing worth measuring.",
      );
    }

    // Defaults to the whole paper lot, but a smaller real purchase is allowed
    // and is itself data: planning 100 and buying 50 is a divergence in size,
    // and refusing to record it would only mean it went unrecorded.
    const quantity = input.quantity == null ? paper.quantity : Number(input.quantity);
    if (!(quantity > 0)) throw new Error("Quantity must be greater than zero.");
    if (quantity - paper.quantity > 1e-9) {
      throw new Error(
        `The paper trade is for ${paper.quantity} share(s); promoting more than that is a separate purchase, not a promotion.`,
      );
    }

    const fees = Number(input.fees ?? 0);
    const real = insertTxn({
      holderId,
      // Paper trades are not account-dependent -- Joe's own decision -- so a
      // real one needs to be told where it actually happened.
      accountId: input.accountId ?? null,
      securityId: paper.security_id,
      watchedItemId: paper.watched_item_id ?? null,
      sourceId: paper.source_id ?? null,
      strategyId: paper.strategy_id ?? null,
      isPaperTrade: 0,
      transactionType: "BUY",
      transactionDate: input.fillDate || new Date().toISOString().slice(0, 10),
      quantity,
      price: fillPrice,
      fees,
      costBasis: quantity * fillPrice + fees,
      quantityRemaining: quantity,
      linkedBuyId: null,
      externalRef: null,
      importBatchId: null,
      notes: input.notes ?? null,
      // Deliberately NOT copied from the paper lot. A plan owns a ladder of
      // rungs against a quantity, and pointing two legs at one plan would let
      // the paper leg's automatic exits draw down the real position. The real
      // leg gets its own plan when the user makes one.
      planId: null,
      promotedFromId: paper.id,
    });

    // The paper row is untouched on purpose. It keeps its quantity, its plan
    // and its rungs, and goes on running as the mechanically-followed baseline.
    return { real, paper: getTransaction.get(id, holderId) };
  });
}

const promotedLegStmt = db.prepare(`
  SELECT id, transaction_date, quantity, price, account_id
  FROM transactions
  WHERE promoted_from_id = ? AND voided_at IS NULL
  ORDER BY transaction_date, id
`);

/**
 * The real trade(s) a paper lot was promoted into, with the entry gap.
 *
 * Positive means the real fill was BETTER than the paper one -- bought cheaper
 * than the plan said. The same sign convention the efficiency report uses, so
 * the two never have to be reconciled in a reader's head.
 */
export function promotedLegs(holderId, paperId) {
  const paper = getTransaction.get(paperId, holderId);
  if (!paper) return [];
  return promotedLegStmt.all(paperId).map((real) => ({
    ...real,
    gapPerShare: paper.price - real.price,
    gapTotal: (paper.price - real.price) * real.quantity,
    daysLate: Math.round(
      (Date.parse(`${real.transaction_date}T00:00:00Z`) -
        Date.parse(`${paper.transaction_date}T00:00:00Z`)) /
        86400000,
    ),
    quantityShortfall: paper.quantity - real.quantity,
  }));
}
