// The "HTML" file for orders. Pure functions: data in, markup out.
import { money, signedMoney, formatQty, formatPrice } from "../shared/format.js";

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
  symbol: (p) => `<td><strong>${escapeHtml(p.symbol)}</strong>${accountBadge(p)}</td>`,
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

/**
 * Collapses a ticker's lots into one row, expandable to the individual
 * purchases -- the shape a broker statement uses, and for the same reason: at a
 * glance you want the holding, and on demand you want how you got it.
 *
 * The per-lot model stays underneath untouched. Each lot keeps its own entry
 * price, holding period and thesis, and every action still operates on a
 * specific lot -- the group row is a summary, not a new kind of thing. That is
 * why the actions live on the lot rows: selling, editing, and above all setting
 * an exit ladder are per-lot decisions, and a plan belongs to one entry thesis.
 * A group-level Exits button would quietly imply the lots share a plan.
 *
 * A single-lot ticker renders exactly as before, with no disclosure control --
 * an expander that reveals one row identical to the one above it is noise.
 */
export function renderPositionsRows(positions, columns, opts = {}) {
  const {
    showPromote = false,
    emptyMessage = 'No open positions. Use "+ Log Order" to record a purchase.',
    expanded = new Set(),
  } = opts;

  if (positions.length === 0) {
    return `<tr><td colspan="${columns.length + 1}" class="empty-row">${escapeHtml(emptyMessage)}</td></tr>`;
  }

  // Preserve the incoming order -- it is whatever the user sorted by.
  const groups = [];
  const byKey = new Map();
  for (const p of positions) {
    const key = p.security_id;
    if (!byKey.has(key)) {
      const g = { key, lots: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    byKey.get(key).lots.push(p);
  }

  return groups
    .map((g) => {
      if (g.lots.length === 1) return lotRow(g.lots[0], columns, showPromote, { indented: false });

      const isOpen = expanded.has(g.key);
      const summary = summariseLots(g.lots);
      const cells = columns
        .map((col) => (GROUP_CELL_RENDERERS[col.key] || (() => "<td></td>"))(summary, isOpen))
        .join("");

      const header = `
        <tr class="group-row${isOpen ? " group-open" : ""}" data-security-id="${g.key}">
          ${cells}
          <td class="actions-cell"></td>
        </tr>`;

      const children = isOpen
        ? g.lots.map((lot) => lotRow(lot, columns, showPromote, { indented: true })).join("")
        : "";

      return header + children;
    })
    .join("");
}

/**
 * A ticker's lots as one holding.
 *
 * Entry is the WEIGHTED average -- total cost over total shares -- not the mean
 * of the entry prices, which would misreport any position built in unequal
 * sizes. Unrealized is taken over priced lots only, so a partially-quoted
 * holding does not compare two different sets of shares.
 */
function summariseLots(lots) {
  const first = lots[0];
  const shares = lots.reduce((s, l) => s + l.quantity_remaining, 0);
  const cost = lots.reduce((s, l) => s + l.cost_basis, 0);
  const priced = lots.filter((l) => l.market_value != null);
  const value = priced.length ? priced.reduce((s, l) => s + l.market_value, 0) : null;
  const pricedCost = priced.reduce((s, l) => s + l.cost_basis, 0);
  const unrealized = value == null ? null : value - pricedCost;

  return {
    security_id: first.security_id,
    symbol: first.symbol,
    accountBadge: groupAccountBadge(lots),
    security_name: first.security_name,
    exchange_code: first.exchange_code,
    last_price: first.last_price,
    lotCount: lots.length,
    quantity_remaining: shares,
    cost_per_share: shares > 0 ? cost / shares : null,
    cost_basis: cost,
    market_value: value,
    unrealized_pnl: unrealized,
    unrealized_pnl_percent: unrealized != null && pricedCost > 0 ? (unrealized / pricedCost) * 100 : null,
    // Deliberately absent at group level: lots bought months apart have no
    // single holding period, and averaging days held invents a number.
    days_held: null,
  };
}

/**
 * A compact account marker for column one.
 *
 * Letter plus the last four digits, not a brokerage logo: real marks would mean
 * bundling trademarked images into a personal app for no functional gain, and
 * they would not solve the actual problem anyway. Both Fidelity accounts here
 * are Rollover IRAs -- a Fidelity logo on each would identify neither. The
 * NUMBER is what distinguishes them, so the number is what the badge leads on.
 *
 * Colour is derived from the brokerage so the eye can group rows without
 * reading, and the full label is in the title for when reading is needed.
 */
function accountBadge(p) {
  if (!p.broker_slug) return "";
  const last4 = p.account_number ? String(p.account_number).slice(-4) : "";
  const initial = (p.broker_name || p.broker_slug).charAt(0).toUpperCase();
  const full = `${escapeHtml(p.broker_name || p.broker_slug)}${p.account_number ? ` ${escapeHtml(p.account_number)}` : ""}`;
  return `<span class="acct-badge acct-${escapeHtml(p.broker_slug)}" title="${full}">${initial}${
    last4 ? `<span class="acct-num">${escapeHtml(last4)}</span>` : ""
  }</span>`;
}

/**
 * The badge for a consolidated row.
 *
 * When a holding spans accounts -- RKLB sits in both Fidelity IRAs -- one badge
 * would be a lie and several would crowd the cell, so it says how many and
 * names them on hover. Expanding shows which lot is where.
 */
function groupAccountBadge(lots) {
  const distinct = [...new Map(lots.filter((l) => l.broker_slug).map((l) => [l.account_number ?? l.broker_slug, l])).values()];
  if (distinct.length === 0) return "";
  if (distinct.length === 1) return accountBadge(distinct[0]);
  const names = distinct
    .map((l) => `${l.broker_name}${l.account_number ? ` ${l.account_number}` : ""}`)
    .join(", ");
  return `<span class="acct-badge acct-multi" title="Held across: ${escapeHtml(names)}">${distinct.length} accts</span>`;
}

const GROUP_CELL_RENDERERS = {
  symbol: (g, isOpen) => `
    <td>
      <button type="button" class="group-toggle" data-security-id="${g.security_id}"
              aria-expanded="${isOpen}"
              title="${isOpen ? "Hide" : "Show"} the ${g.lotCount} purchases behind this holding">
        <span class="group-caret">${isOpen ? "\u25BE" : "\u25B8"}</span><strong>${escapeHtml(g.symbol)}</strong>
      </button>${g.accountBadge}
    </td>`,
  security_name: (g) => `<td>${escapeHtml(g.security_name || "")}</td>`,
  exchange_code: (g) => `<td>${escapeHtml(g.exchange_code || "—")}</td>`,
  quantity_remaining: (g) => `<td>${formatQty(g.quantity_remaining)}</td>`,
  cost_per_share: (g) => `<td title="Weighted average across ${g.lotCount} lots">${formatPrice(g.cost_per_share)}</td>`,
  cost_basis: (g) => `<td>${money(g.cost_basis)}</td>`,
  last_price: (g) => `<td class="price-cell">${formatPrice(g.last_price)}</td>`,
  market_value: (g) => `<td>${money(g.market_value)}</td>`,
  unrealized_pnl: (g) =>
    `<td class="${g.unrealized_pnl == null ? "" : g.unrealized_pnl >= 0 ? "change-up" : "change-down"}">${signedMoney(g.unrealized_pnl)}</td>`,
  unrealized_pnl_percent: (g) =>
    `<td class="${g.unrealized_pnl_percent == null ? "" : g.unrealized_pnl_percent >= 0 ? "change-up" : "change-down"}">${
      g.unrealized_pnl_percent == null
        ? "—"
        : `${g.unrealized_pnl_percent >= 0 ? "+" : ""}${g.unrealized_pnl_percent.toFixed(2)}%`
    }</td>`,
  days_held: (g) => `<td class="muted-cell">${g.lotCount} lots</td>`,
};

/** One purchase. Unchanged from before, except it can be shown as a child. */
function lotRow(p, columns, showPromote, { indented }) {
  const cells = columns
    .map((col) => (POSITION_CELL_RENDERERS[col.key] || (() => "<td>—</td>"))(p))
    .join("");
  return `
    <tr class="${indented ? "lot-row" : ""}">
      ${cells}
      <td class="actions-cell">
        ${showPromote ? `<button type="button" class="icon-btn promote-txn-btn" data-id="${p.lot_id}" data-symbol="${escapeHtml(p.symbol)}" title="Promote to a real purchase" aria-label="Promote ${escapeHtml(p.symbol)} to a real purchase">${ACTION_ICONS.promote}</button>` : ""}
        <button type="button" class="icon-btn sell-lot-btn" data-symbol="${escapeHtml(p.symbol)}" data-lot-id="${p.lot_id}" data-qty="${p.quantity_remaining}" title="Sell from this lot" aria-label="Sell ${escapeHtml(p.symbol)}">${ACTION_ICONS.sell}</button>
        <button type="button" class="icon-btn exits-btn" data-id="${p.lot_id}" data-symbol="${escapeHtml(p.symbol)}" title="Exit plan: take-profit and stop rungs" aria-label="Exit plan for ${escapeHtml(p.symbol)}">${ACTION_ICONS.exits}</button>
        <button type="button" class="icon-btn edit-txn-btn" data-id="${p.lot_id}" title="Correct this purchase" aria-label="Edit ${escapeHtml(p.symbol)} purchase">${ACTION_ICONS.edit}</button>
      </td>
    </tr>`;
}

/**
 * Totals row for the positions table.
 *
 * Sums the rows CURRENTLY DISPLAYED, not the whole portfolio -- so it responds
 * to the ticker filter as well as the account scope. A footer that ignored the
 * filter above it would contradict the rows it sits under, which is worse than
 * having no footer.
 *
 * Only genuinely additive columns get a total. Averaging an entry price across
 * different lot sizes, or summing a percentage, produces a number that looks
 * meaningful and is not.
 */
export function renderPositionsFooter(positions, columns) {
  if (positions.length === 0) return "";

  const sum = (fn) => positions.reduce((acc, p) => acc + (fn(p) ?? 0), 0);
  const anyPriced = positions.some((p) => p.market_value != null);

  const totalCost = sum((p) => p.cost_basis);
  const totalValue = anyPriced ? sum((p) => p.market_value) : null;
  // Only over priced rows, or the percentage compares different sets.
  const pricedCost = positions.filter((p) => p.market_value != null).reduce((a, p) => a + p.cost_basis, 0);
  const totalUnreal = anyPriced ? totalValue - pricedCost : null;
  const pct = anyPriced && pricedCost > 0 ? (totalUnreal / pricedCost) * 100 : null;

  const TOTALS = {
    symbol: () => `<td><strong>Total</strong></td>`,
    quantity_remaining: () => `<td></td>`,
    cost_basis: () => `<td><strong>${money(totalCost)}</strong></td>`,
    market_value: () => `<td><strong>${money(totalValue)}</strong></td>`,
    unrealized_pnl: () =>
      `<td class="${totalUnreal == null ? "" : totalUnreal >= 0 ? "change-up" : "change-down"}"><strong>${signedMoney(totalUnreal)}</strong></td>`,
    unrealized_pnl_percent: () =>
      `<td class="${pct == null ? "" : pct >= 0 ? "change-up" : "change-down"}"><strong>${
        pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`
      }</strong></td>`,
  };

  const cells = columns.map((col) => (TOTALS[col.key] || (() => "<td></td>"))()).join("");
  return `<tr class="totals-row">${cells}<td></td></tr>`;
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
    <div class="summary-item"><span class="summary-label">Positions</span><span class="summary-value">${s.positionCount}${s.lotCount > s.positionCount ? `<span class="summary-label"> in ${s.lotCount} lots</span>` : ""}</span></div>
    <div class="summary-item"><span class="summary-label">Cost Basis</span><span class="summary-value">${money(s.totalCost)}</span></div>
    <div class="summary-item"><span class="summary-label">Market Value</span>${valueCell}</div>
    <div class="summary-item"><span class="summary-label" title="On current holdings only — this is the figure comparable to a broker’s total gain/loss.">Unrealized</span>${unrealCell}</div>
    ${
      // Cash and account total only appear for a single account: summing
      // balances across accounts gives a figure no statement shows.
      s.cash == null
        ? ""
        : `<div class="summary-item"><span class="summary-label"${
            s.cashIsDerived
              ? ' title="Derived from the trade ledger — no opening balance recorded, so this assumes the account began empty and every movement since is imported."'
              : ""
          }>Cash${s.cashIsDerived ? " *" : ""}</span><span class="summary-value">${money(s.cash)}</span></div>` +
          `<div class="summary-item"><span class="summary-label" title="Positions plus cash. Shown only when every position is priced — a total built on a partial market value would be a fragment with a confident label.">Account Total</span><span class="summary-value">${money(s.accountTotal)}</span></div>`
    }
    <div class="summary-item"><span class="summary-label">Realized</span><span class="summary-value ${realClass}">${signedMoney(s.realizedPnl)}</span></div>
    <div class="summary-item"><span class="summary-label">Dividends</span><span class="summary-value">${money(s.dividendIncome)}</span></div>
    <div class="summary-item"><span class="summary-label" title="Realized + dividends + unrealized. A broker’s “total gain/loss” is usually unrealized only, so these will not match.">Total Return</span><span class="summary-value ${totalClass}">${signedMoney(s.totalReturn)}${
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
