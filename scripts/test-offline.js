// Fully offline verification: schema + watchlist CRUD + alert-trigger logic.
// No network calls, so this proves the DB layer and business logic are
// correct without needing live Yahoo/Finnhub access. It is NOT a substitute
// for smoke-test-watchlist.js, which exercises the real provider calls --
// this just covers everything that doesn't require leaving the machine.
import fs from "node:fs";
import path from "node:path";

const TEST_DB_PATH = path.join(process.cwd(), "data", "strategy_lab.test-offline.db");
fs.mkdirSync(path.dirname(TEST_DB_PATH), { recursive: true });
fs.rmSync(TEST_DB_PATH, { force: true });
process.env.DB_PATH = TEST_DB_PATH;

const { default: db } = await import("../lib/db.js");
const schema = fs.readFileSync(path.join(process.cwd(), "schema.sql"), "utf8");
db.exec(schema);
console.log("Schema applied to test DB.");

// schema.sql already contains every migration's effect, so the ledger is
// baselined rather than replayed -- the same thing scripts/init-db.js does for
// a real install. ANY path that applies schema.sql directly has to do this, or
// a later `npm run db:migrate` will try to re-apply files the database already
// has and fail on "table already exists".
const { baseline: baselineMigrations } = await import("../lib/migrate.js");
baselineMigrations();

// Same shared seed init-db uses. Applying schema.sql alone leaves a
// structurally correct database missing the reference rows the app assumes
// exist -- which is how this suite ended up with no brokerages.
const { seedReferenceData } = await import("../lib/seed.js");
seedReferenceData();

const {
  addWatchedItem,
  listWatchedItems,
  isTriggered,
  applyAlertIfTriggered,
  createWatchlist,
  listWatchlists,
  getOrCreateDefaultWatchlist,
  findExistingWatchedItems,
  deleteWatchedItems,
  renameWatchlist: renameWatchlistFn,
  reorderWatchlists: reorderWatchlistsFn,
  deleteWatchlist: deleteWatchlistFn,
  listUnacknowledgedAlerts,
  acknowledgeAlert,
  acknowledgeAllAlerts,
} = await import("../services/watchlistService.js");

// The suite once threw part-way through and took 216 checks down with it,
// unnoticed for weeks, because a crash still exits non-zero and the visible
// output still ended in a long list of OKs. An exit code nobody reads is not
// a signal, so the count itself is checked: a run doing far fewer checks than
// expected has aborted, however healthy it looks.
//
// Raise this when tests are added. Never lower it to make a run pass -- if the
// count dropped, find out what stopped running.
const MIN_EXPECTED_CHECKS = 495;

// Registered as an exit handler, NOT checked at the end of the run: the
// failure this guards against is the suite THROWING part-way through, which
// never reaches the end of the file. An exit handler fires however the
// process ends, so the abort is stated in words after the stack trace rather
// than left for someone to infer from a check count they were not counting.
process.on("exit", () => {
  const total = passed + failed;
  if (total < MIN_EXPECTED_CHECKS) {
    console.error(
      `\nABORTED: only ${total} checks ran, expected at least ${MIN_EXPECTED_CHECKS}.` +
        `\nThe suite stopped early. Any passes above are NOT a clean run.`,
    );
  }
});

let passed = 0;
let failed = 0;
function check(label, condition) {
  if (condition) {
    passed++;
    console.log(`  OK  ${label}`);
  } else {
    failed++;
    console.log(`FAIL  ${label}`);
  }
}

console.log("\n1. isTriggered() logic checks");
check(
  "BUY_LIMIT with single target (buy_price_high only) fires at or below target",
  isTriggered({ order_type: "BUY_LIMIT", buy_price_high: 11, buy_price_low: null }, 11) === true,
);
check(
  "BUY_LIMIT does not fire above target",
  isTriggered({ order_type: "BUY_LIMIT", buy_price_high: 11, buy_price_low: null }, 12) === false,
);
check(
  "BUY_LIMIT with a floor does not fire below the floor (gap-down guard)",
  isTriggered({ order_type: "BUY_LIMIT", buy_price_high: 11, buy_price_low: 9 }, 5) === false,
);
check(
  "SELL_LIMIT with single target (take_profit_low only) fires at or above target",
  isTriggered({ order_type: "SELL_LIMIT", take_profit_low: 200, take_profit_high: null }, 200) === true,
);
check(
  "SELL_LIMIT does not fire below target",
  isTriggered({ order_type: "SELL_LIMIT", take_profit_low: 200, take_profit_high: null }, 199) === false,
);
check(
  "WATCH never fires, regardless of price",
  isTriggered({ order_type: "WATCH", buy_price_high: null, take_profit_low: null }, 999999) === false,
);

console.log("\n1b. Stop-loss and second take-profit (BUG 10)");
// These were stored by addWatchedItem and then omitted from getActiveWatching's
// column list, so isTriggered never saw them: a stop-loss you set was
// structurally incapable of firing. Silent, which for a stop is the worst
// possible failure.
const { triggerReason } = await import("../services/watchlistService.js");

const stopOnSell = { order_type: "SELL_LIMIT", take_profit_low: 20, escape_price: 9 };
check("Stop-loss fires when price falls to it", triggerReason(stopOnSell, 9) === "STOP");
check("Stop-loss fires when price falls below it", triggerReason(stopOnSell, 8.25) === "STOP");
check("Stop-loss does not fire above it", triggerReason(stopOnSell, 9.01) === null);
check("Take-profit still fires normally alongside a stop", triggerReason(stopOnSell, 21) === "TAKE_PROFIT");

// A journal, not an execution path: a broken thesis is worth recording whether
// the plan was to buy or to sell.
const stopOnBuy = { order_type: "BUY_LIMIT", buy_price_high: 11, escape_price: 9 };
check("Stop-loss fires on a BUY_LIMIT plan too", triggerReason(stopOnBuy, 8.5) === "STOP");
check("...and the buy target still fires in its own range", triggerReason(stopOnBuy, 10.5) === "BUY");

// WATCH means never alert. A stop on one would promise an alert that cannot fire.
check(
  "A stop on a WATCH item never fires",
  triggerReason({ order_type: "WATCH", escape_price: 50 }, 10) === null,
);

// Stop outranks everything: if both a stop and a target match, the stop is the
// fact that matters.
check(
  "Stop-loss outranks a take-profit that also matches",
  triggerReason({ order_type: "SELL_LIMIT", take_profit_low: 5, escape_price: 9 }, 9) === "STOP",
);

const tp2 = { order_type: "SELL_LIMIT", take_profit_low: 20, take_profit_2_low: 30 };
check("First take-profit fires in its range", triggerReason(tp2, 21) === "TAKE_PROFIT");
check("Second take-profit fires when only it matches", triggerReason({ order_type: "SELL_LIMIT", take_profit_2_low: 30 }, 31) === "TAKE_PROFIT_2");
check("Neither take-profit fires below both", triggerReason(tp2, 19) === null);

check(
  "isTriggered still agrees with triggerReason",
  isTriggered(stopOnSell, 8) === true && isTriggered(stopOnSell, 15) === false,
);

// The unit checks above pass plain objects straight to triggerReason, so they
// would NOT have caught the actual bug: the fields were real, stored and
// evaluated correctly -- they were simply missing from getActiveWatching's
// SELECT, so the evaluator never received them. Every field triggerReason
// reads must therefore be a column that query fetches, and that invariant is
// worth asserting mechanically rather than remembering.
const wlSource = fs.readFileSync(path.join(process.cwd(), "services/watchlistService.js"), "utf8");
const activeWatchingSql = /const getActiveWatching = db\.prepare\(`([\s\S]*?)`\)/.exec(wlSource)[1];
const reasonBody = /export function triggerReason\(item, price\) \{([\s\S]*?)^\}/m.exec(wlSource)[1];
const fieldsRead = [...new Set([...reasonBody.matchAll(/item\.(\w+)/g)].map((m) => m[1]))];
const notSelected = fieldsRead.filter((f) => !activeWatchingSql.includes(f));
check(
  `getActiveWatching selects every field triggerReason reads (${fieldsRead.length} fields)`,
  notSelected.length === 0,
);
if (notSelected.length) console.log(`      missing from the query: ${notSelected.join(", ")}`);

console.log("\n2. DB wiring checks (no network -- security pre-seeded)");
// NASDAQ comes from the shared reference seed above, not inserted here.
const exchangeId = db.prepare("SELECT id FROM exchanges WHERE code='NASDAQ'").get().id;
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('NVDA', ?, 'NVIDIA Corp', 'manual')",
).run(exchangeId);

const holder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Offline Test', 1) RETURNING *")
  .get();
check("Holder created", holder.id != null);

// addWatchedItem calls getOrCreateSecurity internally, which now finds the
// NVDA row above by symbol alone (no exchangeCode passed) and returns
// without ever touching the network -- this is the exact path that was
// broken before the getOrCreateSecurity fix above.
const item = await addWatchedItem({
  holderId: holder.id,
  symbol: "NVDA",
  orderType: "BUY_LIMIT",
  targetPrice: 11,
  notes: "offline test",
  skipBackfill: true, // no network in this suite; live backfill is smoke-test territory
});
check("Watched item created via addWatchedItem (no network call)", item.id != null && item.symbol === "NVDA");
check("addWatchedItem's targetPrice convenience set buy_price_high", item.buy_price_high === 11);
check("Watched item starts in WATCHING status", item.status === "WATCHING");

console.log("\n2c. Securities uniqueness (BUG 6)");
const priceSvcEarly = await import("../services/priceService.js");

// The DB-level guarantee. `UNIQUE (symbol, exchange_id)` on the table permits
// this, because exchange_id is NULL on almost every row and NULLs never
// compare equal -- which is exactly why duplicates were possible at all.
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('DUPE', NULL, 'Dupe Co', 'manual')",
).run();
let duplicateSymbolRejected = false;
try {
  db.prepare(
    "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('DUPE', NULL, 'Dupe Co Again', 'manual')",
  ).run();
} catch {
  duplicateSymbolRejected = true;
}
check("A second securities row with the same symbol is rejected", duplicateSymbolRejected);

let duplicateAcrossExchangesRejected = false;
try {
  db.prepare(
    "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('DUPE', ?, 'Dupe Co Elsewhere', 'manual')",
  ).run(exchangeId);
} catch {
  duplicateAcrossExchangesRejected = true;
}
check(
  "...and so is the same symbol under a different exchange",
  duplicateAcrossExchangesRejected,
);

// The deterministic half of BUG 6, which needed no concurrency at all: a row
// stored with exchange_id NULL was invisible to a lookup that supplied an
// exchange, so a second row got inserted. Reaching the network here at all
// means the lookup missed -- this suite has no network, so it would fail.
const foundDespiteExchange = await priceSvcEarly.getOrCreateSecurity("DUPE", {
  exchangeCode: "NYSE",
});
check(
  "A NULL-exchange row is found even when an exchangeCode is supplied",
  foundDespiteExchange.symbol === "DUPE" && foundDespiteExchange.name === "Dupe Co",
);
check(
  "...and no second row was created for it",
  db.prepare("SELECT COUNT(*) AS n FROM securities WHERE symbol = 'DUPE'").get().n === 1,
);

// The concurrent half: overlapping calls share one in-flight promise, so both
// callers get the identical object. Two independent calls would each build a
// fresh row object, so reference equality is what distinguishes them.
const [shared1, shared2] = await Promise.all([
  priceSvcEarly.getOrCreateSecurity("DUPE"),
  priceSvcEarly.getOrCreateSecurity("DUPE"),
]);
check("Concurrent lookups for one symbol share a single in-flight call", shared1 === shared2);

// A failed lookup must not leave a poisoned entry that later calls await
// forever. NOSUCH is not in the DB, so this reaches the network and fails --
// what matters is that the second attempt still gets to try.
let firstFailed = false;
let secondAlsoRan = false;
try {
  await priceSvcEarly.getOrCreateSecurity("NOSUCHTICKERXYZ");
} catch {
  firstFailed = true;
}
try {
  await priceSvcEarly.getOrCreateSecurity("NOSUCHTICKERXYZ");
} catch {
  secondAlsoRan = true;
}
check("A failed lookup does not poison later attempts for that symbol", firstFailed && secondAlsoRan);

// Cleaned up so the securities table is back to just NVDA: a later check in
// section 5b counts rows globally, and leaving DUPE behind breaks it.
db.prepare("DELETE FROM securities WHERE symbol = 'DUPE'").run();

console.log("\n2d. Alerts record WHICH level was crossed (BUG 10)");
// The reason is stored as a column, not left to be read back out of the
// message. The point of the app is judging how reliable a source turned out to
// be, and "hit its stop" is the opposite outcome from "hit its target" -- so
// that has to be a GROUP BY, not a text search.
const stopItem = await addWatchedItem({
  holderId: holder.id,
  symbol: "NVDA",
  orderType: "SELL_LIMIT",
  targetPrice: 100,
  escapePrice: 40,
  skipBackfill: true,
});
check("addWatchedItem stores the stop-loss", stopItem.escape_price === 40);

const stopFired = applyAlertIfTriggered({ ...stopItem, symbol: "NVDA" }, 38);
check("A price through the stop fires an alert", stopFired !== null);
check("...tagged as a STOP", stopFired.reason === "STOP");
check("...with a message naming the stop, not a generic 'target hit'", /stop-loss/i.test(stopFired.message));

const storedAlert = db
  .prepare("SELECT * FROM alerts WHERE watched_item_id = ? ORDER BY id DESC LIMIT 1")
  .get(stopItem.id);
check("The reason is persisted as a column", storedAlert.trigger_reason === "STOP");
check("The trigger price is persisted", storedAlert.trigger_price === 38);
check(
  "Outcomes are attributable by reason without parsing prose",
  db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE trigger_reason = 'STOP'").get().n === 1,
);

// A plan whose target fires and is then MISSED must still have a live stop.
// This is the case the feature exists for: the signal went out, the exit did
// not happen, and the price then fell through the floor. Firing the take-profit
// used to take the item out of evaluation permanently, so the stop stayed
// silent exactly when it mattered most.
const missedItem = await addWatchedItem({
  holderId: holder.id,
  symbol: "NVDA",
  orderType: "SELL_LIMIT",
  targetPrice: 10.75,
  escapePrice: 9,
  skipBackfill: true,
});
const hitTarget = applyAlertIfTriggered({ ...missedItem, symbol: "NVDA" }, 10.75);
check("The take-profit fires first", hitTarget?.reason === "TAKE_PROFIT");
check(
  "The item is marked ALERT",
  db.prepare("SELECT status FROM watched_items WHERE id = ?").get(missedItem.id).status === "ALERT",
);
check(
  "The same level does not fire twice while the price sits there",
  applyAlertIfTriggered({ ...missedItem, symbol: "NVDA" }, 10.8) === null,
);
const hitStop = applyAlertIfTriggered({ ...missedItem, symbol: "NVDA" }, 8.9);
check("...but the stop STILL fires after a missed exit", hitStop?.reason === "STOP");
check(
  "Both outcomes are on the record for this plan",
  db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE watched_item_id = ?").get(missedItem.id).n === 2,
);

// An item that has already alerted must stay in the evaluation set, or none of
// the above can happen in the real polling path.
const activeSql = /const getActiveWatching = db\.prepare\(`([\s\S]*?)`\)/.exec(
  fs.readFileSync(path.join(process.cwd(), "services/watchlistService.js"), "utf8"),
)[1];
check("getActiveWatching still evaluates items that have already alerted", /ALERT/.test(activeSql));

db.prepare("DELETE FROM alerts WHERE watched_item_id = ?").run(missedItem.id);
db.prepare("DELETE FROM watched_items WHERE id = ?").run(missedItem.id);

// Cleaned up: later sections count watched_items and alerts globally.
db.prepare("DELETE FROM alerts WHERE watched_item_id = ?").run(stopItem.id);
db.prepare("DELETE FROM watched_items WHERE id = ?").run(stopItem.id);

console.log("\n2b. Watchlist (named list) checks");
const defaultList = getOrCreateDefaultWatchlist(holder.id);
check(
  "Default list was auto-created by addWatchedItem",
  defaultList.name === "Tickers to Watch",
);
check("The item above landed in the General list (no list specified)", item.watchlist_id === defaultList.id);

const techList = createWatchlist(holder.id, "Tech");
check("createWatchlist creates a new named list", techList.id !== defaultList.id && techList.name === "Tech");

try {
  createWatchlist(holder.id, "Tech");
  check("Duplicate list name rejected", false);
} catch {
  check("Duplicate list name rejected", true);
}

const watchOnlyItem = await addWatchedItem({
  holderId: holder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  watchlistId: techList.id,
  notes: "just tracking, no target",
  skipBackfill: true,
});
check("WATCH item created with no targetPrice at all", watchOnlyItem.id != null && watchOnlyItem.buy_price_high == null);
check(
  "WATCH item never counted as triggerable",
  applyAlertIfTriggered(
    { id: watchOnlyItem.id, symbol: "NVDA", order_type: "WATCH", buy_price_high: null, take_profit_low: null },
    50000,
  ) === null,
);

const itemInTechList = await addWatchedItem({
  holderId: holder.id,
  symbol: "NVDA",
  orderType: "SELL_LIMIT",
  targetPrice: 500,
  watchlistName: "Tech",
  notes: "goes in Tech, not General",
  skipBackfill: true,
});
check("addWatchedItem respects an explicit watchlistName", itemInTechList.watchlist_id === techList.id);

const lists = listWatchlists(holder.id);
const generalSummary = lists.find((l) => l.id === defaultList.id);
const techSummary = lists.find((l) => l.id === techList.id);
check(
  "listWatchlists returns both lists with correct item_count",
  generalSummary?.item_count === 1 && techSummary?.item_count === 2, // watchOnlyItem + itemInTechList
);

const generalOnly = listWatchedItems(holder.id, { watchlistId: defaultList.id });
check(
  "listWatchedItems filtered by watchlistId only returns that list's items",
  generalOnly.length === 1 && generalOnly[0].id === item.id,
);

console.log("\n3. Alert write-path checks (applyAlertIfTriggered)");
const notFired = applyAlertIfTriggered(
  { id: item.id, symbol: "NVDA", order_type: "BUY_LIMIT", buy_price_high: 11, buy_price_low: null },
  15,
);
check("No alert written when price is above target", notFired === null);

const beforeAlerts = db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n;
const fired = applyAlertIfTriggered(
  { id: item.id, symbol: "NVDA", order_type: "BUY_LIMIT", buy_price_high: 11, buy_price_low: null },
  10.5,
);
check("Alert fires when price crosses target", fired !== null && fired.price === 10.5);

const afterAlerts = db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n;
check("Exactly one alert row was inserted", afterAlerts === beforeAlerts + 1);

const updatedItem = db.prepare("SELECT status FROM watched_items WHERE id = ?").get(item.id);
check("watched_items.status flipped to ALERT", updatedItem.status === "ALERT");

const list = listWatchedItems(holder.id, {});
check("listWatchedItems reflects the ALERT status", list.find((w) => w.id === item.id)?.status === "ALERT");

