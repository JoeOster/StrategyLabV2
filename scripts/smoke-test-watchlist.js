// Manual end-to-end check: real holder, real security (resolved live from
// Yahoo), a watched item with a target price deliberately set above the
// current price so it fires immediately, then checkAlerts() run for real.
// Not a replacement for a proper test suite -- just proof the wiring works
// before building a UI on top of it.
import db from "../lib/db.js";
import { addWatchedItem, listWatchedItems, checkAlerts } from "../services/watchlistService.js";

async function main() {
  const holder = db
    .prepare("INSERT INTO account_holders (name, is_default) VALUES ('Smoke Test', 1) RETURNING *")
    .get();
  console.log("Created holder:", holder);

  const symbol = process.argv[2] || "AAPL";
  console.log(`\nResolving security + live quote for ${symbol}...`);

  const item = await addWatchedItem({
    holderId: holder.id,
    symbol,
    orderType: "BUY_LIMIT",
    targetPrice: 100000, // absurdly high so it triggers against any real price
    notes: "smoke test",
  });
  console.log("Watched item created:", item);

  console.log("\nRunning checkAlerts() against live Yahoo data...");
  const fired = await checkAlerts();
  console.log("Alerts fired:", fired);

  const list = listWatchedItems(holder.id, {});
  console.log("\nWatchlist after check:", list);

  if (fired.length === 0) {
    throw new Error("Expected the deliberately-absurd target to fire an alert, but none fired.");
  }
  console.log("\nSMOKE TEST PASSED");
}

main().catch((err) => {
  console.error("\nSMOKE TEST FAILED:", err);
  process.exitCode = 1;
});
