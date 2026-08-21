// The "Data" file for the Import tab. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

const send = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then(handleResponse);

export const fetchAccounts = () => fetch("/api/accounts").then(handleResponse);
export const fetchLatestImported = () => fetch("/api/imports/latest").then(handleResponse);
export const matchAccount = (filename) =>
  fetch(`/api/accounts/match?filename=${encodeURIComponent(filename)}`).then(handleResponse);

export const stageImport = (accountId, files) => send("/api/imports", { accountId, files });
export const fetchBatch = (id) => fetch(`/api/imports/${id}`).then(handleResponse);
export const fetchDiscrepancies = (id) =>
  fetch(`/api/imports/${id}/discrepancies`).then(handleResponse);
export const approveBatch = (id) => send(`/api/imports/${id}/approve`);
export const applyCorrection = (batchId, rowId, fields) =>
  send(`/api/imports/${batchId}/rows/${rowId}/correct`, fields ? { fields } : {});
