// The "Conductor" for the Orders view. Owns panel/sort/filter state and
// wires listeners; markup comes from render.js, server calls from api.js.
import * as api from "./api.js";
import {
  POSITION_COLUMNS,
  HISTORY_COLUMNS,
  renderHeaderRow,
  renderPositionsRows,
  renderHistoryRows,
  renderSummary,
  renderSourceOptions,
  renderLotOptions,
  sortRows,
  filterPositions,
} from "./render.js";
import { orderFormToPayload, validateOrderPayload } from "./handlers.js";

const state = {
  activePanel: "positions",
  positions: [],
  summary: null,
  transactions: [],
  positionsSort: { key: "symbol", dir: "asc" },
  historySort: { key: "transaction_date", dir: "desc" },
  positionsFilter: "",
  sources: [],
};

const els = {};

export async function initializeOrdersModule() {
  els.tabs = document.getElementById("orders-tabs");
  els.panels = [...document.querySelectorAll(".orders-panel")];
  els.banner = document.getElementById("orders-banner");
  els.summary = document.getElementById("portfolio-summary");

  els.positionsThead = document.getElementById("positions-thead-row");
  els.positionsTbody = document.getElementById("positions-tbody");
  els.positionsFilter = document.getElementById("positions-filter");
  els.positionsCount = document.getElementById("positions-count");
  els.refreshPricesBtn = document.getElementById("orders-refresh-prices-btn");

  els.historyThead = document.getElementById("history-thead-row");
  els.historyTbody = document.getElementById("history-tbody");
  els.historyCount = document.getElementById("history-count");
  els.historySymbol = document.getElementById("history-symbol");
  els.historyType = document.getElementById("history-type");
  els.historyStart = document.getElementById("history-start");
  els.historyEnd = document.getElementById("history-end");
  els.historyClearBtn = document.getElementById("history-clear-btn");

  els.orderDialog = document.getElementById("order-dialog");
  els.orderForm = document.getElementById("order-form");
  els.orderTypeSelect = document.getElementById("order-type-select");
  els.orderSourceSelect = document.getElementById("order-source-select");
  els.orderLotSelect = document.getElementById("order-lot-select");
  els.orderLotLabel = document.getElementById("order-lot-label");
  els.orderPriceText = document.getElementById("order-price-text");
  els.orderQtyLabel = document.getElementById("order-qty-label");
  els.orderFeesLabel = document.getElementById("order-fees-label");
  els.orderHint = document.getElementById("order-hint");
  els.orderCancelBtn = document.getElementById("order-cancel-btn");
  els.logOrderBtns = [document.getElementById("log-order-btn"), document.getElementById("log-order-btn-2")];

  els.tabs.addEventListener("click", handleTabClick);
  els.positionsThead.addEventListener("click", (e) => handleSort(e, "positionsSort", renderPositions));
  els.historyThead.addEventListener("click", (e) => handleSort(e, "historySort", renderHistory));
  els.positionsTbody.addEventListener("click", handlePositionsAction);
  els.historyTbody.addEventListener("click", handleHistoryAction);

  els.positionsFilter.addEventListener("input", () => {
    state.positionsFilter = els.positionsFilter.value;
    renderPositions();
  });

  for (const input of [els.historySymbol, els.historyType, els.historyStart, els.historyEnd]) {
    input.addEventListener("change", loadHistory);
  }
  els.historySymbol.addEventListener("input", debounce(loadHistory, 300));
  els.historyClearBtn.addEventListener("click", () => {
    els.historySymbol.value = "";
    els.historyType.value = "";
    els.historyStart.value = "";
    els.historyEnd.value = "";
    loadHistory();
  });

  els.logOrderBtns.forEach((btn) => btn?.addEventListener("click", () => openOrderDialog()));
  els.orderCancelBtn.addEventListener("click", () => els.orderDialog.close());
  els.orderTypeSelect.addEventListener("change", updateOrderFormForType);
  // Which lots are available depends on the ticker, so re-derive as it's typed.
  els.orderForm.elements.symbol.addEventListener("input", debounce(updateOrderFormForType, 250));
  els.orderForm.addEventListener("submit", handleOrderSubmit);
  els.refreshPricesBtn.addEventListener("click", handleRefreshPrices);

  await reloadOrdersView();
}

