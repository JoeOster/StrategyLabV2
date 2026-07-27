// The "Conductor" for the header alerts bell. Unlike every other module,
// this one isn't tied to a view -- it's always visible, so it owns its own
// polling instead of waiting for a reloadXView() call from view-switching.
import * as api from "./api.js";
import { renderAlertRows } from "./render.js";

// Client-side badge freshness. The server checks real prices every 15 min
// during market hours (services/alertScheduler.js); this just re-reads
// whatever the server already knows, so a much shorter interval here is
// cheap -- it's a single indexed query, not a provider call.
const POLL_INTERVAL_MS = 60_000;

const state = { alerts: [] };
const els = {};

export async function initializeAlertsModule() {
  els.bellBtn = document.getElementById("alerts-bell-btn");
  els.bellCount = document.getElementById("alerts-bell-count");
  els.dialog = document.getElementById("alerts-dialog");
  els.list = document.getElementById("alerts-list");
  els.ackAllBtn = document.getElementById("alerts-ack-all-btn");
  els.closeBtn = document.getElementById("alerts-close-btn");

  els.bellBtn.addEventListener("click", handleBellClick);
  els.list.addEventListener("click", handleListClick);
  els.ackAllBtn.addEventListener("click", handleAckAll);
  els.closeBtn.addEventListener("click", () => els.dialog.close());

  await loadAlerts();
  setInterval(loadAlerts, POLL_INTERVAL_MS);
}

async function loadAlerts() {
  try {
    state.alerts = await api.fetchAlerts();
    renderBadge();
    if (els.dialog.open) renderList();
  } catch {
    // A failed poll shouldn't throw an error banner in the user's face every
    // 60 seconds -- just leave the badge showing its last-known count.
  }
}

function renderBadge() {
  const count = state.alerts.length;
  els.bellCount.textContent = String(count);
  els.bellCount.hidden = count === 0;
}

function renderList() {
  els.list.innerHTML = renderAlertRows(state.alerts);
}

async function handleBellClick() {
  await loadAlerts();
  renderList();
  els.dialog.showModal();
}

async function handleListClick(event) {
  const btn = event.target.closest('[data-action="ack"]');
  if (!btn) return;
  try {
    await api.acknowledgeAlert(Number(btn.dataset.id));
    await loadAlerts();
    renderList();
  } catch {
    // Leave the row in place -- the user can just try again.
  }
}

async function handleAckAll() {
  try {
    await api.acknowledgeAllAlerts();
    await loadAlerts();
    renderList();
  } catch {
    /* same -- a failed bulk-ack just means try again */
  }
}
