// The "Orders" module: watch a ticker, set a target, get alerted when price
// crosses it. This works on watched_items regardless of is_paper_trade, so
// the same code powers real Orders and Strategy Lab paper ideas.
//
// Alert semantics (this is a judgment call -- flag if it's not what you
// pictured):
//   BUY_LIMIT  fires when last_price <= buy_price_high
//              (and >= buy_price_low, if you set a floor -- otherwise any
//               price at or below the target counts)
//   SELL_LIMIT fires when last_price >= take_profit_low
//              (and <= take_profit_high, if you set a ceiling)
// For a single-number target like "alert me at $11", set buy_price_high (or
// take_profit_low) = 11 and leave the other bound null.
import db, { withTransaction } from "../lib/db.js";
import {
  getOrCreateSecurity,
  refreshQuote,
  backfillHistorical,
  backfillDividendsSplits,
  getHistoryCoverage,
} from "./priceService.js";
import { deliverAlertWebhook } from "./notifyService.js";
import { applySplitToOpenLots } from "./transactionsService.js";

// --- Watchlists (named lists: "Tech", "Dip Buys", etc.) ---------------------
// One list per item, not tags. Every holder gets a default list so nothing
// has to be created before adding a first ticker; `npm run db:init` seeds it
// up front, and getOrCreateDefaultWatchlist() recreates it if it's missing.

// Defined in lib/constants.js (no DB dependency) and re-exported here so
// callers can keep importing it from the service.
export { DEFAULT_WATCHLIST_NAME } from "../lib/constants.js";
import { DEFAULT_WATCHLIST_NAME } from "../lib/constants.js";

const getWatchlistByName = db.prepare("SELECT * FROM watchlists WHERE holder_id = ? AND name = ?");
const insertWatchlist = db.prepare(
  "INSERT INTO watchlists (holder_id, name, sort_order) VALUES (@holderId, @name, @sortOrder) RETURNING *",
);

/** Idempotent: returns the existing list if the name already exists for this holder. */
export function getOrCreateWatchlistByName(holderId, name, sortOrder = 0) {
  const existing = getWatchlistByName.get(holderId, name);
  if (existing) return existing;
  return insertWatchlist.get({ holderId, name, sortOrder });
}

export function getOrCreateDefaultWatchlist(holderId) {
  return getOrCreateWatchlistByName(holderId, DEFAULT_WATCHLIST_NAME);
}

/** Not idempotent -- throws (UNIQUE constraint) if the name already exists. */
export function createWatchlist(holderId, name, sortOrder = 0) {
  return insertWatchlist.get({ holderId, name, sortOrder });
}

const listWatchlistsQuery = db.prepare(`
  SELECT wl.*, COUNT(w.id) AS item_count
  FROM watchlists wl
  LEFT JOIN watched_items w ON w.watchlist_id = wl.id
  WHERE wl.holder_id = ?
  GROUP BY wl.id
  ORDER BY wl.sort_order, wl.name
`);

// --- The virtual "Orders" list ---------------------------------------------
// A system-managed pseudo-list containing every ticker currently held
// (quantity_remaining > 0). Deliberately NOT a real `watchlists` row:
// membership is derived from positions on every read, so it can never drift
// out of sync the way a synced copy would, and there's nothing to migrate
// when a position opens or closes. The id is a string so it can't collide
// with a real numeric watchlist id.
export { ORDERS_LIST_ID } from "../lib/constants.js";
import { ORDERS_LIST_ID } from "../lib/constants.js";

const heldSecuritiesQuery = db.prepare(`
  SELECT
    s.id AS security_id, s.symbol, s.name AS security_name,
    SUM(t.quantity_remaining) AS shares_held,
    MIN(t.transaction_date) AS first_bought,
    SUM(t.cost_basis * (t.quantity_remaining / t.quantity)) AS cost_basis,
    q.last_price, q.prev_close, q.fetched_at AS quote_fetched_at,
    (SELECT COUNT(*) FROM historical_prices hp WHERE hp.security_id = s.id) AS history_days,
    (SELECT MAX(date) FROM historical_prices hp WHERE hp.security_id = s.id) AS history_latest
  FROM transactions t
  JOIN securities s ON s.id = t.security_id
  LEFT JOIN quotes_cache q ON q.security_id = s.id
  WHERE t.holder_id = ? AND t.transaction_type = 'BUY'
    AND t.quantity_remaining > 0 AND t.is_paper_trade = 0
    AND t.voided_at IS NULL
  GROUP BY s.id
  ORDER BY s.symbol
`);

