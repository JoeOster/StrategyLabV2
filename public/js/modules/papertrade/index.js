// The "Conductor" for the Paper Trade view. Mirrors orders/index.js almost
// exactly (same positions/history split, same column-prefs wiring), plus a
// Strategy field on the log/edit dialog and a Promote action that turns a
// paper BUY into a real one in place -- see promotePaperTrade in
// transactionsService.js for what that does under the hood.
import * as api from "./api.js";
import {
  POSITION_COLUMNS,
  HISTORY_COLUMNS,
  renderHeaderRow,
  renderPositionsRows,
  renderHistoryRows,
  renderSummary,
  renderSourceOptions,
  renderStrategyOptions,
  renderLotOptions,
  sortRows,
  filterPositions,
} from "./render.js";
import { paperOrderFormToPayload, validateOrderPayload } from "./handlers.js";
import { loadColumnPrefs, visibleColumnsInOrder, openColumnDialog } from "../shared/columnPrefs.js";
import { COLUMN_STORAGE_KEYS } from "../shared/tableRegistry.js";

const POSITIONS_COLUMN_KEY = COLUMN_STORAGE_KEYS.paperPositions;
const HISTORY_COLUMN_KEY = COLUMN_STORAGE_KEYS.paperHistory;

const state = {
  activePanel: "positions",
  positions: [],
  summary: null,
  transactions: [],
  positionsSort: { key: "symbol", dir: "asc" },
  historySort: { key: "transaction_date", dir: "desc" },
  positionsFilter: "",
  sources: [],
  strategies: [],
  editingId: null,
  positionColumns: visibleColumnsInOrder(
    POSITION_COLUMNS,
    loadColumnPrefs(POSITIONS_COLUMN_KEY, POSITION_COLUMNS),
  ),
  historyColumns: visibleColumnsInOrder(
    HISTORY_COLUMNS,
    loadColumnPrefs(HISTORY_COLUMN_KEY, HISTORY_COLUMNS),
  ),
};

const els = {};

export async function initializePaperTradeModule() {
  els.tabs = document.getElementById("papertrade-tabs");
  els.panels = [...document.querySelectorAll(".papertrade-panel")];
  els.banner = document.getElementById("papertrade-banner");
  els.summary = document.getElementById("paper-portfolio-summary");

  els.positionsThead = document.getElementById("paper-positions-thead-row");
  els.positionsTbody = document.getElementById("paper-positions-tbody");
  els.positionsFilter = document.getElementById("paper-positions-filter");
  els.positionsCount = document.getElementById("paper-positions-count");
  els.refreshPricesBtn = document.getElementById("paper-refresh-prices-btn");
  els.positionsColumnsBtn = document.getElementById("paper-positions-columns-btn");

  els.historyThead = document.getElementById("paper-history-thead-row");
  els.historyTbody = document.getElementById("paper-history-tbody");
  els.historyCount = document.getElementById("paper-history-count");
  els.historySymbol = document.getElementById("paper-history-symbol");
  els.historyType = document.getElementById("paper-history-type");
  els.historyStart = document.getElementById("paper-history-start");
  els.historyEnd = document.getElementById("paper-history-end");
  els.historyClearBtn = document.getElementById("paper-history-clear-btn");
  els.historyColumnsBtn = document.getElementById("paper-history-columns-btn");

  // The Columns dialog is shared across every table in the app (see
  // tableRegistry.js) -- Paper Trade just points the same shared dialog
  // elements at its own storage keys, exactly as orders/index.js does.
  els.columnDialog = document.getElementById("column-dialog");
  els.columnDialogList = document.getElementById("column-dialog-list");
  els.columnResetBtn = document.getElementById("column-reset-btn");
  els.columnDoneBtn = document.getElementById("column-done-btn");

  els.orderDialog = document.getElementById("paper-order-dialog");
  els.orderForm = document.getElementById("paper-order-form");
  els.orderTypeSelect = document.getElementById("paper-order-type-select");
  els.orderSourceSelect = document.getElementById("paper-order-source-select");
  els.orderStrategySelect = document.getElementById("paper-order-strategy-select");
  els.orderLotSelect = document.getElementById("paper-order-lot-select");
  els.orderLotLabel = document.getElementById("paper-order-lot-label");
  els.orderPriceText = document.getElementById("paper-order-price-text");
  els.orderQtyLabel = document.getElementById("paper-order-qty-label");
  els.orderFeesLabel = document.getElementById("paper-order-fees-label");
  els.orderHint = document.getElementById("paper-order-hint");
  els.orderDialogTitle = document.getElementById("paper-order-dialog-title");
  els.orderDeleteBtn = document.getElementById("paper-order-delete-btn");
  els.orderCancelBtn = document.getElementById("paper-order-cancel-btn");
  els.logOrderBtns = [document.getElementById("log-paper-trade-btn"), document.getElementById("log-paper-trade-btn-2")];

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

  els.positionsColumnsBtn.addEventListener("click", () =>
    openColumnDialog({
      dialog: els.columnDialog,
      listEl: els.columnDialogList,
      resetBtn: els.columnResetBtn,
      doneBtn: els.columnDoneBtn,
      allColumns: POSITION_COLUMNS,
      storageKey: POSITIONS_COLUMN_KEY,
      onChange: refreshPositionColumns,
    }),
  );
  els.historyColumnsBtn.addEventListener("click", () =>
    openColumnDialog({
      dialog: els.columnDialog,
      listEl: els.columnDialogList,
      resetBtn: els.columnResetBtn,
      doneBtn: els.columnDoneBtn,
      allColumns: HISTORY_COLUMNS,
      storageKey: HISTORY_COLUMN_KEY,
      onChange: refreshHistoryColumns,
    }),
  );

  els.logOrderBtns.forEach((btn) => btn?.addEventListener("click", () => openOrderDialog()));
  els.orderCancelBtn.addEventListener("click", () => els.orderDialog.close());
  els.orderTypeSelect.addEventListener("change", updateOrderFormForType);
  els.orderForm.elements.symbol.addEventListener("input", debounce(updateOrderFormForType, 250));
  els.orderForm.addEventListener("submit", handleOrderSubmit);
  els.orderDeleteBtn.addEventListener("click", handleDeleteFromDialog);
  els.refreshPricesBtn.addEventListener("click", handleRefreshPrices);

  await reloadPaperTradeView();
}

