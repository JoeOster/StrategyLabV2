// The "Conductor" for the Efficiency view.
import {
  renderBenchmarkSummary,
  renderBenchmarkGroups,
  renderBenchmarkGroupHead,
} from "./benchmark.js";
import {
  renderEfficiencySummary,
  renderEfficiencyGroups,
  renderEfficiencyGroupHead,
  renderEfficiencyEvents,
} from "./render.js";

const state = {
  report: null,
  benchmark: null,
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
  els.benchSummary = document.getElementById("benchmark-summary");
  els.benchHead = document.getElementById("benchmark-group-head");
  els.benchBody = document.getElementById("benchmark-group-body");
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
    const q = state.paper == null ? "" : `?paper=${state.paper ? "1" : "0"}`;
    // Fetched together: they are two halves of one question -- was the plan
    // followed, and was it worth following -- and loading them separately
    // would let the page show one against a stale other.
    const [report, benchmark] = await Promise.all([
      fetchReport(state.paper),
      fetch(`/api/benchmark${q}`).then((r) => (r.ok ? r.json() : null)),
    ]);
    state.report = report;
    state.benchmark = benchmark;
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

  const b = state.benchmark;
  if (b && els.benchSummary) {
    els.benchSummary.innerHTML = renderBenchmarkSummary(b);
    els.benchHead.innerHTML = renderBenchmarkGroupHead();
    els.benchBody.innerHTML = renderBenchmarkGroups(
      state.grouping === "source" ? b.bySource : b.byStrategy,
      { emptyMessage: "No closed round trips to compare yet." },
    );
    // Present only in the no-history empty state, so it is bound on render
    // rather than once at init.
    const backfill = document.getElementById("benchmark-backfill-btn");
    if (backfill) backfill.addEventListener("click", handleBackfill);
  }

  const groups = state.grouping === "source" ? r.bySource : r.byStrategy;
  els.groupBody.innerHTML = renderEfficiencyGroups(groups, {
    emptyMessage:
      state.grouping === "source"
        ? "No sources have produced a measurable event yet."
        : "No strategies have produced a measurable event yet.",
  });

  els.eventsBody.innerHTML = renderEfficiencyEvents(r.events);
}

/**
 * Fetches the benchmark's price history.
 *
 * Explicit rather than automatic. It is a network call, and a report that
 * silently reaches for the internet when opened is a report that hangs when
 * the internet is down.
 */
async function handleBackfill(event) {
  const btn = event.currentTarget;
  btn.disabled = true;
  btn.textContent = "Fetching…";
  try {
    const res = await fetch("/api/benchmark/backfill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "2024-01-01" }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "Backfill failed");
    banner(`Fetched ${body.bars} daily bars for ${body.symbol}.`, false);
    await reloadEfficiencyView();
  } catch (err) {
    banner(err.message, true);
    btn.disabled = false;
    btn.textContent = "Try again";
  }
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