console.log("\n3b. Historical price storage + list-query enrichment");
// Seed history directly rather than calling Yahoo -- this verifies the
// storage shape and the listWatchedItems() coverage columns without a
// network dependency. The live backfill path is covered by smoke-test.
const insertBar = db.prepare(
  `INSERT OR IGNORE INTO historical_prices (security_id, date, open, high, low, close, adj_close, volume, source)
   VALUES (?, ?, 1, 2, 0.5, ?, ?, 1000, 'yahoo')`,
);
insertBar.run(item.security_id, "2026-07-20", 10.0, 10.0);
insertBar.run(item.security_id, "2026-07-21", 11.0, 11.0);
insertBar.run(item.security_id, "2026-07-22", 12.0, 12.0);
check("Historical bars stored", db.prepare("SELECT COUNT(*) AS n FROM historical_prices").get().n === 3);

// Re-inserting the same date must be a no-op, not a duplicate -- this is what
// makes the nightly refresh safe to run repeatedly.
insertBar.run(item.security_id, "2026-07-22", 99.0, 99.0);
check(
  "Re-inserting the same date is idempotent (no duplicate row)",
  db.prepare("SELECT COUNT(*) AS n FROM historical_prices").get().n === 3,
);

const enriched = listWatchedItems(holder.id, {}).find((w) => w.id === item.id);
check("listWatchedItems reports history_days", enriched?.history_days === 3);
check("listWatchedItems reports history_latest", enriched?.history_latest === "2026-07-22");
check(
  "listWatchedItems exposes quote metadata columns for the tooltip",
  "quote_fetched_at" in enriched && "quote_source" in enriched && "quote_as_of" in enriched,
);

console.log("\n3d. Duplicate detection (findExistingWatchedItems)");
// State at this point: NVDA exists as BUY_LIMIT (General, now ALERT),
// WATCH (Tech), and SELL_LIMIT (Tech).
check(
  "Finds an existing entry of the same type",
  findExistingWatchedItems(holder.id, "NVDA", { orderType: "WATCH" }).length === 1,
);
check(
  "Does NOT match a different type (NVDA as WATCH vs BUY_LIMIT are both legit)",
  findExistingWatchedItems(holder.id, "NVDA", { orderType: "SELL_LIMIT" }).every(
    (m) => m.order_type === "SELL_LIMIT",
  ),
);
check(
  "Omitting orderType returns every active entry for the symbol",
  findExistingWatchedItems(holder.id, "NVDA").length === 3,
);
check(
  "Unknown symbol returns nothing",
  findExistingWatchedItems(holder.id, "ZZZZ", { orderType: "WATCH" }).length === 0,
);
check(
  "Symbol match is case-insensitive (form input isn't normalized)",
  findExistingWatchedItems(holder.id, "nvda", { orderType: "WATCH" }).length === 1,
);
check(
  "Result carries the list name and type needed for the warning dialog",
  (() => {
    const m = findExistingWatchedItems(holder.id, "NVDA", { orderType: "WATCH" })[0];
    return m.watchlist_name === "Tech" && m.order_type === "WATCH" && m.symbol === "NVDA";
  })(),
);

// Closed-out items shouldn't count as duplicates -- re-watching something
// you previously cancelled is a new decision, not a mistake.
db.prepare("UPDATE watched_items SET status = 'CANCELLED' WHERE id = ?").run(watchOnlyItem.id);
check(
  "CANCELLED entries are not treated as duplicates",
  findExistingWatchedItems(holder.id, "NVDA", { orderType: "WATCH" }).length === 0,
);
db.prepare("UPDATE watched_items SET status = 'WATCHING' WHERE id = ?").run(watchOnlyItem.id);

console.log("\n3c. Table sort/filter logic (pure functions from render.js)");
const { sortItems, filterItems } = await import("../public/js/modules/watchlist/render.js");
const sampleRows = [
  { symbol: "NVDA", security_name: "NVIDIA Corp", status: "WATCHING", order_type: "WATCH", last_price: 120, prev_close: 100, notes: "" },
  { symbol: "AAPL", security_name: "Apple Inc.", status: "ALERT", order_type: "BUY_LIMIT", buy_price_high: 200, last_price: 180, prev_close: 200, notes: "dip buy" },
  { symbol: "INTC", security_name: "Intel Corp", status: "WATCHING", order_type: "WATCH", last_price: null, prev_close: null, notes: "" },
];

const bySymbolAsc = sortItems(sampleRows, "symbol", "asc").map((r) => r.symbol);
check("sortItems sorts strings ascending", JSON.stringify(bySymbolAsc) === JSON.stringify(["AAPL", "INTC", "NVDA"]));

const bySymbolDesc = sortItems(sampleRows, "symbol", "desc").map((r) => r.symbol);
check("sortItems sorts strings descending", JSON.stringify(bySymbolDesc) === JSON.stringify(["NVDA", "INTC", "AAPL"]));

// NVDA is $120, AAPL is $180, INTC has no quote -- so ascending is
// NVDA, AAPL, then the null.
const byPriceAsc = sortItems(sampleRows, "last_price", "asc").map((r) => r.symbol);
check("sortItems sorts numbers, nulls last", JSON.stringify(byPriceAsc) === JSON.stringify(["NVDA", "AAPL", "INTC"]));

const byPriceDesc = sortItems(sampleRows, "last_price", "desc").map((r) => r.symbol);
check("sortItems keeps nulls last even when descending", byPriceDesc[byPriceDesc.length - 1] === "INTC");

const byChange = sortItems(sampleRows, "change_pct", "desc").map((r) => r.symbol);
check("sortItems computes change_pct (NVDA +20% ranks above AAPL -10%)", byChange[0] === "NVDA");

check("sortItems does not mutate the input array", sampleRows[0].symbol === "NVDA");

check("filterItems matches on symbol", filterItems(sampleRows, "nvda").length === 1);
check("filterItems matches on company name", filterItems(sampleRows, "apple").length === 1);
check("filterItems matches on notes", filterItems(sampleRows, "dip").length === 1);
check("filterItems matches on status", filterItems(sampleRows, "alert").length === 1);
check("filterItems with empty query returns everything", filterItems(sampleRows, "  ").length === 3);
check("filterItems with no match returns nothing", filterItems(sampleRows, "zzzz").length === 0);

const { orderTypeLabel } = await import("../public/js/modules/watchlist/render.js");
check("orderTypeLabel renders readable labels", orderTypeLabel("BUY_LIMIT") === "Buy Limit" && orderTypeLabel("WATCH") === "Watching");
check(
  "filterItems matches the readable type label, not just the raw enum",
  filterItems(sampleRows, "buy limit").length === 1,
);
check(
  "filterItems type dropdown narrows to one type",
  filterItems(sampleRows, "", "WATCH").length === 2,
);
check(
  "filterItems combines type dropdown AND text query",
  filterItems(sampleRows, "nvda", "WATCH").length === 1 && filterItems(sampleRows, "aapl", "WATCH").length === 0,
);
check("filterItems with empty type filter returns all types", filterItems(sampleRows, "", "").length === 3);

const byType = sortItems(sampleRows, "order_type", "asc").map((r) => r.order_type);
check("sortItems sorts by type label", byType[0] === "BUY_LIMIT");

console.log("\n3e. Delete (deleteWatchedItems)");
const otherHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Someone Else', 0) RETURNING *")
  .get();
const otherList = createWatchlist(otherHolder.id, "Theirs");
const otherItem = await addWatchedItem({
  holderId: otherHolder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  watchlistId: otherList.id,
  skipBackfill: true,
});

// Ownership: passing another holder's id must be a no-op, not a deletion.
const crossHolder = deleteWatchedItems(holder.id, [otherItem.id]);
check("Cannot delete another holder's item", crossHolder.deleted === 0);
check(
  "Other holder's item still exists",
  db.prepare("SELECT COUNT(*) AS n FROM watched_items WHERE id = ?").get(otherItem.id).n === 1,
);

check("Deleting a non-existent id is a no-op, not an error", deleteWatchedItems(holder.id, [999999]).deleted === 0);
check("Empty id list is a no-op", deleteWatchedItems(holder.id, []).deleted === 0);

// Alert history should cascade away with the item it belongs to.
const alertsBefore = db
  .prepare("SELECT COUNT(*) AS n FROM alerts WHERE watched_item_id = ?")
  .get(item.id).n;
check("Item under test has alert history to lose", alertsBefore > 0);

const singleDelete = deleteWatchedItems(holder.id, [item.id]);
check("Single delete reports one row removed", singleDelete.deleted === 1);
check("Delete returns metadata captured before removal", singleDelete.items[0]?.symbol === "NVDA");
check(
  "Alerts cascade-deleted with the item",
  db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE watched_item_id = ?").get(item.id).n === 0,
);

// Multi-delete: remove the two remaining Tech entries in one call.
const remaining = listWatchedItems(holder.id, {}).map((w) => w.id);
check("Two entries remain before multi-delete", remaining.length === 2);
const multiDelete = deleteWatchedItems(holder.id, remaining);
check("Multi-delete removes all selected entries", multiDelete.deleted === 2);
check("Watchlist is empty afterwards", listWatchedItems(holder.id, {}).length === 0);

// Securities are shared reference data -- deleting a watched item must not
// remove the ticker itself, or price history would vanish with it.
check(
  "Deleting watched items does not delete the security",
  db.prepare("SELECT COUNT(*) AS n FROM securities WHERE symbol = 'NVDA'").get().n === 1,
);
check(
  "Historical price data survives item deletion",
  db.prepare("SELECT COUNT(*) AS n FROM historical_prices").get().n === 3,
);

console.log("\n3f. Scheduled alerts: market hours, webhook, acknowledge");
const { isMarketOpen } = await import("../services/alertScheduler.js");
check(
  "Market closed just before 9:30am ET (Monday)",
  isMarketOpen(new Date("2026-07-27T13:29:00Z")) === false,
);
check(
  "Market open right at 9:30am ET (Monday)",
  isMarketOpen(new Date("2026-07-27T13:30:00Z")) === true,
);
check(
  "Market open mid-afternoon ET (Monday)",
  isMarketOpen(new Date("2026-07-27T19:59:00Z")) === true,
);
check(
  "Market closed right at 4:00pm ET (Monday)",
  isMarketOpen(new Date("2026-07-27T20:00:00Z")) === false,
);
check("Market closed on Saturday", isMarketOpen(new Date("2026-08-01T16:00:00Z")) === false);
check("Market closed on Sunday", isMarketOpen(new Date("2026-07-26T16:00:00Z")) === false);

const { deliverAlertWebhook } = await import("../services/notifyService.js");
const fakeFiredAlerts = [{ watchedItemId: 1, symbol: "NVDA", price: 123.45 }];

check(
  "deliverAlertWebhook no-ops with an empty fired list",
  (await deliverAlertWebhook([])).reason === "no-alerts",
);
check(
  "deliverAlertWebhook no-ops when no URL is configured (default)",
  (await deliverAlertWebhook(fakeFiredAlerts)).reason === "not-configured",
);

const settingsSvcEarly = await import("../services/settingsService.js");
settingsSvcEarly.saveGeneralSettings({ alert_webhook_url: "https://example.invalid/hook" });

const originalFetch = globalThis.fetch;
let capturedRequest = null;
globalThis.fetch = async (url, opts) => {
  capturedRequest = { url, opts };
  return { ok: true, status: 200, statusText: "OK" };
};
const webhookResult = await deliverAlertWebhook(fakeFiredAlerts);
check("deliverAlertWebhook sends when a URL is configured", webhookResult.sent === true);
check("...to the configured URL", capturedRequest?.url === "https://example.invalid/hook");
check(
  "...with the fired alerts in the JSON body",
  JSON.parse(capturedRequest.opts.body).alerts[0].symbol === "NVDA",
);
check(
  "...with no Authorization header when none is configured",
  capturedRequest.opts.headers.Authorization === undefined,
);

// Home Assistant's REST API (the ai_orchestrator integration this hook is
// actually for) requires a bearer token -- confirm it rides along verbatim.
settingsSvcEarly.saveGeneralSettings({ alert_webhook_auth_header: "Bearer test-token-123" });
capturedRequest = null;
await deliverAlertWebhook(fakeFiredAlerts);
check(
  "deliverAlertWebhook sends the configured Authorization header verbatim",
  capturedRequest?.opts.headers.Authorization === "Bearer test-token-123",
);

globalThis.fetch = async () => {
  throw new Error("simulated network failure");
};
const webhookFailResult = await deliverAlertWebhook(fakeFiredAlerts);
check(
  "deliverAlertWebhook swallows a network failure instead of throwing",
  webhookFailResult.sent === false && webhookFailResult.reason === "network-error",
);

globalThis.fetch = originalFetch;
settingsSvcEarly.saveGeneralSettings({ alert_webhook_url: "", alert_webhook_auth_header: "" }); // reset for later sections

// --- Acknowledge flow ---
// Reuses `holder` and `otherHolder` from earlier sections rather than creating
// fresh ones. That used to be load-bearing, because 5c counted every
// account_holders row; it no longer is, but reusing them keeps the fixture
// small.
const alertHolder = holder;
const alertList = createWatchlist(alertHolder.id, "Alert Test List");
const alertItem = await addWatchedItem({
  holderId: alertHolder.id,
  symbol: "NVDA",
  orderType: "BUY_LIMIT",
  buyPriceHigh: 100,
  watchlistId: alertList.id,
  skipBackfill: true,
});
const alertItem2 = await addWatchedItem({
  holderId: alertHolder.id,
  symbol: "NVDA", // reuses the already-seeded NVDA security (section 2) --
  // AAPL/MSFT aren't seeded yet at this point in the file, and this section
  // must stay offline-safe, so no new symbol should be introduced here.
  orderType: "SELL_LIMIT",
  takeProfitLow: 200,
  watchlistId: alertList.id,
  skipBackfill: true,
});
applyAlertIfTriggered(
  { id: alertItem.id, symbol: "NVDA", order_type: "BUY_LIMIT", buy_price_high: 100, buy_price_low: null },
  95,
);
applyAlertIfTriggered(
  { id: alertItem2.id, symbol: "NVDA", order_type: "SELL_LIMIT", take_profit_low: 200, take_profit_high: null },
  210,
);

const unacked = listUnacknowledgedAlerts(alertHolder.id);
check("listUnacknowledgedAlerts returns both fresh alerts", unacked.length === 2);
check(
  "Alerts are ordered newest first",
  new Date(unacked[0].triggered_at) >= new Date(unacked[1].triggered_at),
);

check(
  "Acknowledging another holder's alert is a no-op",
  acknowledgeAlert(otherHolder.id, unacked[0].id).acknowledged === 0,
);
check(
  "...the alert is still unacknowledged after that no-op",
  listUnacknowledgedAlerts(alertHolder.id).length === 2,
);

const ackResult = acknowledgeAlert(alertHolder.id, unacked[0].id);
check("acknowledgeAlert reports one row acknowledged", ackResult.acknowledged === 1);
check(
  "Acknowledged alert no longer appears in the unacknowledged list",
  listUnacknowledgedAlerts(alertHolder.id).length === 1,
);
check(
  "Re-acknowledging the same alert is a no-op the second time",
  acknowledgeAlert(alertHolder.id, unacked[0].id).acknowledged === 0,
);

const ackAllResult = acknowledgeAllAlerts(alertHolder.id);
check("acknowledgeAllAlerts acknowledges the one remaining alert", ackAllResult.acknowledged === 1);
check("Nothing left unacknowledged after Acknowledge All", listUnacknowledgedAlerts(alertHolder.id).length === 0);

// Cleanup: this section reused `holder`, whose watchlist state later
// sections (5e in particular) make specific assumptions about. Remove the
// list and items this section added so it leaves things exactly as it
// found them.
deleteWatchedItems(alertHolder.id, [alertItem.id, alertItem2.id]);
deleteWatchlistFn(alertHolder.id, alertList.id, { deleteItems: true });

console.log("\n5. Settings: general key/value");
const settingsSvc = await import("../services/settingsService.js");
const defaults = settingsSvc.getGeneralSettings();
check("Unset settings fall back to defaults", defaults.app_title === "Strategy Lab");
settingsSvc.saveGeneralSettings({ app_title: "Joe's Lab", default_take_profit_percent: "12.5" });
check("Saved values are read back", settingsSvc.getGeneralSettings().app_title === "Joe's Lab");
const rejected = settingsSvc.saveGeneralSettings({ not_a_real_setting: "x", app_title: "Kept" });
check("Unknown keys are ignored, not written", rejected.ignored.includes("not_a_real_setting"));
check("Known keys in the same patch still save", rejected.saved.includes("app_title"));
check(
  "schema_version cannot be overwritten via settings",
  settingsSvc.saveGeneralSettings({ schema_version: "99" }).ignored.includes("schema_version"),
);

console.log("\n5b. Settings: exchanges");
const newExchange = settingsSvc.createExchange({ code: "tsx", name: "Toronto" });
check("Exchange code is upper-cased", newExchange.code === "TSX");
let dupeExchangeBlocked = false;
try {
  settingsSvc.createExchange({ code: "TSX", name: "Dup" });
} catch {
  dupeExchangeBlocked = true;
}
check("Duplicate exchange code rejected", dupeExchangeBlocked);
check(
  "listExchanges reports how many securities use each one",
  settingsSvc.listExchanges().find((e) => e.code === "NASDAQ")?.security_count === 1,
);
check("Exchange can be deleted", settingsSvc.deleteExchange(newExchange.id).deleted === 1);
check(
  "Deleting an exchange leaves its securities intact",
  db.prepare("SELECT COUNT(*) AS n FROM securities").get().n === 1,
);

console.log("\n5c. Settings: account holders");
const holders = settingsSvc.listHolders();
// Counts what this suite created rather than every row: lib/seed.js creates a
// default holder ("Me") for every database, and a raw total also breaks any
// time another section adds one. The previous version asserted length === 2
// and had a warning comment two sections up telling people not to add holders
// -- a test that constrains the rest of the suite is the wrong shape.
check(
  "listHolders returns the holders this suite created, with counts",
  [holder.id, otherHolder.id].every((id) => holders.some((h) => h.id === id)),
);
const newHolder = settingsSvc.createHolder("Third Person");
check("New holder is not default when others exist", newHolder.is_default === 0);
settingsSvc.makeHolderDefault(newHolder.id);
check(
  "makeHolderDefault promotes exactly one holder",
  settingsSvc.listHolders().filter((h) => h.is_default === 1).length === 1,
);
settingsSvc.renameHolder(newHolder.id, "Renamed Person");
check(
  "renameHolder works",
  settingsSvc.listHolders().find((h) => h.id === newHolder.id)?.name === "Renamed Person",
);
settingsSvc.deleteHolder(newHolder.id);
check(
  "Deleting the default holder promotes another one",
  settingsSvc.listHolders().filter((h) => h.is_default === 1).length === 1,
);

console.log("\n5d. Settings: advice sources");
const sourcesSvc = await import("../services/sourcesService.js");
const bookSource = sourcesSvc.createSource({
  name: "Trading in the Zone",
  type: "book",
  details: { author: "Mark Douglas", isbn: "9780735201446" },
});
check("Book source created with details", bookSource.details.author === "Mark Douglas");
check("getSource merges base row and details", sourcesSvc.getSource(bookSource.id).details.isbn === "9780735201446");

