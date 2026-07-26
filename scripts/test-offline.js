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
} = await import("../services/watchlistService.js");

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

console.log("\n2. DB wiring checks (no network -- security pre-seeded)");
db.prepare("INSERT INTO exchanges (code, name) VALUES ('NASDAQ','Nasdaq')").run();
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

console.log("\n5. Settings: general key/value");
const settingsSvc = await import("../services/settingsService.js");
const defaults = settingsSvc.getGeneralSettings();
check("Unset settings fall back to defaults", defaults.app_title === "Strategy Lab");
settingsSvc.saveGeneralSettings({ app_title: "Joe's Lab", default_take_profit_percent: "12.5" });
check("Saved values are read back", settingsSvc.getGeneralSettings().app_title === "Joe's Lab");
check(
  "Unsaved keys keep their defaults",
  settingsSvc.getGeneralSettings().notification_cooldown_minutes === "30",
);
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
check("listHolders returns both holders with counts", holders.length === 2);
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

console.log("\n6d. Transactions: deletion restores lot state");
const lastSell = tx
  .listTransactions(traderHolder.id, { type: "SELL" })
  .find((t) => t.linked_buy_id === lot2.id);
const beforeQty = db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(lot2.id)
  .quantity_remaining;
tx.deleteTransaction(traderHolder.id, lastSell.id);
const afterQty = db.prepare("SELECT quantity_remaining FROM transactions WHERE id = ?").get(lot2.id)
  .quantity_remaining;
check("Deleting a sell returns its shares to the lot", afterQty === beforeQty + lastSell.quantity);

let deleteSoldBuyBlocked = false;
try {
  tx.deleteTransaction(traderHolder.id, lot1.id);
} catch {
  deleteSoldBuyBlocked = true;
}
check("Cannot delete a buy that has already been sold", deleteSoldBuyBlocked);

check(
  "Cannot delete another holder's transaction",
  tx.deleteTransaction(holder.id, lot2.id).deleted === 0,
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

for (const selector of [".settings-panel", ".orders-panel", ".source-panel", ".view-btn"]) {
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
