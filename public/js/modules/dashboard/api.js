// The "Data" file for the dashboard module. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchPositions = ({ accountId = null } = {}) =>
  fetch(`/api/positions${accountId ? `?accountId=${accountId}` : ""}`).then(handleResponse);

export const fetchAccountsForFilter = () => fetch("/api/accounts").then(handleResponse);

export const fetchTickerDetail = (symbol, days = 180) =>
  fetch(`/api/ticker/${encodeURIComponent(symbol)}?days=${days}`).then(handleResponse);

export const refreshPrices = () =>
  fetch("/api/check-alerts", { method: "POST" }).then(handleResponse);

export const fetchTickerNews = (symbol) =>
  fetch(`/api/ticker/${encodeURIComponent(symbol)}/news`).then(handleResponse);

export const refreshTicker = (symbol) =>
  fetch(`/api/ticker/${encodeURIComponent(symbol)}/refresh`, { method: "POST" }).then(handleResponse);