let badTypeRejected = false;
try {
  sourcesSvc.createSource({ name: "Bad", type: "podcast" });
} catch {
  badTypeRejected = true;
}
check("Unknown source type rejected", badTypeRejected);

const personSource = sourcesSvc.createSource({
  name: "Some Guru",
  type: "person",
  details: { email: "guru@example.com", app_type: "Discord" },
});
check("Person source stores its own detail fields", personSource.details.email === "guru@example.com");

// Retyping must not leave the old type's detail row behind.
const retyped = sourcesSvc.updateSourceById(personSource.id, {
  name: "Some Guru's Book",
  type: "book",
  details: { author: "Some Guru" },
});
check("Source can change type", retyped.type === "book" && retyped.details.author === "Some Guru");
check(
  "Stale detail row from the previous type is cleared",
  db.prepare("SELECT COUNT(*) AS n FROM advice_source_person_details WHERE source_id = ?").get(personSource.id).n === 0,
);

check("listSources returns both sources", sourcesSvc.listSources().length === 2);
sourcesSvc.deleteSource(retyped.id);
check("Source deleted", sourcesSvc.listSources().length === 1);
check(
  "Deleting a source cascades its detail row",
  db.prepare("SELECT COUNT(*) AS n FROM advice_source_book_details WHERE source_id = ?").get(retyped.id).n === 0,
);

console.log("\n5e. Settings: watchlist management");
const listA = getOrCreateDefaultWatchlist(holder.id);
const listB = createWatchlist(holder.id, "Temp List");
renameWatchlistFn(holder.id, listB.id, "Renamed List");
check(
  "renameWatchlist works",
  listWatchlists(holder.id).find((w) => w.id === listB.id)?.name === "Renamed List",
);
reorderWatchlistsFn(holder.id, [listB.id, listA.id]);
check("reorderWatchlists puts the chosen list first", listWatchlists(holder.id)[0].id === listB.id);

// Non-empty lists must not silently take their items down with them.
await addWatchedItem({
  holderId: holder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  watchlistId: listB.id,
  skipBackfill: true,
});
let nonEmptyBlocked = false;
try {
  deleteWatchlistFn(holder.id, listB.id);
} catch {
  nonEmptyBlocked = true;
}
check("Deleting a non-empty list is refused by default", nonEmptyBlocked);
deleteWatchlistFn(holder.id, listB.id, { moveItemsToWatchlistId: listA.id });
check("Deleting with moveItemsToWatchlistId relocates the items", listWatchedItems(holder.id, { watchlistId: listA.id }).length === 1);
check("List is gone after its items were moved", listWatchlists(holder.id).every((w) => w.id !== listB.id));

// Reduce to exactly one list before testing the last-list guard -- earlier
// sections left a "Tech" list on this holder, so without this the delete
// below is legitimately allowed and the check would be meaningless.
// listWatchlists now also returns the virtual "Orders" entry, which is not
// deletable -- skip it here and when counting.
for (const wl of listWatchlists(holder.id)) {
  if (!wl.is_virtual && wl.id !== listA.id) deleteWatchlistFn(holder.id, wl.id, { deleteItems: true });
}
check(
  "Exactly one real list remains before the guard test",
  listWatchlists(holder.id).filter((w) => !w.is_virtual).length === 1,
);

let lastListBlocked = false;
try {
  deleteWatchlistFn(holder.id, listA.id, { deleteItems: true });
} catch {
  lastListBlocked = true;
}
check("Cannot delete the only remaining list", lastListBlocked);

console.log("\n5f. Settings: source form mapping (pure functions)");
const { sourceFormToPayload, sourceToFormValues } = await import(
  "../public/js/modules/settings/handlers.js"
);
const fakeForm = new Map([
  ["type", "book"],
  ["name", "  Spaced Title  "],
  ["url", ""],
  ["description", "desc"],
  ["book_author", "An Author"],
  ["book_isbn", ""],
  ["person_email", "should-be-ignored@example.com"],
]);
fakeForm.get = Map.prototype.get.bind(fakeForm);
const payload = sourceFormToPayload(fakeForm);
check("sourceFormToPayload trims the name", payload.name === "Spaced Title");
check("sourceFormToPayload maps prefixed fields into details", payload.details.author === "An Author");
check("sourceFormToPayload converts blanks to null", payload.url === null && payload.details.isbn === null);
check(
  "sourceFormToPayload ignores fields from other types",
  !("email" in payload.details),
);
const formValues = sourceToFormValues({
  id: 7,
  type: "person",
  name: "X",
  url: null,
  description: null,
  details: { email: "a@b.c", phone: null },
});
check("sourceToFormValues re-prefixes detail fields", formValues.person_email === "a@b.c");
check("sourceToFormValues turns nulls into empty strings", formValues.person_phone === "" && formValues.url === "");

console.log("\n6. Transactions: lot accounting");
const tx = await import("../services/transactionsService.js");
const traderHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Trader', 0) RETURNING *")
  .get();

// Two lots of NVDA at different prices, so FIFO ordering is observable.
const lot1 = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-01-10",
  quantity: 100,
  price: 10,
  fees: 5,
});
const lot2 = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-02-20",
  quantity: 50,
  price: 20,
  fees: 5,
});
check("Buy creates a lot with full quantity remaining", lot1.quantity_remaining === 100);
check("Cost basis includes fees", lot1.cost_basis === 100 * 10 + 5);

let openPositions = tx.listOpenPositions(traderHolder.id);
check("Both lots show as open positions", openPositions.length === 2);
check(
  "Lot cost-per-share includes its share of fees",
  Math.abs(openPositions[0].cost_per_share - 10.05) < 1e-9,
);

// Oversell must be refused outright.
let oversellBlocked = false;
try {
  await tx.recordSell({
    holderId: traderHolder.id,
    symbol: "NVDA",
    transactionDate: "2026-03-01",
    quantity: 500,
    price: 25,
  });
} catch (err) {
  oversellBlocked = /only 150 held/.test(err.message);
}
check("Selling more than held is refused with a useful message", oversellBlocked);

// Partial sell inside the first lot only.
const partial = await tx.recordSell({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-03-01",
  quantity: 40,
  price: 15,
});
check("Partial sell creates one sell row", partial.sells.length === 1);
check("Partial sell draws from the oldest lot (FIFO)", partial.sells[0].linked_buy_id === lot1.id);
// 40 shares: proceeds 40*15 = 600, cost 40*10.05 = 402 -> 198
check("Realized P&L on the partial sell is correct", Math.abs(partial.realizedPnl - 198) < 1e-9);

openPositions = tx.listOpenPositions(traderHolder.id);
const remainingLot1 = openPositions.find((p) => p.lot_id === lot1.id);
check("Lot 1 quantity reduced by the sale", remainingLot1.quantity_remaining === 60);
check(
  "Remaining cost basis reflects only the shares still held",
  Math.abs(remainingLot1.cost_basis - 60 * 10.05) < 1e-9,
);

// Sell spanning both lots: 80 shares = 60 from lot1 + 20 from lot2.
const spanning = await tx.recordSell({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-04-01",
  quantity: 80,
  price: 30,
});
check("Multi-lot sell writes one row per lot touched", spanning.sells.length === 2);
check("Multi-lot sell hits the older lot first", spanning.sells[0].linked_buy_id === lot1.id);
check("Multi-lot sell then moves to the next lot", spanning.sells[1].linked_buy_id === lot2.id);
check(
  "Multi-lot sell quantities split correctly",
  spanning.sells[0].quantity === 60 && spanning.sells[1].quantity === 20,
);
// 60 @ cost 10.05 -> proceeds 1800, cost 603 -> 1197
// 20 @ cost 20.10 -> proceeds  600, cost 402 -> 198
check("Realized P&L across lots is correct", Math.abs(spanning.realizedPnl - 1395) < 1e-9);

openPositions = tx.listOpenPositions(traderHolder.id);
check("Fully-drained lot drops out of open positions", openPositions.every((p) => p.lot_id !== lot1.id));
check("Partially-drained lot remains with the right quantity", openPositions[0].quantity_remaining === 30);

console.log("\n6b. Transactions: fee allocation across lots");
const feeSell = spanning.sells;
const totalFees = feeSell.reduce((sum, s) => sum + s.fees, 0);
check("Fees are split across the generated sell rows, not duplicated", Math.abs(totalFees - 0) < 1e-9);
// Pre-seed AAPL: getOrCreateSecurity would otherwise call Yahoo for a
// profile, which has no network in this suite.
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('AAPL', ?, 'Apple Inc.', 'manual')",
).run(exchangeId);

const feeTest = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "AAPL",
  transactionDate: "2026-01-01",
  quantity: 10,
  price: 100,
  fees: 0,
});
const feeSellResult = await tx.recordSell({
  holderId: traderHolder.id,
  symbol: "AAPL",
  transactionDate: "2026-02-01",
  quantity: 10,
  price: 110,
  fees: 20,
});
check(
  "Sell fees reduce realized P&L",
  Math.abs(feeSellResult.realizedPnl - (10 * 110 - 20 - 10 * 100)) < 1e-9,
);

console.log("\n6c. Transactions: history and summary");
const history = tx.listTransactions(traderHolder.id, {});
check("History includes buys and sells", history.length >= 6);
check(
  "SELL rows carry a realized P&L; BUY rows do not",
  history.every((t) => (t.transaction_type === "SELL") === (t.realized_pnl !== null)),
);

await tx.recordDividend({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-05-01",
  amount: 42.5,
});
const summary = tx.getPortfolioSummary(traderHolder.id);
check("Summary counts remaining open lots", summary.positionCount === 1);
check("Summary totals realized P&L", Math.abs(summary.realizedPnl - (198 + 1395 + 80)) < 1e-6);
check("Summary totals dividend income", Math.abs(summary.dividendIncome - 42.5) < 1e-9);

// Orders are never hard-deleted -- schema v7 replaced deleteTransaction with
// voidTransaction, which keeps the row for the audit trail and stops it
// counting. This section still called the old function and therefore threw,
// taking every check after it down with it.
console.log("\n6d. Transactions: voiding restores lot state");
const lastSell = tx
  .listTransactions(traderHolder.id, { type: "SELL" })
  .find((t) => t.linked_buy_id === lot2.id);
const beforeQty = db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(lot2.id)
  .quantity_remaining;
tx.voidTransaction(traderHolder.id, lastSell.id, "test");
const afterQty = db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(lot2.id)
  .quantity_remaining;
check("Voiding a sell returns its shares to the lot", afterQty === beforeQty + lastSell.quantity);
check(
  "A voided sell is stamped rather than removed",
  db.prepare("SELECT voided_at FROM transactions WHERE id = ?").get(lastSell.id).voided_at != null,
);

let voidSoldBuyBlocked = false;
try {
  tx.voidTransaction(traderHolder.id, lot1.id);
} catch {
  voidSoldBuyBlocked = true;
}
check("Cannot void a buy that has already been sold", voidSoldBuyBlocked);

check(
  "Cannot void another holder's transaction",
  tx.voidTransaction(holder.id, lot2.id).voided === 0,
);

console.log("\n6g. Transactions: editing keeps lot accounting consistent");
const editHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Editor', 0) RETURNING *")
  .get();

// Untouched lot: quantity is freely editable.
const editLot = await tx.recordBuy({
  holderId: editHolder.id, symbol: "NVDA", transactionDate: "2026-01-05",
  quantity: 100, price: 10, fees: 0,
});
const editedBuy = tx.updateTransaction(editHolder.id, editLot.id, { quantity: 120, price: 11 });
check("Untouched BUY quantity can be edited", editedBuy.quantity === 120);
check("Editing a BUY recomputes cost basis", editedBuy.cost_basis === 120 * 11);
check("Editing an untouched BUY resets quantity_remaining", editedBuy.quantity_remaining === 120);

check(
  "Type changes are refused",
  (() => {
    try {
      tx.updateTransaction(editHolder.id, editLot.id, { transactionType: "SELL" });
      return false;
    } catch {
      return true;
    }
  })(),
);

// Sell part of it, then the quantity becomes locked.
await tx.recordSell({
  holderId: editHolder.id, symbol: "NVDA", transactionDate: "2026-02-01",
  quantity: 50, price: 20, fees: 0,
});
check(
  "BUY quantity is locked once shares have been sold",
  (() => {
    try {
      tx.updateTransaction(editHolder.id, editLot.id, { quantity: 200 });
      return false;
    } catch (err) {
      return /already been sold/.test(err.message);
    }
  })(),
);

// Correcting the purchase price must fix past sells too, or the books lie.
const sellRow = tx.listTransactions(editHolder.id, { type: "SELL" })[0];
const pnlBefore = sellRow.realized_pnl; // 50*20 - 50*11 = 1000 - 550 = 450
check("Realized P&L before the correction", Math.abs(pnlBefore - 450) < 1e-9);

tx.updateTransaction(editHolder.id, editLot.id, { price: 12 });
const sellAfter = tx.listTransactions(editHolder.id, { type: "SELL" })[0];
check(
  "Correcting a BUY price recomputes linked sells' cost basis",
  Math.abs(sellAfter.cost_basis - 50 * 12) < 1e-9,
);
check(
  "...so realized P&L updates to match (50*20 - 50*12 = 400)",
  Math.abs(sellAfter.realized_pnl - 400) < 1e-9,
);

// Editing a SELL re-allocates against its lot.
const lotBeforeEdit = db
  .prepare("SELECT quantity_remaining FROM transactions WHERE id = ?")
  .get(editLot.id).quantity_remaining;
check("Lot shows 70 remaining after selling 50 of 120", lotBeforeEdit === 70);

tx.updateTransaction(editHolder.id, sellAfter.id, { quantity: 30 });
check(
  "Reducing a SELL returns shares to the lot",
  db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(editLot.id)
    .quantity_remaining === 90,
);

tx.updateTransaction(editHolder.id, sellAfter.id, { quantity: 100 });
check(
  "Increasing a SELL takes more from the lot",
  db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(editLot.id)
    .quantity_remaining === 20,
);

check(
  "A SELL can't be increased beyond what the lot holds",
  (() => {
    try {
      tx.updateTransaction(editHolder.id, sellAfter.id, { quantity: 500 });
      return false;
    } catch (err) {
      return /only holds/.test(err.message);
    }
  })(),
);
check(
  "A failed edit leaves the lot untouched",
  db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(editLot.id)
    .quantity_remaining === 20,
);

check(
  "Cannot edit another holder's transaction",
  (() => {
    try {
      tx.updateTransaction(holder.id, editLot.id, { price: 999 });
      return false;
    } catch (err) {
      return /not found/i.test(err.message);
    }
  })(),
);

// Dividends edit on amount, not quantity/price-per-share.
const divRow = await tx.recordDividend({
  holderId: editHolder.id, symbol: "NVDA", transactionDate: "2026-03-01", amount: 10,
});
const editedDiv = tx.updateTransaction(editHolder.id, divRow.id, { amount: 25 });
check("Dividend amount can be edited", editedDiv.price === 25);
check(
  "Dividend amount must stay positive",
  (() => {
    try {
      tx.updateTransaction(editHolder.id, divRow.id, { amount: 0 });
      return false;
    } catch {
      return true;
    }
  })(),
);

console.log("\n6h. Transactions: strategy_id threading + Paper Trade promote");
// Fresh holder + a strategy to tag lots with, so this section is independent
// of whatever the strategies suite (section 11) does to the same tables.
const paperHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Paper Trader', 0) RETURNING *")
  .get();
const journalSvcForPaper = await import("../services/journalService.js");
const bookSourceForPaper = db
  .prepare("INSERT INTO advice_sources (name, type) VALUES ('Paper Trade Test Source', 'book') RETURNING *")
  .get();
const paperStrategy = journalSvcForPaper.createStrategy({
  title: "Breakout Test Strategy",
  sources: [{ sourceId: bookSourceForPaper.id }],
});

const paperBuy = await tx.recordBuy({
  holderId: paperHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-06-01",
  quantity: 10,
  price: 50,
  fees: 0,
  isPaperTrade: true,
  strategyId: paperStrategy.id,
});
check("A paper BUY is tagged with is_paper_trade", paperBuy.is_paper_trade === 1);
check("A paper BUY carries the given strategy_id", paperBuy.strategy_id === paperStrategy.id);

const paperPositions = tx.listOpenPositions(paperHolder.id, { isPaperTrade: true });
check("Paper positions are scoped separately from real ones", paperPositions.length === 1);
check(
  "Paper position resolves strategy_title via the join",
  paperPositions[0].strategy_title === "Breakout Test Strategy",
);
check(
  "Real positions for the same holder don't see the paper lot",
  tx.listOpenPositions(paperHolder.id, { isPaperTrade: false }).length === 0,
);

const paperSell = await tx.recordSell({
  holderId: paperHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-06-15",
  quantity: 4,
  price: 60,
  isPaperTrade: true,
});
check(
  "A paper SELL without an explicit strategyId inherits it from the lot",
  paperSell.sells[0].strategy_id === paperStrategy.id,
);

// A second, untouched paper lot for the actual promote tests.
const promoteLot = await tx.recordBuy({
  holderId: paperHolder.id,
  symbol: "AAPL",
  transactionDate: "2026-06-01",
  quantity: 5,
  price: 100,
  fees: 0,
  isPaperTrade: true,
});
const promoted = tx.promotePaperTrade(paperHolder.id, promoteLot.id);
check("Promoting flips is_paper_trade to 0", promoted.is_paper_trade === 0);
check("Promoting preserves cost basis", promoted.cost_basis === 5 * 100);
check("Promoting preserves quantity_remaining", promoted.quantity_remaining === 5);
check(
  "The promoted lot now shows up as a real position",
  tx.listOpenPositions(paperHolder.id, { isPaperTrade: false }).some((p) => p.lot_id === promoteLot.id),
);
check(
  "...and no longer appears among paper positions",
  !tx.listOpenPositions(paperHolder.id, { isPaperTrade: true }).some((p) => p.lot_id === promoteLot.id),
);

check(
  "Promoting an already-real transaction is refused",
  (() => {
    try {
      tx.promotePaperTrade(paperHolder.id, promoteLot.id);
      return false;
    } catch (err) {
      return /already a real transaction/.test(err.message);
    }
  })(),
);

const nonBuyPaper = await tx.recordDividend({
  holderId: paperHolder.id, symbol: "NVDA", transactionDate: "2026-06-20", amount: 5, isPaperTrade: true,
});
check(
  "Promoting a non-BUY (e.g. a dividend) is refused",
  (() => {
    try {
      tx.promotePaperTrade(paperHolder.id, nonBuyPaper.id);
      return false;
    } catch (err) {
      return /Only a paper BUY/.test(err.message);
    }
  })(),
);

