// Fetch daily price history for securities that have none.
//
// The app backfills on demand and, until the Research button started asking,
// nothing ever demanded it: 117 of 118 securities had no stored prices at all.
// Every ticker detail dialog drew an empty chart and reported no 52-week range,
// and the benchmark comparison had exactly one security it could measure
// against. The capability existed the whole time and was simply never called.
//
// Run:  npm run db:backfill-history [-- --all] [-- --dry-run]
//
// Defaults to securities you currently HOLD, which is the set where a missing
// chart is actually noticeable. `--all` covers every security on file,
// including long-closed positions, which is worth it once if the backtester in
// V2_BACKLOG is ever built and pointless before then.
import db from "../lib/db.js";
import { backfillSecurityHistory } from "../services/watchlistService.js";

const all = process.argv.includes("--all");
const dryRun = process.argv.includes("--dry-run");

const targets = db
  .prepare(
    `SELECT s.id, s.symbol
       FROM securities s
      WHERE NOT EXISTS (SELECT 1 FROM historical_prices h WHERE h.security_id = s.id)
        AND (@all = 1 OR EXISTS (
              SELECT 1 FROM transactions t
               WHERE t.security_id = s.id AND t.quantity_remaining > 0 AND t.voided_at IS NULL))
      ORDER BY s.symbol`,
  )
  .all({ all: all ? 1 : 0 });

console.log(
  `${targets.length} ${all ? "securities" : "held securities"} with no stored history` +
    `${dryRun ? " (dry run)" : ""}\n`,
);

if (dryRun) {
  for (const t of targets) console.log(`  ${t.symbol}`);
  console.log("\nDry run -- nothing fetched.");
  process.exit(0);
}

let filled = 0;
const failed = [];

for (const t of targets) {
  try {
    const result = await backfillSecurityHistory(t.id, t.symbol);
    // Zero bars is not an error and not a success. A delisted ticker, or one
    // Yahoo does not carry, returns an empty series rather than throwing --
    // counting that as "filled" would make the summary claim coverage the
    // database does not have.
    if (result.barCount > 0) {
      filled++;
      console.log(`  ${t.symbol.padEnd(8)} ${String(result.barCount).padStart(4)} bars`);
    } else {
      failed.push({ symbol: t.symbol, error: "no bars returned" });
    }
  } catch (err) {
    // One bad ticker must not abandon the rest. The app's own usage budget
    // (300 calls/60s) surfaces here as an error too, which is the right
    // behaviour: better to report a gap than to hammer the provider past a
    // limit this app set for itself.
    failed.push({ symbol: t.symbol, error: err.message });
  }
}

console.log(`\n${filled} filled, ${failed.length} could not be fetched`);
if (failed.length) {
  console.log("\nStill without history:");
  for (const f of failed) console.log(`  ${f.symbol.padEnd(8)} ${f.error}`);
}
