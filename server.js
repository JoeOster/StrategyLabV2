// Thin HTTP layer. Every route just parses the request, calls a service
// function that's already covered by scripts/test-offline.js, and shapes
// the JSON response -- no business logic lives here.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSchemaCurrent } from "./lib/db.js";

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
} = await import("./services/watchlistService.js");
const settings = await import("./services/settingsService.js");
const sources = await import("./services/sourcesService.js");
const txns = await import("./services/transactionsService.js");
const tickerDetail = await import("./services/tickerDetailService.js");

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
  res.json(listWatchedItems(holder.id, { watchlistId }));
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

// --- Orders: executed transactions & positions ------------------------------

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

app.post("/api/transactions/:id/delete", (req, res) => {
  const holder = getOrCreateDefaultHolder();
  try {
    res.json(txns.deleteTransaction(holder.id, Number(req.params.id)));
  } catch (err) {
    res.status(409).json({ error: err.message });
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

app.listen(PORT, () => {
  console.log(`Strategy Lab V2 listening on http://localhost:${PORT}`);
});
