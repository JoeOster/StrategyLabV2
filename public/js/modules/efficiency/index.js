// The "Conductor" for the Efficiency view.
import {
  renderEfficiencySummary,
  renderEfficiencyGroups,
  renderEfficiencyGroupHead,
  renderEfficiencyEvents,
} from "./render.js";

const state = {
  report: null,
  // null = both legs. The honest default: the paper leg follows the plan
  // mechanically, so it is the baseline the real leg is measured against
  // rather than a separate universe.
  paper: null,
  grouping: "source",
};

const els = {};

async function fetchReport(paper) {
  const q = paper == null ? "" : `?paper=${paper ? "1" : "0"}`;
  const res = await fetch(`/api/efficiency${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function initializeEfficiencyModule() {
  els.banner = document.getElementById("efficiency-banner");
  els.summary = document.getElementById("efficiency-summary");
  els.groupHead = document.getElementById("efficiency-group-head");
  els.groupBody = document.getElementById("efficiency-group-body");
  els.eventsBody = document.getElementById("efficiency-events-body");
  els.legFilter = document.getElementById("efficiency-leg");
  els.groupToggle = [...document.querySelectorAll("[data-eff-group]")];

  if (!els.summary) return; // view not present

  els.legFilter.addEventListener("change", async () => {
    const v = els.legFilter.value;
    state.paper = v === "" ? null : v === "paper";
    await reloadEfficiencyView();
  });

  els.groupToggle.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.grouping = btn.dataset.effGroup;
      els.groupToggle.forEach((b) => b.classList.toggle("active", b === btn));
      renderAll();
    }),
  );

  await reloadEfficiencyView();
}

export async function reloadEfficiencyView() {
  if (!els.summary) return;
  try {
    state.report = await fetchReport(state.paper);
    banner(null);
    renderAll();
  } catch (err) {
    banner(err.message, true);
  }
}

function renderAll() {
  const r = state.report;
  els.summary.innerHTML = renderEfficiencySummary(r);
  els.groupHead.innerHTML = renderEfficiencyGroupHead();

  const groups = state.grouping === "source" ? r.bySource : r.byStrategy;
  els.groupBody.innerHTML = renderEfficiencyGroups(groups, {
    emptyMessage:
      state.grouping === "source"
        ? "No sources have produced a measurable event yet."
        : "No strategies have produced a measurable event yet.",
  });

  els.eventsBody.innerHTML = renderEfficiencyEvents(r.events);
}

function banner(message, isError) {
  if (!els.banner) return;
  if (!message) {
    els.banner.hidden = true;
    return;
  }
  els.banner.hidden = false;
  els.banner.textContent = message;
  els.banner.className = `status-banner ${isError ? "status-error" : "status-success"}`;
}