export async function reloadOrdersView() {
  await loadPositions();
  if (state.activePanel === "history") await loadHistory();
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

async function handleTabClick(event) {
  const tab = event.target.closest(".tab[data-panel]");
  if (!tab) return;
  state.activePanel = tab.dataset.panel;
  els.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  els.panels.forEach((p) => (p.hidden = p.dataset.panel !== state.activePanel));
  if (state.activePanel === "history") await loadHistory();
}

async function loadPositions() {
  try {
    const { positions, summary } = await api.fetchPositions();
    state.positions = positions;
    state.summary = summary;
    els.summary.innerHTML = renderSummary(summary);
    renderPositions();
  } catch (err) {
    banner(err.message, true);
  }
}

function renderPositions() {
  const visible = sortRows(
    filterPositions(state.positions, state.positionsFilter),
    state.positionsSort.key,
    state.positionsSort.dir,
  );
  els.positionsThead.innerHTML = renderHeaderRow(
    POSITION_COLUMNS,
    state.positionsSort.key,
    state.positionsSort.dir,
  );
  els.positionsTbody.innerHTML = renderPositionsRows(visible);
  els.positionsCount.textContent =
    visible.length === state.positions.length
      ? `${state.positions.length} lot(s)`
      : `${visible.length} of ${state.positions.length} lot(s)`;
}

async function loadHistory() {
  try {
    state.transactions = await api.fetchTransactions({
      symbol: els.historySymbol.value.trim(),
      type: els.historyType.value,
      startDate: els.historyStart.value,
      endDate: els.historyEnd.value,
    });
    renderHistory();
  } catch (err) {
    banner(err.message, true);
  }
}

function renderHistory() {
  const visible = sortRows(state.transactions, state.historySort.key, state.historySort.dir);
  els.historyThead.innerHTML = renderHeaderRow(
    HISTORY_COLUMNS,
    state.historySort.key,
    state.historySort.dir,
  );
  els.historyTbody.innerHTML = renderHistoryRows(visible);
  els.historyCount.textContent = `${visible.length} transaction(s)`;
}

function handleSort(event, sortStateKey, rerender) {
  const th = event.target.closest("th[data-sort-key]");
  if (!th) return;
  const sort = state[sortStateKey];
  if (sort.key === th.dataset.sortKey) {
    sort.dir = sort.dir === "asc" ? "desc" : "asc";
  } else {
    sort.key = th.dataset.sortKey;
    sort.dir = "asc";
  }
  rerender();
}

async function handlePositionsAction(event) {
  const btn = event.target.closest(".sell-lot-btn");
  if (!btn) return;
  // Pre-fill a sell against this specific lot rather than making the user
  // re-type what they're already looking at.
  openOrderDialog({
    type: "SELL",
    symbol: btn.dataset.symbol,
    lotId: Number(btn.dataset.lotId),
    quantity: Number(btn.dataset.qty),
  });
}

async function handleHistoryAction(event) {
  const btn = event.target.closest(".delete-txn-btn");
  if (!btn) return;
  if (!window.confirm("Delete this transaction? Lot quantities will be adjusted to match.")) return;
  try {
    await api.deleteTransaction(Number(btn.dataset.id));
    await reloadOrdersView();
    banner("Transaction deleted.", false);
  } catch (err) {
    banner(err.message, true);
  }
}

async function handleRefreshPrices() {
  els.refreshPricesBtn.disabled = true;
  els.refreshPricesBtn.textContent = "Refreshing…";
  try {
    await api.refreshPrices();
    await loadPositions();
    banner("Prices refreshed.", false);
  } catch (err) {
    banner(err.message, true);
  } finally {
    els.refreshPricesBtn.disabled = false;
    els.refreshPricesBtn.textContent = "Refresh Prices";
  }
}

async function openOrderDialog(prefill = {}) {
  els.orderForm.reset();
  els.orderForm.elements.transactionDate.value = new Date().toISOString().slice(0, 10);
  els.orderForm.elements.fees.value = "0";

  try {
    state.sources = await api.fetchSources();
    els.orderSourceSelect.innerHTML = renderSourceOptions(state.sources);
  } catch {
    // A missing source list shouldn't block logging a trade.
  }

  if (prefill.type) els.orderTypeSelect.value = prefill.type;
  if (prefill.symbol) els.orderForm.elements.symbol.value = prefill.symbol;
  if (prefill.quantity) els.orderForm.elements.quantity.value = prefill.quantity;

  updateOrderFormForType();

  if (prefill.lotId) {
    els.orderLotSelect.value = String(prefill.lotId);
  }
  els.orderDialog.showModal();
}

function updateOrderFormForType() {
  const type = els.orderTypeSelect.value;
  const isDividend = type === "DIVIDEND";
  const isSell = type === "SELL";

  els.orderPriceText.textContent = isDividend ? "Total amount" : "Price per share";
  els.orderQtyLabel.hidden = isDividend;
  els.orderFeesLabel.hidden = isDividend;
  els.orderLotLabel.hidden = !isSell;

  if (isSell) {
    const symbol = els.orderForm.elements.symbol.value.trim().toUpperCase();
    const lots = state.positions.filter((p) => p.symbol === symbol);
    // Preserve an explicitly chosen lot across re-renders of the dropdown.
    const previous = els.orderLotSelect.value;
    els.orderLotSelect.innerHTML = renderLotOptions(lots);
    if (previous && [...els.orderLotSelect.options].some((o) => o.value === previous)) {
      els.orderLotSelect.value = previous;
    }
    const held = lots.reduce((sum, l) => sum + l.quantity_remaining, 0);
    els.orderHint.textContent = symbol
      ? lots.length
        ? `You hold ${held} share(s) of ${symbol} across ${lots.length} lot(s).`
        : `No open lots found for ${symbol}.`
      : "Enter a ticker to see which lots you hold.";
  } else {
    els.orderHint.textContent = isDividend
      ? "Dividends are recorded as income and don't affect your share count."
      : "";
  }
}

async function handleOrderSubmit(event) {
  event.preventDefault();
  const payload = orderFormToPayload(new FormData(els.orderForm));
  const error = validateOrderPayload(payload);
  if (error) return banner(error, true);

  try {
    await api.recordTransaction(payload);
    els.orderDialog.close();
    await reloadOrdersView();
    banner(`${payload.transactionType} recorded for ${payload.symbol}.`, false);
  } catch (err) {
    banner(err.message, true);
  }
}

// Symbol field is free text, so re-query lots only after typing settles.
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
