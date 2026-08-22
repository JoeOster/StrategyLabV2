// The "Conductor" for the Patterns view.
import {
  renderPatternsHeader,
  renderWinLoss,
  renderRepeatedLosses,
  renderRepeatHead,
  renderHoldingPeriods,
  renderSameDay,
  renderUnplanned,
} from "./render.js";

const state = {
  report: null,
  // Real trades by default. Paper is a separate universe here in a way it is
  // not elsewhere: a paper leg follows its plan mechanically, so its holding
  // periods and win rate describe the plan rather than the trader, and mixing
  // them into "what do I keep doing" would answer a different question.
  paper: false,
};

const els = {};

export async function initializePatternsModule() {
  els.banner = document.getElementById("patterns-banner");
  els.header = document.getElementById("patterns-header");
  els.winloss = document.getElementById("patterns-winloss");
  els.repeatHead = document.getElementById("patterns-repeat-head");
  els.repeatBody = document.getElementById("patterns-repeat-body");
  els.holding = document.getElementById("patterns-holding");
  els.sameday = document.getElementById("patterns-sameday");
  els.unplanned = document.getElementById("patterns-unplanned");
  els.legToggle = [...document.querySelectorAll("[data-patterns-leg]")];

  if (!els.winloss) return;

  els.legToggle.forEach((btn) =>
    btn.addEventListener("click", async () => {
      state.paper = btn.dataset.patternsLeg === "paper";
      els.legToggle.forEach((b) => b.classList.toggle("active", b === btn));
      await reloadPatternsView();
    }),
  );

  await reloadPatternsView();
}

export async function reloadPatternsView() {
  if (!els.winloss) return;
  try {
    const res = await fetch(`/api/patterns?paper=${state.paper ? "1" : "0"}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Request failed: ${res.status}`);
    state.report = await res.json();
    banner(null);
    render();
  } catch (err) {
    banner(err.message, true);
  }
}

function render() {
  const r = state.report;
  els.header.innerHTML = renderPatternsHeader(r);
  els.winloss.innerHTML = renderWinLoss(r.winLoss);
  els.repeatHead.innerHTML = renderRepeatHead();
  els.repeatBody.innerHTML = renderRepeatedLosses(r.repeatedLosses);
  els.holding.innerHTML = renderHoldingPeriods(r.holdingPeriods);
  els.sameday.innerHTML = renderSameDay(r.sameDay, r.sampleSize || 1);
  els.unplanned.innerHTML = renderUnplanned(r.unplanned);
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
