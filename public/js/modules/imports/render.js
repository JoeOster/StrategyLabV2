// The "HTML" file for the Import tab. Pure functions: data in, markup out.
//
// The screen is shaped around what a monthly audit is actually for. Rows the
// broker agrees with are the boring majority and get a count, not a list. The
// two lists that matter are the trades you got WRONG and the trades you FORGOT.
const money = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

export function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

export function renderAccountOptions(accounts) {
  return accounts
    .map(
      (a) =>
        `<option value="${a.id}" ${a.has_parser ? "" : "disabled"}>${escapeHtml(a.label)}${
          a.has_parser ? "" : " — no CSV parser"
        }</option>`,
    )
    .join("");
}

/** "Latest imported: 2026-08-17" per account, with the advice that matters. */
export function renderCurrency(rows) {
  if (rows.length === 0) return "";
  return `
    <ul class="settings-list">
      ${rows
        .map(
          (r) => `
        <li>
          <div class="settings-row">
            <div class="settings-row-main">
              <strong>${escapeHtml(r.broker)} ${escapeHtml(r.account_number ?? "")}</strong>
              <span class="settings-row-meta">
                ${
                  r.latest_transaction_date
                    ? `latest imported: ${escapeHtml(r.latest_transaction_date)} — download from a week or so before this, overlapping is safe`
                    : "nothing imported yet"
                }
              </span>
            </div>
          </div>
        </li>`,
        )
        .join("")}
    </ul>`;
}

function warningBlock(warnings) {
  if (!warnings || warnings.length === 0) return "";
  return warnings
    .map(
      (w) => `
      <p class="status-banner status-error">
        ${escapeHtml(w.message)}
        ${w.symbols ? `<br /><strong>${escapeHtml(w.symbols.join(", "))}</strong>` : ""}
      </p>`,
    )
    .join("");
}

/**
 * The preview.
 *
 * Ordered by what needs a human: discrepancies first because they are why the
 * audit exists, then missing trades, then everything that already agreed.
 */
/**
 * Batches staged and never decided on.
 *
 * Staging writes the batch to the database while the preview lived only in the
 * browser's memory, so a reload left it stranded -- in the data, invisible in
 * the UI. This is the way back to one. It renders nothing at all when there is
 * nothing pending, rather than an empty panel saying so: a permanent "no
 * unfinished imports" heading is noise on every visit for a state that is
 * almost always true.
 */
export function renderPendingBatches(batches) {
  if (!batches || batches.length === 0) return "";
  return `
    <div class="status-banner status-warn pending-imports">
      <strong>${batches.length} unfinished import${batches.length === 1 ? "" : "s"}.</strong>
      Staged but never approved &mdash; nothing from ${batches.length === 1 ? "it" : "them"} is in your ledger yet.
      <ul class="pending-list">
        ${batches
          .map(
            (b) => `
          <li>
            <strong>${escapeHtml(b.broker_name)}${b.account_number ? ` ${escapeHtml(b.account_number)}` : ""}</strong>
            &mdash; ${escapeHtml(b.filename || "unnamed")}
            <span class="muted-cell">staged ${escapeHtml(String(b.imported_at).slice(0, 16))}</span>
            <br />
            <span class="muted-cell">
              ${b.new_rows} to add, ${b.duplicate_rows} already present${b.review_rows ? `, ${b.review_rows} needing review` : ""}
            </span>
            <button type="button" class="resume-batch-btn" data-batch-id="${b.id}">Review</button>
            <button type="button" class="discard-batch-btn" data-batch-id="${b.id}">Discard</button>
          </li>`,
          )
          .join("")}
      </ul>
    </div>`;
}

export function renderPreview(staged, discrepancies) {
  const c = staged.counts;

  const discrepancyRows = discrepancies.length
    ? discrepancies
        .map(
          (d) => `
        <li data-row-id="${d.rowId}">
          <div class="settings-row">
            <div class="settings-row-main">
              <strong>${escapeHtml(d.symbol)}</strong>
              <span class="settings-row-meta">
                ${escapeHtml(d.transactionType)} ${escapeHtml(d.transactionDate)} ·
                ${d.differences
                  .map(
                    (x) =>
                      `${escapeHtml(x.field)}: you <strong>${escapeHtml(
                        x.field === "transaction_date" ? x.ledger : money(x.ledger),
                      )}</strong> vs broker <strong>${escapeHtml(
                        x.field === "transaction_date" ? x.broker : money(x.broker),
                      )}</strong>`,
                  )
                  .join(" · ")}
              </span>
            </div>
            <div class="settings-row-actions">
              <button type="button" data-action="correct" data-row-id="${d.rowId}"
                      title="Replace your figures with the broker's">Use broker's</button>
            </div>
          </div>
        </li>`,
        )
        .join("")
    : `<li class="empty-row">Nothing disagrees. Your entries match the broker.</li>`;

  const dropped = staged.dropped ?? [];

  return `
    ${warningBlock(staged.warnings)}

    <div class="panel-head"><h2>Discrepancies</h2></div>
    <p class="panel-hint">
      Trades you recorded whose numbers differ from the statement. This is what the audit is for.
      Applying a correction also re-derives the realized P&amp;L of anything already sold from that lot.
    </p>
    <ul class="settings-list">${discrepancyRows}</ul>

    <div class="panel-head">
      <h2>Missing trades</h2>
      ${c.new > 0 ? `<button type="button" id="import-approve-btn" class="primary">Add all ${c.new}</button>` : ""}
    </div>
    <p class="panel-hint">
      On the statement but not in your journal — trades you did not record at the time.
    </p>
    <p class="panel-hint">
      <strong>${c.new}</strong> to add ·
      <strong>${c.matched + c.duplicate}</strong> already agree ·
      <strong>${dropped.length}</strong> dropped
      ${dropped.length ? `(${escapeHtml([...new Set(dropped.map((d) => d.symbol))].join(", "))} — no matching buy in the export window)` : ""}
    </p>

    <p class="panel-hint">Implied positions after import: ${
      Object.entries(staged.impliedPositions ?? {})
        .map(([sym, qty]) => `${escapeHtml(sym)} ${qty}`)
        .join(", ") || "none"
    }</p>`;
}
