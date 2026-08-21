// The "HTML" file for Notifications. Pure functions: data in, markup out.
import { relativeTime, escapeHtml } from "../alerts/render.js";

const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/** "sell 40 at $15.00 or better" -- the rung read back as the instruction it is. */
function rungInstruction(a) {
  if (!a.plan_exit_id) return escapeHtml(a.message || "");
  const band =
    a.rung_kind === "STOP"
      ? `${money(a.price_high ?? a.price_low)} or worse`
      : `${money(a.price_low ?? a.price_high)} or better`;
  return `sell ${a.rung_quantity} at ${band}`;
}

function outcome(a) {
  if (!a.resolution) return "";
  if (a.resolution === "accepted") {
    return `<span class="status-pill">accepted</span>`;
  }
  // The two declines mean different things and must not read the same. One
  // says the level was wrong; the other says it was right and you chose
  // otherwise -- only the second is an execution gap.
  const label = a.decline_kind === "invalid" ? "declined · bad level" : "declined · chose not to";
  return `<span class="status-pill">${escapeHtml(label)}</span>`;
}

export function renderNotificationRows(alerts) {
  if (alerts.length === 0) {
    return `<li class="empty-row">Nothing to decide. Alerts land here when a plan's level is reached.</li>`;
  }

  return alerts
    .map((a) => {
      const attribution = [a.source_name, a.strategy_title].filter(Boolean).map(escapeHtml).join(" · ");
      const isExit = Boolean(a.plan_exit_id);

      // Only an unresolved exit rung is actionable. An entry alert is a
      // decision about whether the idea was taken, and the trade itself goes
      // through Journal's Execute, which collects a real fill.
      const actions =
        a.resolution || !isExit
          ? outcome(a)
          : `
            <button type="button" data-action="accept" data-id="${a.id}"
                    data-paper="${a.isPaper ? 1 : 0}" data-trigger="${a.trigger_price}"
                    title="${a.isPaper ? "Record the sale at the price this fired at" : "Record the sale — you'll be asked what you actually got"}">Accept</button>
            <button type="button" data-action="decline-judgement" data-id="${a.id}"
                    title="The level was right, you chose not to act">Chose not to</button>
            <button type="button" data-action="decline-invalid" data-id="${a.id}"
                    title="This level was wrong and should not have fired">Bad level</button>`;

      return `
      <li data-id="${a.id}" class="${a.resolution ? "voided-row" : ""}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(a.symbol ?? "")}</strong>
            ${a.isPaper ? '<span class="type-pill type-watch">paper</span>' : ""}
            <span class="settings-row-meta">
              ${escapeHtml(rungInstruction(a))}
              · fired at ${money(a.trigger_price)} ${escapeHtml(relativeTime(a.triggered_at))}
              ${attribution ? ` · ${attribution}` : ""}
              ${a.resolution_note ? ` · “${escapeHtml(a.resolution_note)}”` : ""}
            </span>
          </div>
          <div class="settings-row-actions">${actions}</div>
        </div>
      </li>`;
    })
    .join("");
}
