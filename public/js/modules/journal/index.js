// The "Conductor" for the Journal / Strategy Lab view. Owns which panel is
// active and wires listeners; markup comes from render.js, server calls from
// api.js, form validation from handlers.js -- the same four-file split as
// every other feature module in this app.
import * as api from "./api.js";
import {
  renderIdeasList,
  renderStrategiesList,
  renderStrategySourceRows,
  renderSourceOptions,
  renderStrategyOptions,
} from "./render.js";
import {
  ideaFormToPayload,
  validateIdeaPayload,
  strategyFormToPayload,
  validateStrategyPayload,
  strategySourceFormToPayload,
  executeFormToPayload,
  validateExecutePayload,
} from "./handlers.js";

const state = {
  activePanel: "ideas",
  ideas: [],
  strategies: [],
  sources: [],
  sourceFilter: "",
  statusFilter: "",
  // Non-null while the strategy dialog is editing an existing row rather
  // than creating a new one.
  editingStrategyId: null,
  // Unified source-tag rows shown in the strategy dialog's "Sources" list --
  // see mapServerTag/mapPendingTag. In edit mode these are persisted
  // (linkId set) and add/remove hit the API immediately; in create mode
  // they're pending (linkId null) until the whole strategy is saved.
  strategySourceTags: [],
  // Which idea the execute dialog is currently open for.
  executingIdeaId: null,
};

const els = {};

export async function initializeJournalModule() {
  els.tabs = document.getElementById("journal-tabs");
  els.panels = [...document.querySelectorAll(".journal-panel")];
  els.banner = document.getElementById("journal-banner");

  els.ideasList = document.getElementById("journal-ideas-list");
  els.ideasSourceFilter = document.getElementById("journal-ideas-source-filter");
  els.ideasStatusFilter = document.getElementById("journal-ideas-status-filter");
  els.addIdeaBtn = document.getElementById("journal-add-idea-btn");

  els.strategiesList = document.getElementById("journal-strategies-list");
  els.addStrategyBtn = document.getElementById("journal-add-strategy-btn");

  els.ideaDialog = document.getElementById("idea-dialog");
  els.ideaForm = document.getElementById("idea-form");
  els.ideaSourceSelect = document.getElementById("idea-source-select");
  els.ideaStrategySelect = document.getElementById("idea-strategy-select");
  els.ideaOrderTypeSelect = document.getElementById("idea-order-type-select");
  els.ideaTargetPriceLabel = document.getElementById("idea-target-price-label");
  els.ideaCancelBtn = document.getElementById("idea-cancel-btn");

  els.strategyDialog = document.getElementById("strategy-dialog");
  els.strategyForm = document.getElementById("strategy-form");
  els.strategyDialogTitle = document.getElementById("strategy-dialog-title");
  els.strategyCancelBtn = document.getElementById("strategy-cancel-btn");
  els.strategySourcesList = document.getElementById("strategy-sources-list");
  els.strategySourceAddSelect = document.getElementById("strategy-source-add-select");
  els.strategySourceAddChapter = document.getElementById("strategy-source-add-chapter");
  els.strategySourceAddPage = document.getElementById("strategy-source-add-page");
  els.strategySourceAddNotes = document.getElementById("strategy-source-add-notes");
  els.strategySourceAddBtn = document.getElementById("strategy-source-add-btn");

  els.executeDialog = document.getElementById("execute-dialog");
  els.executeForm = document.getElementById("execute-form");
  els.executeTitle = document.getElementById("execute-dialog-title");
  els.executeCancelBtn = document.getElementById("execute-cancel-btn");

  els.tabs.addEventListener("click", handleTabClick);
  els.ideasList.addEventListener("click", handleIdeasAction);
  els.strategiesList.addEventListener("click", handleStrategiesAction);
  els.ideasSourceFilter.addEventListener("change", () => {
    state.sourceFilter = els.ideasSourceFilter.value;
    loadIdeas();
  });
  els.ideasStatusFilter.addEventListener("change", () => {
    state.statusFilter = els.ideasStatusFilter.value;
    loadIdeas();
  });

  els.addIdeaBtn.addEventListener("click", () => openIdeaDialog());
  els.ideaCancelBtn.addEventListener("click", () => els.ideaDialog.close());
  els.ideaSourceSelect.addEventListener("change", updateStrategyOptionsForIdeaForm);
  els.ideaOrderTypeSelect.addEventListener("change", updateTargetPriceVisibility);
  els.ideaForm.addEventListener("submit", handleIdeaSubmit);

  els.addStrategyBtn.addEventListener("click", () => openStrategyDialog(null));
  els.strategyCancelBtn.addEventListener("click", () => els.strategyDialog.close());
  els.strategyForm.addEventListener("submit", handleStrategySubmit);
  els.strategySourceAddBtn.addEventListener("click", handleAddStrategySourceClick);
  els.strategySourcesList.addEventListener("click", handleStrategySourceRemoveClick);

  els.executeCancelBtn.addEventListener("click", () => els.executeDialog.close());
  els.executeForm.addEventListener("submit", handleExecuteSubmit);

  // reloadJournalView() fetches sources (for the filter dropdown) and the
  // active panel's data -- no separate fetch needed here.
  await reloadJournalView();
}

