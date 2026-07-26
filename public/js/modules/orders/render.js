// The "HTML" file for orders. Pure functions: data in, markup out.

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

export function renderPositionsRows(positions) {
  if (positions.length === 0) {
    return `<tr><td colspan="${POSITION_COLUMNS.length + 1}" class="empty-row">No open positions. Use "+ Log Order" to record a purchase.</td></tr>`;
  }
  return positions
    .map((p) => {
      const pnlClass = p.unrealized_pnl == null ? "" : p.unrealized_pnl >= 0 ? "change-up" : "change-down";
      return `
        <tr>
          <td><strong>${escapeHtml(p.symbol)}</strong></td>
          <td>${escapeHtml(p.security_name || "")}</td>
          <td>${escapeHtml(p.exchange_code || "—")}</td>
          <td>${formatQty(p.quantity_remaining)}</td>
          <td>${money(p.cost_per_share)}</td>
          <td>${money(p.cost_basis)}</td>
          <td title="${escapeHtml(priceTooltip(p))}">${money(p.last_price)}</td>
          <td>${money(p.market_value)}</td>
          <td class="${pnlClass}">${signedMoney(p.unrealized_pnl)}</td>
          <td class="${pnlClass}">${p.unrealized_pnl_percent == null ? "—" : `${p.unrealized_pnl_percent >= 0 ? "+" : ""}${p.unrealized_pnl_percent.toFixed(2)}%`}</td>
          <td title="Bought ${escapeHtml(p.transaction_date)}${p.source_name ? ` · via ${escapeHtml(p.source_name)}` : ""}">${p.days_held == null ? "—" : `${p.days_held}d`}</td>
          <td class="actions-cell">
            <button type="button" class="sell-lot-btn" data-symbol="${escapeHtml(p.symbol)}" data-lot-id="${p.lot_id}" data-qty="${p.quantity_remaining}" title="Sell from this lot">Sell</button>
            <button type="button" class="edit-txn-btn" data-id="${p.lot_id}" title="Correct this purchase">Edit</button>
          </td>
        </tr>`;
    })
    .join("");
}

export function renderHistoryRows(rows) {
  if (rows.length === 0) {
    return `<tr><td colspan="${HISTORY_COLUMNS.length + 1}" class="empty-row">No transactions match these filters.</td></tr>`;
  }
  return rows
    .map((t) => {
      const pnlClass = t.realized_pnl == null ? "" : t.realized_pnl >= 0 ? "change-up" : "change-down";
      return `
        <tr>
          <td>${escapeHtml(t.transaction_date)}</td>
          <td><strong>${escapeHtml(t.symbol)}</strong></td>
          <td><span class="type-pill type-txn-${t.transaction_type.toLowerCase()}">${escapeHtml(t.transaction_type)}</span></td>
          <td>${t.transaction_type === "DIVIDEND" ? "—" : formatQty(t.quantity)}</td>
          <td>${money(t.price)}</td>
          <td>${t.fees ? money(t.fees) : "—"}</td>
          <td>${money(t.total)}</td>
          <td class="${pnlClass}">${signedMoney(t.realized_pnl)}</td>
          <td>${escapeHtml(t.source_name || "—")}</td>
          <td class="actions-cell">
            <button type="button" class="edit-txn-btn" data-id="${t.id}" title="Edit this transaction">Edit</button>
            <button type="button" class="delete-txn-btn" data-id="${t.id}" title="Delete this transaction">✕</button>
          </td>
        </tr>`;
    })
    .join("");
}

export function renderSummary(s) {
  if (!s || s.positionCount === 0) {
    return `<div class="summary-item"><span class="summary-label">No open positions</span></div>`;
  }
  const unrealClass = s.unrealizedPnl >= 0 ? "change-up" : "change-down";
  const realClass = s.realizedPnl >= 0 ? "change-up" : "change-down";
  const totalClass = s.totalReturn >= 0 ? "change-up" : "change-down";
  return `
    <div class="summary-item"><span class="summary-label">Positions</span><span class="summary-value">${s.positionCount}</span></div>
    <div class="summary-item"><span class="summary-label">Cost Basis</span><span class="summary-value">${money(s.totalCost)}</span></div>
    <div class="summary-item"><span class="summary-label">Market Value</span><span class="summary-value">${money(s.totalValue)}</span></div>
    <div class="summary-item"><span class="summary-label">Unrealized</span><span class="summary-value ${unrealClass}">${signedMoney(s.unrealizedPnl)}${s.unrealizedPnlPercent == null ? "" : ` (${s.unrealizedPnlPercent >= 0 ? "+" : ""}${s.unrealizedPnlPercent.toFixed(2)}%)`}</span></div>
    <div class="summary-item"><span class="summary-label">Realized</span><span class="summary-value ${realClass}">${signedMoney(s.realizedPnl)}</span></div>
    <div class="summary-item"><span class="summary-label">Dividends</span><span class="summary-value">${money(s.dividendIncome)}</span></div>
    <div class="summary-item"><span class="summary-label">Total Return</span><span class="summary-value ${totalClass}">${signedMoney(s.totalReturn)}</span></div>`;
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
