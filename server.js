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
const bookLookup = await import("./services/bookLookupService.js");
const accounts = await import("./services/accountsService.js");
const imports = await import("./services/importService.js");
const plans = await import("./services/plansService.js");
const alertsSvc = await import("./services/alertsService.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3113;

const app = express();
// 25mb rather than the 100kb default: broker CSVs are posted as text in a
// JSON body (see the import routes below), and the two Fidelity IRA exports
// together are already 86kb before JSON escaping.
app.use(express.json({ limit: "25mb" }));
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

// Shared by the watched-items and journal-idea routes, which record the same
// kind of plan from two different entry points.
function validateStop(escapePrice, targetPrice) {
  const hasStop = escapePrice != null && escapePrice !== "";
  const hasTarget = targetPrice != null && targetPrice !== "";
  if (!hasStop || !hasTarget) return null;
  if (Number(escapePrice) >= Number(targetPrice)) {
    return `Stop-loss ($${Number(escapePrice)}) must be below the target price ($${Number(targetPrice)}).`;
  }
  return null;
}
app.post("/api/watched-items", async (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const {
    symbol, orderType, targetPrice, watchlistId, watchlistName, notes, isPaperTrade,
    escapePrice, takeProfit2Low,
  } = req.body || {};

  if (!symbol || !symbol.trim()) {
    return res.status(400).json({ error: "symbol is required" });
  }
  if (!["BUY_LIMIT", "SELL_LIMIT", "WATCH"].includes(orderType)) {
    return res.status(400).json({ error: "orderType must be BUY_LIMIT, SELL_LIMIT, or WATCH" });
  }
  if (orderType !== "WATCH" && (targetPrice == null || targetPrice === "")) {
    return res.status(400).json({ error: "targetPrice is required for BUY_LIMIT/SELL_LIMIT" });
  }
  // A stop at or above the target is a typo, not a strategy: it would fire the
  // instant it was evaluated and read as the feature being broken.
  const stopError = validateStop(escapePrice, targetPrice);
  if (stopError) return res.status(400).json({ error: stopError });

  try {
    const item = await addWatchedItem({
      holderId: holder.id,
      symbol: symbol.trim(),
      orderType,
      targetPrice: targetPrice != null ? Number(targetPrice) : undefined,
      // Forwarded rather than dropped: the service has always stored these,
      // but nothing sent them and nothing evaluated them (BUG 10).
      escapePrice: escapePrice != null && escapePrice !== "" ? Number(escapePrice) : undefined,
      takeProfit2Low:
        takeProfit2Low != null && takeProfit2Low !== "" ? Number(takeProfit2Low) : undefined,
      watchlistId: watchlistId != null ? Number(watchlistId) : undefined,
      watchlistName,
      notes,
      isPaperTrade: !!isPaperTrade,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("Failed to add watched item:", err);
    // Only a real lookup failure is a 502. Anything else -- a deleted
    // watchlistId hitting a FK constraint, bad input -- kept its own cause but
    // was reported as an unresolvable symbol, pointing at the wrong thing
    // entirely (BUG 12).
    if (err.code === "SYMBOL_LOOKUP_FAILED") {
      return res.status(502).json({ error: `Could not resolve "${symbol}": ${err.message}` });
    }
    res.status(400).json({ error: err.message });
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

// The notifications queue. Distinct from the bell, which only lists what has
// not been silenced: this is every alert with what was DECIDED about it.
app.get("/api/notifications", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(
    alertsSvc.listAlerts(holder.id, {
      unresolvedOnly: req.query.pending === "1",
      limit: Number(req.query.limit) || 200,
    }),
  );
});

// Body: { resolution: 'accepted'|'declined', declineKind?, note?, fillPrice?, fillDate? }
//
// Accepting a PAPER exit rung records the sale at the price the rung fired at --
// that is the plan followed mechanically. Accepting a REAL one requires the
// price actually got: defaulting it to the trigger price would record the ideal
// as though it were real and erase the very gap being measured.
app.post("/api/notifications/:id/resolve", async (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(await alertsSvc.resolveAlert(holder.id, Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
// --- Accounts ----------------------------------------------------------------
// The accounts table shipped in schema v1 but nothing ever wrote to it, which
// blocked CSV import outright (import_batches.account_id is NOT NULL).
//
// The listing carries two dates that are routinely far apart and answer
// different questions: last_transaction_date (how current the data is) and
// last_imported_at (when an import last ran). See docs/IMPORTS.md -- the first
// is what tells you what span to download next, and should be presented as a
// point to start *before*, since overlapping exports deduplicate safely and a
// gap silently loses transactions.
// --- Brokerages ------------------------------------------------------------
// A table since v15, not a CHECK constraint: opening an account somewhere new
// is data, and as an enum it was a schema migration (v11 existed only to add
// two of them).

app.get("/api/brokers", (req, res) => {
  res.json(accounts.listBrokers());
});

app.post("/api/brokers", (req, res) => {
  try {
    res.status(201).json(accounts.createBroker(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Rename only. The slug is what importService selects a parser by, so it is
// deliberately not editable -- renaming the label must not move the wiring.
app.patch("/api/brokers/:id", (req, res) => {
  try {
    res.json(accounts.updateBroker(Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/accounts", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  res.json(accounts.listAccounts(holder.id));
});

app.post("/api/accounts", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.status(201).json(accounts.createAccount(holder.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/accounts/:id", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(accounts.updateAccount(holder.id, Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Exit plans ------------------------------------------------------------
// A plan is one entry thesis covering one or more lots, and it owns the exit
// ladder. A rung firing raises an alert and never sells -- this app is a
// journal, and the gap between what the rung said and what was actually done
// is the measurement, so closing it automatically would erase it.

app.get("/api/plans", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const status = req.query.status ? String(req.query.status) : null;
  res.json(plans.listPlans(holder.id, { status }));
});

app.get("/api/plans/:id", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(plans.getPlan(holder.id, Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Body: { tradeId, notes? }. The plan inherits source/strategy from the trade
// rather than asking again -- the thesis is why the trade was made, and the
// trade already records it.
app.post("/api/plans", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { tradeId, notes } = req.body || {};
  if (!tradeId) return res.status(400).json({ error: "tradeId is required" });
  try {
    // get-or-create: opening the ladder for a trade that already has one is
    // not an error, and the dialog should not have to look it up first.
    res.status(201).json(plans.getOrCreatePlanForTrade(holder.id, Number(tradeId), { notes }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Scaling into the same thesis. Body: { tradeId }.
app.post("/api/plans/:id/trades", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  const { tradeId } = req.body || {};
  if (!tradeId) return res.status(400).json({ error: "tradeId is required" });
  try {
    res.json(plans.attachTradeToPlan(holder.id, Number(req.params.id), Number(tradeId)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Body: { kind, quantity, priceLow?, priceHigh?, sequence? }
// A stop is an ordinary rung: kind STOP with priceHigh set.
app.post("/api/plans/:id/exits", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.status(201).json(plans.addExit(holder.id, Number(req.params.id), req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Cancelled rather than deleted: a rung that has fired is part of the record,
// and the service refuses to cancel one for that reason.
app.post("/api/plans/:id/exits/:exitId/cancel", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(plans.cancelExit(holder.id, Number(req.params.id), Number(req.params.exitId)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/trades/:id/detach-plan", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(plans.detachTradeFromPlan(holder.id, Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Broker CSV imports ---------------------------------------------------
// Upload -> preview -> approve. Staging never touches `transactions`; approval
// writes only the rows classified `new`, through recordBuy/recordSell so FIFO,
// cost basis and the void filter all apply. See docs/IMPORTS.md.
//
// Files arrive as text in a JSON body rather than as multipart form data: the
// app deliberately runs on express and yahoo-finance2 and nothing else, and a
// multipart parser would be a third dependency for something the browser can
// already do with FileReader.

// Ahead of /api/imports/:id, or "latest" is parsed as a batch id.
app.get("/api/imports/latest", (req, res) => {
  res.json(imports.latestImportedPerAccount());
});

app.post("/api/imports", (req, res) => {
  try {
    const { accountId, files } = req.body || {};
    res.status(201).json(imports.stageImport({ accountId: Number(accountId), files }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/imports/:id", (req, res) => {
  try {
    res.json(imports.getBatchPreview(Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// The rows the broker disagrees with -- the point of a monthly typo audit.
app.get("/api/imports/:id/discrepancies", (req, res) => {
  try {
    res.json(imports.listDiscrepancies(Number(req.params.id)));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Body: { fields?: string[] } -- omit to apply every difference, or name a
// subset to take the price but not the date, which is the common case when a
// broker reports settlement date rather than trade date.
//
// One row at a time and explicitly, never in bulk: silently rewriting history
// to agree with a CSV is how a journal stops being trustworthy.
app.post("/api/imports/:id/rows/:rowId/correct", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(
      imports.applyCorrection(holder.id, Number(req.params.id), Number(req.params.rowId), {
        fields: Array.isArray(req.body?.fields) ? req.body.fields : null,
      }),
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/imports/:id/approve", async (req, res) => {
  try {
    const rowIds = Array.isArray(req.body?.rowIds) ? req.body.rowIds : null;
    res.json(await imports.approveBatch(Number(req.params.id), { rowIds }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/book-lookup", async (req, res) => {
  try {
    const result = await bookLookup.lookupBook(req.query.isbn || "");
    if (!result.ok) {
      // "not an ISBN" and "an ISBN nobody has" are different problems wanting
      // different UI -- a typo to correct vs. a form to fill in by hand. The
      // 979-8 (Amazon KDP) range routinely hits the second even with the
      // Google Books fallback configured.
      return res.status(result.reason === "invalid-isbn" ? 400 : 404).json({
        error:
          result.reason === "invalid-isbn"
            ? "That doesn't look like an ISBN. Enter 10 or 13 digits."
            : "No book found for that ISBN -- enter the title and author manually.",
      });
    }
    res.json(result.book);
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
  const { symbol, orderType, targetPrice, sourceId, strategyId, notes, escapePrice } =
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
  // A stop at or above the target is a typo, not a strategy: it would fire the
  // instant it was evaluated and read as the feature being broken.
  const stopError = validateStop(escapePrice, targetPrice);
  if (stopError) return res.status(400).json({ error: stopError });
  if (!sourceId) {
    return res.status(400).json({ error: "sourceId is required" });
  }

  try {
    const item = await journal.recordJournalIdea({
      holderId: holder.id,
      symbol: symbol.trim(),
      orderType,
      targetPrice: targetPrice != null ? Number(targetPrice) : undefined,
      escapePrice: escapePrice != null && escapePrice !== "" ? Number(escapePrice) : undefined,
      sourceId: Number(sourceId),
      strategyId: strategyId ? Number(strategyId) : undefined,
      notes,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error("Failed to add journal idea:", err);
    // See the watched-items route above (BUG 12).
    if (err.code === "SYMBOL_LOOKUP_FAILED") {
      return res.status(502).json({ error: `Could not resolve "${symbol}": ${err.message}` });
    }
    res.status(400).json({ error: err.message });
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
      needsReviewOnly: req.query.needsReview === "1",
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
// Clears the "this figure was extrapolated" flag once real records have been
// checked against it. Does not change the numbers -- correcting those is a
// PUT /api/transactions/:id -- it only records that reconciliation happened,
// so the row drops off the outstanding list without losing the fact that it
// was once an estimate.
app.post("/api/transactions/:id/resolve-review", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(txns.resolveReview(holder.id, Number(req.params.id), req.body?.note ?? null));
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

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
    // runNightlyJob() reports rather than throws, so its result has to be
    // checked -- returning {ok:true} unconditionally made this endpoint claim
    // success even when every ticker failed (BUG 4).
    const result = await scheduler.runNightlyJob();
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
// The app now runs as a user-level systemd unit on the orchestrator NUC, so
// `systemctl --user restart strategylab` is what delivers SIGTERM here. The
// old Windows caveat about `taskkill` not reliably reaching a console app no
// longer applies -- that path, and scripts/stop-server.ps1 with it, is gone.
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

// BUG 8 backstop. Node's default for an unhandled rejection is to crash, and
// this app has async timers (both schedulers) whose rejections reach no caller.
// A dropped nightly tick should be a log line, not a dead process.
process.on("unhandledRejection", (reason) => {
  console.error("[server] Unhandled promise rejection:", reason instanceof Error ? reason.message : reason);
});

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