/**
 * Held tickers, shaped to match watched_items rows so the watchlist table can
 * render them without a separate code path. Marked `is_virtual` so the UI can
 * suppress delete buttons and keep the list out of "add to list" dropdowns.
 */
export function listOrdersVirtualItems(holderId) {
  return heldSecuritiesQuery.all(holderId).map((row) => ({
    // Prefixed string id: these aren't real watched_items rows, and anything
    // that tries to treat one as a deletable id should fail loudly.
    id: `virtual-${row.security_id}`,
    is_virtual: 1,
    watchlist_id: ORDERS_LIST_ID,
    watchlist_name: "Orders",
    security_id: row.security_id,
    symbol: row.symbol,
    security_name: row.security_name,
    order_type: "HELD",
    status: "OPEN",
    quantity: row.shares_held,
    buy_price_low: null,
    buy_price_high: null,
    take_profit_low: null,
    take_profit_high: null,
    notes: `${row.shares_held} share(s) since ${row.first_bought}`,
    created_at: row.first_bought,
    last_price: row.last_price,
    prev_close: row.prev_close,
    quote_fetched_at: row.quote_fetched_at,
    history_days: row.history_days,
    history_latest: row.history_latest,
    alert_count: 0,
    cost_basis: row.cost_basis,
  }));
}

export function listWatchlists(holderId) {
  const real = listWatchlistsQuery.all(holderId);
  const heldCount = heldSecuritiesQuery.all(holderId).length;
  // Always present, even when empty, so its purpose stays discoverable.
  return [
    ...real,
    {
      id: ORDERS_LIST_ID,
      name: "Orders",
      item_count: heldCount,
      is_virtual: 1,
      sort_order: 9999,
    },
  ];
}

const renameWatchlistStmt = db.prepare(
  "UPDATE watchlists SET name = @name WHERE id = @id AND holder_id = @holderId",
);
const setWatchlistOrder = db.prepare(
  "UPDATE watchlists SET sort_order = @sortOrder WHERE id = @id AND holder_id = @holderId",
);
const countItemsInList = db.prepare(
  "SELECT COUNT(*) AS n FROM watched_items WHERE watchlist_id = ?",
);
const countListsForHolder = db.prepare("SELECT COUNT(*) AS n FROM watchlists WHERE holder_id = ?");
const deleteWatchlistStmt = db.prepare("DELETE FROM watchlists WHERE id = ? AND holder_id = ?");
const moveItemsToList = db.prepare(
  "UPDATE watched_items SET watchlist_id = @toId WHERE watchlist_id = @fromId AND holder_id = @holderId",
);

// The Orders list is system-managed: it can't be renamed, reordered,
// deleted, or added to. Every mutation path checks this so the guarantee
// holds even if the UI is bypassed.
function assertNotVirtual(id) {
  if (String(id) === ORDERS_LIST_ID) {
    throw new Error("The Orders list is managed automatically and can't be changed.");
  }
}

export function renameWatchlist(holderId, id, name) {
  assertNotVirtual(id);
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("List name is required");
  return { updated: renameWatchlistStmt.run({ id, holderId, name: trimmed }).changes };
}

/** Persists tab order. `orderedIds` is the desired left-to-right sequence. */
export function reorderWatchlists(holderId, orderedIds) {
  return withTransaction(() => {
    let updated = 0;
    orderedIds.forEach((id, index) => {
      // Silently skip the virtual list rather than throwing -- it may appear
      // in an ordering array simply because it was on screen.
      if (String(id) === ORDERS_LIST_ID) return;
      updated += setWatchlistOrder.run({ id: Number(id), holderId, sortOrder: index }).changes;
    });
    return { updated };
  });
}

/**
 * Deletes a list. Because watched_items.watchlist_id is ON DELETE RESTRICT, a
 * non-empty list can't just be dropped -- the caller must either move its
 * items elsewhere (`moveItemsToWatchlistId`) or explicitly opt into deleting
 * them. Refuses to remove a holder's last list, since every item needs one.
 */
