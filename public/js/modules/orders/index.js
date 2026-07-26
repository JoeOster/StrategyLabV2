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
  // Non-null when the order dialog is editing an existing transaction rather
  // than creating a new one.
  editingId: null,
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
  els.orderDialogTitle = document.getElementById("order-dialog-title");
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
  const editBtn = event.target.closest(".edit-txn-btn");
  if (editBtn) return openEditDialog(Number(editBtn.dataset.id));

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
  const editBtn = event.target.closest(".edit-txn-btn");
  if (editBtn) return openEditDialog(Number(editBtn.dataset.id));

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

/**
 * Opens the order dialog in edit mode, populated from an existing
 * transaction. The type field is locked: changing a BUY into a SELL would
 * invalidate the lot links, so the server refuses it anyway.
 */
async function openEditDialog(transactionId) {
  // Look in whichever list is loaded; fall back to fetching history if the
  // row came from the positions table and history hasn't been loaded yet.
  let txn = state.transactions.find((t) => t.id === transactionId);
  if (!txn) {
    try {
      state.transactions = await api.fetchTransactions({});
      txn = state.transactions.find((t) => t.id === transactionId);
    } catch (err) {
      return banner(err.message, true);
    }
  }
  if (!txn) return banner("Couldn't find that transaction.", true);

  state.editingId = transactionId;
  els.orderForm.reset();

  try {
    state.sources = await api.fetchSources();
    els.orderSourceSelect.innerHTML = renderSourceOptions(state.sources);
  } catch {
    /* a missing source list shouldn't block editing */
  }

  els.orderTypeSelect.value = txn.transaction_type;
  els.orderTypeSelect.disabled = true;
  els.orderForm.elements.symbol.value = txn.symbol;
  els.orderForm.elements.symbol.readOnly = true; // ticker changes = a different trade
  els.orderForm.elements.transactionDate.value = txn.transaction_date;
  els.orderForm.elements.quantity.value = txn.quantity;
  els.orderForm.elements.price.value = txn.price;
  els.orderForm.elements.fees.value = txn.fees ?? 0;
  els.orderForm.elements.notes.value = txn.notes ?? "";
  if (txn.source_id) els.orderSourceSelect.value = String(txn.source_id);

  els.orderDialogTitle.textContent = `Edit ${txn.transaction_type} — ${txn.symbol}`;
  updateOrderFormForType();
  // Lot selection only applies when creating a new sell.
  els.orderLotLabel.hidden = true;
  els.orderHint.textContent =
    txn.transaction_type === "BUY"
      ? "Correcting the price also updates the realized P&L of any sales from this lot."
      : "Changing the quantity re-allocates shares against the original purchase.";

  els.orderDialog.showModal();
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
  // Clear any leftover edit state so "+ Log Order" always creates.
  state.editingId = null;
  els.orderTypeSelect.disabled = false;
  els.orderForm.elements.symbol.readOnly = false;
  els.orderDialogTitle.textContent = "Log Order";

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
  // A disabled <select> is omitted from FormData, so in edit mode the type
  // has to be read back off the element directly.
  const formData = new FormData(els.orderForm);
  if (state.editingId && !formData.get("transactionType")) {
    formData.set("transactionType", els.orderTypeSelect.value);
  }

  const payload = orderFormToPayload(formData);
  const error = validateOrderPayload(payload);
  if (error) return banner(error, true);

  try {
    if (state.editingId) {
      await api.updateTransaction(state.editingId, payload);
      els.orderDialog.close();
      await reloadOrdersView();
      banner(`Updated ${payload.symbol}.`, false);
    } else {
      await api.recordTransaction(payload);
      els.orderDialog.close();
      await reloadOrdersView();
      banner(`${payload.transactionType} recorded for ${payload.symbol}.`, false);
    }
  } catch (err) {
    // Keep the dialog open so the user can correct and retry.
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
