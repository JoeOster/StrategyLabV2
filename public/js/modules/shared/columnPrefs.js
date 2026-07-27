// Column show/hide/reorder, shared by every sortable data table (Watchlist,
// Orders positions, Orders history). One shared file so the three tables
// behave identically and a fix only has to happen once.
//
// Split deliberately into pure functions (testable with plain objects and no
// DOM or localStorage -- see scripts/test-offline.js) and a thin DOM-wiring
// layer at the bottom. Same split this codebase uses between render.js and
// handlers.js elsewhere.

// --- pure: merging stored prefs against a table's current column set -------

/**
 * Reconciles a stored column order against the table's current full column
 * list. Columns the table no longer has are dropped; columns added to the
 * table since the prefs were saved (a new optional column shipped later) are
 * appended at the end rather than silently missing from the reorder list.
 * @param {string[]} allKeys every column key the table currently supports, in default order
 * @param {string[]} storedOrder order last saved by the user (may be stale/missing)
 */
export function mergeOrder(allKeys, storedOrder) {
  const known = new Set(allKeys);
  const kept = (Array.isArray(storedOrder) ? storedOrder : []).filter((k) => known.has(k));
  const seen = new Set(kept);
  const appended = allKeys.filter((k) => !seen.has(k));
  return [...kept, ...appended];
}

/**
 * @param {Array<{key: string, default?: boolean}>} allColumns
 * @param {string[]|null|undefined} storedVisible null/undefined = never saved -- fall back to each column's own default
 */
export function resolveVisible(allColumns, storedVisible) {
  if (!Array.isArray(storedVisible)) {
    return allColumns.filter((c) => c.default !== false).map((c) => c.key);
  }
  const known = new Set(allColumns.map((c) => c.key));
  return storedVisible.filter((k) => known.has(k));
}

export function defaultPrefs(allColumns) {
  return {
    order: allColumns.map((c) => c.key),
    visible: allColumns.filter((c) => c.default !== false).map((c) => c.key),
  };
}

/**
 * Moves `draggedKey` to sit immediately before (or after) `targetKey` in an
 * order array, returning a new array. Pulled out as its own pure function
 * specifically so the reorder arithmetic can be run against plain arrays in
 * a test -- this exact logic previously had a bug (reinserting the target's
 * own key instead of the dragged key, plus a missing index-shift after
 * removal) that read as correct on a first pass and only showed up once
 * actually dragged in a browser.
 *
 * `insertAfter` matters for the adjacent case: if `draggedKey` is already
 * immediately before `targetKey`, "insert before" is a no-op -- the item
 * doesn't move because it's already exactly there. Without an after-mode,
 * dragging an item down by exactly one slot (dropping it on its very next
 * sibling) would silently do nothing. The DOM layer below picks before/after
 * based on which half of the target row the drop lands in.
 *
 * @param {string[]} order
 * @param {string} draggedKey
 * @param {string} targetKey
 * @param {boolean} [insertAfter=false]
 */
export function reorderKey(order, draggedKey, targetKey, insertAfter = false) {
  if (draggedKey === targetKey) return [...order];
  const from = order.indexOf(draggedKey);
  const targetIndex = order.indexOf(targetKey);
  if (from === -1 || targetIndex === -1) return [...order];
  let to = insertAfter ? targetIndex + 1 : targetIndex;
  const next = [...order];
  next.splice(from, 1);
  // Removing an earlier element shifts everything after it left by one, so
  // the insertion point needs the same adjustment -- otherwise the dragged
  // column lands one slot off whenever it moves downward in the list.
  if (from < to) to -= 1;
  next.splice(to, 0, draggedKey);
  return next;
}

/** Column defs in the user's chosen order, filtered to the ones currently visible. */
export function visibleColumnsInOrder(allColumns, prefs) {
  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const visible = new Set(prefs.visible);
  return prefs.order
    .filter((k) => visible.has(k))
    .map((k) => byKey.get(k))
    .filter(Boolean);
}

// --- localStorage persistence ------------------------------------------------
// Deliberately per-browser, not server-side: this is a single-user personal
// app with no auth (see STATUS.md), and "which columns I like to see" is
// exactly the kind of preference that shouldn't need a schema bump to store.