export function deleteWatchlist(holderId, id, opts = {}) {
  assertNotVirtual(id);
  return withTransaction(() => {
    if (countListsForHolder.get(holderId).n <= 1) {
      throw new Error("Cannot delete your only list.");
    }
    const itemCount = countItemsInList.get(id).n;
    if (itemCount > 0) {
      if (opts.moveItemsToWatchlistId) {
        moveItemsToList.run({ fromId: id, toId: Number(opts.moveItemsToWatchlistId), holderId });
      } else if (opts.deleteItems) {
        db.prepare("DELETE FROM watched_items WHERE watchlist_id = ? AND holder_id = ?").run(
          id,
          holderId,
        );
      } else {
        throw new Error(
          `This list still has ${itemCount} item(s). Move them to another list or delete them first.`,
        );
      }
    }
    return { deleted: deleteWatchlistStmt.run(id, holderId).changes };
  });
}

// --- Watched items (the "Orders" tab / Strategy Lab ideas) ------------------

const insertWatchedItem = db.prepare(`
  INSERT INTO watched_items (
    holder_id, watchlist_id, security_id, source_id, strategy_id, is_paper_trade, order_type,
    quantity, buy_price_low, buy_price_high, take_profit_low, take_profit_high,
    take_profit_2_low, take_profit_2_high, escape_price, expiration_date, notes
  ) VALUES (
    @holderId, @watchlistId, @securityId, @sourceId, @strategyId, @isPaperTrade, @orderType,
    @quantity, @buyPriceLow, @buyPriceHigh, @takeProfitLow, @takeProfitHigh,
    @takeProfit2Low, @takeProfit2High, @escapePrice, @expirationDate, @notes
  ) RETURNING *
`);

/**
 * @param {object} input
 * @param {number} input.holderId
 * @param {string} input.symbol
 * @param {'BUY_LIMIT'|'SELL_LIMIT'|'WATCH'} input.orderType WATCH = just tracking, no target, never alerts
 * @param {number} [input.watchlistId] explicit list to add to
 * @param {string} [input.watchlistName] find-or-create a list by name (ignored if watchlistId given). Defaults to DEFAULT_WATCHLIST_NAME.
 * @param {boolean} [input.isPaperTrade=false]
 * @param {number} [input.targetPrice] convenience: sets buy_price_high (BUY_LIMIT) or take_profit_low (SELL_LIMIT). Ignored for WATCH.
 * @param {number} [input.escapePrice] stop-loss. Alerts when price falls to or below it, for BUY_LIMIT and SELL_LIMIT alike.
 * @param {number} [input.takeProfit2Low] a second, further-out take-profit. Independent of the first.
 */
export async function addWatchedItem(input) {
  // Adding to the virtual Orders list is meaningless -- membership comes from
  // holding shares, not from a watchlist row. Fall back to the default list.
  const requestedListId =
    String(input.watchlistId) === ORDERS_LIST_ID ? undefined : input.watchlistId;

  const security = await getOrCreateSecurity(input.symbol, { exchangeCode: input.exchangeCode });

  const watchlistId =
    requestedListId ??
    getOrCreateWatchlistByName(input.holderId, input.watchlistName || DEFAULT_WATCHLIST_NAME).id;

  const isPaperTrade = input.isPaperTrade ? 1 : 0;
  let buyPriceHigh = input.buyPriceHigh ?? null;
  let takeProfitLow = input.takeProfitLow ?? null;
  if (input.targetPrice != null) {
    if (input.orderType === "BUY_LIMIT") buyPriceHigh = input.targetPrice;
    if (input.orderType === "SELL_LIMIT") takeProfitLow = input.targetPrice;
  }

  const row = insertWatchedItem.get({
    holderId: input.holderId,
    watchlistId,
    securityId: security.id,
    sourceId: input.sourceId ?? null,
    strategyId: input.strategyId ?? null,
    isPaperTrade,
    orderType: input.orderType,
    quantity: input.quantity ?? null,
    buyPriceLow: input.buyPriceLow ?? null,
    buyPriceHigh,
    takeProfitLow,
    takeProfitHigh: input.takeProfitHigh ?? null,
    takeProfit2Low: input.takeProfit2Low ?? null,
    takeProfit2High: input.takeProfit2High ?? null,
    escapePrice: input.escapePrice ?? null,
    expirationDate: input.expirationDate ?? null,
    notes: input.notes ?? null,
  });

  // Kick off a history backfill for this ticker. Deliberately fire-and-forget:
  // a slow or failed Yahoo history call should never stop a ticker from being
  // added -- the row is already committed above, and backfill is idempotent
  // (UNIQUE(security_id, date)) so a later refresh just fills the gap.
  if (!input.skipBackfill) {
    backfillSecurityHistory(security.id, security.symbol).catch((err) =>
      console.error(`History backfill failed for ${security.symbol}:`, err.message),
    );
  }

  return { ...row, symbol: security.symbol };
}

