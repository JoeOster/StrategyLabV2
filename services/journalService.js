// Journal / Strategy Lab: paper trade ideas linked to a specific source
// (book/guru/site) and, optionally, a specific strategy (a chapter, a rule, a
// specific call). The "execute" flow is what turns a paper idea into a real
// trade once you actually act on it.
//
// Deliberately thin. Paper ideas ARE watched_items (is_paper_trade=1) and
// executed trades ARE transactions -- this file doesn't duplicate that
// storage, it just adds the strategy layer on top and orchestrates the one
// new operation (execute) that spans both tables. See docs/STATUS.md's
// "Journal / Strategy Lab" section for the judgment calls made here.
import db, { withTransaction } from "../lib/db.js";
import { addWatchedItem, deleteWatchedItems } from "./watchlistService.js";
import { recordBuyWith } from "./transactionsService.js";
import { getOrCreateSecurity } from "./priceService.js";

// --- Strategies --------------------------------------------------------------
// A strategy is source-independent (schema v5+): the same strategy ("Buy the
// dip") can be tagged with multiple sources -- a book AND a podcast AND a
// person -- each with its own chapter/page/notes, via the strategy_sources
// join table. A strategy must be created with at least one source (the whole
// point of the Journal is tying an idea back to where it came from), but more
// can be added or removed afterward, and deleting a source only removes that
// one tag -- the strategy itself survives as long as it has other tags (or
// even none; nothing stops a strategy from ending up untagged).

const insertStrategy = db.prepare(`
  INSERT INTO strategies (title, notes) VALUES (@title, @notes) RETURNING *
`);
const updateStrategyStmt = db.prepare(`
  UPDATE strategies SET title = @title, notes = @notes WHERE id = @id
`);
const getStrategyStmt = db.prepare("SELECT * FROM strategies WHERE id = ?");
const deleteStrategyStmt = db.prepare("DELETE FROM strategies WHERE id = ?");

const insertStrategySource = db.prepare(`
  INSERT INTO strategy_sources (strategy_id, source_id, chapter, page_number, notes)
  VALUES (@strategyId, @sourceId, @chapter, @pageNumber, @notes) RETURNING *
`);
const updateStrategySourceStmt = db.prepare(`
  UPDATE strategy_sources SET chapter = @chapter, page_number = @pageNumber, notes = @notes
  WHERE id = @id
`);
const getStrategySourceStmt = db.prepare("SELECT * FROM strategy_sources WHERE id = ?");
const deleteStrategySourceStmt = db.prepare("DELETE FROM strategy_sources WHERE id = ?");

const listStrategySourcesQuery = db.prepare(`
  SELECT ss.*, s.name AS source_name, s.type AS source_type
  FROM strategy_sources ss
  JOIN advice_sources s ON s.id = ss.source_id
  WHERE ss.strategy_id = ?
  ORDER BY s.name
`);

/** Every source a strategy is tagged with, each carrying its own chapter/page/notes. */
export function listStrategySources(strategyId) {
  return listStrategySourcesQuery.all(strategyId);
}

const listStrategiesQuery = db.prepare(`
  SELECT st.*,
    (SELECT COUNT(*) FROM watched_items w WHERE w.strategy_id = st.id) AS idea_count,
    (
      SELECT GROUP_CONCAT(name, ', ') FROM (
        SELECT s.name AS name
        FROM strategy_sources ss JOIN advice_sources s ON s.id = ss.source_id
        WHERE ss.strategy_id = st.id
        ORDER BY s.name
      )
    ) AS source_names
  FROM strategies st
  WHERE (
    @sourceId IS NULL
    OR EXISTS (SELECT 1 FROM strategy_sources ss WHERE ss.strategy_id = st.id AND ss.source_id = @sourceId)
  )
  ORDER BY st.title
`);

/** @param {{sourceId?: number}} filters omit sourceId for every strategy across every source */
export function listStrategies(filters = {}) {
  return listStrategiesQuery.all({ sourceId: filters.sourceId ?? null });
}

export function getStrategy(id) {
  const strategy = getStrategyStmt.get(id);
  if (!strategy) return null;
  return { ...strategy, sources: listStrategySources(id) };
}

function normalizeSourceTag(tag) {
  const sourceId = Number(tag?.sourceId);
  if (!Number.isFinite(sourceId)) throw new Error("Each source tag needs a sourceId");
  return {
    sourceId,
    chapter: tag.chapter || null,
    pageNumber: tag.pageNumber != null && tag.pageNumber !== "" ? Number(tag.pageNumber) : null,
    notes: tag.notes || null,
  };
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.notes]
 * @param {{sourceId: number, chapter?: string, pageNumber?: number, notes?: string}[]} input.sources
 *   At least one required -- see module note above.
 */
