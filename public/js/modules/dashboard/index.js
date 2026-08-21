// The "Conductor" for the Dashboard view. Card grid + table toggle over the
// same open-position data, with a click-through detail panel per ticker.
import * as api from "./api.js";
import {
  TABLE_COLUMNS,
  renderCards,
  renderTableHead,
  renderTableRows,
  renderExchangeOptions,
  renderTickerDetail,
  sortPositions,
  filterPositions,
} from "./render.js";

const state = {
  positions: [],
  summary: null,
  view: "cards",
  filter: "",
  exchange: "",
  sortKey: "symbol",
  sortDir: "asc",
  detailSymbol: null,
};

const els = {};

export async function initializeDashboardModule() {
  els.banner = document.getElementById("dashboard-banner");
  els.summary = document.getElementById("dashboard-summary");
  els.cards = document.getElementById("dash-cards");
  els.tableWrap = document.getElementById("dash-table");
  els.theadRow = document.getElementById("dash-thead-row");
  els.tbody = document.getElementById("dash-tbody");
  els.filter = document.getElementById("dash-filter");
  els.exchangeFilter = document.getElementById("dash-exchange-filter");
  els.sortSelect = document.getElementById("dash-sort");
  els.count = document.getElementById("dash-count");
  els.refreshBtn = document.getElementById("dash-refresh-btn");
  els.viewToggle = [...document.querySelectorAll("[data-dash-view]")];

  els.detailDialog = document.getElementById("ticker-detail-dialog");
  els.detailBody = document.getElementById("ticker-detail-body");
  els.detailCloseBtn = document.getElementById("ticker-detail-close-btn");
  els.researchBtn = document.getElementById("ticker-research-btn");
  els.tickerRefreshBtn = document.getElementById("ticker-refresh-btn");

  els.filter.addEventListener("input", () => {
    state.filter = els.filter.value;
    renderAll();
  });
  els.exchangeFilter.addEventListener("change", () => {
    state.exchange = els.exchangeFilter.value;
    renderAll();
  });
  els.sortSelect.addEventListener("change", () => {
    const [key, dir] = els.sortSelect.value.split(":");
    state.sortKey = key;
    state.sortDir = dir;
    renderAll();
  });

  els.viewToggle.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view = btn.dataset.dashView;
      els.viewToggle.forEach((b) => b.classList.toggle("active", b === btn));
      els.cards.hidden = state.view !== "cards";
      els.tableWrap.hidden = state.view !== "table";
      renderAll();
    }),
  );

  // Delegated: both views re-render constantly, so per-element listeners
  // would need re-binding after every sort or filter change.
  els.cards.addEventListener("click", handleOpenDetail);
  els.tbody.addEventListener("click", handleOpenDetail);
  els.theadRow.addEventListener("click", handleTableSort);

  els.refreshBtn.addEventListener("click", handleRefresh);
  els.tickerRefreshBtn.addEventListener("click", handleTickerRefresh);
  els.detailCloseBtn.addEventListener("click", () => els.detailDialog.close());
  els.researchBtn.addEventListener("click", () => {
    window.alert(
      "Ticker research isn't wired up yet.\n\nThe plan is a Claude skill you invoke in a chat session " +
        "(\"research NVDA\") which reads this app's data and searches the web. " +
        "See docs/V2_BACKLOG.md.",
    );
  });

  await reloadDashboardView();
}

export async function reloadDashboardView() {
  try {
    const { positions, summary } = await api.fetchPositions();
    state.positions = positions;
    state.summary = summary;

    // Preserve the chosen exchange if it still exists after a data refresh.
    const previousExchange = state.exchange;
    els.exchangeFilter.innerHTML = renderExchangeOptions(positions);
    if ([...els.exchangeFilter.options].some((o) => o.value === previousExchange)) {
      els.exchangeFilter.value = previousExchange;
    } else {
      state.exchange = "";
    }

    renderSummaryStrip();
    renderAll();
  } catch (err) {
    banner(err.message, true);
  }
}

