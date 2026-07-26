// The "HTML" file. Pure functions: data in, markup out. Never fetches data
// and never attaches event listeners -- that's api.js and handlers.js.

export const COLUMNS = [
  { key: "symbol", label: "Symbol" },
  { key: "security_name", label: "Name" },
  { key: "order_type", label: "Type" },
  { key: "target", label: "Target" },
  { key: "last_price", label: "Last Price" },
  { key: "change_pct", label: "Change" },
  { key: "history_days", label: "History" },
  { key: "status", label: "Status" },
];

export const ORDER_TYPE_LABELS = {
  WATCH: "Watching",
  BUY_LIMIT: "Buy Limit",
  SELL_LIMIT: "Sell Limit",
  // Not a real order_type -- only appears on rows of the virtual Orders list,
  // which are derived from open positions rather than watched_items.
  HELD: "Held",
};

export function orderTypeLabel(orderType) {
  return ORDER_TYPE_LABELS[orderType] || orderType;
}

export function renderTabs(watchlists, activeId) {
  const tabs = watchlists
    .map(
      (wl) => `
      <button type="button" class="tab${String(wl.id) === String(activeId) ? " active" : ""}${wl.is_virtual ? " tab-virtual" : ""}" data-watchlist-id="${wl.id}"${wl.is_virtual ? ' title="Automatic: every ticker you currently hold"' : ""}>
        ${escapeHtml(wl.name)} <span class="tab-count">${wl.item_count}</span>
      </button>`,
    )
    .join("");
  return `${tabs}<button type="button" class="tab tab-new" id="new-list-tab">+ New List</button>`;
}