// Pre-seed AMZN (not used elsewhere in this suite) so getOrCreateSecurity
// doesn't try a live Yahoo lookup.
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('AMZN', ?, 'Amazon.com Inc', 'manual')",
).run(exchangeId);
const partlySoldPaperLot = await tx.recordBuy({
  holderId: paperHolder.id,
  symbol: "AMZN",
  transactionDate: "2026-06-01",
  quantity: 10,
  price: 200,
  fees: 0,
  isPaperTrade: true,
});
await tx.recordSell({
  holderId: paperHolder.id, symbol: "AMZN", transactionDate: "2026-06-10", quantity: 3, price: 210,
  isPaperTrade: true,
});
check(
  "Promoting a partly-sold paper lot is refused",
  (() => {
    try {
      tx.promotePaperTrade(paperHolder.id, partlySoldPaperLot.id);
      return false;
    } catch (err) {
      return /partly or fully sold/.test(err.message);
    }
  })(),
);

console.log("\n6i. Paper Trade: handlers + render (pure functions)");
const { paperOrderFormToPayload } = await import("../public/js/modules/papertrade/handlers.js");
const { renderPositionsRows: renderOrdersPositionsRows } = await import(
  "../public/js/modules/orders/render.js"
);
const { renderPositionsRows: renderPaperPositionsRows } = await import(
  "../public/js/modules/papertrade/render.js"
);

const paperPayload = paperOrderFormToPayload(
  fakeFormData({
    transactionType: "BUY",
    symbol: "nvda",
    transactionDate: "2026-07-01",
    quantity: "10",
    price: "50",
    fees: "0",
    sourceId: "",
    strategyId: "3",
    notes: "",
  }),
);
check("paperOrderFormToPayload forces isPaperTrade true", paperPayload.isPaperTrade === true);
check("paperOrderFormToPayload still coerces strategyId through", paperPayload.strategyId === "3");

const fakeLot = { lot_id: 7, symbol: "NVDA", quantity_remaining: 10 };
const fakeCols = [{ key: "symbol", label: "Ticker" }];
check(
  "Orders' own renderPositionsRows omits Promote by default (real Orders table)",
  !renderOrdersPositionsRows([fakeLot], fakeCols).includes("promote-txn-btn"),
);
check(
  "Paper Trade's renderPositionsRows always includes Promote",
  renderPaperPositionsRows([fakeLot], fakeCols).includes("promote-txn-btn"),
);
check(
  "Paper Trade's empty-state message is paper-specific",
  renderPaperPositionsRows([], fakeCols).includes("Log Paper Trade"),
);

console.log("\n6j. Transactions: stock split adjustment");
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('SPLTCO', ?, 'Split Test Co', 'manual')",
).run(exchangeId);
const splitSecurityId = db.prepare("SELECT id FROM securities WHERE symbol = 'SPLTCO'").get().id;
const splitHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Splitter', 0) RETURNING *")
  .get();

// Lot bought before the split, partially sold before the split -- exercises
// quantity AND quantity_remaining rescaling together, not just a fresh lot.
const preSplitLot = await tx.recordBuy({
  holderId: splitHolder.id, symbol: "SPLTCO", transactionDate: "2026-01-01",
  quantity: 100, price: 40, fees: 0,
});
await tx.recordSell({
  holderId: splitHolder.id, symbol: "SPLTCO", transactionDate: "2026-01-15",
  quantity: 30, price: 45,
});
// Lot bought ON the split date already reflects post-split share counts --
// applySplitToOpenLots' `transaction_date < splitDate` bound must exclude it.
const onSplitDateLot = await tx.recordBuy({
  holderId: splitHolder.id, symbol: "SPLTCO", transactionDate: "2026-02-01",
  quantity: 20, price: 20, fees: 0,
});

const { lotsAdjusted } = tx.applySplitToOpenLots(splitSecurityId, "2026-02-01", "2:1");
check("applySplitToOpenLots only touches the one lot opened before the split date", lotsAdjusted === 1);

const rescaledLot = db.prepare("SELECT * FROM transactions WHERE id = ?").get(preSplitLot.id);
check("2:1 split doubles the lot's original quantity (100 -> 200)", rescaledLot.quantity === 200);
check(
  "2:1 split doubles quantity_remaining too (100-30=70 -> 140)",
  rescaledLot.quantity_remaining === 140,
);
check(
  "Split leaves total cost_basis (dollars) untouched -- only share count changes",
  rescaledLot.cost_basis === preSplitLot.cost_basis,
);

const untouchedLot = db.prepare("SELECT * FROM transactions WHERE id = ?").get(onSplitDateLot.id);
check(
  "A lot bought on the split date itself is left alone",
  untouchedLot.quantity === 20 && untouchedLot.quantity_remaining === 20,
);

const splitAudit = db
  .prepare("SELECT * FROM transactions WHERE transaction_type = 'SPLIT_ADJ' AND linked_buy_id = ?")
  .get(preSplitLot.id);
check("A SPLIT_ADJ audit row is logged, linked back to the adjusted lot", splitAudit != null);
check("SPLIT_ADJ row records the resulting share count", splitAudit.quantity === 140);

console.log("\n6k. Transactions: recordBuy retroactively applies an already-known split");
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('BACKDATE', ?, 'Backdate Test Co', 'manual')",
).run(exchangeId);
const backdateSecurityId = db.prepare("SELECT id FROM securities WHERE symbol = 'BACKDATE'").get().id;
db.prepare(
  "INSERT INTO splits (security_id, split_date, ratio, source) VALUES (?, '2026-03-01', '3:1', 'yahoo')",
).run(backdateSecurityId);

// Entering a real historical trade *after* the split it happened before was
// already recorded -- e.g. backfilling old trades into a stock that's since
// split. Should come out already-adjusted, not stuck pre-split.
const backdatedLot = await tx.recordBuy({
  holderId: splitHolder.id, symbol: "BACKDATE", transactionDate: "2026-01-20",
  quantity: 10, price: 60, fees: 0,
});
check("A backdated buy entered after a known split is auto-adjusted (10 -> 30)", backdatedLot.quantity === 30);
check(
  "Backdated buy's quantity_remaining is adjusted too",
  backdatedLot.quantity_remaining === 30,
);
check(
  "Backdated buy's cost_basis (total dollars actually paid) is untouched",
  backdatedLot.cost_basis === 10 * 60,
);

const postSplitBuy = await tx.recordBuy({
  holderId: splitHolder.id, symbol: "BACKDATE", transactionDate: "2026-04-01",
  quantity: 15, price: 20, fees: 0,
});
check("A buy entered after the split date is untouched by it", postSplitBuy.quantity === 15);

console.log("\n6e. Orders: form mapping + validation (pure functions)");
const { orderFormToPayload, validateOrderPayload } = await import(
  "../public/js/modules/orders/handlers.js"
);
function fakeFormData(entries) {
  const map = new Map(Object.entries(entries));
  return { get: (k) => (map.has(k) ? map.get(k) : null) };
}

const buyPayload = orderFormToPayload(
  fakeFormData({
    transactionType: "BUY",
    symbol: " nvda ",
    transactionDate: "2026-07-01",
    quantity: "10",
    price: "120.5",
    fees: "1.99",
    sourceId: "",
    notes: "",
  }),
);
check("orderFormToPayload upper-cases and trims the ticker", buyPayload.symbol === "NVDA");
check("orderFormToPayload coerces numbers", buyPayload.quantity === 10 && buyPayload.price === 120.5);
check("orderFormToPayload turns empty optional fields into null", buyPayload.sourceId === null && buyPayload.notes === null);
check("BUY payload validates", validateOrderPayload(buyPayload) === null);

const dividendPayload = orderFormToPayload(
  fakeFormData({ transactionType: "DIVIDEND", symbol: "NVDA", transactionDate: "2026-07-01", price: "42.5" }),
);
check("DIVIDEND maps price to amount", dividendPayload.amount === 42.5);
check("DIVIDEND payload validates", validateOrderPayload(dividendPayload) === null);

const sellWithLot = orderFormToPayload(
  fakeFormData({
    transactionType: "SELL",
    symbol: "NVDA",
    transactionDate: "2026-07-02",
    quantity: "5",
    price: "130",
    fees: "0",
    lotId: "42",
  }),
);
check("SELL carries an explicitly chosen lotId", sellWithLot.lotId === 42);
const sellNoLot = orderFormToPayload(
  fakeFormData({
    transactionType: "SELL",
    symbol: "NVDA",
    transactionDate: "2026-07-02",
    quantity: "5",
    price: "130",
    fees: "0",
    lotId: "",
  }),
);
check("SELL omits lotId when FIFO is chosen", !("lotId" in sellNoLot));

check(
  "Validation rejects a missing ticker",
  validateOrderPayload({ ...buyPayload, symbol: "" }) === "Ticker is required.",
);
check(
  "Validation rejects a missing date",
  validateOrderPayload({ ...buyPayload, transactionDate: null }) === "Date is required.",
);
check(
  "Validation rejects zero quantity",
  validateOrderPayload({ ...buyPayload, quantity: 0 }) === "Quantity must be greater than zero.",
);
check(
  "Validation rejects a zero dividend",
  validateOrderPayload({ ...dividendPayload, amount: 0 }) === "Dividend amount must be greater than zero.",
);
check("Validation allows a zero price (e.g. a gifted share)", validateOrderPayload({ ...buyPayload, price: 0 }) === null);

console.log("\n6f. Orders: table sort/filter (pure functions)");
const { sortRows, filterPositions } = await import("../public/js/modules/orders/render.js");
const posRows = [
  { symbol: "NVDA", security_name: "NVIDIA Corp", unrealized_pnl: 500, last_price: 120 },
  { symbol: "AAPL", security_name: "Apple Inc.", unrealized_pnl: -50, last_price: 180 },
  { symbol: "INTC", security_name: "Intel Corp", unrealized_pnl: null, last_price: null },
];
check(
  "sortRows orders numerically, nulls last",
  JSON.stringify(sortRows(posRows, "unrealized_pnl", "desc").map((r) => r.symbol)) ===
    JSON.stringify(["NVDA", "AAPL", "INTC"]),
);
check("sortRows does not mutate its input", posRows[0].symbol === "NVDA");
check("filterPositions matches ticker", filterPositions(posRows, "nvda").length === 1);
check("filterPositions matches company name", filterPositions(posRows, "intel").length === 1);
check("filterPositions with a blank query returns everything", filterPositions(posRows, "  ").length === 3);

console.log("\n7. Dashboard: ticker detail service");
const detailSvc = await import("../services/tickerDetailService.js");

check("Unknown ticker returns null, not a crash", detailSvc.getTickerDetail(traderHolder.id, "NOSUCH") === null);

const nvdaDetail = detailSvc.getTickerDetail(traderHolder.id, "nvda");
check("Symbol lookup is case-insensitive", nvdaDetail !== null && nvdaDetail.security.symbol === "NVDA");
check("Detail includes the security profile", nvdaDetail.security.name === "NVIDIA Corp");
check("Detail includes stored price history for the chart", Array.isArray(nvdaDetail.series));
check("Detail includes the holder's open lots", nvdaDetail.position.lots.length === 1);
check(
  "Position totals match the open lot",
  nvdaDetail.position.total_shares === nvdaDetail.position.lots[0].quantity_remaining,
);
check("Detail includes trade history", nvdaDetail.trades.length > 0);
check(
  "SELL rows in detail carry realized P&L, BUYs do not",
  nvdaDetail.trades.every((t) => (t.transaction_type === "SELL") === (t.realized_pnl !== null)),
);

// A different holder must not see this holder's lots or trades.
const otherView = detailSvc.getTickerDetail(holder.id, "NVDA");
check("Another holder sees the same security but none of these positions", otherView.position.lots.length === 0);

console.log("\n7b. Dashboard: sparkline + sort/filter (pure functions)");
const dashRender = await import("../public/js/modules/dashboard/render.js");

check(
  "Sparkline degrades gracefully with too little data",
  dashRender.renderSparkline([]).includes("Not enough price history"),
);
check(
  "Sparkline degrades gracefully with a single point",
  dashRender.renderSparkline([{ date: "2026-01-01", close: 10 }]).includes("Not enough price history"),
);
const spark = dashRender.renderSparkline([
  { date: "2026-01-01", close: 10 },
  { date: "2026-01-02", close: 12 },
  { date: "2026-01-03", close: 11 },
]);
check("Sparkline renders an SVG polyline", spark.includes("<polyline") && spark.includes("<svg"));
check("Sparkline labels the first and last dates", spark.includes("2026-01-01") && spark.includes("2026-01-03"));
// A perfectly flat series would divide by zero without the guard in renderSparkline.
const flat = dashRender.renderSparkline([
  { date: "2026-01-01", close: 10 },
  { date: "2026-01-02", close: 10 },
]);
check("Flat price series does not produce NaN coordinates", !flat.includes("NaN"));

const dashRows = [
  { symbol: "NVDA", security_name: "NVIDIA Corp", exchange_code: "NASDAQ", unrealized_pnl: 500 },
  { symbol: "AAPL", security_name: "Apple Inc.", exchange_code: "NASDAQ", unrealized_pnl: -20 },
  { symbol: "GE", security_name: "General Electric", exchange_code: "NYSE", unrealized_pnl: null },
];
check(
  "Dashboard sort puts nulls last",
  dashRender.sortPositions(dashRows, "unrealized_pnl", "desc").at(-1).symbol === "GE",
);
check("Dashboard exchange filter narrows correctly", dashRender.filterPositions(dashRows, "", "NYSE").length === 1);
check(
  "Dashboard combines text and exchange filters",
  dashRender.filterPositions(dashRows, "apple", "NASDAQ").length === 1 &&
    dashRender.filterPositions(dashRows, "apple", "NYSE").length === 0,
);
// Count option elements, not raw string hits -- each option contains its
// exchange code twice (value attribute + label text).
const exchangeOptions = [...dashRender.renderExchangeOptions(dashRows).matchAll(/<option value="([^"]*)"/g)].map(
  (m) => m[1],
);
check(
  "Dashboard exchange options are deduped and sorted, with an All entry",
  JSON.stringify(exchangeOptions) === JSON.stringify(["", "NASDAQ", "NYSE"]),
);

console.log("\n8. Virtual \"Orders\" watchlist");
const wlSvc = await import("../services/watchlistService.js");

// traderHolder holds NVDA (one open lot) from section 6.
const traderLists = wlSvc.listWatchlists(traderHolder.id);
const ordersList = traderLists.find((l) => l.id === "orders");
check("Orders list always appears in listWatchlists", ordersList != null);
check("Orders list is flagged virtual", ordersList.is_virtual === 1);
check("Orders list counts held tickers", ordersList.item_count === 1);

const ordersItems = wlSvc.listWatchedItems(traderHolder.id, { watchlistId: "orders" });
check("Orders list returns the held ticker", ordersItems.length === 1 && ordersItems[0].symbol === "NVDA");
check("Orders rows are marked virtual", ordersItems[0].is_virtual === 1);
check("Orders rows use the HELD pseudo-type", ordersItems[0].order_type === "HELD");
check("Orders rows carry the share count", ordersItems[0].quantity > 0);
check(
  "Orders row ids are non-numeric so they can't be mistaken for real items",
  Number.isNaN(Number(ordersItems[0].id)),
);

// A holder with no positions should still see the list, just empty.
const emptyOrders = wlSvc.listWatchedItems(holder.id, { watchlistId: "orders" });
check("Holder with no positions sees an empty Orders list", emptyOrders.length === 0);

// The list must be immutable.
let renameBlocked = false;
try {
  wlSvc.renameWatchlist(traderHolder.id, "orders", "Nope");
} catch {
  renameBlocked = true;
}
check("Orders list cannot be renamed", renameBlocked);

let deleteBlocked = false;
try {
  wlSvc.deleteWatchlist(traderHolder.id, "orders");
} catch {
  deleteBlocked = true;
}
check("Orders list cannot be deleted", deleteBlocked);

// Reorder should skip it silently rather than blowing up the whole call.
const realListId = traderLists.find((l) => !l.is_virtual)?.id;
if (realListId) {
  const reorderResult = wlSvc.reorderWatchlists(traderHolder.id, ["orders", realListId]);
  check("Reorder ignores the virtual list instead of failing", reorderResult.updated >= 0);
}

// Adding with watchlistId='orders' must fall back to a real list.
const fallbackItem = await addWatchedItem({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  watchlistId: "orders",
  skipBackfill: true,
});
check(
  "Adding to the Orders list falls back to a real list",
  fallbackItem.watchlist_id !== "orders" && Number.isFinite(fallbackItem.watchlist_id),
);

console.log("\n8d. Watchlist filtering fails closed, not open");
// Regression test for a real bug: the Orders tab sent watchlistId="orders",
// the server coerced it with Number() -> NaN, SQLite bound NaN as NULL, and
// `@watchlistId IS NULL` matched EVERY row -- so every tab showed every item.
const filterHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Filter Test', 0) RETURNING *")
  .get();
// Uses a dedicated ticker rather than AAPL so this test doesn't disturb the
// held-but-unwatched state that section 8b asserts on.
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('MSFT', ?, 'Microsoft Corp', 'manual')",
).run(exchangeId);

const fListA = createWatchlist(filterHolder.id, "List A");
const fListB = createWatchlist(filterHolder.id, "List B");
await addWatchedItem({
  holderId: filterHolder.id, symbol: "NVDA", orderType: "WATCH",
  watchlistId: fListA.id, skipBackfill: true,
});
await addWatchedItem({
  holderId: filterHolder.id, symbol: "MSFT", orderType: "WATCH",
  watchlistId: fListB.id, skipBackfill: true,
});

check("No filter returns every item", wlSvc.listWatchedItems(filterHolder.id, {}).length === 2);
check(
  "Filtering by list A returns only its item",
  (() => {
    const rows = wlSvc.listWatchedItems(filterHolder.id, { watchlistId: fListA.id });
    return rows.length === 1 && rows[0].symbol === "NVDA";
  })(),
);
check(
  "Filtering by list B returns only its item",
  (() => {
    const rows = wlSvc.listWatchedItems(filterHolder.id, { watchlistId: fListB.id });
    return rows.length === 1 && rows[0].symbol === "MSFT";
  })(),
);
check(
  "A NaN watchlistId returns nothing, NOT everything",
  wlSvc.listWatchedItems(filterHolder.id, { watchlistId: NaN }).length === 0,
);
check(
  "A garbage watchlistId returns nothing, NOT everything",
  wlSvc.listWatchedItems(filterHolder.id, { watchlistId: "not-a-list" }).length === 0,
);
check(
  "A non-existent numeric watchlistId returns nothing",
  wlSvc.listWatchedItems(filterHolder.id, { watchlistId: 999999 }).length === 0,
);

console.log("\n8c. Default watchlist seeding");
const { DEFAULT_WATCHLIST_NAME } = wlSvc;
check("Default list name is exported as a constant", DEFAULT_WATCHLIST_NAME === "Tickers to Watch");
// A brand-new holder should get the default list on first use, so nothing
// has to be created manually before adding a ticker.
const freshHolder = db
  .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Fresh', 0) RETURNING *")
  .get();
