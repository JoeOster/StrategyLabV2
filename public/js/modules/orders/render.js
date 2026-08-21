// The "HTML" file for orders. Pure functions: data in, markup out.
import { renderStrategyOptions } from "../journal/render.js";
export { renderStrategyOptions };

// `default: false` columns are available via the Columns tool but hidden
// until the user opts in -- see public/js/modules/shared/columnPrefs.js.
export const POSITION_COLUMNS = [
  { key: "symbol", label: "Ticker" },
  { key: "security_name", label: "Name" },
  { key: "exchange_code", label: "Exch" },
  { key: "quantity_remaining", label: "Qty" },
  { key: "cost_per_share", label: "Entry" },
  { key: "cost_basis", label: "Cost Basis" },
  { key: "last_price", label: "Price" },
  { key: "market_value", label: "Value" },
  { key: "unrealized_pnl", label: "Unreal. P/L" },
  { key: "unrealized_pnl_percent", label: "%" },
  { key: "days_held", label: "Held" },
  { key: "transaction_date", label: "Bought", default: false },
  { key: "original_quantity", label: "Orig. Qty", default: false },
  { key: "fees", label: "Fees", default: false },
  { key: "prev_close", label: "Prev Close", default: false },
  { key: "source_name", label: "Source", default: false },
  { key: "strategy_title", label: "Strategy", default: false },
  { key: "notes", label: "Notes", default: false },
];

export const HISTORY_COLUMNS = [
  { key: "transaction_date", label: "Date" },
  { key: "symbol", label: "Ticker" },
  { key: "transaction_type", label: "Type" },
  { key: "quantity", label: "Qty" },
  { key: "price", label: "Price" },
  { key: "fees", label: "Fees" },
  { key: "total", label: "Total" },
  { key: "realized_pnl", label: "Realized P/L" },
  { key: "source_name", label: "Source" },
  { key: "strategy_title", label: "Strategy", default: false },
  { key: "exchange_code", label: "Exch", default: false },
  { key: "linked_buy_date", label: "From Lot", default: false },
  { key: "external_ref", label: "Ext Ref", default: false },
  { key: "notes", label: "Notes", default: false },
];

export function renderHeaderRow(columns, sortKey, sortDir, { trailingBlank = true } = {}) {
  const cells = columns
    .map((col) => {
      const active = col.key === sortKey;
      const arrow = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
      return `<th class="sortable${active ? " sorted" : ""}" data-sort-key="${col.key}">${escapeHtml(col.label)}${arrow}</th>`;
    })
    .join("");
  return trailingBlank ? `${cells}<th class="actions-col"></th>` : cells;
}

// One render function per column key, each returning a full `<td>...</td>`
// string so cell-specific classes/titles stay next to the markup that needs
// them (mirrors the same pattern in watchlist/render.js).
const POSITION_CELL_RENDERERS = {
  symbol: (p) => `<td><strong>${escapeHtml(p.symbol)}</strong></td>`,
  security_name: (p) => `<td>${escapeHtml(p.security_name || "")}</td>`,
  exchange_code: (p) => `<td>${escapeHtml(p.exchange_code || "—")}</td>`,
  quantity_remaining: (p) => `<td>${formatQty(p.quantity_remaining)}</td>`,
  cost_per_share: (p) => `<td>${money(p.cost_per_share)}</td>`,
  cost_basis: (p) => `<td>${money(p.cost_basis)}</td>`,
  last_price: (p) => `<td title="${escapeHtml(priceTooltip(p))}">${money(p.last_price)}</td>`,
  market_value: (p) => `<td>${money(p.market_value)}</td>`,
  unrealized_pnl: (p) => {
    const cls = p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "change-up" : "change-down";
    return `<td class="${cls}">${signedMoney(p.unrealized_pnl)}</td>`;
  },
  unrealized_pnl_percent: (p) => {
    const cls = p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "change-up" : "change-down";
    return `<td class="${cls}">${p.unrealized_pnl_percent == null ? "—" : `${p.unrealized_pnl_percent >= 0 ? "+" : ""}${p.unrealized_pnl_percent.toFixed(2)}%`}</td>`;
  },
  days_held: (p) =>
    `<td title="Bought ${escapeHtml(p.transaction_date)}${p.source_name ? ` · via ${escapeHtml(p.source_name)}` : ""}">${p.days_held == null ? "—" : `${p.days_held}d`}</td>`,
  transaction_date: (p) => `<td>${escapeHtml(p.transaction_date || "—")}</td>`,
  original_quantity: (p) => `<td>${formatQty(p.original_quantity)}</td>`,
  fees: (p) => `<td>${p.fees ? money(p.fees) : "—"}</td>`,
  prev_close: (p) => `<td>${money(p.prev_close)}</td>`,
  source_name: (p) => `<td>${escapeHtml(p.source_name || "—")}</td>`,
  strategy_title: (p) => `<td>${escapeHtml(p.strategy_title || "—")}</td>`,
  notes: (p) => `<td class="notes-cell" title="${escapeHtml(p.notes || "")}">${truncate(p.notes, 40)}</td>`,
};

