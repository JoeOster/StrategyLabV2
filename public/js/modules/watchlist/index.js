// The "Conductor" -- the only file the rest of the app imports. Owns module
// state (active tab, sort, filter) and wires listeners to the elements
// defined in public/index.html. Imports from its siblings (api.js,
// render.js, handlers.js) but they never import each other directly.
import * as api from "./api.js";
import {
  ALL_COLUMNS,
  renderTabs,
  renderHeaderRow,
  renderItemsRows,
  renderWatchlistOptions,
  renderStatusBanner,
  renderDuplicateList,
  renderDeleteChoices,
  orderTypeLabel,
  sortItems,
  filterItems,
} from "./render.js";
import {
  makeAddTickerHandler,
  makeNewListHandler,
  makeRefreshHandler,
  makeRefreshHistoryHandler,
} from "./handlers.js";
import { loadColumnPrefs, visibleColumnsInOrder, openColumnDialog } from "../shared/columnPrefs.js";
import { COLUMN_STORAGE_KEYS } from "../shared/tableRegistry.js";

// Single source of truth for this key lives in tableRegistry.js -- Settings'
// "Table Columns" panel reads/writes the exact same key, so they can never
// silently drift apart.
const COLUMN_STORAGE_KEY = COLUMN_STORAGE_KEYS.watchlist;

const state = {
  watchlists: [],
  activeWatchlistId: null,
  // Raw rows straight from the API. Sorting/filtering are applied to a copy
  // at render time so toggling either never mutates or loses data.
  items: [],
  sortKey: "symbol",
  sortDir: "asc",
  filterQuery: "",
  typeFilter: "",
  // Recomputed from localStorage on init and whenever the Columns dialog
  // changes something -- see refreshColumns() below.
  columns: visibleColumnsInOrder(ALL_COLUMNS, loadColumnPrefs(COLUMN_STORAGE_KEY, ALL_COLUMNS)),
};

const els = {};