check(
  "New holder starts with no real lists",
  wlSvc.listWatchlists(freshHolder.id).filter((l) => !l.is_virtual).length === 0,
);
const autoList = wlSvc.getOrCreateDefaultWatchlist(freshHolder.id);
check("getOrCreateDefaultWatchlist creates the default list", autoList.name === DEFAULT_WATCHLIST_NAME);
check(
  "Calling it again returns the same list rather than duplicating",
  wlSvc.getOrCreateDefaultWatchlist(freshHolder.id).id === autoList.id,
);

console.log("\n8b. Quote refresh covers held positions, not just watched ones");
// A held-but-never-watchlisted ticker is the case that was broken: it never
// got a quote, so its Dashboard card showed no price.
const heldOnly = db
  .prepare("SELECT COUNT(*) AS n FROM securities WHERE symbol = 'AAPL'")
  .get().n;
check("AAPL exists as a security", heldOnly === 1);
const aaplId = db.prepare("SELECT id FROM securities WHERE symbol='AAPL'").get().id;
const aaplWatched = db
  .prepare("SELECT COUNT(*) AS n FROM watched_items WHERE security_id = ?")
  .get(aaplId).n;
check("AAPL is not on any watchlist (the previously-broken case)", aaplWatched === 0);

console.log("\n8e. Watchlist 10-day trend series + sparkline");
const seriesRows = wlSvc.listWatchedItems(filterHolder.id, { watchlistId: fListA.id });
check("Watchlist rows carry a recent_series array", Array.isArray(seriesRows[0].recent_series));
check(
  "recent_series is chronological (oldest first)",
  (() => {
    const s = seriesRows[0].recent_series;
    return s.length < 2 || s[0].date <= s[s.length - 1].date;
  })(),
);
check(
  "recent_series is capped at 10 bars",
  seriesRows[0].recent_series.length <= 10,
);

const { renderTrendSparkline } = await import("../public/js/modules/watchlist/render.js");
check(
  "Sparkline degrades to a dash with no series",
  renderTrendSparkline(undefined).includes("trend-empty"),
);
check(
  "Sparkline degrades to a dash with a single bar",
  renderTrendSparkline([{ date: "2026-01-01", close: 10 }]).includes("trend-empty"),
);

const risingSpark = renderTrendSparkline([
  { date: "2026-01-01", close: 10 },
  { date: "2026-01-02", close: 11 },
  { date: "2026-01-03", close: 13 },
]);
check("Sparkline renders an SVG polyline", risingSpark.includes("<polyline") && risingSpark.includes("<svg"));
check("Rising series uses the success colour", risingSpark.includes("var(--success)"));
check(
  "Sparkline labels the net $ change, not the price",
  risingSpark.includes("+$3.00"),
);

const fallingSpark = renderTrendSparkline([
  { date: "2026-01-01", close: 20 },
  { date: "2026-01-02", close: 18 },
]);
check("Falling series uses the danger colour", fallingSpark.includes("var(--danger)"));
check("Falling series labels a negative change", fallingSpark.includes("-$2.00"));

const flatSpark = renderTrendSparkline([
  { date: "2026-01-01", close: 5 },
  { date: "2026-01-02", close: 5 },
]);
check("Flat series produces no NaN coordinates", !flatSpark.includes("NaN"));

// Sorting by the trend column should use the net move the line depicts.
const trendSorted = sortItems(
  [
    { symbol: "A", recent_series: [{ close: 10 }, { close: 12 }] }, // +2
    { symbol: "B", recent_series: [{ close: 10 }, { close: 5 }] }, // -5
    { symbol: "C", recent_series: [] }, // no data
  ],
  "trend_10d",
  "desc",
);
check(
  "Trend column sorts by net change with no-data last",
  JSON.stringify(trendSorted.map((r) => r.symbol)) === JSON.stringify(["A", "B", "C"]),
);

console.log("\n8f. Incremental history refresh");
const priceSvc = await import("../services/priceService.js");
const covered = priceSvc.getHistoryCoverage(item.security_id);
check("getHistoryCoverage reports stored bar count", covered.barCount === 3);
check("getHistoryCoverage reports the newest date", covered.lastDate === "2026-07-22");

const noHistorySec = db
  .prepare("INSERT INTO securities (symbol, name, data_source) VALUES ('ZZZZ','Test Co','manual') RETURNING *")
  .get();
const emptyCoverage = priceSvc.getHistoryCoverage(noHistorySec.id);
check("Coverage of an unfetched security is empty", emptyCoverage.barCount === 0 && emptyCoverage.lastDate === null);

console.log("\n8g. Scheduler timing math");
const sched = await import("../services/scheduler.js");
// 22:00 -> next 01:00 is 3h away, tomorrow.
check(
  "Schedules to the next occurrence when the hour has passed today",
  sched.msUntilNextRun(1, new Date("2026-07-25T22:00:00")) === 3 * 3600000,
);
// 00:00 -> 01:00 today is 1h away.
check(
  "Schedules later today when the hour is still ahead",
  sched.msUntilNextRun(1, new Date("2026-07-25T00:00:00")) === 3600000,
);
// Exactly at the hour should go to tomorrow, not fire in a zero-delay loop.
check(
  "Exactly at the target hour schedules for tomorrow, not immediately",
  sched.msUntilNextRun(1, new Date("2026-07-25T01:00:00")) === 24 * 3600000,
);
check(
  "A different hour is honoured",
  sched.msUntilNextRun(6, new Date("2026-07-25T00:00:00")) === 6 * 3600000,
);
check(
  "Delay is always positive",
  [0, 1, 6, 13, 23].every((h) => sched.msUntilNextRun(h, new Date("2026-07-25T13:37:00")) > 0),
);

check(
  "Scheduler settings have defaults",
  settingsSvc.getGeneralSettings().nightly_refresh_enabled === "1" &&
    settingsSvc.getGeneralSettings().nightly_refresh_hour === "1",
);
check(
  "Scheduler settings are whitelisted (saveable)",
  settingsSvc.saveGeneralSettings({ nightly_refresh_hour: "3" }).saved.includes("nightly_refresh_hour"),
);

console.log("\n10. Summary endpoint (Prime_Dashboard consumer)");
const summarySvc = await import("../services/summaryService.js");

// Give the trader holder a quote so day-change math has something to work on.
const nvdaSecId = db.prepare("SELECT id FROM securities WHERE symbol='NVDA'").get().id;
db.prepare(
  `INSERT INTO quotes_cache (security_id, last_price, prev_close, source)
   VALUES (?, 110, 100, 'yahoo')
   ON CONFLICT(security_id) DO UPDATE SET last_price=110, prev_close=100`,
).run(nvdaSecId);

const snap = summarySvc.getDashboardSummary(traderHolder.id);
check("Summary has an asOf timestamp", typeof snap.asOf === "string");
check("Summary reports portfolio headline numbers", snap.portfolio.positionCount >= 1);
check("Summary rolls lots up to a ticker count", snap.portfolio.tickerCount >= 1);
// Derived from actual holdings rather than hardcoded -- earlier sections
// buy and sell against this holder, so the share count isn't fixed.
const heldNvda = tx
  .listOpenPositions(traderHolder.id)
  .filter((p) => p.symbol === "NVDA")
  .reduce((sum, p) => sum + p.quantity_remaining, 0);
check(
  "Day change is computed from prev close, not cost basis",
  Math.abs(snap.portfolio.dayChange - heldNvda * (110 - 100)) < 1e-6,
);
check(
  "Day change percent is relative to prev close",
  Math.abs(snap.portfolio.dayChangePercent - 10) < 1e-6,
);
check("Top movers are returned", snap.topMovers.length >= 1);
check("Top movers carry symbol and day change", snap.topMovers[0].symbol === "NVDA");
check("Summary includes alert counts", typeof snap.alerts.activeCount === "number");
check("Summary includes watchlist count", typeof snap.watchlist.activeCount === "number");
check("Summary reports quote freshness", "newestFetchedAt" in snap.quotes);

check("moverLimit is honoured", summarySvc.getDashboardSummary(traderHolder.id, { moverLimit: 1 }).topMovers.length <= 1);

// A holder with nothing shouldn't blow up or emit misleading zeros-as-facts.
const emptySnap = summarySvc.getDashboardSummary(freshHolder.id);
check("Empty portfolio returns a valid snapshot", emptySnap.portfolio.positionCount === 0);
check("Empty portfolio reports null day change, not 0", emptySnap.portfolio.dayChange === null);
check("Empty portfolio has no movers", emptySnap.topMovers.length === 0);

// Movers sort by absolute move, so a big drop ranks alongside a big gain.
const msftSecId = db.prepare("SELECT id FROM securities WHERE symbol='MSFT'").get().id;
db.prepare(
  `INSERT INTO quotes_cache (security_id, last_price, prev_close, source)
   VALUES (?, 50, 100, 'yahoo')
   ON CONFLICT(security_id) DO UPDATE SET last_price=50, prev_close=100`,
).run(msftSecId);
await tx.recordBuy({
  holderId: traderHolder.id, symbol: "MSFT", transactionDate: "2026-01-01",
  quantity: 10, price: 100, fees: 0,
});
const withLoser = summarySvc.getDashboardSummary(traderHolder.id);
check(
  "A -50% mover outranks a +10% mover",
  withLoser.topMovers[0].symbol === "MSFT" && withLoser.topMovers[0].dayChangePercent < 0,
);

console.log("\n11. Journal / Strategy Lab");
const journalSvc = await import("../services/journalService.js");

// A second, unrelated source for the many-to-many tests below -- NOT
// personSource, which section 5d already deleted as part of its own
// retype/delete coverage (see line ~460).
const podcastSource = sourcesSvc.createSource({ name: "Some Podcast", type: "website" });

let missingTitleRejected = false;
try {
  journalSvc.createStrategy({ sources: [{ sourceId: bookSource.id }] });
} catch {
  missingTitleRejected = true;
}
check("createStrategy rejects a missing title", missingTitleRejected);

let missingSourcesRejected = false;
try {
  journalSvc.createStrategy({ title: "No sources" });
} catch {
  missingSourcesRejected = true;
}
check("createStrategy rejects zero sources (a strategy must start tagged to at least one)", missingSourcesRejected);

const strategy = journalSvc.createStrategy({
  title: "Buy the dip",
  notes: "wait for a 10% pullback",
  sources: [{ sourceId: bookSource.id, chapter: "Chapter 4", pageNumber: 42 }],
});
check("createStrategy returns the new row", strategy.id != null && strategy.title === "Buy the dip");
check("createStrategy returns the tagged source", strategy.sources.length === 1 && strategy.sources[0].source_name === bookSource.name);
check(
  "The initial source tag carries its chapter/page",
  strategy.sources[0].chapter === "Chapter 4" && strategy.sources[0].page_number === 42,
);

// The whole point of the redesign: the same strategy tagged with a second,
// unrelated source (a podcast, not the book) -- with its own notes, no
// chapter/page since that's a book-only concept.
const strategyWithSecondTag = journalSvc.addStrategySource(strategy.id, {
  sourceId: podcastSource.id,
  notes: "also recommends this on their show",
});
check("addStrategySource returns the new tag row", strategyWithSecondTag.source_id === podcastSource.id);
check(
  "getStrategy now shows both tagged sources",
  journalSvc.getStrategy(strategy.id).sources.length === 2,
);

let duplicateTagRejected = false;
try {
  journalSvc.addStrategySource(strategy.id, { sourceId: bookSource.id });
} catch (err) {
  duplicateTagRejected = /already tagged/.test(err.message);
}
check("addStrategySource rejects tagging the same source twice", duplicateTagRejected);

let addSourceOnMissingStrategyRejected = false;
try {
  journalSvc.addStrategySource(999999, { sourceId: bookSource.id });
} catch (err) {
  addSourceOnMissingStrategyRejected = /not found/i.test(err.message);
}
check("addStrategySource rejects an unknown strategy id", addSourceOnMissingStrategyRejected);

const strategiesForBookSource = journalSvc.listStrategies({ sourceId: bookSource.id });
const strategiesForPodcastSource = journalSvc.listStrategies({ sourceId: podcastSource.id });
check(
  "listStrategies({sourceId}) finds a strategy tagged with that source, regardless of which other sources it's also tagged with",
  strategiesForBookSource.some((s) => s.id === strategy.id) && strategiesForPodcastSource.some((s) => s.id === strategy.id),
);
check(
  // source_names is alphabetical ("Some Podcast" sorts before "Trading in the Zone").
  "listStrategies aggregates both tagged source names",
  strategiesForBookSource.find((s) => s.id === strategy.id)?.source_names === `${podcastSource.name}, ${bookSource.name}`,
);
check(
  "A fresh strategy starts with zero linked ideas",
  strategiesForBookSource.find((s) => s.id === strategy.id)?.idea_count === 0,
);
check(
  "listStrategies with an unrelated sourceId excludes it",
  !journalSvc.listStrategies({ sourceId: 999999 }).some((s) => s.id === strategy.id),
);

const updatedStrategy = journalSvc.updateStrategy(strategy.id, { title: "Buy the dip (revised)" });
check("updateStrategy persists the title change", updatedStrategy.title === "Buy the dip (revised)");
check("updateStrategy leaves source tags alone", updatedStrategy.sources.length === 2);

const bookTagId = journalSvc.getStrategy(strategy.id).sources.find((s) => s.source_id === bookSource.id).id;
const editedTag = journalSvc.updateStrategySource(bookTagId, { chapter: "Chapter 5", pageNumber: 88 });
check("updateStrategySource changes that tag's chapter/page", editedTag.chapter === "Chapter 5" && editedTag.page_number === 88);
check(
  "updateStrategySource doesn't touch the other tag",
  journalSvc.getStrategy(strategy.id).sources.find((s) => s.source_id === podcastSource.id).chapter === null,
);

const podcastTagId = journalSvc.getStrategy(strategy.id).sources.find((s) => s.source_id === podcastSource.id).id;
const removeFirstTag = journalSvc.removeStrategySource(podcastTagId);
check("removeStrategySource removes exactly one tag", removeFirstTag.deleted === 1);
check(
  "The strategy survives with just the remaining tag",
  journalSvc.getStrategy(strategy.id).sources.length === 1,
);
// Removing the LAST tag is permitted too -- a strategy isn't force-deleted
// just because it's (temporarily) untagged from every source.
const lastTagId = journalSvc.getStrategy(strategy.id).sources[0].id;
journalSvc.removeStrategySource(lastTagId);
check(
  "Removing the last tag leaves the strategy itself intact, just source-less",
  journalSvc.getStrategy(strategy.id) != null && journalSvc.getStrategy(strategy.id).sources.length === 0,
);
check("getStrategy returns null for an unknown id", journalSvc.getStrategy(999999) === null);

// Re-tag with both sources for the rest of the ideas/execute tests below --
// the book keeps its chapter/page, the podcast tag has none (that's only a
// book concept), which is exactly the per-source distinction this redesign
// exists to support.
journalSvc.addStrategySource(strategy.id, { sourceId: bookSource.id, chapter: "Chapter 4", pageNumber: 42 });
journalSvc.addStrategySource(strategy.id, { sourceId: podcastSource.id });

let ideaMissingSourceRejected = false;
try {
  await journalSvc.recordJournalIdea({
    holderId: traderHolder.id,
    symbol: "NVDA",
    orderType: "WATCH",
    skipBackfill: true,
  });
} catch {
  ideaMissingSourceRejected = true;
}
check("recordJournalIdea rejects a missing sourceId", ideaMissingSourceRejected);

const idea = await journalSvc.recordJournalIdea({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "BUY_LIMIT",
  targetPrice: 50,
  sourceId: bookSource.id,
  strategyId: strategy.id,
  notes: "book says buy under $50",
  skipBackfill: true,
});
check("recordJournalIdea creates a watched_item", idea.id != null && idea.buy_price_high === 50);
check("recordJournalIdea forces is_paper_trade regardless of caller input", idea.is_paper_trade === 1);
check("A new idea starts WATCHING", idea.status === "WATCHING");

const ideasList = journalSvc.listJournalIdeas(traderHolder.id, {});
const listedIdea = ideasList.find((i) => i.id === idea.id);
check("listJournalIdeas returns the new idea", listedIdea != null);
check("listJournalIdeas joins the source name", listedIdea?.source_name === bookSource.name);
check("listJournalIdeas joins the strategy title", listedIdea?.strategy_title === "Buy the dip (revised)");
check(
  "listJournalIdeas resolves the chapter/page from THIS idea's specific (strategy, source) tag",
  listedIdea?.strategy_chapter === "Chapter 4" && listedIdea?.strategy_page_number === 42,
);

// Same strategy, but sourced from the podcast instead of the book -- the
// per-source join should surface that tag's (empty) chapter/page instead of
// leaking the book's. This is the actual payoff of the many-to-many redesign.
const ideaViaPodcast = await journalSvc.recordJournalIdea({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  sourceId: podcastSource.id,
  strategyId: strategy.id,
  skipBackfill: true,
});
const listedIdeaViaPodcast = journalSvc
  .listJournalIdeas(traderHolder.id, {})
  .find((i) => i.id === ideaViaPodcast.id);
check(
  "The same strategy via a different source resolves that source's own (null) chapter/page, not the book's",
  listedIdeaViaPodcast?.strategy_title === "Buy the dip (revised)" &&
    listedIdeaViaPodcast?.strategy_chapter === null &&
    listedIdeaViaPodcast?.strategy_page_number === null,
);

check(
  "listJournalIdeas can filter by strategyId",
  journalSvc.listJournalIdeas(traderHolder.id, { strategyId: strategy.id }).length === 2,
);
check(
  "listJournalIdeas can filter by an unrelated strategyId (returns nothing)",
  journalSvc.listJournalIdeas(traderHolder.id, { strategyId: 999999 }).length === 0,
);

// The regular Watchlist view must never show this paper idea mixed in with
// real watches -- this is the specific gap closed alongside the Journal
// module (see server.js's GET /api/watched-items, which now defaults to
// isPaperTrade=false for exactly this reason).
check(
  "The paper idea is invisible to a real-only watched-items query",
  wlSvc.listWatchedItems(traderHolder.id, { isPaperTrade: false }).every((w) => w.id !== idea.id),
);
check(
  "The paper idea IS visible when isPaperTrade=true is requested",
  wlSvc.listWatchedItems(traderHolder.id, { isPaperTrade: true }).some((w) => w.id === idea.id),
);

// executeJournalIdea must refuse a real (non-paper) watched item -- reusing
// it on the wrong kind of row would be a silent logic error, not a crash.
const realWatch = await addWatchedItem({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  skipBackfill: true,
});
let realItemExecuteRejected = false;
try {
  await journalSvc.executeJournalIdea(traderHolder.id, realWatch.id, {
    transactionDate: "2026-07-01",
    quantity: 10,
    price: 45,
  });
} catch (err) {
  realItemExecuteRejected = /already a real watched item/.test(err.message);
}
check("executeJournalIdea refuses a non-paper watched item", realItemExecuteRejected);

