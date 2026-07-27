// The "Data" file for the alerts bell. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchAlerts = () => fetch("/api/alerts").then(handleResponse);

export const acknowledgeAlert = (id) =>
  fetch(`/api/alerts/${id}/acknowledge`, { method: "POST" }).then(handleResponse);

export const acknowledgeAllAlerts = () =>
  fetch("/api/alerts/acknowledge-all", { method: "POST" }).then(handleResponse);
