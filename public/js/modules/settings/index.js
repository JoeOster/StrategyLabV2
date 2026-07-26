// The "Conductor" for the Settings view. Owns which panel is active and
// wires listeners; delegates markup to render.js and server calls to api.js.
import * as api from "./api.js";
import {
  renderListsPanel,
  renderSourcesPanel,
  renderHoldersPanel,
  renderExchangesPanel,
  SOURCE_NAME_LABELS,
} from "./render.js";
import { sourceFormToPayload, sourceToFormValues, generalFormToPayload } from "./handlers.js";

const state = {
  activePanel: "lists",
  watchlists: [],
};

const els = {};
let onDataChanged = () => {};

export async function initializeSettingsModule({ onChange } = {}) {
  onDataChanged = onChange || (() => {});

  els.tabs = document.getElementById("settings-tabs");
  els.banner = document.getElementById("settings-banner");
  els.panels = [...document.querySelectorAll(".settings-panel")];
  els.lists = document.getElementById("settings-lists");
  els.sources = document.getElementById("settings-sources");
  els.holders = document.getElementById("settings-holders");
  els.exchanges = document.getElementById("settings-exchanges");
  els.generalForm = document.getElementById("general-settings-form");

  els.addListBtn = document.getElementById("settings-add-list-btn");
  els.addSourceBtn = document.getElementById("settings-add-source-btn");
  els.addHolderBtn = document.getElementById("settings-add-holder-btn");
  els.addExchangeBtn = document.getElementById("settings-add-exchange-btn");

  els.sourceDialog = document.getElementById("source-dialog");
  els.sourceForm = document.getElementById("source-form");
  els.sourceTypeSelect = document.getElementById("source-type-select");
  els.sourceNameLabel = document.getElementById("source-name-label");
  els.sourceDialogTitle = document.getElementById("source-dialog-title");
  els.sourceCancelBtn = document.getElementById("source-cancel-btn");
  els.sourcePanels = [...document.querySelectorAll(".source-panel")];

  els.promptDialog = document.getElementById("prompt-dialog");
  els.promptForm = document.getElementById("prompt-form");
  els.promptTitle = document.getElementById("prompt-title");
  els.promptLabel = document.getElementById("prompt-label");
  els.promptInput = document.getElementById("prompt-input");
  els.promptCancelBtn = document.getElementById("prompt-cancel-btn");

  els.confirmDialog = document.getElementById("confirm-dialog");
  els.confirmTitle = document.getElementById("confirm-title");
  els.confirmMessage = document.getElementById("confirm-message");
  els.confirmOkBtn = document.getElementById("confirm-ok-btn");
  els.confirmCancelBtn = document.getElementById("confirm-cancel-btn");

  els.tabs.addEventListener("click", handleTabClick);
  els.lists.addEventListener("click", handleListsAction);
  els.sources.addEventListener("click", handleSourcesAction);
  els.holders.addEventListener("click", handleHoldersAction);
  els.exchanges.addEventListener("click", handleExchangesAction);

  els.addListBtn.addEventListener("click", handleAddList);
  els.addSourceBtn.addEventListener("click", () => openSourceDialog(null));
  els.addHolderBtn.addEventListener("click", handleAddHolder);
  els.addExchangeBtn.addEventListener("click", handleAddExchange);

  els.sourceTypeSelect.addEventListener("change", updateSourcePanels);
  els.sourceCancelBtn.addEventListener("click", () => els.sourceDialog.close());
  els.sourceForm.addEventListener("submit", handleSourceSubmit);
  els.generalForm.addEventListener("submit", handleGeneralSubmit);

  await refreshActivePanel();
}

/** Called when the Settings view becomes visible, so data is never stale. */
export async function refreshSettingsView() {
  await refreshActivePanel();
}

function banner(message, isError) {
  if (!message) {
    els.banner.hidden = true;
    return;
  }
  els.banner.hidden = false;
  els.banner.textContent = message;
  els.banner.className = `status-banner ${isError ? "status-error" : "status-success"}`;
}