export function createStrategy(input) {
  const title = String(input?.title || "").trim();
  if (!title) throw new Error("title is required");
  const sources = Array.isArray(input?.sources) ? input.sources : [];
  if (sources.length === 0) throw new Error("At least one source is required");
  const tags = sources.map(normalizeSourceTag);

  return withTransaction(() => {
    const strategy = insertStrategy.get({ title, notes: input.notes || null });
    for (const tag of tags) {
      insertStrategySource.run({ strategyId: strategy.id, ...tag });
    }
    return getStrategy(strategy.id);
  });
}

export function updateStrategy(id, input) {
  const existing = getStrategyStmt.get(id);
  if (!existing) throw new Error("Strategy not found");
  const title = String(input?.title ?? existing.title).trim();
  if (!title) throw new Error("title is required");

  updateStrategyStmt.run({ id, title, notes: input.notes ?? existing.notes });
  return getStrategy(id);
}

/** Watched items referencing this strategy have strategy_id SET NULL (schema ON DELETE SET NULL) -- the idea itself survives, just loses the strategy link. strategy_sources rows CASCADE. */
export function deleteStrategy(id) {
  return { deleted: deleteStrategyStmt.run(id).changes };
}

/** Tag an existing strategy with an additional source. */
export function addStrategySource(strategyId, tag) {
  if (!getStrategyStmt.get(strategyId)) throw new Error("Strategy not found");
  const normalized = normalizeSourceTag(tag);
  try {
    return insertStrategySource.get({ strategyId, ...normalized });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new Error("This strategy is already tagged with that source");
    }
    throw err;
  }
}

/** Edit the chapter/page/notes of an existing source tag (not which strategy or source it points to). */
export function updateStrategySource(linkId, input) {
  const existing = getStrategySourceStmt.get(linkId);
  if (!existing) throw new Error("Source tag not found");
  updateStrategySourceStmt.run({
    id: linkId,
    chapter: input.chapter !== undefined ? input.chapter || null : existing.chapter,
    pageNumber:
      input.pageNumber !== undefined
        ? input.pageNumber !== null && input.pageNumber !== ""
          ? Number(input.pageNumber)
          : null
        : existing.page_number,
    notes: input.notes !== undefined ? input.notes || null : existing.notes,
  });
  return getStrategySourceStmt.get(linkId);
}

/** Untag a source from a strategy. Permitted even if it's the last tag -- a strategy can end up source-less rather than being force-deleted. */
export function removeStrategySource(linkId) {
  return { deleted: deleteStrategySourceStmt.run(linkId).changes };
}

// --- Journal ideas (paper watched_items) -------------------------------------
// Deliberately just watched_items with is_paper_trade=1 -- see
// watchlistService.js for the underlying CRUD, alert logic, and lot-free
// tracking. This section only adds what's Journal-specific: requiring a
// source, joining strategy/source names for display, and filtering to paper
// items only (the regular Watchlist view now defaults to isPaperTrade=false
// specifically so these never show up mixed in there -- see server.js).

// strategy_sources is joined on BOTH strategy_id AND source_id -- since a
// strategy can now be tagged with several sources, this picks out the one
// chapter/page/notes that's specific to the source actually used for THIS
// idea (rather than a single strategy-level chapter, which no longer exists).
const listIdeasQuery = db.prepare(`
  SELECT
    w.*, s.symbol, s.name AS security_name,
    wl.name AS watchlist_name,
    src.name AS source_name,
    st.title AS strategy_title,
    ss.chapter AS strategy_chapter, ss.page_number AS strategy_page_number,
    q.last_price, q.prev_close, q.fetched_at AS quote_fetched_at
  FROM watched_items w
  JOIN securities s ON s.id = w.security_id
  JOIN watchlists wl ON wl.id = w.watchlist_id
  LEFT JOIN advice_sources src ON src.id = w.source_id
  LEFT JOIN strategies st ON st.id = w.strategy_id
  LEFT JOIN strategy_sources ss ON ss.strategy_id = w.strategy_id AND ss.source_id = w.source_id
  LEFT JOIN quotes_cache q ON q.security_id = w.security_id
  WHERE w.holder_id = @holderId
    AND w.is_paper_trade = 1
    AND (@sourceId IS NULL OR w.source_id = @sourceId)
    AND (@strategyId IS NULL OR w.strategy_id = @strategyId)
    AND (@status IS NULL OR w.status = @status)
  ORDER BY w.created_at DESC
`);

/** @param {{sourceId?: number, strategyId?: number, status?: string}} filters */
export function listJournalIdeas(holderId, filters = {}) {
  return listIdeasQuery.all({
    holderId,
    sourceId: filters.sourceId ?? null,
    strategyId: filters.strategyId ?? null,
    status: filters.status ?? null,
  });
}