export async function reloadPaperTradeView() {
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
    state.positionColumns,
    state.positionsSort.key,
    state.positionsSort.dir,
  );
  els.positionsTbody.innerHTML = renderPositionsRows(visible, state.positionColumns);
  els.positionsCount.textContent =
    visible.length === state.positions.length
      ? `${state.positions.length} lot(s)`
      : `${visible.length} of ${state.positions.length} lot(s)`;
}

function refreshPositionColumns() {
  state.positionColumns = visibleColumnsInOrder(
    POSITION_COLUMNS,
    loadColumnPrefs(POSITIONS_COLUMN_KEY, POSITION_COLUMNS),
  );
  renderPositions();
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
    state.historyColumns,
    state.historySort.key,
    state.historySort.dir,
  );
  els.historyTbody.innerHTML = renderHistoryRows(visible, state.historyColumns);
  els.historyCount.textContent = `${visible.length} transaction(s)`;
}

function refreshHistoryColumns() {
  state.historyColumns = visibleColumnsInOrder(
    HISTORY_COLUMNS,
    loadColumnPrefs(HISTORY_COLUMN_KEY, HISTORY_COLUMNS),
  );
  renderHistory();
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
  const promoteBtn = event.target.closest(".promote-txn-btn");
  if (promoteBtn) return handlePromote(Number(promoteBtn.dataset.id), promoteBtn.dataset.symbol);

  const editBtn = event.target.closest(".edit-txn-btn");
  if (editBtn) return openEditDialog(Number(editBtn.dataset.id));

  const btn = event.target.closest(".sell-lot-btn");
  if (!btn) return;
  openOrderDialog({
    type: "SELL",
    symbol: btn.dataset.symbol,
    lotId: Number(btn.dataset.lotId),
    quantity: Number(btn.dataset.qty),
  });
}

/**
 * Flips a paper BUY to a real one in place. The row then belongs to Orders,
 * not here -- see promotePaperTrade's own comment in transactionsService.js
 * for why cost basis, source, and strategy links all carry over untouched.
 */
async function handlePromote(lotId, symbol) {
  if (
    !window.confirm(
      `Promote this paper ${symbol} position to a real purchase?\n\n` +
        "It will move from Paper Trade into Orders, keeping its journal source and strategy links. This can't be undone.",
    )
  ) {
    return;
  }
  try {
    await api.promoteTransaction(lotId);
    await reloadPaperTradeView();
    banner(`${symbol} promoted to a real purchase -- see it under Orders.`, false);
  } catch (err) {
    banner(err.message, true);
  }
}