export async function initializeWatchlistModule() {
  els.tabs = document.getElementById("watchlist-tabs");
  els.theadRow = document.getElementById("items-thead-row");
  els.tbody = document.getElementById("items-tbody");
  els.rowCount = document.getElementById("row-count");
  els.filterInput = document.getElementById("filter-input");
  els.typeFilter = document.getElementById("type-filter");
  els.duplicateDialog = document.getElementById("duplicate-dialog");
  els.duplicateMessage = document.getElementById("duplicate-message");
  els.duplicateList = document.getElementById("duplicate-list");
  els.duplicateCancelBtn = document.getElementById("duplicate-cancel-btn");
  els.duplicateConfirmBtn = document.getElementById("duplicate-confirm-btn");
  els.deleteDialog = document.getElementById("delete-dialog");
  els.deleteMessage = document.getElementById("delete-message");
  els.deleteChoices = document.getElementById("delete-choices");
  els.deleteSelectAllLabel = document.getElementById("delete-select-all-label");
  els.deleteSelectAll = document.getElementById("delete-select-all");
  els.deleteWarning = document.getElementById("delete-warning");
  els.deleteCancelBtn = document.getElementById("delete-cancel-btn");
  els.deleteConfirmBtn = document.getElementById("delete-confirm-btn");
  els.statusBanner = document.getElementById("status-banner");
  els.addBtn = document.getElementById("add-ticker-btn");
  els.refreshBtn = document.getElementById("refresh-btn");
  els.refreshHistoryBtn = document.getElementById("refresh-history-btn");
  els.columnsBtn = document.getElementById("watchlist-columns-btn");
  els.columnDialog = document.getElementById("column-dialog");
  els.columnDialogList = document.getElementById("column-dialog-list");
  els.columnResetBtn = document.getElementById("column-reset-btn");
  els.columnDoneBtn = document.getElementById("column-done-btn");
  els.addDialog = document.getElementById("add-ticker-dialog");
  els.addForm = document.getElementById("add-ticker-form");
  els.addFormWatchlistSelect = document.getElementById("add-form-watchlist");
  els.cancelAddBtn = document.getElementById("cancel-add-btn");
  els.newListDialog = document.getElementById("new-list-dialog");
  els.newListForm = document.getElementById("new-list-form");
  els.cancelListBtn = document.getElementById("cancel-list-btn");
  els.orderTypeSelect = document.getElementById("add-form-order-type");
  els.targetPriceInput = els.addForm.elements.targetPrice;
  els.targetPriceLabel = document.getElementById("add-form-target-price-label");

  await loadWatchlists();
  await loadItems();

  els.tabs.addEventListener("click", handleTabsClick);
  els.theadRow.addEventListener("click", handleSortClick);
  // Delegated: rows are re-rendered constantly, so per-button listeners
  // would need re-binding after every sort/filter/refresh.
  els.tbody.addEventListener("click", handleDeleteClick);
  els.filterInput.addEventListener("input", () => {
    state.filterQuery = els.filterInput.value;
    renderTable();
  });
  els.typeFilter.addEventListener("change", () => {
    state.typeFilter = els.typeFilter.value;
    renderTable();
  });
  els.columnsBtn.addEventListener("click", () =>
    openColumnDialog({
      dialog: els.columnDialog,
      listEl: els.columnDialogList,
      resetBtn: els.columnResetBtn,
      doneBtn: els.columnDoneBtn,
      allColumns: ALL_COLUMNS,
      storageKey: COLUMN_STORAGE_KEY,
      onChange: refreshColumns,
    }),
  );

  els.addBtn.addEventListener("click", () => openAddTickerDialog());
  els.orderTypeSelect.addEventListener("change", updateTargetPriceVisibility);
  els.cancelAddBtn.addEventListener("click", () => els.addDialog.close());
  els.cancelListBtn.addEventListener("click", () => els.newListDialog.close());

  els.addForm.addEventListener(
    "submit",
    makeAddTickerHandler({
      getActiveWatchlistId: () => state.activeWatchlistId,
      dialog: els.addDialog,
      form: els.addForm,
      confirmDuplicate: showDuplicateConfirm,
      onItemAdded: async () => {
        await loadWatchlists();
        await loadItems();
        renderStatusBanner(
          els.statusBanner,
          "Ticker added. Price history is backfilling in the background.",
          false,
        );
      },
      onError: (message) => renderStatusBanner(els.statusBanner, message, true),
    }),
  );

  els.newListForm.addEventListener(
    "submit",
    makeNewListHandler({
      dialog: els.newListDialog,
      form: els.newListForm,
      onListCreated: async () => {
        await loadWatchlists();
        renderStatusBanner(els.statusBanner, "List created.", false);
      },
      onError: (message) => renderStatusBanner(els.statusBanner, message, true),
    }),
  );

  els.refreshBtn.addEventListener(
    "click",
    makeRefreshHandler({
      onStart: () => setBusy(els.refreshBtn, "Refreshing…"),
      onRefreshed: async (fired) => {
        clearBusy(els.refreshBtn, "Refresh Prices");
        await loadItems();
        const message = fired.length
          ? `${fired.length} alert(s) fired: ${fired.map((f) => f.symbol).join(", ")}`
          : "Prices refreshed. No new alerts.";
        renderStatusBanner(els.statusBanner, message, false);
      },
      onError: (message) => {
        clearBusy(els.refreshBtn, "Refresh Prices");
        renderStatusBanner(els.statusBanner, message, true);
      },
    }),
  );

  els.refreshHistoryBtn.addEventListener(
    "click",
    makeRefreshHistoryHandler({
      onStart: () => setBusy(els.refreshHistoryBtn, "Backfilling…"),
      onRefreshed: async (results) => {
        clearBusy(els.refreshHistoryBtn, "Refresh History");
        await loadItems();
        const failures = results.filter((r) => r.error);
        const totalBars = results.reduce((sum, r) => sum + (r.barCount || 0), 0);
        const message = failures.length
          ? `History updated for ${results.length - failures.length} ticker(s); ${failures.length} failed.`
          : `History updated for ${results.length} ticker(s) (${totalBars} bars checked).`;
        renderStatusBanner(els.statusBanner, message, failures.length > 0);
      },
      onError: (message) => {
        clearBusy(els.refreshHistoryBtn, "Refresh History");
        renderStatusBanner(els.statusBanner, message, true);
      },
    }),
  );
}

