// The "Data" file for the Paper Trade module. Same endpoints as Orders, but
// every read is scoped with ?paper=1 and every write forces isPaperTrade
// true -- see server.js's /api/positions and /api/transactions for the
// shared query-param convention this relies on.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchPositions = () => fetch("/api/positions?paper=1").then(handleResponse);

export function fetchTransactions(filters = {}) {
  const params = new URLSearchParams({ paper: "1" });
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  return fetch(`/api/transactions?${params.toString()}`).then(handleResponse);
}

export const recordTransaction = (payload) =>
  fetch("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, isPaperTrade: true }),
  }).then(handleResponse);

export const updateTransaction = (id, payload) =>
  fetch(`/api/transactions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(handleResponse);

/** Orders are voided, never deleted -- the row survives for the audit trail. */
export const voidTransaction = (id, reason = null) =>
  fetch(`/api/transactions/${id}/void`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  }).then(handleResponse);

export const fetchQuote = (symbol) =>
  fetch(`/api/quote/${encodeURIComponent(symbol)}`).then(handleResponse);

/**
 * Records that a paper trade was actually taken.
 *
 * Creates a NEW real transaction and leaves the paper one running -- see
 * promotePaperTrade in transactionsService.js for why both legs have to
 * survive. Requires the price actually paid.
 */
export const promoteTransaction = (id, body) =>
  fetch(`/api/transactions/${id}/promote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(handleResponse);

export const fetchSources = () => fetch("/api/sources").then(handleResponse);

export const fetchStrategies = () => fetch("/api/strategies").then(handleResponse);

// Security prices aren't scoped by paper/real -- a ticker has one quote
// regardless of which tab holds a position in it -- so this hits the same
// endpoint Orders uses.
export const refreshPrices = () =>
  fetch("/api/check-alerts", { method: "POST" }).then(handleResponse);