async function handleHistoryAction(event) {
  const editBtn = event.target.closest(".edit-txn-btn");
  if (editBtn) return openEditDialog(Number(editBtn.dataset.id));

  const btn = event.target.closest(".delete-txn-btn");
  if (!btn) return;
  if (!window.confirm("Delete this paper transaction? Lot quantities will be adjusted to match.")) return;
  try {
    await api.deleteTransaction(Number(btn.dataset.id));
    await reloadPaperTradeView();
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

async function openEditDialog(transactionId) {
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

  await loadSourcesAndStrategies();

  els.orderTypeSelect.value = txn.transaction_type;
  els.orderTypeSelect.disabled = true;
  els.orderForm.elements.symbol.value = txn.symbol;
  els.orderForm.elements.symbol.readOnly = true;
  els.orderForm.elements.transactionDate.value = txn.transaction_date;
  els.orderForm.elements.quantity.value = txn.quantity;
  els.orderForm.elements.price.value = txn.price;
  els.orderForm.elements.fees.value = txn.fees ?? 0;
  els.orderForm.elements.notes.value = txn.notes ?? "";
  if (txn.source_id) els.orderSourceSelect.value = String(txn.source_id);
  if (txn.strategy_id) els.orderStrategySelect.value = String(txn.strategy_id);

  els.orderDialogTitle.textContent = `Edit Paper ${txn.transaction_type} — ${txn.symbol}`;
  els.orderDeleteBtn.hidden = false;
  updateOrderFormForType();
  els.orderLotLabel.hidden = true;
  els.orderHint.textContent =
    txn.transaction_type === "BUY"
      ? "Correcting the price also updates the realized P&L of any paper sales from this lot."
      : "Changing the quantity re-allocates shares against the original paper purchase.";

  els.orderDialog.showModal();
}

async function loadSourcesAndStrategies() {
  try {
    state.sources = await api.fetchSources();
    els.orderSourceSelect.innerHTML = renderSourceOptions(state.sources);
  } catch {
    /* a missing source list shouldn't block logging a paper trade */
  }
  try {
    state.strategies = await api.fetchStrategies();
    els.orderStrategySelect.innerHTML = renderStrategyOptions(state.strategies);
  } catch {
    /* a missing strategy list shouldn't block logging a paper trade */
  }
}

async function openOrderDialog(prefill = {}) {
  state.editingId = null;
  els.orderTypeSelect.disabled = false;
  els.orderForm.elements.symbol.readOnly = false;
  els.orderDialogTitle.textContent = "Log Paper Trade";
  els.orderDeleteBtn.hidden = true;

  els.orderForm.reset();
  els.orderForm.elements.transactionDate.value = new Date().toISOString().slice(0, 10);
  els.orderForm.elements.fees.value = "0";

  await loadSourcesAndStrategies();

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
    // Only ever offers PAPER lots -- state.positions is already paper-scoped
    // (fetched via ?paper=1), so a paper sell can never accidentally match a
    // real lot.
    const lots = state.positions.filter((p) => p.symbol === symbol);
    const previous = els.orderLotSelect.value;
    els.orderLotSelect.innerHTML = renderLotOptions(lots);
    if (previous && [...els.orderLotSelect.options].some((o) => o.value === previous)) {
      els.orderLotSelect.value = previous;
    }
    const held = lots.reduce((sum, l) => sum + l.quantity_remaining, 0);
    els.orderHint.textContent = symbol
      ? lots.length
        ? `You hold ${held} paper share(s) of ${symbol} across ${lots.length} lot(s).`
        : `No open paper lots found for ${symbol}.`
      : "Enter a ticker to see which paper lots you hold.";
  } else {
    els.orderHint.textContent = isDividend
      ? "Paper dividends are recorded as income and don't affect your share count."
      : "";
  }
}

async function handleDeleteFromDialog() {
  if (!state.editingId) return;
  if (
    !window.confirm(
      "Delete this paper transaction?\n\nIf it's a sale, the shares go back to the lot it came from. " +
        "A purchase can't be deleted once any of it has been sold.",
    )
  ) {
    return;
  }
  try {
    await api.deleteTransaction(state.editingId);
    els.orderDialog.close();
    await reloadPaperTradeView();
    banner("Transaction deleted.", false);
  } catch (err) {
    banner(err.message, true);
  }
}

async function handleOrderSubmit(event) {
  event.preventDefault();
  const formData = new FormData(els.orderForm);
  if (state.editingId && !formData.get("transactionType")) {
    formData.set("transactionType", els.orderTypeSelect.value);
  }

  const payload = paperOrderFormToPayload(formData);
  const error = validateOrderPayload(payload);
  if (error) return banner(error, true);

  try {
    if (state.editingId) {
      await api.updateTransaction(state.editingId, payload);
      els.orderDialog.close();
      await reloadPaperTradeView();
      banner(`Updated ${payload.symbol}.`, false);
    } else {
      await api.recordTransaction(payload);
      els.orderDialog.close();
      await reloadPaperTradeView();
      banner(`Paper ${payload.transactionType} recorded for ${payload.symbol}.`, false);
    }
  } catch (err) {
    banner(err.message, true);
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
