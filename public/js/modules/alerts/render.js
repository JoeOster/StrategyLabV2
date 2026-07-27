// The "HTML" file for the alerts bell. Pure functions: data in, markup out.

export function renderAlertRows(alerts) {
  if (alerts.length === 0) {
    return `<li class="empty-row">No alerts.</li>`;
  }
  return alerts
    .map(
      (a) => `
      <li data-id="${a.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(a.symbol)}</strong>
            <span class="settings-row-meta">${escapeHtml(a.message || `Target hit at $${a.trigger_price}`)} · ${escapeHtml(relativeTime(a.triggered_at))}</span>
          </div>
          <div class="settings-row-actions">
            <button type="button" data-action="ack" data-id="${a.id}">Dismiss</button>
          </div>
        </div>
      </li>`,
    )
    .join("");
}

/** "5m ago" / "3h ago" / "2d ago" -- coarse on purpose, this is a notification list, not a ledger. */
export function relativeTime(iso, now = new Date()) {
  const then = new Date(`${iso.replace(" ", "T")}Z`);
  const diffMs = now.getTime() - then.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
