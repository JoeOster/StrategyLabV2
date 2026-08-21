// Thin HTTP layer. Every route just parses the request, calls a service
// function that's already covered by scripts/test-offline.js, and shapes
// the JSON response -- no business logic lives here.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import db, { assertSchemaCurrent } from "./lib/db.js";

// The schema check MUST run before the service modules are imported. Service
// modules call db.prepare() at module scope, and a prepare() against a table
// or column that doesn't exist yet throws immediately -- which is exactly the
// cryptic failure this check exists to replace. Static `import` statements are
// hoisted and evaluated before any top-level code, so these have to be dynamic
// imports placed after the check to get a readable error instead.
assertSchemaCurrent();

const { getOrCreateDefaultHolder } = await import("./services/holderService.js");
const {
  addWatchedItem,
  listWatchedItems,
  listWatchlists,
  createWatchlist,
  checkAlerts,
  refreshAllHistory,
  findExistingWatchedItems,
  deleteWatchedItems,
  renameWatchlist,
  reorderWatchlists,
  deleteWatchlist,
  refreshSingleTicker,
  listUnacknowledgedAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
} = await import("./services/watchlistService.js");
const settings = await import("./services/settingsService.js");
const sources = await import("./services/sourcesService.js");
const txns = await import("./services/transactionsService.js");
const tickerDetail = await import("./services/tickerDetailService.js");
const scheduler = await import("./services/scheduler.js");
const alertScheduler = await import("./services/alertScheduler.js");
const summary = await import("./services/summaryService.js");
const journal = await import("./services/journalService.js");
const bookLookup = await import("./services/providers/openLibraryProvider.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3113;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/watchlists", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(listWatchlists(holder.id));
});

app.post("/api/watchlists", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { name } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const list = createWatchlist(holder.id, name.trim());
    res.status(201).json(list);
  } catch (err) {
    // UNIQUE(holder_id, name) -- most likely cause of a failed insert here.
    res.status(409).json({ error: `A list named "${name.trim()}" already exists.` });
  }
});

app.get("/api/watched-items", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  // Do NOT blindly Number() this: the virtual Orders list uses the string id
  // "orders", and Number("orders") is NaN -- which SQLite binds as NULL,
  // turning the filter into "match everything". Keep non-numeric ids as
  // strings so the service can recognise the sentinel.
  const raw = req.query.watchlistId;
  const watchlistId =
    raw == null || raw === "" ? undefined : /^\d+$/.test(String(raw)) ? Number(raw) : String(raw);
  // Defaults to real items only, so a Journal paper idea (added since the
  // Journal module went in) never shows up mixed into the regular Watchlist
  // tabs. ?paper=1 opts into paper items instead -- same query param the
  // positions/summary/transactions routes already use for this distinction.
  const isPaperTrade = req.query.paper === "1";
  res.json(listWatchedItems(holder.id, { watchlistId, isPaperTrade }));
});

// Checked by the UI before submitting the add form, so the user gets a
// "you're already watching this" prompt instead of silently creating a
// duplicate. Purely advisory -- the POST below does not enforce it, by
// design: the user is allowed to override.
app.get("/api/watched-items/check", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { symbol, orderType } = req.query;
  if (!symbol || !String(symbol).trim()) {
    return res.status(400).json({ error: "symbol is required" });
  }
  const matches = findExistingWatchedItems(holder.id, String(symbol), {
    orderType: orderType ? String(orderType) : undefined,
  });
  res.json({ matches });
});

app.post("/api/watched-items", async (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { symbol, orderType, targetPrice, watchlistId, watchlistName, notes, isPaperTrade } =
    req.body || {};

  if (!symbol || !symbol.trim()) {
    return res.status(400).json({ error: "symbol is required" });
  }
  if (!["BUY_LIMIT", "SELL_LIMIT", "WATCH"].includes(orderType)) {
    return res.status(400).json({ error: "orderType must be BUY_LIMIT, SELL_LIMIT, or WATCH" });
  }
  if (orderType !== "WATCH" && (targetPrice == null || targetPrice === "")) {
    return res.status(400).json({ error: "targetPrice is required for BUY_LIMIT/SELL_LIMIT" });
  }

  try {
    const item = await addWatchedItem({
      holderId: holder.id,
      symbol: symbol.trim(),
      orderType,
      targetPrice: targetPrice != null ? Number(targetPrice) : undefined,
      watchlistId: watchlistId != null ? Number(watchlistId) : undefined,
      watchlistName,
      notes,
      isPaperTrade: !!isPaperTrade,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("Failed to add watched item:", err);
    res.status(502).json({ error: `Could not resolve "${symbol}": ${err.message}` });
  }
});

// POST rather than DELETE-with-body: this handles both "delete this one" and
// "delete these five" through one endpoint, and a JSON body on a DELETE
// request is inconsistently supported across HTTP tooling.
app.post("/api/watched-items/delete", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { ids } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "ids must be a non-empty array" });
  }
  try {
    const result = deleteWatchedItems(holder.id, ids);
    res.json(result);
  } catch (err) {
    console.error("Delete failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// Header bell: everything this holder hasn't dismissed yet.
app.get("/api/alerts", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(listUnacknowledgedAlerts(holder.id));
});

app.post("/api/alerts/:id/acknowledge", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(acknowledgeAlert(holder.id, Number(req.params.id)));
});