export function loadColumnPrefs(storageKey, allColumns) {
  const allKeys = allColumns.map((c) => c.key);
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(storageKey));
  } catch {
    stored = null;
  }
  if (!stored || typeof stored !== "object") return defaultPrefs(allColumns);
  return {
    order: mergeOrder(allKeys, stored.order),
    visible: resolveVisible(allColumns, stored.visible),
  };
}

export function saveColumnPrefs(storageKey, prefs) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(prefs));
  } catch {
    // Private browsing / storage disabled -- reordering just won't persist
    // across reloads. Not worth surfacing an error for a preference.
  }
}

// --- DOM: the shared "Columns" dialog ---------------------------------------
// One dialog element in index.html is reused for all three tables; each
// caller passes its own column list + storage key. Listeners are bound fresh
// on every open and torn down on close -- the same pattern the delete/
// duplicate confirm dialogs already use elsewhere in this app, necessary
// here because the same DOM nodes serve three different tables.

function renderListItems(allColumns, prefs) {
  const byKey = new Map(allColumns.map((c) => [c.key, c]));
  const visible = new Set(prefs.visible);
  return prefs.order
    .map((key) => byKey.get(key))
    .filter(Boolean)
    .map(
      (col) => `
      <li class="column-item" draggable="true" data-key="${col.key}">
        <span class="column-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>
        <label>
          <input type="checkbox" class="column-visible-check" data-key="${col.key}"${
            visible.has(col.key) ? " checked" : ""
          } />
          ${escapeHtml(col.label)}
        </label>
      </li>`,
    )
    .join("");
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * @param {object} opts
 * @param {HTMLDialogElement} opts.dialog
 * @param {HTMLElement} opts.listEl <ul> the checkbox/drag rows render into
 * @param {HTMLElement} opts.resetBtn
 * @param {HTMLElement} opts.doneBtn
 * @param {Array<{key: string, label: string, default?: boolean}>} opts.allColumns
 * @param {string} opts.storageKey
 * @param {() => void} opts.onChange called after every toggle/drag/reset, once the change is already persisted
 */
export function openColumnDialog({ dialog, listEl, resetBtn, doneBtn, allColumns, storageKey, onChange }) {
  let prefs = loadColumnPrefs(storageKey, allColumns);
  let dragKey = null;

  function renderList() {
    listEl.innerHTML = renderListItems(allColumns, prefs);
  }

  function persist() {
    saveColumnPrefs(storageKey, prefs);
    onChange();
  }

  function onCheckChange(e) {
    const check = e.target.closest(".column-visible-check");
    if (!check) return;
    const key = check.dataset.key;
    prefs.visible = check.checked
      ? [...new Set([...prefs.visible, key])]
      : prefs.visible.filter((k) => k !== key);
    persist();
  }

  function onDragStart(e) {
    const li = e.target.closest(".column-item");
    if (!li) return;
    dragKey = li.dataset.key;
    e.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(e) {
    if (!dragKey) return;
    const li = e.target.closest(".column-item");
    if (!li || li.dataset.key === dragKey) return;
    e.preventDefault();
  }

  function onDrop(e) {
    const li = e.target.closest(".column-item");
    if (!li || !dragKey || li.dataset.key === dragKey) return;
    e.preventDefault();
    // Which half of the target row the cursor is over decides before/after --
    // without this, dropping onto the row directly below the dragged one
    // would be a no-op (see reorderKey's doc comment).
    const rect = li.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    prefs.order = reorderKey(prefs.order, dragKey, li.dataset.key, insertAfter);
    dragKey = null;
    renderList();
    persist();
  }

  function onReset() {
    prefs = defaultPrefs(allColumns);
    renderList();
    persist();
  }

  function cleanup() {
    listEl.removeEventListener("change", onCheckChange);
    listEl.removeEventListener("dragstart", onDragStart);
    listEl.removeEventListener("dragover", onDragOver);
    listEl.removeEventListener("drop", onDrop);
    resetBtn.removeEventListener("click", onReset);
    doneBtn.removeEventListener("click", onDone);
    dialog.removeEventListener("close", onDone);
  }

  function onDone() {
    cleanup();
    dialog.close();
  }

  renderList();
  listEl.addEventListener("change", onCheckChange);
  listEl.addEventListener("dragstart", onDragStart);
  listEl.addEventListener("dragover", onDragOver);
  listEl.addEventListener("drop", onDrop);
  resetBtn.addEventListener("click", onReset);
  doneBtn.addEventListener("click", onDone);
  dialog.addEventListener("close", onDone);
  dialog.showModal();
}