// Re-fetch a few days either side of the last stored bar rather than starting
// exactly at it: providers occasionally restate a recent close, and the
// insert is idempotent so overlapping costs nothing.
const INCREMENTAL_OVERLAP_DAYS = 5;

/**
 * Pulls daily OHLCV history (plus dividends/splits) for one security.
 * Idempotent -- safe to re-run; existing rows are ignored, gaps get filled.
 *
 * **Incremental by default.** If history is already stored, this fetches only
 * from a few days before the newest bar. A nightly job re-downloading two
 * years of bars to gain one new row is ~99% waste, and hammering an
 * unofficial endpoint that way is how it stops being available.
 *
 * @param {number} securityId
 * @param {string} symbol
 * @param {object} opts
 * @param {number} [opts.years=2] how far back on a FIRST fetch (no stored history)
 * @param {boolean} [opts.full=false] force a complete re-fetch, ignoring what's stored
 * @param {boolean} [opts.withEvents] fetch dividends/splits too. Defaults to
 *   true on a full/first fetch, false on an incremental top-up (they change
 *   rarely, so the nightly job checks them weekly instead).
 */
export async function backfillSecurityHistory(securityId, symbol, opts = {}) {
  const { lastDate, barCount: storedBars } = getHistoryCoverage(securityId);
  const isFirstFetch = opts.full || !lastDate || storedBars === 0;

  let period1;
  if (isFirstFetch) {
    const years = opts.years ?? 2;
    period1 = new Date(Date.now() - years * 365 * 24 * 60 * 60 * 1000);
  } else {
    period1 = new Date(`${lastDate}T00:00:00Z`);
    period1.setUTCDate(period1.getUTCDate() - INCREMENTAL_OVERLAP_DAYS);
  }

  const barCount = await backfillHistorical(securityId, symbol, { period1 });

  const withEvents = opts.withEvents ?? isFirstFetch;
  let events = { dividendCount: 0, splitCount: 0, newSplits: [] };
  if (withEvents) {
    events = await backfillDividendsSplits(securityId, symbol, { period1 });
    // Sorted chronologically so compounding (two splits in one backfill,
    // e.g. catching up a security that's never been fetched before) applies
    // in the right order -- the provider doesn't guarantee return order.
    const splitsInOrder = [...events.newSplits].sort((a, b) =>
      a.splitDate < b.splitDate ? -1 : a.splitDate > b.splitDate ? 1 : 0,
    );
    for (const split of splitsInOrder) {
      try {
        const { lotsAdjusted } = applySplitToOpenLots(securityId, split.splitDate, split.ratio);
        if (lotsAdjusted > 0) {
          console.log(
            `[splits] Applied ${split.ratio} split (${split.splitDate}) to ${lotsAdjusted} open lot(s), security ${securityId}.`,
          );
        }
      } catch (err) {
        console.error(
          `[splits] Failed to apply ${split.ratio} split (${split.splitDate}) for security ${securityId}:`,
          err.message,
        );
      }
    }
  }

  return { symbol, barCount, incremental: !isFirstFetch, ...events };
}

const getWatchedSecurities = db.prepare(`
  SELECT DISTINCT s.id AS security_id, s.symbol
  FROM watched_items w
  JOIN securities s ON s.id = w.security_id
  WHERE w.status IN ('WATCHING','ALERT')
`);

/**
 * Refreshes daily history for every security currently watched or held.
 * This is what the nightly job calls. Sequential on purpose -- firing these
 * in parallel at an unofficial API is how you get blocked.
 *
 * @param {object} opts
 * @param {boolean} [opts.withEvents] force dividends/splits on or off. The
 *   nightly job passes true once a week and false otherwise.
 */
export async function refreshAllHistory(opts = {}) {
  const results = [];
  // Held-but-unwatched tickers need history too -- the Dashboard charts them.
  for (const { security_id, symbol } of getSecuritiesNeedingQuotes.all()) {
    try {
      results.push(await backfillSecurityHistory(security_id, symbol, opts));
    } catch (err) {
      console.error(`History refresh failed for ${symbol}:`, err.message);
      results.push({ symbol, error: err.message });
    }
  }
  return results;
}