/** Called when the Journal view becomes visible, so data is never stale. */
export async function reloadJournalView() {
  // Refreshes the source filter too -- a source added in Settings since the
  // last visit should show up here without a full page reload.
  try {
    state.sources = await api.fetchSources();
    const previousFilter = els.ideasSourceFilter.value;
    els.ideasSourceFilter.innerHTML = renderSourceOptions(state.sources, null, "All sources");
    if ([...els.ideasSourceFilter.options].some((o) => o.value === previousFilter)) {
      els.ideasSourceFilter.value = previousFilter;
    }
  } catch {
    // A stale source filter shouldn't block the rest of the view from loading.
  }
  if (state.activePanel === "ideas") await loadIdeas();
  else await loadStrategies();
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
  await reloadJournalView();
}

// --- Ideas --------------------------------------------------------------

async function loadIdeas() {
  try {
    state.ideas = await api.fetchIdeas({
      sourceId: state.sourceFilter || undefined,
      status: state.statusFilter || undefined,
    });
    els.ideasList.innerHTML = renderIdeasList(state.ideas);
  } catch (err) {
    banner(err.message, true);
  }
}

async function handleIdeasAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const idea = state.ideas.find((i) => i.id === id);

  if (btn.dataset.action === "execute") return openExecuteDialog(idea);

  if (btn.dataset.action === "remove") {
    const message = idea?.status === "EXECUTED"
      ? "This idea was already executed into a real trade, which is unaffected. Remove the Journal entry itself?"
      : `Remove this ${idea ? idea.symbol : "idea"} idea? This can't be undone.`;
    if (!window.confirm(message)) return;
    try {
      await api.deleteIdeas([id]);
      await loadIdeas();
      banner("Idea removed.", false);
    } catch (err) {
      banner(err.message, true);
    }
  }
}

async function openIdeaDialog() {
  els.ideaForm.reset();
  // Re-fetch rather than trusting state.sources from module init -- a source
  // added in Settings after the page loaded would otherwise be invisible
  // here until a full reload. Mirrors the same re-fetch-on-open pattern
  // orders/index.js already uses for its own source dropdown.
  try {
    state.sources = await api.fetchSources();
  } catch (err) {
    banner(err.message, true);
  }
  els.ideaSourceSelect.innerHTML = renderSourceOptions(state.sources, null);
  await updateStrategyOptionsForIdeaForm();
  updateTargetPriceVisibility();
  els.ideaDialog.showModal();
}

async function updateStrategyOptionsForIdeaForm() {
  const sourceId = els.ideaSourceSelect.value ? Number(els.ideaSourceSelect.value) : null;
  const strategies = sourceId ? await api.fetchStrategies(sourceId) : [];
  els.ideaStrategySelect.innerHTML = renderStrategyOptions(strategies, null);
  els.ideaStrategySelect.disabled = !sourceId;
}

function updateTargetPriceVisibility() {
  const isWatch = els.ideaOrderTypeSelect.value === "WATCH";
  els.ideaTargetPriceLabel.hidden = isWatch;
  els.ideaForm.elements.targetPrice.required = !isWatch;
  if (isWatch) els.ideaForm.elements.targetPrice.value = "";
}