function renderSummaryStrip() {
  const s = state.summary;
  if (!s || s.positionCount === 0) {
    els.summary.innerHTML = `<div class="summary-item"><span class="summary-label">No open positions</span></div>`;
    return;
  }
  const cls = (v) => (v >= 0 ? "change-up" : "change-down");
  const money = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
  const signed = (v) => `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  els.summary.innerHTML = `
    <div class="summary-item"><span class="summary-label">Positions</span><span class="summary-value">${s.positionCount}</span></div>
    <div class="summary-item"><span class="summary-label">Cost Basis</span><span class="summary-value">${money(s.totalCost)}</span></div>
    <div class="summary-item"><span class="summary-label">Market Value</span><span class="summary-value">${money(s.totalValue)}</span></div>
    <div class="summary-item"><span class="summary-label">Unrealized</span><span class="summary-value ${cls(s.unrealizedPnl)}">${signed(s.unrealizedPnl)}${s.unrealizedPnlPercent == null ? "" : ` (${s.unrealizedPnlPercent >= 0 ? "+" : ""}${s.unrealizedPnlPercent.toFixed(2)}%)`}</span></div>
    <div class="summary-item"><span class="summary-label">Realized</span><span class="summary-value ${cls(s.realizedPnl)}">${signed(s.realizedPnl)}</span></div>
    <div class="summary-item"><span class="summary-label">Total Return</span><span class="summary-value ${cls(s.totalReturn)}">${signed(s.totalReturn)}</span></div>`;
}

function visiblePositions() {
  return sortPositions(
    filterPositions(state.positions, state.filter, state.exchange),
    state.sortKey,
    state.sortDir,
  );
}

function renderAll() {
  const visible = visiblePositions();
  if (state.view === "cards") {
    els.cards.innerHTML = renderCards(visible);
  } else {
    els.theadRow.innerHTML = renderTableHead(state.sortKey, state.sortDir);
    els.tbody.innerHTML = renderTableRows(visible);
  }
  els.count.textContent =
    visible.length === state.positions.length
      ? `${state.positions.length} lot(s)`
      : `${visible.length} of ${state.positions.length} lot(s)`;
}

function handleTableSort(event) {
  const th = event.target.closest("th[data-sort-key]");
  if (!th) return;
  if (state.sortKey === th.dataset.sortKey) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = th.dataset.sortKey;
    state.sortDir = "asc";
  }
  // Keep the dropdown honest about what the table is actually doing.
  const combo = `${state.sortKey}:${state.sortDir}`;
  if ([...els.sortSelect.options].some((o) => o.value === combo)) els.sortSelect.value = combo;
  renderAll();
}

async function handleOpenDetail(event) {
  const target = event.target.closest("[data-symbol]");
  if (!target) return;
  await openDetailFor(target.dataset.symbol);
}

/**
 * Error banner as a real element, built with textContent.
 *
 * BUG 9: these two sites were the only places in the frontend that put server
 * text into innerHTML directly -- every render.js routes through escapeHtml.
 * The message interpolates the raw :symbol URL param (server.js), so it is
 * only not-XSS today because Yahoo's lookup happens to reject HTML-bearing
 * tickers first. Any change that relaxes that gate would turn it into stored
 * XSS with no frontend change at all. textContent cannot be talked into
 * parsing markup, so the gate stops mattering.
 */
function errorBanner(message) {
  const p = document.createElement("p");
  p.className = "status-banner status-error";
  p.textContent = message;
  return p;
}

async function openDetailFor(symbol) {
  // Remembered so the dialog's own Refresh button knows what to refresh.
  state.detailSymbol = symbol;
  els.detailBody.innerHTML = `<p class="panel-hint">Loading ${symbol}…</p>`;
  els.detailDialog.showModal();
  try {
    const detail = await api.fetchTickerDetail(symbol);
    els.detailBody.innerHTML = renderTickerDetail(detail);
  } catch (err) {
    els.detailBody.replaceChildren(errorBanner(err.message));
  }
}

/**
 * Refreshes just this ticker (quote + history) without re-polling the whole
 * portfolio, then redraws the dialog in place.
 */
async function handleTickerRefresh() {
  if (!state.detailSymbol) return;
  els.tickerRefreshBtn.disabled = true;
  els.tickerRefreshBtn.textContent = "Refreshing…";
  try {
    await api.refreshTicker(state.detailSymbol);
    await openDetailFor(state.detailSymbol);
    // Cards behind the dialog now show a stale price, so refresh those too.
    await reloadDashboardView();
  } catch (err) {
    els.detailBody.prepend(errorBanner(err.message));
  } finally {
    els.tickerRefreshBtn.disabled = false;
    els.tickerRefreshBtn.textContent = "Refresh Data";
  }
}

async function handleRefresh() {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Refreshing…";
  try {
    await api.refreshPrices();
    await reloadDashboardView();
    banner("Prices refreshed.", false);
  } catch (err) {
    banner(err.message, true);
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "Refresh Prices";
  }
}

function banner(message, isError) {
  if (!message) {
    els.banner.hidden = true;
    return;
  }
  els.banner.hidden = false;
  els.banner.textContent = message;
  els.banner.className = `status-banner ${isError ? "status-error" : "status-success"}`;
}