const findExistingQuery = db.prepare(`
  SELECT w.id, w.order_type, w.status, w.buy_price_high, w.take_profit_low,
         w.created_at, s.symbol, wl.name AS watchlist_name
  FROM watched_items w
  JOIN securities s ON s.id = w.security_id
  JOIN watchlists wl ON wl.id = w.watchlist_id
  WHERE w.holder_id = @holderId
    AND s.symbol = @symbol
    AND w.status IN ('WATCHING','ALERT')
    AND (@orderType IS NULL OR w.order_type = @orderType)
  ORDER BY w.created_at DESC
`);

/**
 * Finds existing active entries for a symbol, so the UI can warn before
 * adding a duplicate. Deliberately ignores CANCELLED/EXPIRED/EXECUTED items --
 * re-watching something you previously closed out isn't a duplicate, it's a
 * new decision.
 *
 * Looks across ALL of the holder's lists, not just the current one: the same
 * ticker sitting on two different lists with the same intent is exactly the
 * kind of thing worth being told about.
 *
 * @param {number} holderId
 * @param {string} symbol
 * @param {{orderType?: string}} opts omit orderType to match any type
 */
export function findExistingWatchedItems(holderId, symbol, opts = {}) {
  return findExistingQuery.all({
    holderId,
    symbol: String(symbol).trim().toUpperCase(),
    orderType: opts.orderType ?? null,
  });
}

const listQuery = db.prepare(`
  SELECT
    w.*, s.symbol, s.name AS security_name,
    wl.name AS watchlist_name,
    q.last_price, q.prev_close, q.open_price, q.day_high, q.day_low, q.volume,
    q.as_of AS quote_as_of, q.source AS quote_source, q.fetched_at AS quote_fetched_at,
    (SELECT COUNT(*) FROM historical_prices hp WHERE hp.security_id = w.security_id) AS history_days,
    (SELECT MAX(date) FROM historical_prices hp WHERE hp.security_id = w.security_id) AS history_latest,
    (SELECT COUNT(*) FROM alerts a WHERE a.watched_item_id = w.id) AS alert_count
  FROM watched_items w
  JOIN securities s ON s.id = w.security_id
  JOIN watchlists wl ON wl.id = w.watchlist_id
  LEFT JOIN quotes_cache q ON q.security_id = w.security_id
  WHERE w.holder_id = @holderId
    AND (@watchlistId IS NULL OR w.watchlist_id = @watchlistId)
    AND (@isPaperTrade IS NULL OR w.is_paper_trade = @isPaperTrade)
    AND (@status IS NULL OR w.status = @status)
  ORDER BY w.created_at DESC
`);

/**
 * @param {number} holderId
 * @param {{watchlistId?: number, isPaperTrade?: boolean, status?: string}} filters
 */
const recentBarsQuery = db.prepare(`
  SELECT date, close FROM historical_prices
  WHERE security_id = ? ORDER BY date DESC LIMIT ?
`);

/**
 * Attaches the last N daily closes to each row, oldest-first, for the
 * watchlist's inline sparkline.
 *
 * Done as one small query per distinct security rather than a window
 * function over the whole table: a personal watchlist is dozens of rows at
 * most, and this keeps the SQL obvious. Revisit if it ever gets large.
 */
function attachRecentSeries(rows, barCount = 10) {
  const cache = new Map();
  for (const row of rows) {
    if (!cache.has(row.security_id)) {
      // Query returns newest-first (so LIMIT takes the most recent); reverse
      // for chronological plotting.
      cache.set(row.security_id, recentBarsQuery.all(row.security_id, barCount).reverse());
    }
    row.recent_series = cache.get(row.security_id);
  }
  return rows;
}

export function listWatchedItems(holderId, filters = {}) {
  // The Orders list isn't backed by watched_items at all -- it's derived
  // from open positions.
  if (String(filters.watchlistId) === ORDERS_LIST_ID) {
    return attachRecentSeries(listOrdersVirtualItems(holderId));
  }

  // Guard against a filter that was meant to narrow but can't be understood.
  // SQLite binds NaN as NULL, so `@watchlistId IS NULL` would be true and the
  // query would quietly return EVERY item instead of none -- which is exactly
  // how the "watchlist shows all items regardless of list" bug happened.
  // Failing closed (empty) is far safer than failing open (everything).
  const requestedId = filters.watchlistId;
  if (requestedId != null && !Number.isFinite(Number(requestedId))) {
    // String() not JSON.stringify() -- the latter renders NaN as "null",
    // which hides the actual problem in the log.
    console.error(`listWatchedItems: ignoring unrecognised watchlistId "${String(requestedId)}"`);
    return [];
  }

  return attachRecentSeries(
    listQuery.all({
      holderId,
      watchlistId: requestedId ?? null,
      isPaperTrade: filters.isPaperTrade == null ? null : filters.isPaperTrade ? 1 : 0,
      status: filters.status ?? null,
    }),
  );
}

