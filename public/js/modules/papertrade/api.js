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

export const deleteTransaction = (id) =>
  fetch(`/api/transactions/${id}/delete`, { method: "POST" }).then(handleResponse);

/** Flips a paper BUY to a real one in place -- see promotePaperTrade in transactionsService.js. */
export const promoteTransaction = (id) =>
  fetch(`/api/transactions/${id}/promote`, { method: "POST" }).then(handleResponse);

export const fetchSources = () => fetch("/api/sources").then(handleResponse);

export const fetchStrategies = () => fetch("/api/strategies").then(handleResponse);

// Security prices aren't scoped by paper/real -- a ticker has one quote
// regardless of which tab holds a position in it -- so this hits the same
// endpoint Orders uses.
export const refreshPrices = () =>
  fetch("/api/check-alerts", { method: "POST" }).then(handleResponse);