const openPositionsBeforeExecute = tx.listOpenPositions(traderHolder.id).length;
const executed = await journalSvc.executeJournalIdea(traderHolder.id, idea.id, {
  transactionDate: "2026-07-15",
  quantity: 25,
  price: 48.5,
  fees: 1,
  notes: "actually pulled the trigger",
});
check("executeJournalIdea returns the new transaction", executed.transaction.transaction_type === "BUY");
check("Executed transaction is real, not paper", executed.transaction.is_paper_trade === 0);
check("Executed transaction links back to the idea", executed.transaction.watched_item_id === idea.id);
check("Executed transaction carries the idea's source", executed.transaction.source_id === bookSource.id);
check(
  "Execution does NOT reuse the paper target price -- the real fill (48.5) is what's stored",
  executed.transaction.price === 48.5,
);
check("The idea itself is marked EXECUTED", executed.item.status === "EXECUTED");
check(
  "Executing opens a real, tracked open position",
  tx.listOpenPositions(traderHolder.id).length === openPositionsBeforeExecute + 1,
);

let doubleExecuteRejected = false;
try {
  await journalSvc.executeJournalIdea(traderHolder.id, idea.id, {
    transactionDate: "2026-07-16",
    quantity: 5,
    price: 49,
  });
} catch (err) {
  doubleExecuteRejected = /Cannot execute an idea with status EXECUTED/.test(err.message);
}
check("An already-executed idea cannot be executed again", doubleExecuteRejected);

// BUG 5: the status check at the top of executeJournalIdea is a plain read,
// and there used to be an await (the security lookup, inside recordBuy)
// between it and the write. Two overlapping calls both passed the check, both
// recorded a BUY and both marked the idea EXECUTED -- the same trade booked
// twice, no error raised. Sequential double-execute (just above) never caught
// it, because sequentially the status really has changed by the second call.
//
// Fired together on purpose: both reach the status check before either writes.
const raceIdea = await journalSvc.recordJournalIdea({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "BUY_LIMIT",
  targetPrice: 50,
  sourceId: bookSource.id,
  notes: "double-execute race",
  skipBackfill: true,
});
const positionsBeforeRace = tx.listOpenPositions(traderHolder.id).length;

const raceResults = await Promise.allSettled([
  journalSvc.executeJournalIdea(traderHolder.id, raceIdea.id, {
    transactionDate: "2026-07-20",
    quantity: 7,
    price: 51,
  }),
  journalSvc.executeJournalIdea(traderHolder.id, raceIdea.id, {
    transactionDate: "2026-07-20",
    quantity: 7,
    price: 51,
  }),
]);

const raceFulfilled = raceResults.filter((r) => r.status === "fulfilled");
check("Concurrent execute: exactly one call succeeds", raceFulfilled.length === 1);
check(
  "Concurrent execute: the loser is rejected, not silently duplicated",
  raceResults.some((r) => r.status === "rejected" && /already executed/i.test(r.reason.message)),
);
check(
  "Concurrent execute: only ONE position is opened",
  tx.listOpenPositions(traderHolder.id).length === positionsBeforeRace + 1,
);
check(
  "Concurrent execute: the losing call rolls its BUY back entirely",
  tx.listTransactions(traderHolder.id, { symbol: "NVDA", type: "BUY" })
    .filter((t) => t.watched_item_id === raceIdea.id).length === 1,
);

// BUG 12: a failure that has nothing to do with symbol lookup must not be
// dressed up as one. Only errors from the provider carry SYMBOL_LOOKUP_FAILED,
// and the routes key their 502-vs-400 choice on exactly that.
let nonLookupError = null;
try {
  await addWatchedItem({
    holderId: traderHolder.id,
    symbol: "NVDA", // already in `securities`, so no lookup happens at all
    orderType: "WATCH",
    watchlistId: 999999, // dead id -> FK violation
    skipBackfill: true,
  });
} catch (err) {
  nonLookupError = err;
}
check("A non-lookup failure still throws", nonLookupError !== null);
check(
  "A non-lookup failure is NOT tagged as a symbol-resolution failure",
  nonLookupError !== null && nonLookupError.code !== "SYMBOL_LOOKUP_FAILED",
);

check(
  "executeJournalIdea rejects an unknown idea id",
  await journalSvc
    .executeJournalIdea(traderHolder.id, 999999, { transactionDate: "2026-07-16", quantity: 1, price: 1 })
    .then(() => false)
    .catch((err) => /not found/i.test(err.message)),
);

// Abandoning a paper idea that was never executed just deletes it -- reuses
// deleteWatchedItems, so cascade rules (alerts, etc.) are already covered.
const abandonedIdea = await journalSvc.recordJournalIdea({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  sourceId: bookSource.id,
  skipBackfill: true,
});
const abandonResult = journalSvc.deleteJournalIdeas(traderHolder.id, [abandonedIdea.id]);
check("Abandoning an idea removes it", abandonResult.deleted === 1);

// Deleting a strategy should not take its ideas down with it -- the schema's
// ON DELETE SET NULL means the idea survives, just loses the strategy tag.
const throwawayStrategy = journalSvc.createStrategy({
  title: "Throwaway",
  sources: [{ sourceId: bookSource.id }],
});
const strategyIdea = await journalSvc.recordJournalIdea({
  holderId: traderHolder.id,
  symbol: "NVDA",
  orderType: "WATCH",
  sourceId: bookSource.id,
  strategyId: throwawayStrategy.id,
  skipBackfill: true,
});
journalSvc.deleteStrategy(throwawayStrategy.id);
check(
  "Deleting a strategy leaves its ideas intact with strategy_id cleared",
  db.prepare("SELECT strategy_id FROM watched_items WHERE id = ?").get(strategyIdea.id).strategy_id === null,
);
check(
  "The orphaned idea is still listed",
  journalSvc.listJournalIdeas(traderHolder.id, {}).some((i) => i.id === strategyIdea.id),
);
check(
  "Deleting a strategy CASCADEs its strategy_sources tag rows (no orphans left behind)",
  db.prepare("SELECT COUNT(*) AS n FROM strategy_sources WHERE strategy_id = ?").get(throwawayStrategy.id).n === 0,
);

// Deleting a SOURCE (not a strategy) should only remove that one tag, not the
// strategy -- exercising strategy_sources.source_id's own ON DELETE CASCADE,
// which is new in schema v5.
const throwawaySource = sourcesSvc.createSource({ name: "Throwaway Podcast", type: "website" });
const multiTaggedStrategy = journalSvc.createStrategy({
  title: "Tagged with a soon-to-be-deleted source",
  sources: [{ sourceId: bookSource.id }, { sourceId: throwawaySource.id }],
});
sourcesSvc.deleteSource(throwawaySource.id);
const afterSourceDelete = journalSvc.getStrategy(multiTaggedStrategy.id);
check(
  "Deleting a source removes only that source's tag",
  afterSourceDelete.sources.length === 1 && afterSourceDelete.sources[0].source_id === bookSource.id,
);
check("The strategy itself survives the source deletion", afterSourceDelete != null);

console.log("\n12. Book ISBN lookup (pure functions -- see openLibraryProvider.js)");
const { normalizeIsbn, parseBookLookupResponse } = await import(
  "../services/providers/openLibraryProvider.js"
);

check("normalizeIsbn accepts a clean ISBN-13", normalizeIsbn("9780735201446") === "9780735201446");
check(
  "normalizeIsbn strips hyphens and spaces",
  normalizeIsbn("978-0-7352-0144-6") === "9780735201446",
);
check("normalizeIsbn accepts ISBN-10 with a trailing X", normalizeIsbn("080442957X") === "080442957X");
check("normalizeIsbn upper-cases a lowercase x", normalizeIsbn("080442957x") === "080442957X");
check("normalizeIsbn rejects too-short input", normalizeIsbn("12345") === null);
check("normalizeIsbn rejects non-numeric junk", normalizeIsbn("not-an-isbn") === null);
check("normalizeIsbn rejects empty/undefined input", normalizeIsbn("") === null && normalizeIsbn(undefined) === null);

// Sample shape of Open Library's actual jscmd=data response.
const sampleResponse = {
  "ISBN:9780735201446": {
    title: "Trading in the Zone",
    authors: [{ name: "Mark Douglas", url: "https://openlibrary.org/authors/OL123A" }],
    publish_date: "2000",
  },
};
check(
  "parseBookLookupResponse extracts title and author",
  (() => {
    const r = parseBookLookupResponse("9780735201446", sampleResponse);
    return r?.title === "Trading in the Zone" && r?.author === "Mark Douglas";
  })(),
);
check(
  "parseBookLookupResponse joins multiple authors",
  (() => {
    const multi = {
      "ISBN:111": { title: "Co-Written Book", authors: [{ name: "A" }, { name: "B" }] },
    };
    return parseBookLookupResponse("111", multi).author === "A, B";
  })(),
);
check(
  "parseBookLookupResponse handles no authors listed",
  (() => {
    const noAuthor = { "ISBN:222": { title: "Anonymous Work" } };
    return parseBookLookupResponse("222", noAuthor).author === null;
  })(),
);
check(
  "parseBookLookupResponse returns null when the ISBN isn't in the response (no match)",
  parseBookLookupResponse("9999999999999", sampleResponse) === null,
);
check(
  "parseBookLookupResponse returns null for a malformed/empty response",
  parseBookLookupResponse("9780735201446", {}) === null &&
    parseBookLookupResponse("9780735201446", null) === null,
);
check(
  "parseBookLookupResponse returns null for an entry with no title",
  parseBookLookupResponse("333", { "ISBN:333": { authors: [{ name: "Ghost" }] } }) === null,
);

console.log("\n13. Exit plans: a thesis owning a ladder of rungs");
const plans = await import("../services/plansService.js");

// A plan is opened by a BUY -- that is what creates the position to exit.
const planBuy = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-08-01",
  quantity: 100,
  price: 90,
  sourceId: bookSource.id,
  strategyId: strategy.id,
});
const plan = plans.createPlanForTrade(traderHolder.id, planBuy.id, { notes: "ladder test" });
check("A plan can be created from a trade", plan.id != null);
check("The plan inherits the trade's source", plan.source_id === bookSource.id);
check("The plan inherits the trade's strategy", plan.strategy_id === strategy.id);
check(
  "The opening trade is attached to it",
  db.prepare("SELECT plan_id FROM transactions WHERE id = ?").get(planBuy.id).plan_id === plan.id,
);
check("The plan holds the lot's shares", plans.planRemainingQuantity(plan.id) === 100);

let secondPlanRejected = false;
try {
  plans.createPlanForTrade(traderHolder.id, planBuy.id);
} catch (err) {
  secondPlanRejected = /already belongs to a plan/.test(err.message);
}
check("A trade cannot belong to two plans", secondPlanRejected);

// Rungs. A stop is an ordinary rung with an upper bound -- no special case.
const rung1 = plans.addExit(traderHolder.id, plan.id, { kind: "TAKE_PROFIT", quantity: 50, priceLow: 110 });
const rung2 = plans.addExit(traderHolder.id, plan.id, { kind: "TAKE_PROFIT", quantity: 30, priceLow: 120 });
const stopRung = plans.addExit(traderHolder.id, plan.id, { kind: "STOP", quantity: 20, priceHigh: 80 });
check("A ladder can hold several take-profit rungs", rung1.id != null && rung2.id != null);
check("A stop is just a rung", stopRung.kind === "STOP" && stopRung.price_high === 80);
check("Rungs are sequenced", rung1.sequence === 0 && rung2.sequence === 1);
check("The ladder commits the shares it promises", plans.planCommittedQuantity(plan.id) === 100);

// Oversell guard: a ladder promising more than the plan holds would fire an
// alert that cannot be honoured, which reads as the app being broken.
let oversellRejected = false;
try {
  plans.addExit(traderHolder.id, plan.id, { kind: "TAKE_PROFIT", quantity: 1, priceLow: 130 });
} catch (err) {
  oversellRejected = /oversell/.test(err.message);
}
check("A rung that would oversell the plan is refused", oversellRejected);

let unboundedRejected = false;
try {
  plans.addExit(traderHolder.id, plan.id, { kind: "TAKE_PROFIT", quantity: 1 });
} catch (err) {
  unboundedRejected = /price bound/.test(err.message);
}
check("A rung with no price bound is refused", unboundedRejected);

// Scaling into the SAME thesis: one ladder over two lots, which is the case
// per-lot exits could not express.
const scaleIn = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "NVDA",
  transactionDate: "2026-08-08",
  quantity: 40,
  price: 95,
});
plans.attachTradeToPlan(traderHolder.id, plan.id, scaleIn.id);
check("Scaling in attaches a second lot to the same thesis", plans.planRemainingQuantity(plan.id) === 140);
check(
  "...which frees up room the ladder can now use",
  plans.addExit(traderHolder.id, plan.id, { kind: "TAKE_PROFIT", quantity: 40, priceLow: 130 }).id != null,
);

// A plan is a thesis about ONE thing.
const otherSecurity = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "AAPL",
  transactionDate: "2026-08-08",
  quantity: 10,
  price: 200,
});
let wrongSecurityRejected = false;
try {
  plans.attachTradeToPlan(traderHolder.id, plan.id, otherSecurity.id);
} catch (err) {
  wrongSecurityRejected = /different security/.test(err.message);
}
check("A trade for another security cannot join the plan", wrongSecurityRejected);

console.log("\n13b. Rung evaluation");
check("A take-profit rung fires at or above its bound", plans.exitTriggered(rung1, 110) === true);
check("...and above it", plans.exitTriggered(rung1, 118) === true);
check("...but not below", plans.exitTriggered(rung1, 109.99) === false);
check("A stop rung fires at or below its bound", plans.exitTriggered(stopRung, 80) === true);
check("...and below it", plans.exitTriggered(stopRung, 60) === true);
check("...but not above", plans.exitTriggered(stopRung, 80.01) === false);
check(
  "A cancelled rung never fires",
  plans.exitTriggered({ ...rung1, status: "cancelled" }, 999) === false,
);

console.log("\n13c. A fired rung reaches the bell and can be acknowledged");
// This is the path that would silently break: alerts used to INNER JOIN
// watched_items, so a rung alert -- which has no watched_item -- would have
// been invisible to the bell and unacknowledgeable.
const pending = plans.listPendingExits().filter((e) => e.plan_id === plan.id);
check("Pending rungs are listed for evaluation with their symbol", pending.length > 0 && pending[0].symbol === "NVDA");

const bellBefore = wlSvc.listUnacknowledgedAlerts(traderHolder.id).length;
const firedRung = pending.find((e) => e.id === rung1.id);
const exitAlert = wlSvc.applyExitAlert(firedRung, 112);
check("Crossing a rung raises an alert", exitAlert !== null);
check("...tagged with the rung's kind", exitAlert.reason === "TAKE_PROFIT");
check("...naming the rung rather than saying 'target hit'", /take-profit rung/.test(exitAlert.message));

const storedExitAlert = db
  .prepare("SELECT * FROM alerts WHERE plan_exit_id = ? ORDER BY id DESC LIMIT 1")
  .get(rung1.id);
check("The alert records which rung fired", storedExitAlert.plan_exit_id === rung1.id);
check("...and has no watched_item parent", storedExitAlert.watched_item_id === null);
check("The rung is marked hit", db.prepare("SELECT status FROM plan_exits WHERE id = ?").get(rung1.id).status === "hit");
check("A hit rung does not fire again", wlSvc.applyExitAlert(db.prepare("SELECT * FROM plan_exits WHERE id = ?").get(rung1.id), 115) === null);

const bell = wlSvc.listUnacknowledgedAlerts(traderHolder.id);
check("The rung alert reaches the bell", bell.length === bellBefore + 1);
const bellRow = bell.find((a) => a.plan_exit_id === rung1.id);
check("...carrying the symbol resolved through the plan", bellRow?.symbol === "NVDA");
check(
  "The rung alert can be acknowledged",
  wlSvc.acknowledgeAlert(traderHolder.id, bellRow.id).acknowledged === 1,
);
check(
  "...and leaves the bell",
  !wlSvc.listUnacknowledgedAlerts(traderHolder.id).some((a) => a.id === bellRow.id),
);

let cancelHitRejected = false;
try {
  plans.cancelExit(traderHolder.id, plan.id, rung1.id);
} catch (err) {
  cancelHitRejected = /already fired/.test(err.message);
}
check("A fired rung cannot be cancelled away", cancelHitRejected);

console.log("\n13d. A sold-out thesis closes");
// A dedicated symbol with no other lots. NOT incidental: recordSell allocates
// FIFO across every open lot for the holder, which crosses plan boundaries --
// see "FIFO sells ignore plan boundaries" in docs/V2_BACKLOG.md. Sharing a
// ticker here made the sell draw down an unrelated older lot instead of this
// plan's, which is exactly the real-world hazard.
db.prepare(
  "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('PLNX', ?, 'Plan Test Co', 'manual')",
).run(exchangeId);
const soldOut = await tx.recordBuy({
  holderId: traderHolder.id,
  symbol: "PLNX",
  transactionDate: "2026-08-09",
  quantity: 10,
  price: 200,
});
const closingPlan = plans.createPlanForTrade(traderHolder.id, soldOut.id);
plans.addExit(traderHolder.id, closingPlan.id, { kind: "TAKE_PROFIT", quantity: 10, priceLow: 250 });
check("Plan is open while shares are held", plans.getPlan(traderHolder.id, closingPlan.id).plan.status === "open");
check("closePlanIfExhausted leaves a held plan alone", plans.closePlanIfExhausted(closingPlan.id).closed === 0);

await tx.recordSell({
  holderId: traderHolder.id,
  symbol: "PLNX",
  transactionDate: "2026-08-10",
  quantity: 10,
  price: 210,
});
check("Selling out empties the plan", plans.planRemainingQuantity(closingPlan.id) === 0);
check("...so the plan closes", plans.closePlanIfExhausted(closingPlan.id).closed === 1);
check(
  "...and its unreachable rungs are cancelled rather than left pending",
  plans.listExits(closingPlan.id).every((e) => e.status !== "pending"),
);
check(
  "A closed plan's rungs are no longer evaluated",
  !plans.listPendingExits().some((e) => e.plan_id === closingPlan.id),
);

const acctSvcEarly = await import("../services/accountsService.js");
console.log("\n14b. Sells are scoped to their account");
// Shares held at one brokerage cannot be sold by another. Before this was
// enforced, selling 100 from account B emptied account A, left B showing 100
// shares it no longer held, and reported P&L against A's cost basis --
// $1,500 instead of $500. Both accounts' books contradicted each other.
const xa = acctSvcEarly.createAccount(holder.id, { broker: "fidelity", accountNumber: "9001" });
const xb = acctSvcEarly.createAccount(holder.id, { broker: "etrade", accountNumber: "9002" });
db.prepare("INSERT INTO securities (symbol, name, data_source) VALUES ('XACC','Cross Account Co','manual')").run();

// A buys first, so a global FIFO would reach for A's lot.
await tx.recordBuy({ holderId: holder.id, accountId: xa.id, symbol: "XACC", transactionDate: "2026-01-01", quantity: 100, price: 10 });
await tx.recordBuy({ holderId: holder.id, accountId: xb.id, symbol: "XACC", transactionDate: "2026-06-01", quantity: 100, price: 20 });

let ambiguousSellRefused = false;
try {
  await tx.recordSell({ holderId: holder.id, symbol: "XACC", transactionDate: "2026-07-01", quantity: 10, price: 25 });
} catch (err) {
  ambiguousSellRefused = /more than one account/.test(err.message);
}
check("A sell that does not name an account is refused when the holding spans several", ambiguousSellRefused);

