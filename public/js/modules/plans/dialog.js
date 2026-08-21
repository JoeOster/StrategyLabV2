// The "Set Exits" dialog, shared by Orders and Paper Trade.
//
// One module rather than one per tab, following the paper/real parity
// principle: a paper trade and a real trade are the same thing apart from a
// flag, so anything that acts on a trade belongs in one place. Orders and
// Paper Trade already share their row renderers for exactly this reason.
//
// A rung firing raises an alert; it never sells. The copy in here says so,
// because a ladder that looks like it will sell for you is worse than no
// ladder at all.
const els = {};
let state = { tradeId: null, symbol: null, plan: null, onChanged: null };

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const fmt = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/** "110.00 or better" / "80.00 or worse" -- the band read as an instruction. */
function bandLabel(rung) {
  if (rung.kind === "STOP") return `${fmt(rung.price_high ?? rung.price_low)} or worse`;
  return `${fmt(rung.price_low ?? rung.price_high)} or better`;
}

export function initPlansUi() {
  els.dialog = document.getElementById("exits-dialog");
  els.title = document.getElementById("exits-dialog-title");
  els.body = document.getElementById("exits-dialog-body");
  els.form = document.getElementById("exit-rung-form");
  els.error = document.getElementById("exits-error");
  els.closeBtn = document.getElementById("exits-close-btn");

  els.closeBtn.addEventListener("click", () => els.dialog.close());
  els.form.addEventListener("submit", handleAddRung);
  els.body.addEventListener("click", handleBodyClick);
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: options?.body ? { "Content-Type": "application/json" } : {},
    ...options,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
  return json;
}

/**
 * Opens the ladder for a trade, creating its plan on first use.
 *
 * The plan is created lazily rather than with every trade: a trade can exist
 * with no plan at all, and most do. Setting exits is the act that says "this
 * position has a thesis worth tracking."
 */
export async function openExitsDialog(tradeId, symbol, onChanged) {
  state = { tradeId, symbol, plan: null, onChanged };
  els.error.hidden = true;
  els.title.textContent = `Exit plan — ${symbol}`;
  els.body.innerHTML = '<p class="panel-hint">Loading…</p>';
  els.dialog.showModal();

  try {
    const trade = await api(`/api/transactions/${tradeId}`).catch(() => null);
    let planId = trade?.plan_id ?? null;
    if (!planId) {
      const created = await api("/api/plans", {
        method: "POST",
        body: JSON.stringify({ tradeId }),
      });
      planId = created.id;
    }
    await refresh(planId);
  } catch (err) {
    showError(err.message);
    els.body.innerHTML = "";
  }
}

async function refresh(planId) {
  state.plan = await api(`/api/plans/${planId}`);
  render();
  if (state.onChanged) state.onChanged();
}

function render() {
  const { plan, exits, heldQuantity, committedQuantity, uncommittedQuantity } = state.plan;

  const rows = exits.length
    ? exits
        .map((e) => {
          const statusPill =
            e.status === "hit"
              ? '<span class="status-pill">fired</span>'
              : e.status === "cancelled"
                ? '<span class="status-pill">cancelled</span>'
                : '<span class="status-pill">pending</span>';
          const cancel =
            e.status === "pending"
              ? `<button type="button" class="cancel-rung-btn" data-id="${e.id}">Cancel</button>`
              : "";
          return `
            <tr>
              <td><span class="type-pill type-${e.kind === "STOP" ? "sell_limit" : "buy_limit"}">${e.kind === "STOP" ? "Stop" : "Target"}</span></td>
              <td>${e.quantity}</td>
              <td>${escapeHtml(bandLabel(e))}</td>
              <td>${statusPill}</td>
              <td class="actions-cell">${cancel}</td>
            </tr>`;
        })
        .join("")
    : '<tr><td colspan="5" class="empty-row">No rungs yet. Add one below.</td></tr>';

  els.body.innerHTML = `
    <p class="panel-hint">
      Holding <strong>${heldQuantity}</strong> share(s) under this thesis.
      <strong>${committedQuantity}</strong> committed to rungs,
      <strong>${uncommittedQuantity}</strong> uncommitted.
    </p>
    <p class="panel-hint">
      A rung that is reached raises an alert. It does not sell —
      record the sale yourself, and the difference is your execution gap.
    </p>
    <table class="data-table">
      <thead><tr><th>Kind</th><th>Qty</th><th>Trigger</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${plan.status !== "open" ? `<p class="panel-hint">This plan is ${escapeHtml(plan.status)}.</p>` : ""}
  `;
}

function showError(message) {
  els.error.textContent = message;
  els.error.hidden = false;
}

async function handleAddRung(event) {
  event.preventDefault();
  els.error.hidden = true;
  const data = new FormData(els.form);
  const kind = data.get("kind");
  const price = data.get("price");

  // A stop triggers at-or-below, a target at-or-above. The user types one
  // number and the direction comes from the kind, rather than asking them to
  // reason about which end of a band they mean.
  const payload = {
    kind,
    quantity: Number(data.get("quantity")),
    priceLow: kind === "STOP" ? null : Number(price),
    priceHigh: kind === "STOP" ? Number(price) : null,
  };

  try {
    await api(`/api/plans/${state.plan.plan.id}/exits`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    els.form.reset();
    await refresh(state.plan.plan.id);
  } catch (err) {
    showError(err.message);
  }
}

async function handleBodyClick(event) {
  const btn = event.target.closest(".cancel-rung-btn");
  if (!btn) return;
  els.error.hidden = true;
  try {
    await api(`/api/plans/${state.plan.plan.id}/exits/${btn.dataset.id}/cancel`, { method: "POST" });
    await refresh(state.plan.plan.id);
  } catch (err) {
    showError(err.message);
  }
}