async function handleTabClick(event) {
  const tab = event.target.closest(".tab[data-panel]");
  if (!tab) return;
  state.activePanel = tab.dataset.panel;
  els.tabs.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  els.panels.forEach((p) => (p.hidden = p.dataset.panel !== state.activePanel));
  await refreshActivePanel();
}

async function refreshActivePanel() {
  banner(null);
  try {
    switch (state.activePanel) {
      case "lists": {
        state.watchlists = await api.fetchWatchlists();
        els.lists.innerHTML = renderListsPanel(state.watchlists);
        break;
      }
      case "sources":
        els.sources.innerHTML = renderSourcesPanel(await api.fetchSources());
        break;
      case "holders":
        els.holders.innerHTML = renderHoldersPanel(await api.fetchHolders());
        break;
      case "exchanges":
        els.exchanges.innerHTML = renderExchangesPanel(await api.fetchExchanges());
        break;
      case "general": {
        const settings = await api.fetchGeneralSettings();
        for (const [key, value] of Object.entries(settings)) {
          const field = els.generalForm.elements[key];
          if (field) field.value = value;
        }
        break;
      }
    }
  } catch (err) {
    banner(err.message, true);
  }
}

// --- Lists ------------------------------------------------------------------

async function handleAddList() {
  const name = await promptFor("New list", "List name");
  if (!name) return;
  await run(() => api.createWatchlist(name), `List "${name}" created.`);
}

async function handleListsAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const list = state.watchlists.find((w) => w.id === id);

  switch (btn.dataset.action) {
    case "rename": {
      const name = await promptFor("Rename list", "List name", list?.name);
      if (!name) return;
      return run(() => api.renameWatchlist(id, name), "List renamed.");
    }
    case "delete": {
      const ok = await confirmAction(
        "Delete list",
        list?.item_count
          ? `"${list.name}" still has ${list.item_count} item(s). Delete the list and all of its items?`
          : `Delete "${list?.name}"?`,
      );
      if (!ok) return;
      // deleteItems is only meaningful when the list is non-empty; passing it
      // unconditionally keeps the call site simple and is harmless otherwise.
      return run(() => api.deleteWatchlist(id, { deleteItems: true }), "List deleted.");
    }
    case "move-up":
    case "move-down": {
      const ids = state.watchlists.map((w) => w.id);
      const index = ids.indexOf(id);
      const swapWith = btn.dataset.action === "move-up" ? index - 1 : index + 1;
      if (swapWith < 0 || swapWith >= ids.length) return;
      [ids[index], ids[swapWith]] = [ids[swapWith], ids[index]];
      return run(() => api.reorderWatchlists(ids), null);
    }
  }
}

// --- Sources ----------------------------------------------------------------

function updateSourcePanels() {
  const type = els.sourceTypeSelect.value;
  els.sourcePanels.forEach((panel) => (panel.hidden = panel.dataset.sourcePanel !== type));
  els.sourceNameLabel.textContent = SOURCE_NAME_LABELS[type] || "Name";
}

async function openSourceDialog(sourceId) {
  els.sourceForm.reset();
  els.sourceForm.elements.id.value = "";
  els.sourceDialogTitle.textContent = sourceId ? "Edit Source" : "New Source";

  if (sourceId) {
    try {
      const source = await api.fetchSource(sourceId);
      const values = sourceToFormValues(source);
      for (const [key, value] of Object.entries(values)) {
        const field = els.sourceForm.elements[key];
        if (field) field.value = value;
      }
    } catch (err) {
      return banner(err.message, true);
    }
  }
  updateSourcePanels();
  els.sourceDialog.showModal();
}

async function handleSourceSubmit(event) {
  event.preventDefault();
  const formData = new FormData(els.sourceForm);
  const id = formData.get("id");
  const payload = sourceFormToPayload(formData);
  try {
    if (id) await api.updateSource(Number(id), payload);
    else await api.createSource(payload);
    els.sourceDialog.close();
    await refreshActivePanel();
    banner(id ? "Source updated." : "Source created.", false);
    onDataChanged();
  } catch (err) {
    banner(err.message, true);
  }
}

async function handleSourcesAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  if (btn.dataset.action === "edit") return openSourceDialog(id);
  if (btn.dataset.action === "delete") {
    const ok = await confirmAction(
      "Delete source",
      "Delete this source? Any watchlist items linked to it will stay, but lose the link.",
    );
    if (!ok) return;
    return run(() => api.deleteSource(id), "Source deleted.");
  }
}