const xSell = await tx.recordSell({ holderId: holder.id, accountId: xb.id, symbol: "XACC", transactionDate: "2026-07-01", quantity: 100, price: 25 });
const heldIn = (id) => db.prepare("SELECT COALESCE(SUM(quantity_remaining),0) q FROM transactions WHERE account_id=? AND transaction_type='BUY' AND voided_at IS NULL").get(id).q;
check("Selling from B leaves A untouched", heldIn(xa.id) === 100);
check("...and empties B", heldIn(xb.id) === 0);
check(
  "...and reports P&L against B's cost basis, not A's",
  Math.abs(xSell.realizedPnl - 500) < 1e-9,
);

db.prepare("DELETE FROM transactions WHERE security_id = (SELECT id FROM securities WHERE symbol = 'XACC')").run();
db.prepare("DELETE FROM securities WHERE symbol = 'XACC'").run();
db.prepare("DELETE FROM accounts WHERE id IN (?, ?)").run(xa.id, xb.id);

console.log("\n14c. Notifications: accepting and declining an alert");
const alertsSvc = await import("../services/alertsService.js");

// A paper position with a ladder, so a rung can fire and be decided on.
db.prepare("INSERT INTO securities (symbol, name, data_source) VALUES ('NOTIF','Notify Co','manual')").run();
const notifBuy = await tx.recordBuy({
  holderId: traderHolder.id, symbol: "NOTIF", transactionDate: "2026-02-01",
  quantity: 100, price: 10, isPaperTrade: true,
});
const notifPlan = plans.createPlanForTrade(traderHolder.id, notifBuy.id);
const notifRung = plans.addExit(traderHolder.id, notifPlan.id, { kind: "TAKE_PROFIT", quantity: 40, priceLow: 15 });
const notifFired = wlSvc.applyExitAlert(
  plans.listPendingExits().find((e) => e.id === notifRung.id),
  16,
);
check("A fired rung appears in the notifications queue", alertsSvc.listAlerts(traderHolder.id, { unresolvedOnly: true }).some((a) => a.plan_exit_id === notifRung.id));

const queued = alertsSvc.listAlerts(traderHolder.id, { unresolvedOnly: true }).find((a) => a.plan_exit_id === notifRung.id);
check("...classified as an exit, and known to be paper", queued.kind === "exit" && queued.isPaper === true);

// Accepting a PAPER rung records the sale at the price the rung FIRED at,
// dated the day it fired -- not today. That is what makes deciding later free.
const positionsBefore = tx.listOpenPositions(traderHolder.id, { isPaperTrade: true }).length;
const accepted = await alertsSvc.resolveAlert(traderHolder.id, queued.id, {
  resolution: "accepted",
});
check("Accepting a paper rung records the sale", accepted.transaction !== null);
check(
  "...at the price the rung fired at, not a fresh one",
  accepted.transaction.sells[0].price === 16,
);
check(
  "...dated when it fired, so acting days later does not move the trade",
  accepted.transaction.sells[0].transaction_date === String(notifFired.message ? queued.triggered_at : "").slice(0, 10),
);
check(
  "...for the rung's quantity",
  accepted.transaction.sells[0].quantity === 40,
);
check(
  "The alert links to the transaction it produced",
  db.prepare("SELECT resulting_transaction_id FROM alerts WHERE id = ?").get(queued.id).resulting_transaction_id != null,
);

let doubleResolveRejected = false;
try {
  await alertsSvc.resolveAlert(traderHolder.id, queued.id, { resolution: "declined" });
} catch (err) {
  doubleResolveRejected = /already accepted/.test(err.message);
}
check("An alert cannot be decided twice", doubleResolveRejected);

// A REAL position must not have the trigger price recorded as its fill --
// that would erase the execution gap the whole feature measures.
const realBuy = await tx.recordBuy({
  holderId: traderHolder.id, symbol: "NOTIF", transactionDate: "2026-02-01", quantity: 50, price: 10,
});
const realPlan = plans.createPlanForTrade(traderHolder.id, realBuy.id);
const realRung = plans.addExit(traderHolder.id, realPlan.id, { kind: "TAKE_PROFIT", quantity: 50, priceLow: 15 });
wlSvc.applyExitAlert(plans.listPendingExits().find((e) => e.id === realRung.id), 16);
const realQueued = alertsSvc.listAlerts(traderHolder.id, { unresolvedOnly: true }).find((a) => a.plan_exit_id === realRung.id);
let realNeedsPrice = false;
try {
  await alertsSvc.resolveAlert(traderHolder.id, realQueued.id, { resolution: "accepted" });
} catch (err) {
  realNeedsPrice = /actually sold at/.test(err.message);
}
check("Accepting a REAL rung without a fill price is refused", realNeedsPrice);
const realAccepted = await alertsSvc.resolveAlert(traderHolder.id, realQueued.id, {
  resolution: "accepted", fillPrice: 15.4,
});;
check("...and records the price actually got, not the trigger", realAccepted.transaction.sells[0].price === 15.4);

// Declining, and the two kinds of it.
const declineBuy = await tx.recordBuy({
  holderId: traderHolder.id, symbol: "NOTIF", transactionDate: "2026-02-01", quantity: 30, price: 10, isPaperTrade: true,
});
const declinePlan = plans.createPlanForTrade(traderHolder.id, declineBuy.id);
const badRung = plans.addExit(traderHolder.id, declinePlan.id, { kind: "TAKE_PROFIT", quantity: 30, priceLow: 15 });
wlSvc.applyExitAlert(plans.listPendingExits().find((e) => e.id === badRung.id), 16);
const badQueued = alertsSvc.listAlerts(traderHolder.id, { unresolvedOnly: true }).find((a) => a.plan_exit_id === badRung.id);
await alertsSvc.resolveAlert(traderHolder.id, badQueued.id, {
  resolution: "declined", declineKind: "invalid", note: "level was set wrong",
});
check(
  "Declining a rung as invalid un-hits it, so it cannot count against adherence",
  db.prepare("SELECT status, hit_at FROM plan_exits WHERE id = ?").get(badRung.id).status === "cancelled",
);
check(
  "...and the reason is a column, not prose",
  db.prepare("SELECT decline_kind FROM alerts WHERE id = ?").get(badQueued.id).decline_kind === "invalid",
);
check("Declining never writes a trade", db.prepare("SELECT resulting_transaction_id FROM alerts WHERE id = ?").get(badQueued.id).resulting_transaction_id === null);

console.log("\n14d. Approving a batch clears its pending rows");
// After approval the preview reported the same rows as still to add, because
// approveBatch linked each row to its transaction but left the status at
// 'new'. On screen that reads as the approval having silently failed, and it
// invites a second click on a button that has already done its work.
const clearAcct = acctSvcEarly.createAccount(holder.id, { broker: "fidelity", accountNumber: "5150" });
db.prepare("INSERT INTO securities (symbol, name, data_source) VALUES ('CLRX','Clear Co','manual')").run();
const clearCsv = [
  "Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date",
  "04/01/2026,YOU BOUGHT CLEAR CO (CLRX) (Cash),CLRX,CLEAR CO,Cash,10,5,,,,\"-50\",",
].join("\n");
const importSvc = await import("../services/importService.js");
const clearBatch = importSvc.stageImport({ accountId: clearAcct.id, files: [{ filename: "clear.csv", text: clearCsv }] });
check("Staged as a missing trade", clearBatch.counts.new === 1);

await importSvc.approveBatch(clearBatch.batch.id);
const afterApprove = importSvc.getBatchPreview(clearBatch.batch.id);
check("After approving, nothing is still listed as new", afterApprove.counts.new === 0);
check("...the row is marked matched", afterApprove.counts.matched === 1);
check(
  "...and it points at the transaction it created",
  afterApprove.rows[0].matchedTransactionId != null,
);

db.prepare("DELETE FROM transactions WHERE account_id = ?").run(clearAcct.id);
db.prepare("DELETE FROM accounts WHERE id = ?").run(clearAcct.id);
db.prepare("DELETE FROM securities WHERE symbol = 'CLRX'").run();

console.log("\n14e. Fidelity parser: income rows survive");
const fidelityParser = await import("../services/importers/fidelity.js");

// A dividend, a fund capital-gain distribution and bond interest are income
// against a holding with NO share movement, so their Quantity column is empty
// or zero. A share-quantity guard placed one line too early discarded every
// one of them immediately after correctly identifying it -- $2,003.63 of real
// income vanished from one IRA without a word.
const incomeCsv = [
  "Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date",
  "02/07/2026,DIVIDEND RECEIVED FIDELITY TREND (FTRNX) (Cash),FTRNX,FIDELITY TREND,Cash,,0,,,,81.29,",
  "02/07/2026,LONG-TERM CAP GAIN FIDELITY TREND (FTRNX) (Cash),FTRNX,FIDELITY TREND,Cash,,0,,,,1142.31,",
  "02/07/2026,SHORT-TERM CAP GAIN FIDELITY TREND (FTRNX) (Cash),FTRNX,FIDELITY TREND,Cash,,0,,,,139.12,",
  "03/02/2026,YOU BOUGHT NVIDIA CORP (NVDA) (Cash),NVDA,NVIDIA CORP,Cash,100,10,,,,\"-1000\",",
].join("\n");
const incomeParsed = fidelityParser.parse(incomeCsv);
const incomeRows = incomeParsed.rows.filter((r) => r.transactionType === "DIVIDEND");

check("Dividends survive the share-quantity guard", incomeRows.length === 3);
check(
  "Capital-gain distributions and interest are income too, not unknown actions",
  incomeParsed.skipped.unknownAction === 0,
);
check(
  "Income carries its amount as the price",
  Math.abs(incomeRows.reduce((s, r) => s + r.price, 0) - (81.29 + 1142.31 + 139.12)) < 1e-9,
);
check("...and no share quantity", incomeRows.every((r) => r.quantity === 0));
check(
  "A genuine share row with zero quantity is still rejected",
  fidelityParser.parse(
    incomeCsv.replace(
      '"03/02/2026,YOU BOUGHT NVIDIA CORP (NVDA) (Cash),NVDA,NVIDIA CORP,Cash,100,10,,,,\"-1000\","'.slice(1, -1),
      "03/02/2026,YOU BOUGHT NVIDIA CORP (NVDA) (Cash),NVDA,NVIDIA CORP,Cash,100,0,,,,\"-1000\",",
    ),
  ).rows.filter((r) => r.transactionType === "BUY").length === 0,
);

console.log("\n14f. Import audit: correcting a typo");
const imports = await import("../services/importService.js");

// The whole point of a monthly audit: a trade recorded by hand whose numbers
// disagree with the broker. Until now match.js found these and nothing could
// act on them -- approveBatch writes only rows classified `new`.
const auditAcct = acctSvcEarly.createAccount(holder.id, { broker: "fidelity", accountNumber: "7788" });
db.prepare("INSERT INTO securities (symbol, name, data_source) VALUES ('AUDT','Audit Co','manual')").run();

// Typed from memory at the wrong price, then partly sold -- so a correction
// has to fix the realized P&L of the sale too, not just the purchase.
const typo = await tx.recordBuy({
  holderId: holder.id, accountId: auditAcct.id, symbol: "AUDT",
  transactionDate: "2026-03-02", quantity: 100, price: 79.49,
});
await tx.recordSell({
  holderId: holder.id, accountId: auditAcct.id, symbol: "AUDT",
  transactionDate: "2026-04-01", quantity: 50, price: 85,
});
const auditPnlBefore = tx.listTransactions(holder.id, { symbol: "AUDT", type: "SELL" })[0].realized_pnl;
check(
  "A typo’d buy gives the wrong realized P&L on its sale",
  Math.abs(auditPnlBefore - 50 * (85 - 79.49)) < 1e-9,
);

// Stage a broker row for the same trade at the true price.
const csv = [
  "Run Date,Action,Symbol,Description,Type,Price ($),Quantity,Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date",
  "03/02/2026,YOU BOUGHT AUDIT CO (AUDT) (Cash),AUDT,AUDIT CO,Cash,79.94,100,,,,\"-7994\",03/03/2026",
].join("\n");
const staged = imports.stageImport({ accountId: auditAcct.id, files: [{ filename: "audit.csv", text: csv }] });
check(
  "The audit flags the trade as a discrepancy rather than a new trade",
  staged.counts.needs_review === 1 && staged.counts.new === 0,
);

const discrepancies = imports.listDiscrepancies(staged.batch.id);
check("The discrepancy is listed with its fields", discrepancies.length === 1);
check(
  "...naming ledger vs broker",
  discrepancies[0].differences.some((d) => d.field === "price" && d.ledger === 79.49 && d.broker === 79.94),
);

const corrected = imports.applyCorrection(holder.id, staged.batch.id, discrepancies[0].rowId, {
  fields: ["price"],
});
check("Applying the correction changes the price", corrected.after.price === 79.94);
check("...and reports what it changed from", corrected.before.price === 79.49);

// The reason corrections go through updateTransaction rather than writing
// columns: fixing the buy re-derives the cost basis of every sell linked to
// it, so past realized P&L is corrected too rather than left inconsistent.
const auditPnlAfter = tx.listTransactions(holder.id, { symbol: "AUDT", type: "SELL" })[0].realized_pnl;
check(
  "Correcting the buy also fixes the realized P&L of the sale already made",
  Math.abs(auditPnlAfter - 50 * (85 - 79.94)) < 1e-9,
);

let doubleCorrectRejected = false;
try {
  imports.applyCorrection(holder.id, staged.batch.id, discrepancies[0].rowId);
} catch (err) {
  doubleCorrectRejected = /can be corrected/.test(err.message);
}
check("A row cannot be corrected twice", doubleCorrectRejected);

db.prepare("DELETE FROM transactions WHERE account_id = ?").run(auditAcct.id);
db.prepare("DELETE FROM accounts WHERE id = ?").run(auditAcct.id);
db.prepare("DELETE FROM securities WHERE symbol = 'AUDT'").run();

console.log("\n15. Brokerages and accounts");
const acctSvc = await import("../services/accountsService.js");

// Brokerages are rows now, not a CHECK constraint. v11 existed only to add
// two of them to that enum; opening an account somewhere new should not be a
// schema change.
const brokers = acctSvc.listBrokers();
check("Brokerages are seeded", brokers.length >= 6);
check(
  "Parser-backed brokerages are flagged as such",
  brokers.filter((b) => b.has_parser === 1).map((b) => b.slug).sort().join(",") === "etrade,fidelity,robinhood",
);

// The slug is what importService selects a parser by, so renaming a brokerage
// must not move it.
const etrade = brokers.find((b) => b.slug === "etrade");
const renamed = acctSvc.updateBroker(etrade.id, { name: "Morgan Stanley E*TRADE" });
check("A brokerage can be renamed", renamed.name === "Morgan Stanley E*TRADE");
check("...without its slug moving", renamed.slug === "etrade");
acctSvc.updateBroker(etrade.id, { name: "E*TRADE" });

let dupeBrokerRejected = false;
try {
  acctSvc.createBroker({ name: "Fidelity" });
} catch (err) {
  dupeBrokerRejected = /already exists/.test(err.message);
}
check("A duplicate brokerage key is refused", dupeBrokerRejected);

const newBroker = acctSvc.createBroker({ name: "Interactive Brokers" });
check("A new brokerage is just a row", newBroker.slug === "interactivebrokers");
check(
  "...and is honest that no parser exists for it",
  newBroker.has_parser === 0,
);

// Accounts carry their number as a column. It used to live inside the
// nickname, e.g. "Rollover IRA (146518557)" -- data hiding in a label.
const acctA = acctSvc.createAccount(holder.id, {
  broker: "fidelity", accountNumber: "146518557", accountType: "ira", nickname: "Rollover IRA",
});
const acctB = acctSvc.createAccount(holder.id, {
  broker: "fidelity", accountNumber: "266356256", accountType: "brokerage", nickname: "Wife brokerage",
});
check("An account records its number", acctA.account_number === "146518557");
check(
  "Accounts are labelled brokerage-then-number, which is how statements are",
  acctSvc.getAccount(holder.id, acctA.id).label.startsWith("Fidelity 146518557"),
);

// The concrete payoff: the monthly audit can pick the account itself.
check(
  "A statement filename matches its account",
  acctSvc.matchAccountByFilename(holder.id, "History_for_Account_266356256.csv")?.id === acctB.id,
);
check(
  "A filename with no number matches nothing",
  acctSvc.matchAccountByFilename(holder.id, "Robinhood.csv") === null,
);
check(
  "An unknown number matches nothing rather than guessing",
  acctSvc.matchAccountByFilename(holder.id, "History_for_Account_999999999.csv") === null,
);

let unknownBrokerRejected = false;
try {
  acctSvc.createAccount(holder.id, { broker: "notabroker" });
} catch (err) {
  unknownBrokerRejected = /Unknown brokerage/.test(err.message);
}
check("An unknown brokerage is named, not left to the foreign key", unknownBrokerRejected);

// Cleanup: later sections count rows globally.
db.prepare("DELETE FROM accounts WHERE id IN (?, ?)").run(acctA.id, acctB.id);
db.prepare("DELETE FROM brokers WHERE id = ?").run(newBroker.id);

console.log("\n14. Migrations");
const mig = await import("../lib/migrate.js");
const { SCHEMA_VERSION: CODE_VERSION } = await import("../lib/schemaVersion.js");
const migFiles = mig.listMigrationFiles();

check("Migration files are discovered", migFiles.length > 0);
check(
  "They are ordered by version",
  migFiles.every((m, i) => i === 0 || m.version > migFiles[i - 1].version),
);
check(
  "Versions are contiguous -- a gap means a migration was never written",
  migFiles.every((m, i) => i === 0 || m.version === migFiles[i - 1].version + 1),
);

// The invariant that keeps the by-hand era from returning: bumping
// SCHEMA_VERSION without adding a migration file is exactly how a database
// ends up structurally behind what the code believes it is.
check(
  `The newest migration matches SCHEMA_VERSION (v${CODE_VERSION})`,
  migFiles[migFiles.length - 1].version === CODE_VERSION,
);
check("Every migration file has content", migFiles.every((m) => fs.readFileSync(m.path, "utf8").trim().length > 0));
check(
  "coversFrom is one below the earliest migration",
  mig.coversFrom() === migFiles[0].version - 1,
);

// This suite's database was built from schema.sql, so init should have
// baselined the ledger -- leaving it empty would make a later migrate try to
// replay every file onto a database that already has all of it.
check("The test database has a migration ledger", mig.appliedVersions().size > 0);
check("...and nothing is pending against it", mig.pendingMigrations().length === 0);

console.log("\n9b. Frontend: regression guards for two fixed UI bugs");

