// The Import tab: the monthly audit.
//
// Import is an AUDIT, not a loader. Manual entry is the primary path, so most
// rows in a statement are trades already recorded and the job is finding the
// ones that are missing or wrong. The screen is ordered accordingly:
// discrepancies first, missing trades second, agreement as a count.
//
// Files are read in the browser and posted as text. The app runs on express and
// yahoo-finance2 and nothing else -- a multipart parser would be a third
// dependency for something FileReader already does.
import * as api from "./api.js";
import { renderPreview, renderAccountOptions, renderCurrency } from "./render.js";

const els = {};
let onDataChanged = () => {};
let staged = null;

export async function initializeImportsModule({ onChange = () => {} } = {}) {
  onDataChanged = onChange;
  els.accountSelect = document.getElementById("import-account");
  els.fileInput = document.getElementById("import-files");
  els.uploadBtn = document.getElementById("import-upload-btn");
  els.preview = document.getElementById("import-preview");
  els.banner = document.getElementById("import-banner");
  els.currency = document.getElementById("import-currency");

  els.uploadBtn.addEventListener("click", handleUpload);
  els.preview.addEventListener("click", handlePreviewAction);
  els.fileInput.addEventListener("change", suggestAccountFromFilename);

  await reloadImportsView();
}

export async function reloadImportsView() {
  const [accounts, currency] = await Promise.all([api.fetchAccounts(), api.fetchLatestImported()]);
  els.accountSelect.innerHTML = renderAccountOptions(accounts);
  els.currency.innerHTML = renderCurrency(currency);
}

function banner(message, isError) {
  els.banner.textContent = message;
  els.banner.classList.toggle("status-error", Boolean(isError));
  els.banner.hidden = false;
  if (!isError) setTimeout(() => (els.banner.hidden = true), 5000);
}

/**
 * Picks the account from the filename where it is unambiguous.
 *
 * A Fidelity export is literally named History_for_Account_266356256.csv, which
 * is the reason account_number stopped living inside the nickname. Only sets
 * the field when exactly one account matches -- attaching a statement to the
 * wrong account would misfile every trade in it, so a guess is worse than
 * leaving it to the user.
 */
async function suggestAccountFromFilename() {
  const file = els.fileInput.files?.[0];
  if (!file) return;
  const match = await api.matchAccount(file.name).catch(() => null);
  if (match?.id) {
    els.accountSelect.value = String(match.id);
    banner(`Matched ${file.name} to ${match.label}.`);
  }
}

async function handleUpload() {
  const accountId = Number(els.accountSelect.value);
  const files = [...(els.fileInput.files ?? [])];
  if (!accountId) return banner("Choose an account.", true);
  if (files.length === 0) return banner("Choose at least one file.", true);

  els.uploadBtn.disabled = true;
  els.preview.innerHTML = `<p class="panel-hint">Reading…</p>`;
  try {
    // Read all of them and stage together. The two Fidelity IRA exports
    // overlap, and a sell in the second is often covered by a buy in the
    // first -- staging them separately orphans those sells and the drop policy
    // then discards real trades.
    const payload = await Promise.all(
      files.map(async (f) => ({ filename: f.name, text: await f.text() })),
    );
    staged = await api.stageImport(accountId, payload);
    const discrepancies = await api.fetchDiscrepancies(staged.batch.id);
    els.preview.innerHTML = renderPreview(staged, discrepancies);
    banner(`Staged ${staged.batch.row_count} row(s). Nothing has been written yet.`);
  } catch (err) {
    els.preview.innerHTML = "";
    banner(err.message, true);
  } finally {
    els.uploadBtn.disabled = false;
  }
}

async function handlePreviewAction(event) {
  const btn = event.target.closest("button[data-action], #import-approve-btn");
  if (!btn || !staged) return;

  try {
    if (btn.id === "import-approve-btn") {
      const result = await api.approveBatch(staged.batch.id);
      banner(
        `Added ${result.written.length} trade(s)` +
          (result.skippedDuplicates.length ? `, skipped ${result.skippedDuplicates.length} already present` : "") +
          ".",
      );
    } else if (btn.dataset.action === "correct") {
      const result = await api.applyCorrection(staged.batch.id, Number(btn.dataset.rowId));
      banner(
        `Corrected ${result.symbol}: ` +
          result.applied.map((a) => `${a.field} ${a.ledger} → ${a.broker}`).join(", ") +
          ".",
      );
    } else {
      return;
    }

    // Re-read rather than mutate the DOM: the counts, the discrepancy list and
    // the implied positions all move together after either action.
    const discrepancies = await api.fetchDiscrepancies(staged.batch.id);
    const preview = await api.fetchBatch(staged.batch.id);
    staged = { ...staged, counts: preview.counts };
    els.preview.innerHTML = renderPreview(staged, discrepancies);
    await reloadImportsView();
    onDataChanged();
  } catch (err) {
    banner(err.message, true);
  }
}
