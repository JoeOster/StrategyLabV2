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
import { renderSummary } from "../shared/summary.js";

const state = {
  positions: [],
  summary: null,
  view: "cards",
  filter: "",
  exchange: "",
  // Server-side, unlike the exchange filter below it. Account scope has to
  // reach the server because the strip's cash, realized P&L and dividends are
  // computed there -- filtering the fetched rows in the browser would narrow
  // the table while leaving those three figures portfolio-wide, which is the
  // exact mismatch that makes a total untrustworthy.
  accountId: null,
  accounts: [],
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
  els.accountFilter = document.getElementById("dash-account-filter");
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
  els.accountFilter.addEventListener("change", async () => {
    const raw = els.accountFilter.value;
    state.accountId = raw === "" ? null : Number(raw);
    // A refetch, not a re-render: the summary figures come from the server.
    await reloadDashboardView();
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

  await populateAccountFilter();
  await reloadDashboardView();
}

/**
 * Fills the account dropdown from the server.
 *
 * Driven FROM state, never read back into it -- Chrome restores a <select>
 * value across a reload without firing `change`, so trusting the DOM let the
 * control show one account while the data showed another.
 */
async function populateAccountFilter() {
  const accounts = await api.fetchAccountsForFilter();
  state.accounts = accounts;
  els.accountFilter.innerHTML =
    '<option value="">All accounts</option>' +
    accounts
      .map((a) => `<option value="${a.id}">${a.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</option>`)
      .join("");
  els.accountFilter.value = state.accountId == null ? "" : String(state.accountId);
}

export async function reloadDashboardView() {
  try {
    const { positions, summary } = await api.fetchPositions({ accountId: state.accountId });
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
  els.summary.innerHTML = renderSummary(state.summary);
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
