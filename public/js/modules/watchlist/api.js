// The "Data" file. Every server call for this module goes through here.
// Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function fetchWatchlists() {
  return fetch("/api/watchlists").then(handleResponse);
}

export function fetchWatchedItems(watchlistId) {
  const url = watchlistId ? `/api/watched-items?watchlistId=${watchlistId}` : "/api/watched-items";
  return fetch(url).then(handleResponse);
}

export function checkExisting(symbol, orderType) {
  const params = new URLSearchParams({ symbol });
  if (orderType) params.set("orderType", orderType);
  return fetch(`/api/watched-items/check?${params}`).then(handleResponse);
}

export function addWatchedItem(payload) {
  return fetch("/api/watched-items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then(handleResponse);
}

export function deleteWatchedItems(ids) {
  return fetch("/api/watched-items/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  }).then(handleResponse);
}

export function createWatchlist(name) {
  return fetch("/api/watchlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }).then(handleResponse);
}

export function runCheckAlerts() {
  return fetch("/api/check-alerts", { method: "POST" }).then(handleResponse);
}

export function runRefreshHistory() {
  return fetch("/api/refresh-history", { method: "POST" }).then(handleResponse);
}