const getItemsForDeletion = db.prepare(`
  SELECT w.id, w.order_type, w.status, s.symbol, wl.name AS watchlist_name,
         (SELECT COUNT(*) FROM alerts a WHERE a.watched_item_id = w.id) AS alert_count,
         (SELECT COUNT(*) FROM transactions t WHERE t.watched_item_id = w.id AND t.voided_at IS NULL) AS transaction_count
  FROM watched_items w
  JOIN securities s ON s.id = w.security_id
  JOIN watchlists wl ON wl.id = w.watchlist_id
  WHERE w.holder_id = @holderId AND w.id = @id
`);

const deleteItem = db.prepare("DELETE FROM watched_items WHERE id = ? AND holder_id = ?");

/**
 * Deletes one or more watched items. Scoped by holderId so an id from
 * another holder can't be deleted by guessing numbers.
 *
 * Cascade behavior worth knowing (defined in schema.sql):
 *   - alerts.watched_item_id is ON DELETE CASCADE -> the item's alert
 *     history goes with it.
 *   - transactions.watched_item_id is ON DELETE SET NULL -> a real trade
 *     executed from this idea survives, but loses the link back to it.
 *
 * All-or-nothing: wrapped in one transaction, so a bad id in the list
 * doesn't leave a half-finished delete.
 *
 * @param {number} holderId
 * @param {number[]} ids
 * @returns {{deleted: number, items: Array}} items = metadata captured before deletion
 */
export function deleteWatchedItems(holderId, ids) {
  const idList = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (idList.length === 0) return { deleted: 0, items: [] };

  return withTransaction(() => {
    const items = [];
    let deleted = 0;
    for (const id of idList) {
      // Capture metadata first -- once the row is gone we can't report on it.
      const meta = getItemsForDeletion.get({ holderId, id });
      if (!meta) continue; // not found, or belongs to a different holder
      const result = deleteItem.run(id, holderId);
      if (result.changes > 0) {
        deleted += result.changes;
        items.push(meta);
      }
    }
    return { deleted, items };
  });
}

// escape_price and the second take-profit are in this list deliberately: they
// were stored by addWatchedItem and then omitted here, so a stop-loss you set
// was structurally excluded from ever being evaluated. No error, no alert --
// the single worst failure mode for a stop (BUG 10). Any column added to
// watched_items that isTriggered reads MUST be added here too.
const getActiveWatching = db.prepare(`
  SELECT w.id, w.order_type, w.buy_price_low, w.buy_price_high,
         w.take_profit_low, w.take_profit_high,
         w.take_profit_2_low, w.take_profit_2_high, w.escape_price,
         w.security_id, s.symbol
  FROM watched_items w
  JOIN securities s ON s.id = w.security_id
  -- ALERT as well as WATCHING. status is a record of what has ALREADY fired,
  -- not a signal to stop looking: an item that hit its take-profit still has a
  -- live stop-loss, and dropping out of evaluation on first alert means the
  -- stop goes silent exactly when a plan has gone wrong -- the target was hit,
  -- the exit was missed, and the price then fell through the floor. It also
  -- made take_profit_2 unreachable, since the first target is always crossed
  -- first. Firing once per LEVEL is enforced in applyAlertIfTriggered.
  --
  -- EXECUTED/CANCELLED/EXPIRED stay excluded: those plans are closed.
  WHERE w.status IN ('WATCHING','ALERT')
`);

// Securities that need a fresh quote: anything actively watched, PLUS
// anything actually held. Held positions were originally missed, so a ticker
// you bought but never added to a watchlist never got a price at all -- its
// Dashboard card and detail panel just showed "no quote".
const getSecuritiesNeedingQuotes = db.prepare(`
  SELECT DISTINCT s.id AS security_id, s.symbol
  FROM securities s
  WHERE s.id IN (SELECT security_id FROM watched_items WHERE status IN ('WATCHING','ALERT'))
     OR s.id IN (
       SELECT security_id FROM transactions
       WHERE transaction_type = 'BUY' AND quantity_remaining > 0 AND voided_at IS NULL
     )
`);

