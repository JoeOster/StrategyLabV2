// The "Data" file for Journal. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function send(url, method, body) {
  return fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(handleResponse);
}

// --- Ideas (paper watched_items) ---
export function fetchIdeas(filters = {}) {
  const params = new URLSearchParams();
  if (filters.sourceId) params.set("sourceId", filters.sourceId);
  if (filters.strategyId) params.set("strategyId", filters.strategyId);
  if (filters.status) params.set("status", filters.status);
  const qs = params.toString();
  return fetch(`/api/journal/ideas${qs ? `?${qs}` : ""}`).then(handleResponse);
}
export const createIdea = (payload) => send("/api/journal/ideas", "POST", payload);
export const executeIdea = (id, fill) => send(`/api/journal/ideas/${id}/execute`, "POST", fill);
// Ideas are watched_items under the hood -- the existing Watchlist delete
// endpoint already handles holder-scoping and alert-history cleanup, so
// abandoning an idea reuses it rather than duplicating that logic here.
export const deleteIdeas = (ids) => send("/api/watched-items/delete", "POST", { ids });

// --- Strategies ---
export function fetchStrategies(sourceId) {
  const qs = sourceId ? `?sourceId=${sourceId}` : "";
  return fetch(`/api/strategies${qs}`).then(handleResponse);
}
export const fetchStrategy = (id) => fetch(`/api/strategies/${id}`).then(handleResponse);
// payload: { title, notes?, sources: [{ sourceId, chapter?, pageNumber?, notes? }, ...] }
export const createStrategy = (payload) => send("/api/strategies", "POST", payload);
// payload: { title?, notes? } -- source tags managed separately, see below.
export const updateStrategy = (id, payload) => send(`/api/strategies/${id}`, "PUT", payload);
export const deleteStrategy = (id) => send(`/api/strategies/${id}/delete`, "POST", {});

// --- Strategy <-> source tags (many-to-many) ---
export const addStrategySource = (strategyId, payload) =>
  send(`/api/strategies/${strategyId}/sources`, "POST", payload);
export const updateStrategySource = (strategyId, linkId, payload) =>
  send(`/api/strategies/${strategyId}/sources/${linkId}`, "PUT", payload);
export const removeStrategySource = (strategyId, linkId) =>
  send(`/api/strategies/${strategyId}/sources/${linkId}/delete`, "POST", {});

// --- Sources (read-only here -- managed in Settings) ---
export const fetchSources = () => fetch("/api/sources").then(handleResponse);