// --- Holders ----------------------------------------------------------------

async function handleAddHolder() {
  const name = await promptFor("New account holder", "Name");
  if (!name) return;
  await run(() => api.createHolder(name), `Holder "${name}" added.`);
}

async function handleHoldersAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  switch (btn.dataset.action) {
    case "rename": {
      const name = await promptFor("Rename holder", "Name");
      if (!name) return;
      return run(() => api.renameHolder(id, name), "Holder renamed.");
    }
    case "make-default":
      return run(() => api.makeHolderDefault(id), "Default holder changed.");
    case "delete": {
      const ok = await confirmAction(
        "Delete account holder",
        "This removes the holder and everything they own — lists, watched items, accounts and transactions. This cannot be undone.",
      );
      if (!ok) return;
      return run(() => api.deleteHolder(id), "Holder deleted.");
    }
  }
}

// --- Exchanges --------------------------------------------------------------

async function handleAddExchange() {
  const code = await promptFor("New exchange", "Code (e.g. NASDAQ)");
  if (!code) return;
  await run(() => api.createExchange({ code, name: code }), `Exchange ${code} added.`);
}

async function handleExchangesAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn || btn.dataset.action !== "delete") return;
  const ok = await confirmAction(
    "Delete exchange",
    "Tickers assigned to this exchange will keep working, but lose their exchange link.",
  );
  if (!ok) return;
  await run(() => api.deleteExchange(Number(btn.dataset.id)), "Exchange deleted.");
}

// --- General ----------------------------------------------------------------

async function handleGeneralSubmit(event) {
  event.preventDefault();
  const payload = generalFormToPayload(new FormData(els.generalForm));
  try {
    const result = await api.saveGeneralSettings(payload);
    banner("Settings saved.", false);
    document.getElementById("app-title").textContent = result.settings.app_title;
    onDataChanged();
  } catch (err) {
    banner(err.message, true);
  }
}

// --- Shared helpers ---------------------------------------------------------

/** Runs an API call, refreshes the panel, and reports success or failure. */
async function run(fn, successMessage) {
  try {
    await fn();
    await refreshActivePanel();
    if (successMessage) banner(successMessage, false);
    onDataChanged();
  } catch (err) {
    banner(err.message, true);
  }
}

// Promise-wrapped <dialog> replacements for window.prompt/confirm, which are
// blocked or styled inconsistently in some browsers and can't be themed.
function promptFor(title, label, initialValue = "") {
  els.promptTitle.textContent = title;
  els.promptLabel.textContent = label;
  els.promptInput.value = initialValue;

  return new Promise((resolve) => {
    function cleanup(result) {
      els.promptForm.removeEventListener("submit", onSubmit);
      els.promptCancelBtn.removeEventListener("click", onCancel);
      els.promptDialog.removeEventListener("close", onCancel);
      els.promptDialog.close();
      resolve(result);
    }
    const onSubmit = (e) => {
      e.preventDefault();
      cleanup(els.promptInput.value.trim() || null);
    };
    const onCancel = () => cleanup(null);

    els.promptForm.addEventListener("submit", onSubmit);
    els.promptCancelBtn.addEventListener("click", onCancel);
    els.promptDialog.addEventListener("close", onCancel);
    els.promptDialog.showModal();
    els.promptInput.focus();
  });
}

function confirmAction(title, message) {
  els.confirmTitle.textContent = title;
  els.confirmMessage.textContent = message;

  return new Promise((resolve) => {
    function cleanup(result) {
      els.confirmOkBtn.removeEventListener("click", onOk);
      els.confirmCancelBtn.removeEventListener("click", onCancel);
      els.confirmDialog.removeEventListener("close", onCancel);
      els.confirmDialog.close();
      resolve(result);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);

    els.confirmOkBtn.addEventListener("click", onOk);
    els.confirmCancelBtn.addEventListener("click", onCancel);
    els.confirmDialog.addEventListener("close", onCancel);
    els.confirmDialog.showModal();
  });
}