const insertAlert = db.prepare(`
  INSERT INTO alerts (watched_item_id, trigger_price, trigger_reason, message)
  VALUES (@watchedItemId, @triggerPrice, @triggerReason, @message)
`);

const markAlerted = db.prepare(`UPDATE watched_items SET status = 'ALERT' WHERE id = ?`);

// One alert per level per item. Without this, keeping ALERT items in
// evaluation would re-fire the same target on every 15-minute poll for as
// long as the price stayed there.
const alertAlreadyFiredForLevel = db.prepare(
  "SELECT 1 FROM alerts WHERE watched_item_id = ? AND trigger_reason = ?",
);

// Exported (not just internal) specifically so it can be unit-tested with
// plain objects and prices, no DB or network involved -- this is the part
// of the whole watchlist feature most worth getting right and cheapest to
// verify in isolation.
export function isTriggered(item, price) {
  return triggerReason(item, price) !== null;
}

/**
 * Which target a price crossed, or null for none.
 *
 * Split out from isTriggered so the alert can say WHICH level was hit. "target
 * hit" is ambiguous once an item can carry an entry, two take-profits and a
 * stop -- and a stop being hit is the one you least want to mistake for good
 * news.
 *
 * @returns {'STOP'|'BUY'|'TAKE_PROFIT'|'TAKE_PROFIT_2'|null}
 */
export function triggerReason(item, price) {
  // Stop-loss is checked FIRST and for both plan directions. This app is a
  // journal, not an execution path -- an alert here is "notice this and write
  // it down", not "sell now" -- so a stop breach is worth surfacing whether the
  // plan was to buy or to sell, and it outranks any other level that happens to
  // match at the same price.
  if (item.order_type !== "WATCH" && item.escape_price != null && price <= item.escape_price) {
    return "STOP";
  }

  if (item.order_type === "BUY_LIMIT" && item.buy_price_high != null) {
    const aboveFloor = item.buy_price_low == null || price >= item.buy_price_low;
    if (price <= item.buy_price_high && aboveFloor) return "BUY";
  }

  if (item.order_type === "SELL_LIMIT") {
    // Each take-profit is independent: the second is a further-out target, not
    // a refinement of the first, and either one alone is a valid setup.
    if (item.take_profit_low != null) {
      const belowCeiling = item.take_profit_high == null || price <= item.take_profit_high;
      if (price >= item.take_profit_low && belowCeiling) return "TAKE_PROFIT";
    }
    if (item.take_profit_2_low != null) {
      const belowCeiling2 = item.take_profit_2_high == null || price <= item.take_profit_2_high;
      if (price >= item.take_profit_2_low && belowCeiling2) return "TAKE_PROFIT_2";
    }
  }

  // WATCH items (and anything else with no target set) fall through here --
  // intentional, not a gap. "Just watching" means never alerting.
  return null;
}

const TRIGGER_MESSAGES = {
  STOP: (item, price) => `${item.symbol} fell to $${price} — stop-loss level $${item.escape_price} reached`,
  BUY: (item, price) => `${item.symbol} at $${price} — buy target $${item.buy_price_high} reached`,
  TAKE_PROFIT: (item, price) => `${item.symbol} at $${price} — take-profit $${item.take_profit_low} reached`,
  TAKE_PROFIT_2: (item, price) =>
    `${item.symbol} at $${price} — second take-profit $${item.take_profit_2_low} reached`,
};

/**
 * Evaluates one watched_item against a price and, if triggered, writes the
 * alert + status update as a single transaction. Split out from checkAlerts
 * so the DB-write path can be exercised directly in tests without needing a
 * live quote first.
 * @returns {{watchedItemId: number, symbol: string, price: number,
 *   reason: string, message: string} | null}
 */
export function applyAlertIfTriggered(item, price) {
  const reason = triggerReason(item, price);
  if (reason === null) return null;
  // Already fired for this level -- the price simply has not left the band yet.
  if (alertAlreadyFiredForLevel.get(item.id, reason)) return null;
  const message = TRIGGER_MESSAGES[reason](item, price);
  withTransaction(() => {
    insertAlert.run({ watchedItemId: item.id, triggerPrice: price, triggerReason: reason, message });
    markAlerted.run(item.id);
  });
  // `reason` rides along so callers -- the bell, the Home Assistant webhook --
  // can tell a stop from a profit target without re-deriving it from prose.
  return { watchedItemId: item.id, symbol: item.symbol, price, reason, message };
}

