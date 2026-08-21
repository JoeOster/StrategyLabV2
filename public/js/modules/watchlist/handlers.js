// The "Listeners & Buttons" file. Gathers input, calls api.js, then
// hands off to a callback (owned by index.js) to re-render and update
// state. Never builds HTML directly and never owns module state itself --
// that keeps this file testable/reusable independent of the DOM it's
// eventually wired into.
import * as api from "./api.js";

/**
 * @param {object} deps
 * @param {(matches: Array) => Promise<boolean>} deps.confirmDuplicate
 *   Shown when the symbol already exists with the SAME order type. Resolves
 *   true to proceed, false to cancel. Injected rather than called directly
 *   so this file stays free of DOM/dialog specifics.
 */
export function makeAddTickerHandler({
  getActiveWatchlistId,
  dialog,
  form,
  onItemAdded,
  onError,
  confirmDuplicate,
}) {
  return async function handleAddTickerSubmit(event) {
    event.preventDefault();
    const formData = new FormData(form);
    const symbol = formData.get("symbol");
    const orderType = formData.get("orderType");
    const targetPrice = formData.get("targetPrice");
    const escapePrice = formData.get("escapePrice");
    const notes = formData.get("notes");
    const selected = Number(formData.get("watchlistId"));
    const watchlistId = Number.isFinite(selected) && selected > 0 ? selected : getActiveWatchlistId();

    try {
      // Only warn on same symbol AND same type -- holding NVDA as both a
      // WATCH and a BUY_LIMIT is a legitimate setup, not a mistake.
      if (confirmDuplicate) {
        const { matches } = await api.checkExisting(symbol, orderType);
        if (matches.length > 0) {
          const proceed = await confirmDuplicate(matches);
          if (!proceed) return; // leave the add dialog open so they can adjust
        }
      }

      await api.addWatchedItem({ symbol, orderType, targetPrice, escapePrice, notes, watchlistId });
      form.reset();
      dialog.close();
      await onItemAdded();
    } catch (err) {
      onError(err.message);
    }
  };
}

export function makeNewListHandler({ dialog, form, onListCreated, onError }) {
  return async function handleNewListSubmit(event) {
    event.preventDefault();
    const formData = new FormData(form);
    const name = formData.get("name");
    try {
      await api.createWatchlist(name);
      form.reset();
      dialog.close();
      await onListCreated();
    } catch (err) {
      onError(err.message);
    }
  };
}

export function makeRefreshHandler({ onRefreshed, onError, onStart }) {
  return async function handleRefreshClick() {
    if (onStart) onStart();
    try {
      const { fired } = await api.runCheckAlerts();
      await onRefreshed(fired);
    } catch (err) {
      onError(err.message);
    }
  };
}

export function makeRefreshHistoryHandler({ onRefreshed, onError, onStart }) {
  return async function handleRefreshHistoryClick() {
    if (onStart) onStart();
    try {
      const { results } = await api.runRefreshHistory();
      await onRefreshed(results);
    } catch (err) {
      onError(err.message);
    }
  };
}