app.post("/api/alerts/acknowledge-all", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(acknowledgeAllAlerts(holder.id));
});

app.post("/api/check-alerts", async (req, res) => {
  try {
    const fired = await checkAlerts();
    res.json({ fired });
  } catch (err) {
    console.error("checkAlerts failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/refresh-history", async (req, res) => {
  try {
    const results = await refreshAllHistory();
    res.json({ results });
  } catch (err) {
    console.error("refreshAllHistory failed:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Settings: watchlist management ----------------------------------------

app.patch("/api/watchlists/:id", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(renameWatchlist(holder.id, Number(req.params.id), req.body?.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/watchlists/reorder", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { orderedIds } = req.body || {};
  if (!Array.isArray(orderedIds)) {
    return res.status(400).json({ error: "orderedIds must be an array" });
  }
  res.json(reorderWatchlists(holder.id, orderedIds));
});

app.post("/api/watchlists/:id/delete", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { moveItemsToWatchlistId, deleteItems } = req.body || {};
  try {
    res.json(deleteWatchlist(holder.id, Number(req.params.id), { moveItemsToWatchlistId, deleteItems }));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// --- Settings: general ------------------------------------------------------

app.get("/api/settings/general", (req, res) => {
  res.json(settings.getGeneralSettings());
});

app.put("/api/settings/general", (req, res) => {
  try {
    const result = settings.saveGeneralSettings(req.body);
    // Re-arm with the new hour / enabled flag rather than waiting for the
    // next run to pick it up.
    scheduler.startScheduler();
    alertScheduler.startAlertScheduler();
    res.json({ ...result, settings: settings.getGeneralSettings() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Settings: exchanges ----------------------------------------------------

app.get("/api/exchanges", (req, res) => res.json(settings.listExchanges()));

app.post("/api/exchanges", (req, res) => {
  try {
    res.status(201).json(settings.createExchange(req.body || {}));
  } catch (err) {
    // UNIQUE(code) is the likely failure here.
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/exchanges/:id/delete", (req, res) => {
  try {
    res.json(settings.deleteExchange(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Settings: account holders ----------------------------------------------

app.get("/api/holders", (req, res) => res.json(settings.listHolders()));

app.post("/api/holders", (req, res) => {
  try {
    res.status(201).json(settings.createHolder(req.body?.name, { makeDefault: req.body?.makeDefault }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/api/holders/:id", (req, res) => {
  try {
    if (req.body?.makeDefault) {
      return res.json(settings.makeHolderDefault(Number(req.params.id)));
    }
    res.json(settings.renameHolder(Number(req.params.id), req.body?.name));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/holders/:id/delete", (req, res) => {
  try {
    res.json(settings.deleteHolder(Number(req.params.id)));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// --- Settings: advice sources -----------------------------------------------

app.get("/api/sources", (req, res) => res.json(sources.listSources()));

app.get("/api/sources/:id", (req, res) => {
  const source = sources.getSource(Number(req.params.id));
  if (!source) return res.status(404).json({ error: "Source not found" });
  res.json(source);
});

app.post("/api/sources", (req, res) => {
  try {
    res.status(201).json(sources.createSource(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/sources/:id", (req, res) => {
  try {
    res.json(sources.updateSourceById(Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/sources/:id/delete", (req, res) => {
  try {
    res.json(sources.deleteSource(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Auto-fill helper for the book source dialog: enter an ISBN, get back a
// title/author to pre-populate. Purely a convenience -- the form works fine
// without it, so a miss or a lookup failure is a 404, not a 500.
app.get("/api/book-lookup", async (req, res) => {
  try {
    const result = await bookLookup.lookupBookByIsbn(req.query.isbn || "");
    if (!result) return res.status(404).json({ error: "No book found for that ISBN." });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// --- Journal / Strategy Lab: strategies --------------------------------------
// A strategy can be tagged with multiple sources (a book AND a podcast AND a
// person), each with its own chapter/page/notes via strategy_sources. Listing
// supports an optional ?sourceId= filter (the Journal UI can narrow the
// Strategy dropdown to strategies tagged with the currently-selected source).

app.get("/api/strategies", (req, res) => {
  const sourceId = req.query.sourceId ? Number(req.query.sourceId) : undefined;
  res.json(journal.listStrategies({ sourceId }));
});

app.get("/api/strategies/:id", (req, res) => {
  const strategy = journal.getStrategy(Number(req.params.id));
  if (!strategy) return res.status(404).json({ error: "Strategy not found" });
  res.json(strategy);
});

// Body: { title, notes?, sources: [{ sourceId, chapter?, pageNumber?, notes? }, ...] }
// At least one source tag is required at creation time.
app.post("/api/strategies", (req, res) => {
  try {
    res.status(201).json(journal.createStrategy(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Body: { title?, notes? } -- source tags are managed via the dedicated
// endpoints below, not through this update.
app.put("/api/strategies/:id", (req, res) => {
  try {
    res.json(journal.updateStrategy(Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/strategies/:id/delete", (req, res) => {
  try {
    res.json(journal.deleteStrategy(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Body: { sourceId, chapter?, pageNumber?, notes? } -- tag an additional
// source onto an existing strategy.
app.post("/api/strategies/:id/sources", (req, res) => {
  try {
    res.status(201).json(journal.addStrategySource(Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/strategies/:id/sources/:linkId", (req, res) => {
  try {
    res.json(journal.updateStrategySource(Number(req.params.linkId), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/strategies/:id/sources/:linkId/delete", (req, res) => {
  try {
    res.json(journal.removeStrategySource(Number(req.params.linkId)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Journal / Strategy Lab: paper ideas -------------------------------------
// These are watched_items with is_paper_trade=1 under the hood (see
// journalService.js) -- kept on their own /api/journal/* path rather than
// reusing /api/watched-items so the Journal UI's fetches are never at risk of
// silently picking up real watches (or vice versa) through a shared endpoint.

app.get("/api/journal/ideas", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(
    journal.listJournalIdeas(holder.id, {
      sourceId: req.query.sourceId ? Number(req.query.sourceId) : undefined,
      strategyId: req.query.strategyId ? Number(req.query.strategyId) : undefined,
      status: req.query.status || undefined,
    }),
  );
});

app.post("/api/journal/ideas", async (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { symbol, orderType, targetPrice, sourceId, strategyId, notes } = req.body || {};

  if (!symbol || !symbol.trim()) {
    return res.status(400).json({ error: "symbol is required" });
  }
  if (!["BUY_LIMIT", "SELL_LIMIT", "WATCH"].includes(orderType)) {
    return res.status(400).json({ error: "orderType must be BUY_LIMIT, SELL_LIMIT, or WATCH" });
  }
  if (orderType !== "WATCH" && (targetPrice == null || targetPrice === "")) {
    return res.status(400).json({ error: "targetPrice is required for BUY_LIMIT/SELL_LIMIT" });
  }
  if (!sourceId) {
    return res.status(400).json({ error: "sourceId is required" });
  }

  try {
    const item = await journal.recordJournalIdea({
      holderId: holder.id,
      symbol: symbol.trim(),
      orderType,
      targetPrice: targetPrice != null ? Number(targetPrice) : undefined,
      sourceId: Number(sourceId),
      strategyId: strategyId ? Number(strategyId) : undefined,
      notes,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("Failed to add journal idea:", err);
    res.status(502).json({ error: `Could not resolve "${symbol}": ${err.message}` });
  }
});

app.post("/api/journal/ideas/:id/execute", async (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { transactionDate, quantity, price, fees, accountId, notes } = req.body || {};

  if (!transactionDate) return res.status(400).json({ error: "transactionDate is required" });
  if (quantity == null || quantity === "") return res.status(400).json({ error: "quantity is required" });
  if (price == null || price === "") return res.status(400).json({ error: "price is required" });

  try {
    const result = await journal.executeJournalIdea(holder.id, Number(req.params.id), {
      transactionDate,
      quantity: Number(quantity),
      price: Number(price),
      fees: fees != null && fees !== "" ? Number(fees) : 0,
      accountId: accountId ? Number(accountId) : undefined,
      notes,
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Orders: executed transactions & positions ------------------------------

// Compact snapshot for external consumers (Prime_Dashboard on the
// Orchestrator NUC). Read-only and stored-data-only, so it's safe to poll
// frequently -- it never triggers a provider call.
app.get("/api/summary", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(
      summary.getDashboardSummary(holder.id, {
        moverLimit: req.query.movers ? Number(req.query.movers) : undefined,
        alertLimit: req.query.alerts ? Number(req.query.alerts) : undefined,
      }),
    );
  } catch (err) {
    console.error("Summary failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/positions", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const isPaperTrade = req.query.paper === "1";
  res.json({
    positions: txns.listOpenPositions(holder.id, { isPaperTrade }),
    summary: txns.getPortfolioSummary(holder.id, { isPaperTrade }),
  });
});

app.get("/api/transactions", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(
    txns.listTransactions(holder.id, {
      isPaperTrade: req.query.paper === "1",
      symbol: req.query.symbol,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      type: req.query.type,
      includeVoided: req.query.includeVoided === "1",
    }),
  );
});

app.post("/api/transactions", async (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const body = req.body || {};
  const { transactionType, symbol, transactionDate } = body;

  if (!symbol || !String(symbol).trim()) {
    return res.status(400).json({ error: "symbol is required" });
  }
  if (!transactionDate) {
    return res.status(400).json({ error: "transactionDate is required" });
  }
  if (!["BUY", "SELL", "DIVIDEND"].includes(transactionType)) {
    return res.status(400).json({ error: "transactionType must be BUY, SELL or DIVIDEND" });
  }

  const input = {
    ...body,
    holderId: holder.id,
    symbol: String(symbol).trim(),
    sourceId: body.sourceId ? Number(body.sourceId) : null,
    strategyId: body.strategyId ? Number(body.strategyId) : null,
    accountId: body.accountId ? Number(body.accountId) : null,
  };

  try {
    if (transactionType === "BUY") return res.status(201).json(await txns.recordBuy(input));
    if (transactionType === "SELL") return res.status(201).json(await txns.recordSell(input));
    return res.status(201).json(await txns.recordDividend(input));
  } catch (err) {
    console.error("Failed to record transaction:", err);
    // Oversell / unknown-ticker are user-correctable, not server faults.
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/transactions/:id", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(txns.updateTransaction(holder.id, Number(req.params.id), req.body || {}));
  } catch (err) {
    // These are user-correctable (oversell, already-sold lot), not faults.
    res.status(400).json({ error: err.message });
  }
});

// Orders are voided, never deleted -- the row survives for the audit trail and
// simply stops counting. The old /delete path is gone rather than aliased, so
// nothing can hard-delete a transaction by hitting a stale URL.
app.post("/api/transactions/:id/void", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(txns.voidTransaction(holder.id, Number(req.params.id), req.body?.reason ?? null));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// Paper Trade tab: promotes a paper BUY into a real one in place (flips
// is_paper_trade, keeps everything else -- see promotePaperTrade's own
// comment in transactionsService.js for why that's enough).
app.post("/api/transactions/:id/promote", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(txns.promotePaperTrade(holder.id, Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/ticker/:symbol/refresh", async (req, res) => {
  try {
    res.json(await refreshSingleTicker(req.params.symbol));
  } catch (err) {
    console.error(`Refresh failed for ${req.params.symbol}:`, err);
    res.status(502).json({ error: err.message });
  }
});

app.get("/api/ticker/:symbol", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const detail = tickerDetail.getTickerDetail(holder.id, req.params.symbol, {
    seriesDays: req.query.days ? Number(req.query.days) : undefined,
  });
  if (!detail) return res.status(404).json({ error: `No data stored for ${req.params.symbol}.` });
  res.json(detail);
});

// Manual trigger, so the nightly job can be exercised without waiting for
// 01:00 or changing the clock.
app.post("/api/scheduler/run-now", async (req, res) => {
  try {
    await scheduler.runNightlyJob();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Strategy Lab V2 listening on http://localhost:${PORT}`);
  scheduler.startScheduler();
  alertScheduler.startAlertScheduler();
});

// Graceful shutdown. Both schedulers' timers are already .unref()'d so they
// wouldn't hold the process open on their own, but stopping them explicitly
// (rather than just letting process.exit tear everything down) avoids a
// scheduled check firing mid-shutdown and writing to a database connection
// that's in the middle of closing. Mirrors the pattern from the old
// Strategy_Lab project's server.js.
//
// Note (Windows): Ctrl+C in the same terminal reliably delivers SIGINT, so
// this handler runs in the common case. A signal sent from *outside* that
// terminal (e.g. `taskkill /PID <pid>` without `/F`) is not guaranteed to
// reach a Windows console app the same way -- see scripts/stop-server.ps1's
// comments for what that means for restarting after a detached process.
function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down...`);
  scheduler.stopScheduler();
  alertScheduler.stopAlertScheduler();
  try {
    db.close();
  } catch (err) {
    console.error("[server] Error closing database:", err.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
