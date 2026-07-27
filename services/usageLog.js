// Every outbound call to a market data provider goes through here. This is
// the thing that stops a future rewrite from repeating the Polygon/Alpha
// Vantage mistake -- self-throttling instead of finding the limit by
// getting locked out.
import db from "../lib/db.js";

const insertLog = db.prepare(
  `INSERT INTO api_usage_log (provider, endpoint, status_code, note)
   VALUES (@provider, @endpoint, @statusCode, @note)`,
);

const countRecentCalls = db.prepare(
  `SELECT COUNT(*) AS n FROM api_usage_log
   WHERE provider = ? AND called_at >= datetime('now', ?)`,
);

// Soft per-minute budgets. These are deliberately DIFFERENT per provider --
// an earlier version gave Yahoo the same cap as Finnhub, which meant a
// nightly history refresh of more than ~30 tickers would trip a limit that
// only ever applied to Finnhub.
//
//   finnhub - a real, enforced quota on the free tier (60/min). Kept at 50
//             to leave headroom for bursts from the UI while a job runs.
//   yahoo   - unofficial, no published limit. Still self-limited out of
//             courtesy (it's someone else's server), but generously: this is
//             a politeness ceiling, not a quota we're rationing.
//   openlibrary - free, no key, no documented hard limit -- but these calls
//                 are user-triggered one at a time (typing an ISBN), never
//                 batched, so a low budget is plenty and keeps the same
//                 self-throttling habit even for an API with no stated cap.
const PROVIDER_BUDGETS = {
  finnhub: { windowSql: "-60 seconds", max: 50 },
  yahoo: { windowSql: "-60 seconds", max: 300 },
  openlibrary: { windowSql: "-60 seconds", max: 20 },
};

export function assertBudget(provider) {
  const budget = PROVIDER_BUDGETS[provider];
  if (!budget) return; // unknown provider, no budget configured -- let it through
  const { n } = countRecentCalls.get(provider, budget.windowSql);
  if (n >= budget.max) {
    throw new Error(
      `Rate budget exceeded for ${provider}: ${n} calls in the last 60s (limit ${budget.max}). Backing off.`,
    );
  }
}

export function logCall(provider, endpoint, statusCode, note = null) {
  insertLog.run({ provider, endpoint, statusCode, note });
}

// Wraps a provider call: checks the budget, runs it, logs success/failure
// either way, and re-throws so the caller still sees the real error.
export async function withUsageLog(provider, endpoint, fn) {
  assertBudget(provider);
  try {
    const result = await fn();
    logCall(provider, endpoint, 200);
    return result;
  } catch (err) {
    logCall(provider, endpoint, err.statusCode ?? 500, String(err.message).slice(0, 200));
    throw err;
  }
}
