// The "Data" file for Notifications. Never touches the DOM.

async function handleResponse(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const fetchNotifications = ({ pendingOnly = true } = {}) =>
  fetch(`/api/notifications?pending=${pendingOnly ? 1 : 0}`).then(handleResponse);

export const resolveNotification = (id, body) =>
  fetch(`/api/notifications/${id}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(handleResponse);
