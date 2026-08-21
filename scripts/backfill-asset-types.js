// One-off: fill in asset_type for securities recorded before it was written.
//
// The column has enumerated seven types since the first schema and nothing
// ever set it, so every row in the database says 'stock' -- including the six
// Fidelity mutual funds and any money-market sweep that slipped past the
// parser's skip list.
//
// Run:  npm run db:backfill-asset-types [-- --dry-run]
//
// Idempotent. Re-running only touches rows whose stored type disagrees with
// the provider, so it is safe to run again after adding securities.
import db from "../lib/db.js";
import * as yahoo from "../services/providers/yahooProvider.js";
import { mapAssetType } from "../services/priceService.js";

const dryRun = process.argv.includes("--dry-run");

const securities = db
  .prepare("SELECT id, symbol, asset_type FROM securities ORDER BY symbol")
  .all();

const update = db.prepare(
  "UPDATE securities SET asset_type = ?, profile_updated_at = datetime('now') WHERE id = ?",
);

console.log(`${securities.length} securities to check${dryRun ? " (dry run)" : ""}\n`);

const changed = [];
const failed = [];
let unchanged = 0;

for (const s of securities) {
  try {
    const profile = await yahoo.getProfile(s.symbol);
    const mapped = mapAssetType(profile.quoteType);
    if (mapped === s.asset_type) {
      unchanged++;
      continue;
    }
    changed.push({ ...s, to: mapped, quoteType: profile.quoteType });
    if (!dryRun) update.run(mapped, s.id);
    console.log(`  ${s.symbol.padEnd(8)} ${s.asset_type} -> ${mapped}  (${profile.quoteType})`);
  } catch (err) {
    // A delisted ticker no longer resolves, and that is not a reason to abort
    // a backfill over a hundred others. Collected and reported at the end so
    // the failures are visible rather than scrolled past.
    failed.push({ symbol: s.symbol, error: err.message });
  }
}

console.log(`\n${changed.length} reclassified, ${unchanged} already correct, ${failed.length} could not be looked up`);

if (failed.length) {
  console.log("\nNot looked up (left at their stored value):");
  for (const f of failed) console.log(`  ${f.symbol.padEnd(8)} ${f.error}`);
}

if (dryRun && changed.length) console.log("\nDry run -- nothing was written.");
