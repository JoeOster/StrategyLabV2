// The "Data" file for the dashboard module. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchPositions = () => fetch("/api/positions").then(handleResponse);

export const fetchTickerDetail = (symbol, days = 180) =>
  fetch(`/api/ticker/${encodeURIComponent(symbol)}?days=${days}`).then(handleResponse);

export const refreshPrices = () =>
  fetch("/api/check-alerts", { method: "POST" }).then(handleResponse);
