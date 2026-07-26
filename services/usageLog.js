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

// Soft per-minute budgets, kept comfortably under each provider's real
// limit. Finnhub free tier is 60/min; Yahoo is unofficial and has no
// published limit, but it's still someone else's server, so we self-limit.
const PROVIDER_BUDGETS = {
  finnhub: { windowSql: "-60 seconds", max: 50 },
  yahoo: { windowSql: "-60 seconds", max: 60 },
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
