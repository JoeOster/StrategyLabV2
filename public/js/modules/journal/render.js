// The "HTML" file for Journal. Pure functions: data in, markup out.
// Ideas and strategies are relatively few, text-heavy rows (notes, chapter,
// page number) rather than a dense trading table -- rendered as settings-row
// style lists (matching public/js/modules/settings/render.js) instead of a
// sortable <table>, since that shape fits this data better.

export const ORDER_TYPE_LABELS = {
  WATCH: "Watching",
  BUY_LIMIT: "Buy Limit",
  SELL_LIMIT: "Sell Limit",
};

export function orderTypeLabel(orderType) {
  return ORDER_TYPE_LABELS[orderType] || orderType;
}

function targetText(idea) {
  if (idea.order_type === "WATCH") return "Watching";
  const target = idea.order_type === "BUY_LIMIT" ? idea.buy_price_high : idea.take_profit_low;
  const label = idea.order_type === "BUY_LIMIT" ? "Buy ≤" : "Sell ≥";
  return `${label} ${target != null ? `$${target}` : "—"}`;
}

export function renderIdeasList(ideas) {
  if (ideas.length === 0) {
    return `<li class="empty-row">No ideas yet. Use "+ New Idea" to log one against a source or strategy.</li>`;
  }
  return ideas
    .map((idea) => {
      const canExecute = idea.status === "WATCHING" || idea.status === "ALERT";
      const strategyLocation = [idea.strategy_chapter, idea.strategy_page_number != null ? `p.${idea.strategy_page_number}` : null]
        .filter(Boolean)
        .join(" · ");
      const strategyText = idea.strategy_title
        ? `${escapeHtml(idea.strategy_title)}${strategyLocation ? ` (${escapeHtml(strategyLocation)})` : ""}`
        : null;
      return `
      <li data-id="${idea.id}" class="status-${idea.status.toLowerCase()}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(idea.symbol)}</strong>
            <span class="type-pill type-${idea.order_type.toLowerCase()}">${escapeHtml(orderTypeLabel(idea.order_type))}</span>
            <span class="status-pill">${escapeHtml(idea.status)}</span>
            <span class="settings-row-meta">
              ${targetText(idea)}
              ${idea.source_name ? ` · via ${escapeHtml(idea.source_name)}` : ""}
              ${strategyText ? ` · ${strategyText}` : ""}
              ${idea.notes ? ` · ${escapeHtml(truncate(idea.notes, 60))}` : ""}
            </span>
          </div>
          <div class="settings-row-actions">
            ${canExecute ? `<button type="button" data-action="execute" data-id="${idea.id}" class="primary">Execute</button>` : ""}
            <button type="button" data-action="remove" data-id="${idea.id}" class="link-danger">Remove</button>
          </div>
        </div>
      </li>`;
    })
    .join("");
}

export function renderStrategiesList(strategies) {
  if (strategies.length === 0) {
    return `<li class="empty-row">No strategies yet. A strategy is a named idea (e.g. "Buy the dip") that can come from more than one source.</li>`;
  }
  return strategies
    .map(
      (st) => `
      <li data-id="${st.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(st.title)}</strong>
            <span class="settings-row-meta">
              ${st.source_names ? `via ${escapeHtml(st.source_names)}` : "no sources tagged"}
              · ${st.idea_count} idea(s)
            </span>
          </div>
          <div class="settings-row-actions">
            <button type="button" data-action="edit" data-id="${st.id}">Edit</button>
            <button type="button" data-action="delete" data-id="${st.id}" class="link-danger">Delete</button>
          </div>
        </div>
      </li>`,
    )
    .join("");
}

// Rows inside the Strategy dialog's "Sources" sub-list. Each entry is either
// pending (not yet saved -- part of a strategy still being created, removable
// only from local state) or persisted (has a linkId, removable via its own
// API call). Both shapes are unified by index.js before this is called, so
// this stays a pure render function either way.
export function renderStrategySourceRows(sources) {
  if (sources.length === 0) {
    return `<li class="empty-row">No sources tagged yet -- add at least one below.</li>`;
  }
  return sources
    .map((tag) => {
      const detail = [tag.chapter, tag.pageNumber != null ? `p.${tag.pageNumber}` : null]
        .filter(Boolean)
        .map(escapeHtml)
        .join(" · ");
      return `
      <li data-key="${escapeHtml(tag.key)}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(tag.sourceName)}</strong>
            ${detail ? `<span class="settings-row-meta">${detail}</span>` : ""}
            ${tag.notes ? `<span class="settings-row-meta">${escapeHtml(tag.notes)}</span>` : ""}
          </div>
          <div class="settings-row-actions">
            <button type="button" data-action="remove-strategy-source" data-key="${escapeHtml(tag.key)}" class="link-danger">Remove</button>
          </div>
        </div>
      </li>`;
    })
    .join("");
}

export function renderSourceOptions(sources, selectedId, placeholder = "— select a source —") {
  return (
    `<option value="">${escapeHtml(placeholder)}</option>` +
    sources
      .map((s) => `<option value="${s.id}"${s.id === selectedId ? " selected" : ""}>${escapeHtml(s.name)}</option>`)
      .join("")
  );
}

export function renderStrategyOptions(strategies, selectedId) {
  return (
    `<option value="">— none —</option>` +
    strategies
      .map(
        (st) =>
          `<option value="${st.id}"${st.id === selectedId ? " selected" : ""}>${escapeHtml(st.title)}</option>`,
      )
      .join("")
  );
}

function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