/**
 * @param {Array<{key,label}>} columns visible columns, in display order
 * @param {{showPromote?: boolean, emptyMessage?: string}} [opts] showPromote
 *   adds a "Promote" button (Paper Trade tab only -- turns a paper BUY into
 *   a real one in place, see promotePaperTrade in transactionsService.js).
 */
// Row-action icons.
//
// Glyphs rather than SVG or an icon font: this app runs on two packages, and
// the void button in the history table is already a bare Unicode cross, so
// this matches what exists instead of adding a third way to draw a button.
//
// Each carries U+FE0E (text presentation selector) to stop platforms promoting
// them to full-colour emoji, which would break the line weight beside the
// others.
//
// EXITS had no obvious symbol. An up-down pair says what the ladder actually
// is -- take-profit rungs above the price and a stop below it -- where a target
// or a flag would describe only half of it.
const ACTION_ICONS = {
  promote: "\u2191\uFE0E", // upward: a paper trade becoming real
  sell: "$",
  exits: "\u21C5\uFE0E",
  edit: "\u270E\uFE0E",
};

export function renderPositionsRows(positions, columns, opts = {}) {
  const { showPromote = false, emptyMessage = 'No open positions. Use "+ Log Order" to record a purchase.' } = opts;
  if (positions.length === 0) {
    return `<tr><td colspan="${columns.length + 1}" class="empty-row">${escapeHtml(emptyMessage)}</td></tr>`;
  }
  return positions
    .map((p) => {
      const cells = columns
        .map((col) => (POSITION_CELL_RENDERERS[col.key] || (() => "<td>—</td>"))(p))
        .join("");
      return `
        <tr>
          ${cells}
          <td class="actions-cell">
            ${showPromote ? `<button type="button" class="icon-btn promote-txn-btn" data-id="${p.lot_id}" data-symbol="${escapeHtml(p.symbol)}" title="Promote to a real purchase" aria-label="Promote ${escapeHtml(p.symbol)} to a real purchase">${ACTION_ICONS.promote}</button>` : ""}
            <button type="button" class="icon-btn sell-lot-btn" data-symbol="${escapeHtml(p.symbol)}" data-lot-id="${p.lot_id}" data-qty="${p.quantity_remaining}" title="Sell from this lot" aria-label="Sell ${escapeHtml(p.symbol)}">${ACTION_ICONS.sell}</button>
            <button type="button" class="icon-btn exits-btn" data-id="${p.lot_id}" data-symbol="${escapeHtml(p.symbol)}" title="Exit plan: take-profit and stop rungs" aria-label="Exit plan for ${escapeHtml(p.symbol)}">${ACTION_ICONS.exits}</button>
            <button type="button" class="icon-btn edit-txn-btn" data-id="${p.lot_id}" title="Correct this purchase" aria-label="Edit ${escapeHtml(p.symbol)} purchase">${ACTION_ICONS.edit}</button>
          </td>
        </tr>`;
    })
    .join("");
}

const HISTORY_CELL_RENDERERS = {
  transaction_date: (t) => `<td>${escapeHtml(t.transaction_date)}</td>`,
  symbol: (t) => `<td><strong>${escapeHtml(t.symbol)}</strong></td>`,
  transaction_type: (t) =>
    `<td><span class="type-pill type-txn-${t.transaction_type.toLowerCase()}">${escapeHtml(t.transaction_type)}</span></td>`,
  quantity: (t) => `<td>${t.transaction_type === "DIVIDEND" ? "—" : formatQty(t.quantity)}</td>`,
  price: (t) => `<td>${money(t.price)}</td>`,
  fees: (t) => `<td>${t.fees ? money(t.fees) : "—"}</td>`,
  total: (t) => `<td>${money(t.total)}</td>`,
  realized_pnl: (t) => {
    const cls = t.realized_pnl == null ? "" : t.realized_pnl >= 0 ? "change-up" : "change-down";
    return `<td class="${cls}">${signedMoney(t.realized_pnl)}</td>`;
  },
  source_name: (t) => `<td>${escapeHtml(t.source_name || "—")}</td>`,
  strategy_title: (t) => `<td>${escapeHtml(t.strategy_title || "—")}</td>`,
  exchange_code: (t) => `<td>${escapeHtml(t.exchange_code || "—")}</td>`,
  linked_buy_date: (t) => `<td>${escapeHtml(t.linked_buy_date || "—")}</td>`,
  external_ref: (t) => `<td>${escapeHtml(t.external_ref || "—")}</td>`,
  notes: (t) => `<td class="notes-cell" title="${escapeHtml(t.notes || "")}">${truncate(t.notes, 40)}</td>`,
};