const listUnacknowledgedAlertsQuery = db.prepare(`
  SELECT a.id, a.watched_item_id, a.triggered_at, a.trigger_price, a.message, s.symbol
  FROM alerts a
  JOIN watched_items w ON w.id = a.watched_item_id
  JOIN securities s ON s.id = w.security_id
  WHERE w.holder_id = ? AND a.acknowledged_at IS NULL
  ORDER BY a.triggered_at DESC
`);

/** Powers the header bell -- every alert this holder hasn't dismissed yet, newest first. */
export function listUnacknowledgedAlerts(holderId) {
  return listUnacknowledgedAlertsQuery.all(holderId);
}

const acknowledgeAlertStmt = db.prepare(`
  UPDATE alerts SET acknowledged_at = datetime('now')
  WHERE id = ? AND acknowledged_at IS NULL
    AND watched_item_id IN (SELECT id FROM watched_items WHERE holder_id = ?)
`);

/**
 * Clearing the bell doesn't touch the watched_item's own `status` -- that
 * stays 'ALERT' (see markAlerted above) so the item's history is honest
 * about "this target fired." Acknowledging only silences the notification,
 * it isn't the same action as re-arming the watch.
 */
export function acknowledgeAlert(holderId, alertId) {
  return { acknowledged: acknowledgeAlertStmt.run(alertId, holderId).changes };
}

const acknowledgeAllAlertsStmt = db.prepare(`
  UPDATE alerts SET acknowledged_at = datetime('now')
  WHERE acknowledged_at IS NULL
    AND watched_item_id IN (SELECT id FROM watched_items WHERE holder_id = ?)
`);

export function acknowledgeAllAlerts(holderId) {
  return { acknowledged: acknowledgeAllAlertsStmt.run(holderId).changes };
}

/**
 * Refreshes quotes for everything watched OR held, then evaluates each
 * actively-watched item against its target. Returns newly-fired alerts. This
 * is the function a cron job calls on a timer.
 *
 * Refreshing held-but-unwatched tickers matters: without it, a position you
 * bought and never watchlisted would permanently show no price on the
 * Dashboard.
 *
 * @param {{provider?: 'yahoo'|'finnhub'}} opts
 */
export async function checkAlerts(opts = {}) {
  const targets = getSecuritiesNeedingQuotes.all();

  const latestPrices = new Map();
  const failures = [];
  for (const { security_id, symbol } of targets) {
    try {
      const quote = await refreshQuote(security_id, symbol, opts);
      latestPrices.set(security_id, quote.price);
    } catch (err) {
      console.error(`Failed to refresh quote for ${symbol}:`, err.message);
      failures.push({ symbol, error: err.message });
    }
  }

  const firedAlerts = [];
  for (const item of getActiveWatching.all()) {
    const price = latestPrices.get(item.security_id);
    if (price == null) continue;
    const result = applyAlertIfTriggered(item, price);
    if (result) firedAlerts.push(result);
  }
  // Returned as an array for backwards compatibility with existing callers
  // that do `fired.length`; extra detail hangs off named properties.
  firedAlerts.refreshedCount = latestPrices.size;
  firedAlerts.failures = failures;

  // Best-effort, never throws -- see notifyService.js's own comment for why
  // a webhook failure shouldn't fail this call.
  await deliverAlertWebhook(firedAlerts);

  return firedAlerts;
}

/**
 * Refreshes one ticker: its quote, and optionally backfills daily history.
 * Powers the Refresh button in the Dashboard's ticker detail dialog, so a
 * single card can be updated without re-polling the whole portfolio.
 */
export async function refreshSingleTicker(symbol, { withHistory = true } = {}) {
  const security = await getOrCreateSecurity(symbol);
  const quote = await refreshQuote(security.id, security.symbol);

  let historyBars = null;
  if (withHistory) {
    try {
      const result = await backfillSecurityHistory(security.id, security.symbol);
      historyBars = result.barCount;
    } catch (err) {
      // A history failure shouldn't fail the whole refresh -- the quote,
      // which is what the user actually clicked for, already succeeded.
      console.error(`History refresh failed for ${security.symbol}:`, err.message);
    }
  }

  // The price may now cross a target on an existing watched item.
  const fired = [];
  for (const item of getActiveWatching.all()) {
    if (item.security_id !== security.id) continue;
    const result = applyAlertIfTriggered(item, quote.price);
    if (result) fired.push(result);
  }

  await deliverAlertWebhook(fired);

  return { symbol: security.symbol, price: quote.price, historyBars, firedAlerts: fired };
}
