// The "Data" file for the orders module. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchPositions = () => fetch("/api/positions").then(handleResponse);

export function fetchTransactions(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return fetch(`/api/transactions${query ? `?${query}` : ""}`).then(handleResponse);
}

export const recordTransaction = (payload) =>
  fetch("/api/transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(handleResponse);

export const updateTransaction = (id, payload) =>
  fetch(`/api/transactions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(handleResponse);

export const deleteTransaction = (id) =>
  fetch(`/api/transactions/${id}/delete`, { method: "POST" }).then(handleResponse);

export const fetchSources = () => fetch("/api/sources").then(handleResponse);

export const refreshPrices = () =>
  fetch("/api/check-alerts", { method: "POST" }).then(handleResponse);
