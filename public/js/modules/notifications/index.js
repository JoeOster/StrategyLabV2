// The Notifications tab: what the plans said to do, and what was decided.
//
// Distinct from the bell, which only lists what has not been silenced. This is
// a decision queue -- every alert with an Accept / Decline outcome recorded
// against it, including the ones already dealt with.
//
// The queue can be worked days late without penalty. An alert froze its
// trigger price and timestamp when it fired, so accepting on Thursday records
// what was true on Monday. That is the property that makes an asynchronous
// queue honest instead of a source of drift, and it is why nothing here
// auto-acts.
import * as api from "./api.js";
import { renderNotificationRows } from "./render.js";

const els = {};
let onDataChanged = () => {};

export async function initializeNotificationsModule({ onChange = () => {} } = {}) {
  onDataChanged = onChange;
  els.list = document.getElementById("notifications-list");
  els.showResolved = document.getElementById("notifications-show-resolved");
  els.banner = document.getElementById("notifications-banner");
  els.count = document.getElementById("notifications-count");

  els.list.addEventListener("click", handleAction);
  els.showResolved.addEventListener("change", reloadNotificationsView);

  await reloadNotificationsView();
}

export async function reloadNotificationsView() {
  const pendingOnly = !els.showResolved.checked;
  const alerts = await api.fetchNotifications({ pendingOnly });
  els.list.innerHTML = renderNotificationRows(alerts);

  const pending = alerts.filter((a) => !a.resolution).length;
  els.count.textContent = pendingOnly ? `${pending} awaiting a decision` : `${alerts.length} shown`;
}

function banner(message, isError) {
  els.banner.textContent = message;
  els.banner.classList.toggle("status-error", Boolean(isError));
  els.banner.hidden = false;
  if (!isError) setTimeout(() => (els.banner.hidden = true), 4000);
}

async function handleAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const action = btn.dataset.action;

  try {
    if (action === "accept") {
      // A paper rung is the plan followed mechanically, so the price it fired
      // at IS the answer. A real one is not: recording the trigger price as the
      // fill would quietly erase the execution gap, so it has to be asked for.
      const body = { resolution: "accepted" };
      if (btn.dataset.paper !== "1") {
        const fill = window.prompt(
          `What did you actually sell at? (the rung fired at $${btn.dataset.trigger})`,
          btn.dataset.trigger,
        );
        if (fill === null) return;
        body.fillPrice = Number(fill);
      }
      const result = await api.resolveNotification(id, body);
      banner(
        result.transaction
          ? `Recorded ${result.isPaper ? "paper " : ""}sale of ${result.transaction.sells[0].quantity}.`
          : "Marked as taken.",
      );
    } else if (action === "decline-invalid" || action === "decline-judgement") {
      const declineKind = action === "decline-invalid" ? "invalid" : "judgement";
      const note = window.prompt(
        declineKind === "invalid"
          ? "Why was this level wrong? (optional)"
          : "Why did you decide against it? (optional)",
        "",
      );
      if (note === null) return;
      await api.resolveNotification(id, { resolution: "declined", declineKind, note });
      banner(
        declineKind === "invalid"
          ? "Recorded as a level that should not have fired."
          : "Recorded as a decision not to act.",
      );
    } else {
      return;
    }

    await reloadNotificationsView();
    onDataChanged();
  } catch (err) {
    banner(err.message, true);
  }
}