async function handleDeleteClick(event) {
  const btn = event.target.closest(".delete-btn");
  if (!btn) return;
  const clickedId = Number(btn.dataset.itemId);
  if (!Number.isFinite(clickedId)) return; // virtual rows have no real id
  const clicked = state.items.find((i) => i.id === clickedId);
  if (!clicked) return;

  // Sibling entries = same ticker, other types (e.g. NVDA held as both a
  // WATCH and a BUY_LIMIT). Scoped to the items already loaded for the
  // active list, so this reflects exactly what's on screen.
  const entries = state.items.filter((i) => i.symbol === clicked.symbol);
  const ids = await showDeleteConfirm(entries, clickedId, clicked.symbol);
  if (!ids || ids.length === 0) return;

  try {
    const result = await api.deleteWatchedItems(ids);
    await loadWatchlists();
    await loadItems();
    renderStatusBanner(
      els.statusBanner,
      `Removed ${result.deleted} entr${result.deleted === 1 ? "y" : "ies"} for ${clicked.symbol}.`,
      false,
    );
  } catch (err) {
    renderStatusBanner(els.statusBanner, err.message, true);
  }
}

/**
 * Delete confirmation. With a single entry it's a plain confirm; with
 * several entries for the same symbol it becomes a checkbox list so you can
 * remove one, some, or all. Resolves to an array of ids, or null on cancel.
 */
function showDeleteConfirm(entries, clickedId, symbol) {
  const multiple = entries.length > 1;

  els.deleteMessage.textContent = multiple
    ? `${symbol} has ${entries.length} entries. Choose which to remove:`
    : `Remove ${symbol} from your watchlist?`;
  els.deleteChoices.innerHTML = renderDeleteChoices(entries, clickedId);
  els.deleteSelectAllLabel.hidden = !multiple;
  els.deleteSelectAll.checked = false;

  const alertTotal = entries.reduce((sum, e) => sum + (e.alert_count || 0), 0);
  els.deleteWarning.hidden = alertTotal === 0;
  els.deleteWarning.textContent =
    alertTotal > 0 ? "Removing an entry also deletes its recorded alert history." : "";

  return new Promise((resolve) => {
    function selectedIds() {
      return [...els.deleteChoices.querySelectorAll(".delete-choice:checked")].map((cb) =>
        Number(cb.value),
      );
    }
    function onSelectAll() {
      const checked = els.deleteSelectAll.checked;
      els.deleteChoices.querySelectorAll(".delete-choice").forEach((cb) => (cb.checked = checked));
    }
    function cleanup(result) {
      els.deleteConfirmBtn.removeEventListener("click", onConfirm);
      els.deleteCancelBtn.removeEventListener("click", onCancel);
      els.deleteSelectAll.removeEventListener("change", onSelectAll);
      els.deleteDialog.removeEventListener("close", onCancel);
      els.deleteDialog.close();
      resolve(result);
    }
    const onConfirm = () => cleanup(selectedIds());
    const onCancel = () => cleanup(null); // also covers Escape

    els.deleteConfirmBtn.addEventListener("click", onConfirm);
    els.deleteCancelBtn.addEventListener("click", onCancel);
    els.deleteSelectAll.addEventListener("change", onSelectAll);
    els.deleteDialog.addEventListener("close", onCancel);
    els.deleteDialog.showModal();
  });
}

/**
 * Shows the "already watching this" dialog and resolves true if the user
 * chooses to add anyway. Wrapping a <dialog> in a promise keeps the calling
 * handler linear (`if (!await confirm()) return;`) instead of splitting the
 * submit flow across callbacks.
 */
function showDuplicateConfirm(matches) {
  const { symbol, order_type } = matches[0];
  els.duplicateMessage.textContent =
    matches.length === 1
      ? `${symbol} is already on your watchlist as "${orderTypeLabel(order_type)}".`
      : `${symbol} already has ${matches.length} active "${orderTypeLabel(order_type)}" entries.`;
  els.duplicateList.innerHTML = renderDuplicateList(matches);

  return new Promise((resolve) => {
    function cleanup(result) {
      els.duplicateConfirmBtn.removeEventListener("click", onConfirm);
      els.duplicateCancelBtn.removeEventListener("click", onCancel);
      els.duplicateDialog.removeEventListener("close", onCancel);
      els.duplicateDialog.close();
      resolve(result);
    }
    const onConfirm = () => cleanup(true);
    // Also fires on Escape, which should mean "no" -- same as Cancel.
    const onCancel = () => cleanup(false);

    els.duplicateConfirmBtn.addEventListener("click", onConfirm);
    els.duplicateCancelBtn.addEventListener("click", onCancel);
    els.duplicateDialog.addEventListener("close", onCancel);
    els.duplicateDialog.showModal();
  });
}