export function renderHeaderRow(sortKey, sortDir) {
  const sortable = COLUMNS.map((col) => {
    const isActive = col.key === sortKey;
    const arrow = isActive ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th class="sortable${isActive ? " sorted" : ""}" data-sort-key="${col.key}">${escapeHtml(col.label)}${arrow}</th>`;
  }).join("");
  // Trailing actions column is intentionally not sortable.
  return `${sortable}<th class="actions-col"></th>`;
}

export function renderItemsRows(items) {
  if (items.length === 0) {
    // +1 for the non-sortable actions column.
    return `<tr><td colspan="${COLUMNS.length + 1}" class="empty-row">Nothing here yet. Click "+ Add Ticker" to add one.</td></tr>`;
  }
  return items
    .map((item) => {
      const changePct = computeChangePct(item);
      const changeClass = changePct == null ? "" : changePct >= 0 ? "change-up" : "change-down";
      return `
        <tr class="status-${item.status.toLowerCase()}">
          <td>${escapeHtml(item.symbol)}</td>
          <td>${escapeHtml(item.security_name || "")}</td>
          <td><span class="type-pill type-${item.order_type.toLowerCase()}">${escapeHtml(orderTypeLabel(item.order_type))}</span></td>
          <td>${renderTargetCell(item)}</td>
          <td class="price-cell" title="${escapeHtml(buildPriceTooltip(item))}">${formatPrice(item.last_price)}</td>
          <td class="${changeClass}">${changePct == null ? "—" : `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`}</td>
          <td title="${escapeHtml(buildHistoryTooltip(item))}">${item.history_days ? `${item.history_days}d` : "—"}</td>
          <td><span class="status-pill">${escapeHtml(item.status)}</span></td>
          <td class="actions-cell">${
            // Virtual Orders rows aren't deletable -- they disappear on their
            // own once the position is sold.
            item.is_virtual
              ? `<span class="virtual-hint" title="Managed automatically — sell the position to remove it">auto</span>`
              : `<button type="button" class="delete-btn" data-item-id="${item.id}" title="Remove from watchlist" aria-label="Remove ${escapeHtml(item.symbol)}">✕</button>`
          }</td>
        </tr>`;
    })
    .join("");
}

// --- sorting ---------------------------------------------------------------

export function sortItems(items, sortKey, sortDir) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = sortValue(a, sortKey);
    const bv = sortValue(b, sortKey);
    // Nulls always sort to the bottom regardless of direction -- a blank
    // price shouldn't outrank a real one just because you flipped the arrow.
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function sortValue(item, key) {
  switch (key) {
    case "target":
      return item.order_type === "BUY_LIMIT" ? item.buy_price_high : item.take_profit_low;
    case "change_pct":
      return computeChangePct(item);
    case "last_price":
      return item.last_price == null ? null : Number(item.last_price);
    case "history_days":
      return item.history_days == null ? null : Number(item.history_days);
    case "order_type":
      // Sort by what's displayed, so the order matches the visible labels.
      return orderTypeLabel(item.order_type);
    default:
      return item[key] ?? null;
  }
}

/**
 * @param {Array} items
 * @param {string} query free-text search
 * @param {string} [orderType] exact order_type to keep; "" or undefined = all types
 */
export function filterItems(items, query, orderType) {
  let result = items;

  if (orderType) {
    result = result.filter((item) => item.order_type === orderType);
  }

  const q = (query || "").trim().toLowerCase();
  if (!q) return result;

  return result.filter(
    (item) =>
      item.symbol.toLowerCase().includes(q) ||
      (item.security_name || "").toLowerCase().includes(q) ||
      (item.notes || "").toLowerCase().includes(q) ||
      item.status.toLowerCase().includes(q) ||
      // Match the readable label ("Buy Limit"), not the raw enum, since
      // that's what's actually on screen.
      orderTypeLabel(item.order_type).toLowerCase().includes(q),
  );
}

// --- cell helpers ----------------------------------------------------------

function computeChangePct(item) {
  if (item.last_price == null || item.prev_close == null || Number(item.prev_close) === 0) return null;
  return ((Number(item.last_price) - Number(item.prev_close)) / Number(item.prev_close)) * 100;
}

function formatPrice(value) {
  return value != null ? `$${Number(value).toFixed(2)}` : "—";
}

function renderTargetCell(item) {
  if (item.order_type === "HELD") {
    return `${item.quantity} share(s)`;
  }
  if (item.order_type === "WATCH") return "Watching";
  const target = item.order_type === "BUY_LIMIT" ? item.buy_price_high : item.take_profit_low;
  const label = item.order_type === "BUY_LIMIT" ? "Buy ≤" : "Sell ≥";
  return `${label} ${target != null ? `$${target}` : "—"}`;
}

function buildPriceTooltip(item) {
  if (item.last_price == null) {
    return "No quote yet — click Refresh Prices.";
  }
  const lines = [
    `Last: ${formatPrice(item.last_price)}`,
    `Prev close: ${formatPrice(item.prev_close)}`,
    `Open: ${formatPrice(item.open_price)}`,
    `Day range: ${formatPrice(item.day_low)} – ${formatPrice(item.day_high)}`,
    item.volume != null ? `Volume: ${Number(item.volume).toLocaleString()}` : null,
    "",
    `Fetched: ${formatTimestamp(item.quote_fetched_at)} (${describeAge(item.quote_fetched_at)})`,
    item.quote_as_of ? `Exchange time: ${formatTimestamp(item.quote_as_of)}` : null,
    item.quote_source ? `Source: ${item.quote_source}` : null,
  ].filter((line) => line !== null);
  return lines.join("\n");
}

function buildHistoryTooltip(item) {
  if (!item.history_days) {
    return "No daily history stored yet. Use Refresh History to backfill.";
  }
  return `${item.history_days} daily bars stored\nMost recent: ${item.history_latest || "unknown"}`;
}

// SQLite writes these as 'YYYY-MM-DD HH:MM:SS' in UTC with no timezone
// marker, so they must be parsed as UTC explicitly -- otherwise the browser
// reads them as local time and "age" comes out hours off.
function parseSqliteUtc(value) {
  if (!value) return null;
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(value) {
  const date = parseSqliteUtc(value);
  return date ? date.toLocaleString() : "unknown";
}

function describeAge(value) {
  const date = parseSqliteUtc(value);
  if (!date) return "unknown age";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function renderDuplicateList(matches) {
  return matches
    .map((m) => {
      const target =
        m.order_type === "BUY_LIMIT"
          ? m.buy_price_high != null
            ? ` at $${m.buy_price_high}`
            : ""
          : m.order_type === "SELL_LIMIT"
            ? m.take_profit_low != null
              ? ` at $${m.take_profit_low}`
              : ""
            : "";
      const added = m.created_at ? ` — added ${formatTimestamp(m.created_at)}` : "";
      return `<li><strong>${escapeHtml(m.watchlist_name)}</strong>: ${escapeHtml(orderTypeLabel(m.order_type))}${escapeHtml(target)} <span class="status-pill">${escapeHtml(m.status)}</span>${escapeHtml(added)}</li>`;
    })
    .join("");
}

/**
 * Checkbox list for the delete dialog -- one row per entry of the same
 * symbol, so you can remove just the one you clicked, several, or all.
 * @param {Array} entries every active entry sharing the symbol
 * @param {number} clickedId pre-checked (the row whose ✕ was clicked)
 */
export function renderDeleteChoices(entries, clickedId) {
  return entries
    .map((e) => {
      const target =
        e.order_type === "BUY_LIMIT"
          ? e.buy_price_high != null
            ? ` at $${e.buy_price_high}`
            : ""
          : e.order_type === "SELL_LIMIT"
            ? e.take_profit_low != null
              ? ` at $${e.take_profit_low}`
              : ""
            : "";
      return `
        <li>
          <label>
            <input type="checkbox" class="delete-choice" value="${e.id}"${e.id === clickedId ? " checked" : ""} />
            <span class="type-pill type-${e.order_type.toLowerCase()}">${escapeHtml(orderTypeLabel(e.order_type))}</span>
            ${escapeHtml(target)}
            <span class="delete-choice-meta">in ${escapeHtml(e.watchlist_name)} · ${escapeHtml(e.status)}</span>
          </label>
        </li>`;
    })
    .join("");
}

/** Excludes system-managed lists -- you can't choose to add a ticker to Orders. */
export function renderWatchlistOptions(watchlists, selectedId) {
  return watchlists
    .filter((wl) => !wl.is_virtual)
    .map(
      (wl) =>
        `<option value="${wl.id}"${wl.id === selectedId ? " selected" : ""}>${escapeHtml(wl.name)}</option>`,
    )
    .join("");
}

export function renderStatusBanner(el, message, isError) {
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `status-banner ${isError ? "status-error" : "status-success"}`;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
