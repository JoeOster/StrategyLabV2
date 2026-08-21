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

const insertTransaction = db.prepare(`
  INSERT INTO transactions (
    holder_id, account_id, security_id, watched_item_id, source_id, strategy_id, is_paper_trade,
    import_batch_id,
    transaction_type, transaction_date, quantity, price, fees, cost_basis,
    quantity_remaining, linked_buy_id, external_ref, notes,
    needs_review, review_reason
  ) VALUES (
    @holderId, @accountId, @securityId, @watchedItemId, @sourceId, @strategyId, @isPaperTrade,
    @importBatchId,
    @transactionType, @transactionDate, @quantity, @price, @fees, @costBasis,
    @quantityRemaining, @linkedBuyId, @externalRef, @notes,
    @needsReview, @reviewReason
  ) RETURNING *
`);

// node:sqlite requires every named parameter to be supplied, so a new optional
// column would otherwise mean touching every insert call site and hoping none
// was missed. Defaulting here means only the paths that actually set a review
// flag have to mention it.
const insertTxn = (params) =>
  insertTransaction.get({ needsReview: 0, reviewReason: null, importBatchId: null, ...params });

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

const getOpenLots = db.prepare(`
  SELECT * FROM transactions
  WHERE holder_id = @holderId AND security_id = @securityId
    AND transaction_type = 'BUY' AND quantity_remaining > 0
    AND is_paper_trade = @isPaperTrade AND voided_at IS NULL
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
    let lots = getOpenLots.all({
      holderId: input.holderId,
      securityId: security.id,
      isPaperTrade,
    });

    if (input.lotId) {
      lots = lots.filter((lot) => lot.id === Number(input.lotId));
      if (lots.length === 0) throw new Error("That lot is not open, or does not belong to you.");
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
        needsReview: input.needsReview ? 1 : 0,
        reviewReason: input.reviewReason ?? null,
        notes: input.notes ?? null,
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
    src.name AS source_name, strat.title AS strategy_title
  FROM transactions t
  JOIN securities s ON s.id = t.security_id
  LEFT JOIN exchanges e ON e.id = s.exchange_id
  LEFT JOIN quotes_cache q ON q.security_id = t.security_id
  LEFT JOIN advice_sources src ON src.id = t.source_id
  LEFT JOIN strategies strat ON strat.id = t.strategy_id
  WHERE t.holder_id = @holderId
    AND t.transaction_type = 'BUY'
    AND t.quantity_remaining > 0
    AND t.is_paper_trade = @isPaperTrade
    AND t.voided_at IS NULL
  ORDER BY s.symbol, t.transaction_date
`);

/**
 * Open position lots with live valuation. One row per lot (not per ticker) so
 * the entry price and holding period of each purchase stay visible -- that's
 * the distinction the old app's "position lot" cards were built around.
 */
export function listOpenPositions(holderId, { isPaperTrade = false } = {}) {
  return openPositionsQuery.all({ holderId, isPaperTrade: isPaperTrade ? 1 : 0 }).map((row) => {
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

/** Portfolio-level roll-up for the header strip. */
export function getPortfolioSummary(holderId, { isPaperTrade = false } = {}) {
  const positions = listOpenPositions(holderId, { isPaperTrade });
  const totalCost = positions.reduce((sum, p) => sum + p.cost_basis, 0);
  const totalValue = positions.reduce((sum, p) => sum + (p.market_value ?? p.cost_basis), 0);
  const realized = listTransactions(holderId, { isPaperTrade, type: "SELL" }).reduce(
    (sum, t) => sum + (t.realized_pnl ?? 0),
    0,
  );
  const dividends = listTransactions(holderId, { isPaperTrade, type: "DIVIDEND" }).reduce(
    (sum, t) => sum + t.price,
    0,
  );
  return {
    positionCount: positions.length,
    totalCost,
    totalValue,
    unrealizedPnl: totalValue - totalCost,
    unrealizedPnlPercent: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : null,
    realizedPnl: realized,
    dividendIncome: dividends,
    // Everything you've actually banked, versus what's still on paper.
    totalReturn: realized + dividends + (totalValue - totalCost),
  };
}

const getTransaction = db.prepare("SELECT * FROM transactions WHERE id = ? AND holder_id = ?");
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
 * "Promotes" a paper BUY into a real one -- the Paper Trade tab's version of
 * Journal's executeJournalIdea(), but simpler: a paper trade here already IS
 * a fully-specified transaction (real quantity/price/date), not just a
 * target-price watch, so there's no separate fill to collect. Promoting is
 * just flipping is_paper_trade 1 -> 0 on the same row -- cost_basis,
 * quantity_remaining, source_id, and strategy_id all carry over untouched,
 * which is exactly what "leaves the Paper Trade tab and joins Orders,
 * retaining the journal links" means in practice.
 *
 * v1 deliberately only supports promoting an untouched lot (nothing sold
 * against it yet, on paper or otherwise) -- promoting a partially-realized
 * paper position would mean deciding what happens to its paper SELL rows
 * too, which is a real design question left for later. See STATUS.md.
 */
export function promotePaperTrade(holderId, id) {
  return withTransaction(() => {
    const txn = getTransaction.get(id, holderId);
    if (!txn) throw new Error("Transaction not found.");
    if (txn.voided_at) throw new Error("This transaction is voided and can't be promoted.");
    if (!txn.is_paper_trade) throw new Error("This is already a real transaction, not a paper trade.");
    if (txn.transaction_type !== "BUY") {
      throw new Error("Only a paper BUY can be promoted -- it's what opens the position.");
    }
    if (txn.quantity_remaining < txn.quantity) {
      throw new Error(
        "This paper position has already been partly or fully sold on paper. Promoting a partially-realized position isn't supported yet -- delete the paper sell(s) first if you want to promote the whole lot.",
      );
    }
    setRealStmt.run(id);
    return getTransaction.get(id, holderId);
  });
}