function setBusy(button, label) {
  button.disabled = true;
  button.dataset.originalLabel = button.textContent;
  button.textContent = label;
}

function clearBusy(button, fallbackLabel) {
  button.disabled = false;
  button.textContent = button.dataset.originalLabel || fallbackLabel;
}

function updateTargetPriceVisibility() {
  const isWatch = els.orderTypeSelect.value === "WATCH";
  els.targetPriceLabel.hidden = isWatch;
  els.targetPriceInput.required = !isWatch;
  if (isWatch) els.targetPriceInput.value = "";
}

/**
 * Re-fetches lists and items. Called when switching back to this view, or
 * after a settings change that could have renamed/removed a list.
 */
// Exported so the global header menu can open this from any view, not just the
// Watchlist -- the button used to live in the header and was reachable anywhere
// (by accident, via a CSS bug); this makes that reach deliberate.
export function openAddTickerDialog() {
  els.addFormWatchlistSelect.innerHTML = renderWatchlistOptions(state.watchlists, state.activeWatchlistId);
  updateTargetPriceVisibility();
  els.addDialog.showModal();
}

export async function reloadWatchlistView() {
  // If the active list was deleted in Settings, fall back to the first
  // remaining one rather than showing an empty table for a dead id.
  await loadWatchlists();
  if (!state.watchlists.some((w) => String(w.id) === String(state.activeWatchlistId))) {
    state.activeWatchlistId = state.watchlists[0]?.id ?? null;
    els.tabs.innerHTML = renderTabs(state.watchlists, state.activeWatchlistId);
  }
  await loadItems();
}

async function loadWatchlists() {
  state.watchlists = await api.fetchWatchlists();
  if (state.activeWatchlistId == null && state.watchlists.length > 0) {
    state.activeWatchlistId = state.watchlists[0].id;
  }
  els.tabs.innerHTML = renderTabs(state.watchlists, state.activeWatchlistId);
}

async function loadItems() {
  state.items = await api.fetchWatchedItems(state.activeWatchlistId);
  renderTable();
}

function renderTable() {
  const visible = sortItems(
    filterItems(state.items, state.filterQuery, state.typeFilter),
    state.sortKey,
    state.sortDir,
  );
  els.theadRow.innerHTML = renderHeaderRow(state.columns, state.sortKey, state.sortDir);
  els.tbody.innerHTML = renderItemsRows(visible, state.columns);
  els.rowCount.textContent =
    visible.length === state.items.length
      ? `${state.items.length} item(s)`
      : `${visible.length} of ${state.items.length} item(s)`;
}

/** Re-reads column prefs from localStorage and re-renders -- called after every Columns dialog change. */
function refreshColumns() {
  state.columns = visibleColumnsInOrder(ALL_COLUMNS, loadColumnPrefs(COLUMN_STORAGE_KEY, ALL_COLUMNS));
  renderTable();
}

function handleSortClick(event) {
  const th = event.target.closest("th[data-sort-key]");
  if (!th) return;
  const key = th.dataset.sortKey;
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = key;
    state.sortDir = "asc";
  }
  renderTable();
}

async function handleTabsClick(event) {
  if (event.target.closest("#new-list-tab")) {
    els.newListDialog.showModal();
    return;
  }
  const tab = event.target.closest(".tab[data-watchlist-id]");
  if (!tab) return;
  // Ids are numeric for real lists but a string for the virtual "orders"
  // list, so only coerce when it actually is a number.
  const raw = tab.dataset.watchlistId;
  state.activeWatchlistId = /^\d+$/.test(raw) ? Number(raw) : raw;
  els.tabs.innerHTML = renderTabs(state.watchlists, state.activeWatchlistId);
  await loadItems();
}