// BUG 9: server text into innerHTML. The dashboard's ticker-detail dialog was
// the only place in the frontend bypassing the escape-everything convention.
const dashboardSrc = fs.readFileSync(
  path.join(process.cwd(), "public/js/modules/dashboard/index.js"),
  "utf8",
);
check(
  "Dashboard never interpolates err.message into innerHTML/insertAdjacentHTML",
  !/(innerHTML|insertAdjacentHTML)[^;]*\$\{err\.message\}/s.test(dashboardSrc),
);
check("Dashboard builds its error banner with textContent", /errorBanner[\s\S]{0,220}textContent/.test(dashboardSrc));

// BUG 11: create dialogs must reset on OPEN, not only after a successful
// submit, or cancelled input leaks into the next entry.
const watchlistSrc = fs.readFileSync(
  path.join(process.cwd(), "public/js/modules/watchlist/index.js"),
  "utf8",
);
check(
  "openAddTickerDialog resets the form before showing it",
  /function openAddTickerDialog\(\)[\s\S]{0,400}?addForm\.reset\(\)[\s\S]{0,400}?showModal\(\)/.test(watchlistSrc),
);
check(
  "The New List dialog resets before showing it",
  /newListForm\.reset\(\)[\s\S]{0,120}?newListDialog\.showModal\(\)/.test(watchlistSrc),
);

console.log("\n9c. Frontend: row-action buttons are all deliberately sized");
// The Exits button first shipped larger than the others because the sizing
// properties had been copy-pasted per button, so a new one had none and fell
// back to the default size.
//
// The invariant is that every row-action button is sized ON PURPOSE -- either
// by carrying the shared .icon-btn class, or by having its own padding rule.
// Not that they are identical: delete-txn-btn is legitimately a borderless
// transparent affordance rather than a bordered button.
const ordersRenderSrc = fs.readFileSync(path.join(process.cwd(), "public/js/modules/orders/render.js"), "utf8");
const cssSrc = fs.readFileSync(path.join(process.cwd(), "public/css/style.css"), "utf8");

// class attributes may hold several names, e.g. class="icon-btn edit-txn-btn".
const actionButtons = [...ordersRenderSrc.matchAll(/class="([a-z0-9 -]*-btn)"/g)].map((m) =>
  m[1].split(" ").filter(Boolean),
);
const unsized = actionButtons
  .filter((classes) => !classes.includes("icon-btn"))
  .map((classes) => classes[classes.length - 1])
  .filter((cls) => {
    const rule = new RegExp("\." + cls + "[^{]*\{[^}]*padding");
    return !rule.test(cssSrc);
  });
check(
  `Every row-action button is sized (${actionButtons.length} found)`,
  unsized.length === 0,
);
if (unsized.length) console.log(`      unsized, will render at default size: ${unsized.join(", ")}`);

// Icon-only buttons carry no text, so the tooltip is not enough on its own.
const iconButtons = [...ordersRenderSrc.matchAll(/<button[^>]*class="icon-btn[^"]*"[^>]*>/g)].map((m) => m[0]);
check(
  `Every icon-only button has an aria-label (${iconButtons.length} found)`,
  iconButtons.length > 0 && iconButtons.every((b) => b.includes("aria-label=")),
);

console.log("\n9. Frontend wiring: every getElementById target exists in index.html");
// This suite can't click buttons, but it CAN catch the most common way the UI
// silently breaks: JS reaching for an element id that the HTML doesn't have
// (a rename on one side only). Cheap, and covers a real blind spot.
const indexHtml = fs.readFileSync(path.join(process.cwd(), "public", "index.html"), "utf8");
const uiModules = [
  "public/js/main.js",
  "public/js/modules/orders/index.js",
  "public/js/modules/dashboard/index.js",
  "public/js/modules/watchlist/index.js",
  "public/js/modules/settings/index.js",
  "public/js/modules/journal/index.js",
  "public/js/modules/papertrade/index.js",
  "public/js/modules/alerts/index.js",
  "public/js/modules/plans/dialog.js",
  "public/js/modules/notifications/index.js",
  "public/js/modules/imports/index.js",
];
let idsChecked = 0;
const missingIds = [];
for (const relPath of uiModules) {
  const source = fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
  for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) {
    idsChecked++;
    if (!indexHtml.includes(`id="${match[1]}"`)) {
      missingIds.push(`${relPath} -> #${match[1]}`);
    }
  }
}
check(
  `All ${idsChecked} element ids referenced by JS exist in index.html`,
  missingIds.length === 0,
);
if (missingIds.length > 0) console.log("      missing:", missingIds.join(", "));

for (const selector of [".settings-panel", ".orders-panel", ".source-panel", ".journal-panel", ".papertrade-panel", ".alerts-bell", ".view-btn"]) {
  check(`index.html contains elements matching ${selector}`, indexHtml.includes(selector.slice(1)));
}

console.log("\n4. Sanity: schema constraints still enforced through the app layer");
try {
  // Includes a valid watchlist_id so this actually isolates the order_type
  // CHECK constraint, rather than failing for the unrelated reason of
  // omitting a NOT NULL column.
  db.prepare(
    "INSERT INTO watched_items (holder_id, watchlist_id, security_id, order_type, is_paper_trade) VALUES (?, ?, ?, 'NOT_A_REAL_TYPE', 0)",
  ).run(holder.id, defaultList.id, item.security_id);
  check("Invalid order_type rejected", false);
} catch {
  check("Invalid order_type rejected", true);
}

try {
  db.prepare(
    "INSERT INTO watched_items (holder_id, security_id, order_type, is_paper_trade) VALUES (?, ?, 'BUY_LIMIT', 0)",
  ).run(holder.id, item.security_id);
  check("Missing watchlist_id rejected (NOT NULL)", false);
} catch {
  check("Missing watchlist_id rejected (NOT NULL)", true);
}


// ---------------------------------------------------------------------------
console.log("\n20. Summary strip (shared by Dashboard and Orders)");
// This renderer had no coverage at all while it lived in orders/render.js, and
// it now draws the strip on two tabs. Its rules are not cosmetic: it decides
// when a number is unknown rather than zero, and when a total may be shown at
// all. Both fail silently and read as a confident figure, which is exactly the
// failure mode this project keeps hitting.
const { renderSummary } = await import("../public/js/modules/shared/summary.js");

{
  const priced = {
    positionCount: 3, lotCount: 5, pricedCount: 3, unpricedCount: 0,
    totalCost: 21850.7, totalValue: 18848.64, unrealizedPnl: -3002.06,
    unrealizedPnlPercent: -13.74, realizedPnl: 4440.46, dividendIncome: 2014.02,
    totalReturn: 3452.42, cash: 4797.73, cashIsDerived: false, accountTotal: 23646.37,
  };
  const html = renderSummary(priced);

  check("Thousands separators, so $21,850.70 cannot be misread", html.includes("$21,850.70"));
  check("A loss renders signed and negative", html.includes("-$3,002.06"));
  check("Cash appears when the view is scoped to one account", html.includes("$4,797.73"));
  check("Account total appears when every position is priced", html.includes("$23,646.37"));
  check("A recorded cash balance carries no derived asterisk", !html.includes("Cash *"));
  check("Lot count is surfaced when it exceeds position count", html.includes("in 5 lots"));

  // The distinction the strip exists to protect.
  const unpriced = { ...priced, totalValue: null, unrealizedPnl: null, unrealizedPnlPercent: null, accountTotal: null };
  const uhtml = renderSummary(unpriced);
  check("No prices yet renders an em dash, not $0.00", !uhtml.includes("$0.00"));
  check("...and not a figure silently equal to cost basis", uhtml.split("$21,850.70").length === 2);
  check("Total return is labelled realized-only when value is unknown", uhtml.includes("realized only"));

  // Cross-account: summing balances gives a figure no statement shows.
  const allAccounts = { ...priced, cash: null, accountTotal: null };
  check("Cash is hidden when no single account is in scope", !renderSummary(allAccounts).includes("Cash"));
  check("...and so is the account total", !renderSummary(allAccounts).includes("Account Total"));

  // Derived cash is a claim about completeness, and has to say so.
  check("Derived cash is flagged", renderSummary({ ...priced, cashIsDerived: true }).includes("Cash *"));

  // An account holding only cash and no shares -- Schwab, TradeStation.
  const cashOnly = {
    positionCount: 0, lotCount: 0, pricedCount: 0, unpricedCount: 0,
    totalCost: 0, totalValue: 0, unrealizedPnl: 0, unrealizedPnlPercent: null,
    realizedPnl: 0, dividendIncome: 0, totalReturn: 0,
    cash: 100, cashIsDerived: false, accountTotal: 100,
  };
  const cashHtml = renderSummary(cashOnly);
  check("A funded account with no shares still shows its cash", cashHtml.includes("$100.00"));
  check("...and its account total, which is exactly that cash", cashHtml.split("$100.00").length === 3);
  check("...rather than dismissing it as empty", !cashHtml.includes("No open positions"));
  check(
    "A genuinely empty, unscoped view still says so",
    renderSummary({ ...cashOnly, cash: null, accountTotal: null }).includes("No open positions"),
  );

  // A partially-priced portfolio must admit it.
  check("A partial market value says how many are priced",
    renderSummary({ ...priced, pricedCount: 2, unpricedCount: 1 }).includes("2/3 priced"));
}

// ---------------------------------------------------------------------------
console.log("\n21. FIFO respects thesis boundaries");
// The failure this prevents is not an arithmetic one -- the share counts and
// the cost basis stayed correct throughout. It is that a sale made for one
// thesis silently drew its shares from another, because that other lot merely
// happened to be older. The position was right and the ATTRIBUTION was wrong,
// which for an app that exists to measure source reliability is the worse of
// the two.
{
  const boundaryHolder = db
    .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Boundary Test', 0) RETURNING *")
    .get();
  db.prepare(
    "INSERT INTO securities (symbol, exchange_id, name, data_source) VALUES ('RKLB', ?, 'Rocket Lab', 'manual')",
  ).run(exchangeId);

  const mk = (date, qty, price) =>
    tx.recordBuy({
      holderId: boundaryHolder.id, symbol: "RKLB",
      transactionDate: date, quantity: qty, price,
    });

  // Thesis A is OLDER, so plain FIFO would always reach for it first.
  const buyA = await mk("2026-01-10", 100, 10);
  const buyB = await mk("2026-02-10", 100, 20);
  const planA = plans.createPlanForTrade(boundaryHolder.id, buyA.id, { notes: "telegram call" });
  const planB = plans.createPlanForTrade(boundaryHolder.id, buyB.id, { notes: "book pattern" });

  check("Two theses can hold the same ticker", planA.id !== planB.id);
  check("Each thesis counts only its own shares", plans.planRemainingQuantity(planA.id) === 100);

  // The guard.
  let refused = "";
  try {
    await tx.recordSell({
      holderId: boundaryHolder.id, symbol: "RKLB",
      transactionDate: "2026-03-01", quantity: 50, price: 30,
    });
  } catch (err) { refused = err.message; }
  check("An unattributed sale across two theses is refused", /different theses/.test(refused));
  check("...and the refusal names the plans", refused.includes("plan " + planA.id));
  check("...and says why it matters", /attribution/.test(refused));

  // Selling the YOUNGER thesis must not touch the older, cheaper lot.
  const soldB = await tx.recordSell({
    holderId: boundaryHolder.id, symbol: "RKLB", planId: planB.id,
    transactionDate: "2026-03-01", quantity: 50, price: 30,
  });
  check("A plan-scoped sale succeeds", soldB.sells.length === 1);
  check("It draws from that thesis's lot", soldB.sells[0].linked_buy_id === buyB.id);
  check("...and leaves the older thesis untouched", plans.planRemainingQuantity(planA.id) === 100);
  check("...while its own count falls", plans.planRemainingQuantity(planB.id) === 50);

  // Cost basis proves which lot was actually consumed: B cost $20, A cost $10.
  check("Realized P&L uses the SELLING thesis's cost", Math.abs(soldB.realizedPnl - 500) < 1e-9);

  // The sell row records the thesis, which the efficiency report will need.
  check(
    "The sell row records which thesis gave up the shares",
    db.prepare("SELECT plan_id FROM transactions WHERE id = ?").get(soldB.sells[0].id).plan_id === planB.id,
  );

  // A plan cannot sell shares it does not hold, even when the ACCOUNT has them.
  let overPlan = "";
  try {
    await tx.recordSell({
      holderId: boundaryHolder.id, symbol: "RKLB", planId: planB.id,
      transactionDate: "2026-03-02", quantity: 80, price: 30,
    });
  } catch (err) { overPlan = err.message; }
  check("A thesis cannot oversell itself while the account still holds more", /only 50/.test(overPlan));
  check("...and the account genuinely did still hold 150", plans.planRemainingQuantity(planA.id) === 100);

  // Naming a lot is MORE specific than naming a thesis, so it must not trip
  // the ambiguity guard. Ordered wrongly, this was refused -- the one case
  // where the user had been maximally explicit.
  const lotSell = await tx.recordSell({
    holderId: boundaryHolder.id, symbol: "RKLB", lotId: buyA.id,
    transactionDate: "2026-05-01", quantity: 10, price: 30,
  });
  check("Selling an explicitly named lot is never ambiguous", lotSell.sells.length === 1);
  check("...and it comes from the named lot", lotSell.sells[0].linked_buy_id === buyA.id);
  check(
    "...and inherits that lot's thesis",
    db.prepare("SELECT plan_id FROM transactions WHERE id = ?").get(lotSell.sells[0].id).plan_id === planA.id,
  );

  // Untagged lots are their own bucket: "some under a thesis, some not" is
  // exactly as ambiguous as two named theses, and was the case most likely to
  // be waved through.
  const looseHolder = db
    .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Loose Lot Test', 0) RETURNING *")
    .get();
  const tagged = await tx.recordBuy({
    holderId: looseHolder.id, symbol: "RKLB", transactionDate: "2026-01-05", quantity: 10, price: 10,
  });
  const loosePlan = plans.createPlanForTrade(looseHolder.id, tagged.id);
  await tx.recordBuy({
    holderId: looseHolder.id, symbol: "RKLB", transactionDate: "2026-01-06", quantity: 10, price: 11,
  });
  let mixed = "";
  try {
    await tx.recordSell({
      holderId: looseHolder.id, symbol: "RKLB",
      transactionDate: "2026-02-01", quantity: 5, price: 12,
    });
  } catch (err) { mixed = err.message; }
  check("Tagged plus untagged lots also refuse an unattributed sale", /different theses/.test(mixed));
  check("...and the message mentions the untagged ones", /untagged/.test(mixed));
  check("...and a plan-scoped sale still works", (await tx.recordSell({
    holderId: looseHolder.id, symbol: "RKLB", planId: loosePlan.id,
    transactionDate: "2026-02-01", quantity: 5, price: 12,
  })).sells.length === 1);

  // Backward compatibility: the ordinary case must not have become harder.
  const plainHolder = db
    .prepare("INSERT INTO account_holders (name, is_default) VALUES ('No Plans Test', 0) RETURNING *")
    .get();
  await tx.recordBuy({
    holderId: plainHolder.id, symbol: "RKLB", transactionDate: "2026-01-01", quantity: 10, price: 10,
  });
  await tx.recordBuy({
    holderId: plainHolder.id, symbol: "RKLB", transactionDate: "2026-01-02", quantity: 10, price: 12,
  });
  const plainSell = await tx.recordSell({
    holderId: plainHolder.id, symbol: "RKLB", transactionDate: "2026-02-01", quantity: 15, price: 20,
  });
  check("With no plans at all, FIFO spans lots exactly as before", plainSell.sells.length === 2);
  check("...oldest first", plainSell.sells[0].cost_basis === 100);

  // The import path must not dead-end: a broker file cannot answer the
  // question, so the row is flagged for the monthly audit instead of refused.
  const importAcct = acctSvcEarly.createAccount(boundaryHolder.id, {
    broker: "fidelity",
    accountNumber: "8801",
  });
  const batch = db
    .prepare("INSERT INTO import_batches (account_id, broker, row_count) VALUES (?, 'test', 1) RETURNING *")
    .get(importAcct.id);
  const imported = await tx.recordSell({
    holderId: boundaryHolder.id, symbol: "RKLB",
    transactionDate: "2026-04-01", quantity: 20, price: 30,
    importBatchId: batch.id,
  });
  check("An ambiguous IMPORTED sale is allowed through", imported.sells.length >= 1);
  const flagged = db.prepare("SELECT needs_review, review_reason FROM transactions WHERE id = ?")
    .get(imported.sells[0].id);
  check("...but flagged for review", flagged.needs_review === 1);
  check("...with a reason naming the theses it spanned", /plan /.test(flagged.review_reason));
  check("...and saying the file could not answer it", /broker file/.test(flagged.review_reason));
}

// ---------------------------------------------------------------------------
console.log("\n22. The sell form's lot picker agrees with the server's guard");
// The dropdown and the ambiguity guard must share one definition of
// "ambiguous". If they drift, the control offers a choice the server then
// refuses, which reads as the app being broken rather than the user being
// asked a fair question.
{
  const { renderLotOptions } = await import("../public/js/modules/orders/render.js");

  const oneThesis = [
    { lot_id: 1, transaction_date: "2026-01-10", quantity_remaining: 100, cost_per_share: 10, plan_id: 7, plan_source_name: "Telegram" },
    { lot_id: 2, transaction_date: "2026-02-10", quantity_remaining: 50, cost_per_share: 12, plan_id: 7, plan_source_name: "Telegram" },
  ];
  const single = renderLotOptions(oneThesis);
  check("One thesis still offers plain FIFO", single.includes("Oldest first (FIFO)"));
  check("...and does not clutter the options with a thesis name", !single.includes("Telegram"));

  const twoTheses = [
    oneThesis[0],
    { lot_id: 3, transaction_date: "2026-03-10", quantity_remaining: 40, cost_per_share: 20, plan_id: 9, plan_source_name: "Book X" },
  ];
  const spanning = renderLotOptions(twoTheses);
  check("Two theses withdraw FIFO as a default", !spanning.includes("Oldest first (FIFO)"));
  check("...and say why", /spans 2 theses/.test(spanning));
  check("...and label each lot with its thesis", spanning.includes("Telegram") && spanning.includes("Book X"));

  // Untagged lots are their own bucket on BOTH sides, or the two disagree.
  const mixed = [oneThesis[0], { lot_id: 4, transaction_date: "2026-04-10", quantity_remaining: 10, cost_per_share: 15, plan_id: null }];
  const mixedHtml = renderLotOptions(mixed);
  check("Tagged plus untagged counts as spanning, exactly as the server has it", /spans 2 theses/.test(mixedHtml));
  check("...and the untagged lot is labelled as such", mixedHtml.includes("no thesis"));

  // Falls back through the identifiers a plan might actually have.
  const noSource = [
    oneThesis[0],
    { lot_id: 5, transaction_date: "2026-05-10", quantity_remaining: 10, cost_per_share: 15, plan_id: 11, plan_strategy_title: "Volume breakout" },
  ];
  check("A plan with no source falls back to its strategy", renderLotOptions(noSource).includes("Volume breakout"));
  const bare = [oneThesis[0], { lot_id: 6, transaction_date: "2026-06-10", quantity_remaining: 10, cost_per_share: 15, plan_id: 12 }];
  check("A plan with neither still identifies itself", renderLotOptions(bare).includes("plan 12"));
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