/** @param {Array<{key,label}>} columns visible columns, in display order */
export function renderHistoryRows(rows, columns) {
  if (rows.length === 0) {
    return `<tr><td colspan="${columns.length + 1}" class="empty-row">No transactions match these filters.</td></tr>`;
  }
  return rows
    .map((t) => {
      const cells = columns
        .map((col) => (HISTORY_CELL_RENDERERS[col.key] || (() => "<td>—</td>"))(t))
        .join("");
      const actions = t.voided_at
        ? `<span class="voided-tag" title="${escapeHtml(t.void_reason || "Voided")}">voided</span>`
        : `<button type="button" class="icon-btn edit-txn-btn" data-id="${t.id}" title="Edit this transaction" aria-label="Edit ${escapeHtml(t.symbol)} transaction">${ACTION_ICONS.edit}</button>
             <button type="button" class="delete-txn-btn" data-id="${t.id}" title="Void this transaction (kept for the audit trail, stops counting)">✕</button>`;
      return `
        <tr class="${t.voided_at ? "voided-row" : ""}">
          ${cells}
          <td class="actions-cell">${actions}</td>
        </tr>`;
    })
    .join("");
}

export function renderSummary(s) {
  if (!s || s.positionCount === 0) {
    return `<div class="summary-item"><span class="summary-label">No open positions</span></div>`;
  }

  // A missing quote makes market value UNKNOWN, not zero and not equal to
  // cost. Rendering an em dash rather than a number is the whole point: this
  // strip previously showed market value identical to cost basis and
  // unrealized of exactly $0.00 whenever prices had not been fetched, which
  // reads as a confident break-even rather than an absence.
  const unknown = s.totalValue == null;
  const partial = !unknown && s.unpricedCount > 0;

  const unrealClass = unknown ? "" : s.unrealizedPnl >= 0 ? "change-up" : "change-down";
  const realClass = s.realizedPnl >= 0 ? "change-up" : "change-down";
  const totalClass = s.totalReturn >= 0 ? "change-up" : "change-down";

  const valueCell = unknown
    ? `<span class="summary-value" title="No prices fetched yet — use Refresh Prices">—</span>`
    : `<span class="summary-value">${money(s.totalValue)}${
        partial ? `<span class="summary-label"> (${s.pricedCount}/${s.positionCount} priced)</span>` : ""
      }</span>`;

  const unrealCell = unknown
    ? `<span class="summary-value">—</span>`
    : `<span class="summary-value ${unrealClass}">${signedMoney(s.unrealizedPnl)}${
        s.unrealizedPnlPercent == null
          ? ""
          : ` (${s.unrealizedPnlPercent >= 0 ? "+" : ""}${s.unrealizedPnlPercent.toFixed(2)}%)`
      }</span>`;

  return `
    <div class="summary-item"><span class="summary-label">Positions</span><span class="summary-value">${s.positionCount}</span></div>
    <div class="summary-item"><span class="summary-label">Cost Basis</span><span class="summary-value">${money(s.totalCost)}</span></div>
    <div class="summary-item"><span class="summary-label">Market Value</span>${valueCell}</div>
    <div class="summary-item"><span class="summary-label">Unrealized</span>${unrealCell}</div>
    <div class="summary-item"><span class="summary-label">Realized</span><span class="summary-value ${realClass}">${signedMoney(s.realizedPnl)}</span></div>
    <div class="summary-item"><span class="summary-label">Dividends</span><span class="summary-value">${money(s.dividendIncome)}</span></div>
    <div class="summary-item"><span class="summary-label">Total Return</span><span class="summary-value ${totalClass}">${signedMoney(s.totalReturn)}${
      unknown ? '<span class="summary-label"> (realized only)</span>' : ""
    }</span></div>`;
}

export function renderSourceOptions(sources) {
  return (
    `<option value="">— none —</option>` +
    sources.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("")
  );
}

export function renderLotOptions(lots) {
  return (
    `<option value="">Oldest first (FIFO)</option>` +
    lots
      .map(
        (l) =>
          `<option value="${l.lot_id}">${escapeHtml(l.transaction_date)} · ${formatQty(l.quantity_remaining)} @ ${money(l.cost_per_share)}</option>`,
      )
      .join("")
  );
}

// --- shared sort/filter (same null-handling rules as the watchlist table) ---

export function sortRows(rows, sortKey, sortDir) {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1; // nulls always last
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
}

export function filterPositions(positions, query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return positions;
  return positions.filter(
    (p) =>
      p.symbol.toLowerCase().includes(q) || (p.security_name || "").toLowerCase().includes(q),
  );
}

// --- formatting -------------------------------------------------------------

function money(value) {
  if (value == null) return "—";
  const n = Number(value);
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function signedMoney(value) {
  if (value == null) return "—";
  const n = Number(value);
  return `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

function formatQty(value) {
  if (value == null) return "—";
  const n = Number(value);
  // Whole share counts shouldn't render as "100.0000".
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

function truncate(str, maxLen) {
  const s = str || "";
  return s.length > maxLen ? escapeHtml(`${s.slice(0, maxLen - 1)}…`) : escapeHtml(s || "—");
}

function priceTooltip(p) {
  if (p.last_price == null) return "No quote yet — click Refresh Prices.";
  return `Quote fetched: ${p.quote_fetched_at || "unknown"}\nPrev close: ${money(p.prev_close)}`;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