async function handleIdeaSubmit(event) {
  event.preventDefault();
  const payload = ideaFormToPayload(new FormData(els.ideaForm));
  const error = validateIdeaPayload(payload);
  if (error) return banner(error, true);

  try {
    await api.createIdea(payload);
    els.ideaDialog.close();
    await loadIdeas();
    banner(`Idea logged for ${payload.symbol}.`, false);
  } catch (err) {
    banner(err.message, true);
  }
}

function openExecuteDialog(idea) {
  if (!idea) return;
  state.executingIdeaId = idea.id;
  els.executeForm.reset();
  els.executeForm.elements.transactionDate.value = new Date().toISOString().slice(0, 10);
  els.executeForm.elements.fees.value = "0";
  // Pre-fill quantity from the idea if it was set, but never the price -- a
  // real fill routinely differs from the paper target, and silently
  // assuming they match is exactly the kind of "looks right" shortcut this
  // app has been bitten by before (see STATUS.md's "Real bugs found").
  if (idea.quantity) els.executeForm.elements.quantity.value = idea.quantity;
  els.executeTitle.textContent = `Execute ${idea.symbol} — enter the real fill`;
  els.executeDialog.showModal();
}

async function handleExecuteSubmit(event) {
  event.preventDefault();
  const payload = executeFormToPayload(new FormData(els.executeForm));
  const error = validateExecutePayload(payload);
  if (error) return banner(error, true);

  try {
    await api.executeIdea(state.executingIdeaId, payload);
    els.executeDialog.close();
    await loadIdeas();
    banner("Idea executed into a real trade. See it under Orders.", false);
  } catch (err) {
    banner(err.message, true);
  }
}

// --- Strategies -----------------------------------------------------------

async function loadStrategies() {
  try {
    state.strategies = await api.fetchStrategies();
    els.strategiesList.innerHTML = renderStrategiesList(state.strategies);
  } catch (err) {
    banner(err.message, true);
  }
}

async function handleStrategiesAction(event) {
  const btn = event.target.closest("button[data-action]");
  if (!btn) return;
  const id = Number(btn.dataset.id);

  if (btn.dataset.action === "edit") return openStrategyDialog(id);

  if (btn.dataset.action === "delete") {
    const strategy = state.strategies.find((s) => s.id === id);
    const warning =
      strategy?.idea_count > 0
        ? ` ${strategy.idea_count} idea(s) linked to it will keep their history but lose the strategy tag.`
        : "";
    if (!window.confirm(`Delete this strategy?${warning}`)) return;
    try {
      await api.deleteStrategy(id);
      await loadStrategies();
      banner("Strategy deleted.", false);
    } catch (err) {
      banner(err.message, true);
    }
  }
}

async function openStrategyDialog(strategyId) {
  state.editingStrategyId = strategyId;
  els.strategyForm.reset();
  clearStrategySourceAddFields();
  // Same re-fetch-on-open reasoning as openIdeaDialog: a source added in
  // Settings since page load shouldn't require a full reload to show up here.
  try {
    state.sources = await api.fetchSources();
  } catch (err) {
    banner(err.message, true);
  }
  els.strategySourceAddSelect.innerHTML = renderSourceOptions(state.sources, null, "— add a source —");
  els.strategyDialogTitle.textContent = strategyId ? "Edit Strategy" : "New Strategy";

  if (strategyId) {
    try {
      const strategy = await api.fetchStrategy(strategyId);
      els.strategyForm.elements.title.value = strategy.title;
      els.strategyForm.elements.notes.value = strategy.notes ?? "";
      state.strategySourceTags = strategy.sources.map(mapServerTag);
    } catch (err) {
      banner(err.message, true);
      state.strategySourceTags = [];
    }
  } else {
    state.strategySourceTags = [];
  }
  renderStrategySourcesPanel();
  els.strategyDialog.showModal();
}

function renderStrategySourcesPanel() {
  els.strategySourcesList.innerHTML = renderStrategySourceRows(state.strategySourceTags);
}

function clearStrategySourceAddFields() {
  els.strategySourceAddSelect.value = "";
  els.strategySourceAddChapter.value = "";
  els.strategySourceAddPage.value = "";
  els.strategySourceAddNotes.value = "";
}

