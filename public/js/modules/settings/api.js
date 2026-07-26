// The "Data" file for the settings module. Never touches the DOM.

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

// --- Watchlists ---
export const fetchWatchlists = () => fetch("/api/watchlists").then(handleResponse);
export const createWatchlist = (name) => send("/api/watchlists", "POST", { name });
export const renameWatchlist = (id, name) => send(`/api/watchlists/${id}`, "PATCH", { name });
export const reorderWatchlists = (orderedIds) => send("/api/watchlists/reorder", "POST", { orderedIds });
export const deleteWatchlist = (id, opts = {}) => send(`/api/watchlists/${id}/delete`, "POST", opts);

// --- General settings ---
export const fetchGeneralSettings = () => fetch("/api/settings/general").then(handleResponse);
export const saveGeneralSettings = (patch) => send("/api/settings/general", "PUT", patch);

// --- Exchanges ---
export const fetchExchanges = () => fetch("/api/exchanges").then(handleResponse);
export const createExchange = (payload) => send("/api/exchanges", "POST", payload);
export const deleteExchange = (id) => send(`/api/exchanges/${id}/delete`, "POST", {});

// --- Account holders ---
export const fetchHolders = () => fetch("/api/holders").then(handleResponse);
export const createHolder = (name) => send("/api/holders", "POST", { name });
export const renameHolder = (id, name) => send(`/api/holders/${id}`, "PATCH", { name });
export const makeHolderDefault = (id) => send(`/api/holders/${id}`, "PATCH", { makeDefault: true });
export const deleteHolder = (id) => send(`/api/holders/${id}/delete`, "POST", {});

// --- Advice sources ---
export const fetchSources = () => fetch("/api/sources").then(handleResponse);
export const fetchSource = (id) => fetch(`/api/sources/${id}`).then(handleResponse);
export const createSource = (payload) => send("/api/sources", "POST", payload);
export const updateSource = (id, payload) => send(`/api/sources/${id}`, "PUT", payload);
export const deleteSource = (id) => send(`/api/sources/${id}/delete`, "POST", {});