/**
 * Records a new paper idea. A source is required -- the entire point of the
 * Journal is tying an idea back to where it came from; an untethered paper
 * watch is just... the Watchlist's WATCH type, which already exists.
 * @param {object} input
 * @param {number} input.holderId
 * @param {number} input.sourceId
 * @param {number} [input.strategyId]
 * @param {string} input.symbol
 * @param {'BUY_LIMIT'|'SELL_LIMIT'|'WATCH'} input.orderType
 * @param {number} [input.targetPrice]
 * @param {string} [input.notes]
 */
export async function recordJournalIdea(input) {
  if (!input.sourceId) throw new Error("sourceId is required for a Journal idea");
  return addWatchedItem({ ...input, isPaperTrade: true });
}

const getIdeaStmt = db.prepare("SELECT * FROM watched_items WHERE id = ? AND holder_id = ?");
// The status is re-asserted in the UPDATE, not just checked beforehand: zero
// changed rows is then a reliable "someone else executed this first" signal.
// See executeJournalIdea for why a prior read cannot stand in for it (BUG 5).
const markExecuted = db.prepare(
  `UPDATE watched_items SET status = 'EXECUTED', updated_at = datetime('now')
    WHERE id = ? AND status IN ('WATCHING','ALERT')`,
);

/**
 * Turns a paper idea into a real trade: records an actual BUY (fees, real
 * fill price/quantity/date -- deliberately NOT auto-copied from the paper
 * target, since a real fill rarely matches the target exactly) and marks the
 * idea EXECUTED, linking the new transaction back to it.
 *
 * v1 only supports executing into a BUY. A paper SELL_LIMIT idea still gets
 * its alert fired normally by the existing checkAlerts() path; turning that
 * into an actual sale reuses the Orders "Sell" flow against your real
 * holding, which already exists and doesn't need a Journal-specific version.
 *
 * @param {number} holderId
 * @param {number} itemId
 * @param {object} fill
 * @param {string} fill.transactionDate 'YYYY-MM-DD'
 * @param {number} fill.quantity actual filled quantity
 * @param {number} fill.price actual fill price per share
 * @param {number} [fill.fees=0]
 * @param {number} [fill.accountId]
 * @param {string} [fill.notes]
 */
export async function executeJournalIdea(holderId, itemId, fill) {
  const item = getIdeaStmt.get(itemId, holderId);
  if (!item) throw new Error("Journal idea not found");
  if (!item.is_paper_trade) throw new Error("This is already a real watched item, not a paper idea.");
  if (item.status !== "WATCHING" && item.status !== "ALERT") {
    throw new Error(`Cannot execute an idea with status ${item.status}.`);
  }

  const security = db.prepare("SELECT symbol FROM securities WHERE id = ?").get(item.security_id);

  // BUG 5: the status check above is advisory only. Two near-simultaneous
  // calls -- a double-clicked Execute, or a client retry after a slow response
  // -- could both pass it, both record a BUY, and both mark the idea executed,
  // booking the same trade twice with nothing surfaced.
  //
  // It used to be unfixable here without duplicating recordBuy: it does a
  // network lookup before writing, and withTransaction takes a synchronous
  // function, so the buy had to happen outside any transaction. That is no
  // longer true. The lookup is hoisted out and recordBuyWith takes the
  // resolved security, so the write and the status flip now happen in one
  // transaction with no await between them -- which, in a single-threaded
  // process, is genuinely atomic.
  const resolvedSecurity = await getOrCreateSecurity(security.symbol);

  const transaction = withTransaction(() => {
    const txn = recordBuyWith(resolvedSecurity, {
      holderId,
      transactionDate: fill.transactionDate,
      quantity: fill.quantity,
      price: fill.price,
      fees: fill.fees ?? 0,
      accountId: fill.accountId ?? null,
      sourceId: item.source_id,
      watchedItemId: item.id,
      isPaperTrade: false,
      notes: fill.notes ?? null,
    });

    // Zero rows means another request executed this idea between our read and
    // here. Throwing rolls the BUY back with it, so the loser of the race
    // writes nothing at all rather than leaving a duplicate trade behind.
    if (markExecuted.run(itemId).changes === 0) {
      throw new Error("This idea was already executed by another request.");
    }
    return txn;
  });

  return { transaction, item: getIdeaStmt.get(itemId, holderId) };
}

/** Abandoning an idea (never executed) is just deleting the watched_item -- reuses the same cascade rules the Watchlist delete flow already relies on. */
export { deleteWatchedItems as deleteJournalIdeas };