/** A source tag as returned by the server (listStrategySources rows), normalized to the shape render.js and the remove handler expect. */
function mapServerTag(row) {
  return {
    key: String(row.source_id),
    linkId: row.id,
    sourceId: row.source_id,
    sourceName: row.source_name,
    chapter: row.chapter,
    pageNumber: row.page_number,
    notes: row.notes,
  };
}

/** A source tag that only exists client-side so far (new strategy, not yet saved). */
function mapPendingTag(payload) {
  const source = state.sources.find((s) => s.id === payload.sourceId);
  return {
    key: String(payload.sourceId),
    linkId: null,
    sourceId: payload.sourceId,
    sourceName: source ? source.name : `Source #${payload.sourceId}`,
    chapter: payload.chapter,
    pageNumber: payload.pageNumber,
    notes: payload.notes,
  };
}

async function handleAddStrategySourceClick() {
  const payload = strategySourceFormToPayload({
    sourceId: els.strategySourceAddSelect.value,
    chapter: els.strategySourceAddChapter.value,
    pageNumber: els.strategySourceAddPage.value,
    notes: els.strategySourceAddNotes.value,
  });
  if (!payload) return banner("Choose a source to add.", true);
  if (state.strategySourceTags.some((t) => t.sourceId === payload.sourceId)) {
    return banner("That source is already tagged on this strategy.", true);
  }

  if (state.editingStrategyId) {
    try {
      await api.addStrategySource(state.editingStrategyId, payload);
      const strategy = await api.fetchStrategy(state.editingStrategyId);
      state.strategySourceTags = strategy.sources.map(mapServerTag);
      renderStrategySourcesPanel();
      clearStrategySourceAddFields();
      // The tag is already persisted -- refresh the list behind the dialog
      // too, so its "via ..." summary doesn't go stale if the user hits
      // Cancel next instead of Save (found by actually clicking through
      // this flow: Cancel used to leave the background list showing the
      // pre-edit source names).
      await loadStrategies();
    } catch (err) {
      banner(err.message, true);
    }
  } else {
    state.strategySourceTags.push(mapPendingTag(payload));
    renderStrategySourcesPanel();
    clearStrategySourceAddFields();
  }
}

async function handleStrategySourceRemoveClick(event) {
  const btn = event.target.closest("button[data-action='remove-strategy-source']");
  if (!btn) return;
  const key = btn.dataset.key;
  const tag = state.strategySourceTags.find((t) => t.key === key);
  if (!tag) return;

  if (state.editingStrategyId && tag.linkId) {
    try {
      await api.removeStrategySource(state.editingStrategyId, tag.linkId);
      state.strategySourceTags = state.strategySourceTags.filter((t) => t.key !== key);
      renderStrategySourcesPanel();
      // Same reasoning as the add-source branch above: this already hit the
      // server, so the background list needs to reflect it even if the user
      // cancels out of the dialog next instead of clicking Save.
      await loadStrategies();
    } catch (err) {
      banner(err.message, true);
    }
  } else {
    state.strategySourceTags = state.strategySourceTags.filter((t) => t.key !== key);
    renderStrategySourcesPanel();
  }
}

async function handleStrategySubmit(event) {
  event.preventDefault();
  const base = strategyFormToPayload(new FormData(els.strategyForm));

  if (state.editingStrategyId) {
    const error = validateStrategyPayload(base);
    if (error) return banner(error, true);
    try {
      await api.updateStrategy(state.editingStrategyId, base);
      els.strategyDialog.close();
      await loadStrategies();
      banner("Strategy updated.", false);
    } catch (err) {
      banner(err.message, true);
    }
    return;
  }

  const payload = {
    ...base,
    sources: state.strategySourceTags.map((t) => ({
      sourceId: t.sourceId,
      chapter: t.chapter,
      pageNumber: t.pageNumber,
      notes: t.notes,
    })),
  };
  const error = validateStrategyPayload(payload);
  if (error) return banner(error, true);
  try {
    await api.createStrategy(payload);
    els.strategyDialog.close();
    await loadStrategies();
    banner("Strategy created.", false);
  } catch (err) {
    banner(err.message, true);
  }
}
