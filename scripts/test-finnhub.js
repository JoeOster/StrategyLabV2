// One-off live verification for the Finnhub provider path -- see
// STATUS.md's V2_BACKLOG note: "written but has never executed." This is
// NOT part of the offline test suite (it makes a real network call and
// needs a real FINNHUB_API_KEY), so it isn't run by `npm run test:offline`.
//
// Run with: node scripts/test-finnhub.js [SYMBOL]
// (defaults to AAPL if no symbol given)
import * as finnhub from "../services/providers/finnhubProvider.js";

const symbol = process.argv[2] || "AAPL";

if (!process.env.FINNHUB_API_KEY) {
  console.error("FINNHUB_API_KEY is not set -- check .env exists and has the key filled in.");
  process.exit(1);
}

console.log(`Testing Finnhub provider against a real network call for ${symbol}...\n`);

try {
  console.log("getQuote()...");
  const quote = await finnhub.getQuote(symbol);
  console.log("  OK:", quote);
} catch (err) {
  console.error("  FAILED:", err.message);
}

try {
  console.log("\ngetProfile()...");
  const profile = await finnhub.getProfile(symbol);
  console.log("  OK:", profile);
} catch (err) {
  console.error("  FAILED:", err.message);
}

console.log("\nDone. Check data/strategy_lab.dev.db's api_usage_log table if you want to see the logged calls.");
