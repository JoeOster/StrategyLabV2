// The "HTML" file for settings. Pure functions: data in, markup out.

export const SOURCE_TYPE_LABELS = {
  person: "Person",
  group: "Group",
  book: "Book",
  website: "Website",
};

// The "Name" field means something different per type, so the label changes
// with the dropdown rather than staying a generic "Name".
export const SOURCE_NAME_LABELS = {
  person: "Person's name",
  group: "Group name",
  book: "Book title",
  website: "Site name",
};

export function renderListsPanel(watchlists) {
  if (watchlists.length === 0) {
    return `<li class="empty-row">No lists yet.</li>`;
  }
  // The virtual "Orders" list is system-managed -- show it so its existence
  // is explained, but offer no actions on it.
  const realCount = watchlists.filter((wl) => !wl.is_virtual).length;
  return watchlists
    .map(
      (wl, index) => `
      <li data-id="${wl.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(wl.name)}</strong>
            ${wl.is_virtual ? '<span class="type-pill type-watch">Automatic</span>' : ""}
            <span class="settings-row-meta">${wl.item_count} item(s)${wl.is_virtual ? " · every ticker you currently hold" : ""}</span>
          </div>
          <div class="settings-row-actions">
            ${
              wl.is_virtual
                ? ""
                : `<button type="button" data-action="move-up" data-id="${wl.id}" ${index === 0 ? "disabled" : ""} title="Move up">↑</button>
                   <button type="button" data-action="move-down" data-id="${wl.id}" ${index === realCount - 1 ? "disabled" : ""} title="Move down">↓</button>
                   <button type="button" data-action="rename" data-id="${wl.id}">Rename</button>
                   <button type="button" data-action="delete" data-id="${wl.id}" class="link-danger">Delete</button>`
            }
          </div>
        </div>
      </li>`,
    )
    .join("");
}

export function renderSourcesPanel(sources) {
  if (sources.length === 0) {
    return `<li class="empty-row">No advice sources yet. Add the books, people or sites your ideas come from.</li>`;
  }
  return sources
    .map(
      (s) => `
      <li data-id="${s.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(s.name)}</strong>
            <span class="type-pill type-source-${s.type}">${escapeHtml(SOURCE_TYPE_LABELS[s.type] || s.type)}</span>
            <span class="settings-row-meta">${s.watched_count} idea(s)${s.description ? ` · ${escapeHtml(truncate(s.description, 70))}` : ""}</span>
          </div>
          <div class="settings-row-actions">
            <button type="button" data-action="edit" data-id="${s.id}">Edit</button>
            <button type="button" data-action="delete" data-id="${s.id}" class="link-danger">Delete</button>
          </div>
        </div>
      </li>`,
    )
    .join("");
}

export function renderHoldersPanel(holders) {
  return holders
    .map(
      (h) => `
      <li data-id="${h.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(h.name)}</strong>
            ${h.is_default ? '<span class="type-pill type-watch">Default</span>' : ""}
            <span class="settings-row-meta">${h.list_count} list(s) · ${h.watched_count} item(s)</span>
          </div>
          <div class="settings-row-actions">
            ${h.is_default ? "" : `<button type="button" data-action="make-default" data-id="${h.id}">Make default</button>`}
            <button type="button" data-action="rename" data-id="${h.id}">Rename</button>
            <button type="button" data-action="delete" data-id="${h.id}" class="link-danger">Delete</button>
          </div>
        </div>
      </li>`,
    )
    .join("");
}

export function renderExchangesPanel(exchanges) {
  if (exchanges.length === 0) {
    return `<li class="empty-row">No exchanges yet.</li>`;
  }
  return exchanges
    .map(
      (e) => `
      <li data-id="${e.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(e.code)}</strong>
            <span class="settings-row-meta">${escapeHtml(e.name)} · ${e.security_count} ticker(s)</span>
          </div>
          <div class="settings-row-actions">
            <button type="button" data-action="delete" data-id="${e.id}" class="link-danger">Delete</button>
          </div>
        </div>
      </li>`,
    )
    .join("");
}

/**
 * @param {Array<{id: string, label: string, visibleCount: number, totalCount: number}>} tables
 */
export function renderColumnsPanel(tables) {
  return tables
    .map(
      (t) => `
      <li data-table-id="${t.id}">
        <div class="settings-row">
          <div class="settings-row-main">
            <strong>${escapeHtml(t.label)}</strong>
            <span class="settings-row-meta">${t.visibleCount} of ${t.totalCount} columns shown</span>
          </div>
          <div class="settings-row-actions">
            <button type="button" data-action="configure-columns" data-table-id="${t.id}">Configure Columns</button>
          </div>
        </div>
      </li>`,
    )
    .join("");
}

function truncate(str, max) {
  const s = String(str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
