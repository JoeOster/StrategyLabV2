// The "Conductor" for the Dashboard view. Card grid + table toggle over the
// same open-position data, with a click-through detail panel per ticker.
import * as api from "./api.js";
import {
  TABLE_COLUMNS,
  renderCards,
  renderTableHead,
  renderTableRows,
  renderExchangeOptions,
  renderTickerDetail,
  renderTickerNews,
  sortPositions,
  filterPositions,
} from "./render.js";
import { renderSummary } from "../shared/summary.js";

const state = {
  positions: [],
  summary: null,
  view: "cards",
  filter: "",
  exchange: "",
  // Server-side, unlike the exchange filter below it. Account scope has to
  // reach the server because the strip's cash, realized P&L and dividends are
  // computed there -- filtering the fetched rows in the browser would narrow
  // the table while leaving those three figures portfolio-wide, which is the
  // exact mismatch that makes a total untrustworthy.
  accountId: null,
  accounts: [],
  sortKey: "symbol",
  sortDir: "asc",
  detailSymbol: null,
  // The payload behind the open dialog, so the Research button can tell
  // whether this ticker has any stored price history without re-fetching.
  detailData: null,
};

const els = {};

export async function initializeDashboardModule() {
  els.banner = document.getElementById("dashboard-banner");
  els.summary = document.getElementById("dashboard-summary");
  els.cards = document.getElementById("dash-cards");
  els.tableWrap = document.getElementById("dash-table");
  els.theadRow = document.getElementById("dash-thead-row");
  els.tbody = document.getElementById("dash-tbody");
  els.filter = document.getElementById("dash-filter");
  els.exchangeFilter = document.getElementById("dash-exchange-filter");
  els.accountFilter = document.getElementById("dash-account-filter");
  els.sortSelect = document.getElementById("dash-sort");
  els.count = document.getElementById("dash-count");
  els.refreshBtn = document.getElementById("dash-refresh-btn");
  els.viewToggle = [...document.querySelectorAll("[data-dash-view]")];

  els.detailDialog = document.getElementById("ticker-detail-dialog");
  els.detailBody = document.getElementById("ticker-detail-body");
  els.detailActions = document.querySelector("#ticker-detail-dialog .form-actions");
  els.detailCloseBtn = document.getElementById("ticker-detail-close-btn");
  els.researchBtn = document.getElementById("ticker-research-btn");
  els.tickerRefreshBtn = document.getElementById("ticker-refresh-btn");

  els.filter.addEventListener("input", () => {
    state.filter = els.filter.value;
    renderAll();
  });
  els.exchangeFilter.addEventListener("change", () => {
    state.exchange = els.exchangeFilter.value;
    renderAll();
  });
  els.accountFilter.addEventListener("change", async () => {
    const raw = els.accountFilter.value;
    state.accountId = raw === "" ? null : Number(raw);
    // A refetch, not a re-render: the summary figures come from the server.
    await reloadDashboardView();
  });
  els.sortSelect.addEventListener("change", () => {
    const [key, dir] = els.sortSelect.value.split(":");
    state.sortKey = key;
    state.sortDir = dir;
    renderAll();
  });

  els.viewToggle.forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view = btn.dataset.dashView;
      els.viewToggle.forEach((b) => b.classList.toggle("active", b === btn));
      els.cards.hidden = state.view !== "cards";
      els.tableWrap.hidden = state.view !== "table";
      renderAll();
    }),
  );

  // Delegated: both views re-render constantly, so per-element listeners
  // would need re-binding after every sort or filter change.
  els.cards.addEventListener("click", handleOpenDetail);
  els.tbody.addEventListener("click", handleOpenDetail);
  els.theadRow.addEventListener("click", handleTableSort);

  els.refreshBtn.addEventListener("click", handleRefresh);
  els.tickerRefreshBtn.addEventListener("click", handleTickerRefresh);
  els.detailCloseBtn.addEventListener("click", () => els.detailDialog.close());
  els.researchBtn.addEventListener("click", showResearchHint);

  await populateAccountFilter();
  await reloadDashboardView();
}

/**
 * Fills the account dropdown from the server.
 *
 * Driven FROM state, never read back into it -- Chrome restores a <select>
 * value across a reload without firing `change`, so trusting the DOM let the
 * control show one account while the data showed another.
 */
async function populateAccountFilter() {
  const accounts = await api.fetchAccountsForFilter();
  state.accounts = accounts;
  els.accountFilter.innerHTML =
    '<option value="">All accounts</option>' +
    accounts
      .map((a) => `<option value="${a.id}">${a.label.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</option>`)
      .join("");
  els.accountFilter.value = state.accountId == null ? "" : String(state.accountId);
}

export async function reloadDashboardView() {
  try {
    const { positions, summary } = await api.fetchPositions({ accountId: state.accountId });
    state.positions = positions;
    state.summary = summary;

    // Preserve the chosen exchange if it still exists after a data refresh.
    const previousExchange = state.exchange;
    els.exchangeFilter.innerHTML = renderExchangeOptions(positions);
    if ([...els.exchangeFilter.options].some((o) => o.value === previousExchange)) {
      els.exchangeFilter.value = previousExchange;
    } else {
      state.exchange = "";
    }

    renderSummaryStrip();
    renderAll();
  } catch (err) {
    banner(err.message, true);
  }
}

function renderSummaryStrip() {
  els.summary.innerHTML = renderSummary(state.summary);
}

function visiblePositions() {
  return sortPositions(
    filterPositions(state.positions, state.filter, state.exchange),
    state.sortKey,
    state.sortDir,
  );
}

function renderAll() {
  const visible = visiblePositions();
  if (state.view === "cards") {
    els.cards.innerHTML = renderCards(visible);
  } else {
    els.theadRow.innerHTML = renderTableHead(state.sortKey, state.sortDir);
    els.tbody.innerHTML = renderTableRows(visible);
  }
  els.count.textContent =
    visible.length === state.positions.length
      ? `${state.positions.length} lot(s)`
      : `${visible.length} of ${state.positions.length} lot(s)`;
}

function handleTableSort(event) {
  const th = event.target.closest("th[data-sort-key]");
  if (!th) return;
  if (state.sortKey === th.dataset.sortKey) {
    state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  } else {
    state.sortKey = th.dataset.sortKey;
    state.sortDir = "asc";
  }
  // Keep the dropdown honest about what the table is actually doing.
  const combo = `${state.sortKey}:${state.sortDir}`;
  if ([...els.sortSelect.options].some((o) => o.value === combo)) els.sortSelect.value = combo;
  renderAll();
}

async function handleOpenDetail(event) {
  const target = event.target.closest("[data-symbol]");
  if (!target) return;
  await openDetailFor(target.dataset.symbol);
}

/**
 * Error banner as a real element, built with textContent.
 *
 * BUG 9: these two sites were the only places in the frontend that put server
 * text into innerHTML directly -- every render.js routes through escapeHtml.
 * The message interpolates the raw :symbol URL param (server.js), so it is
 * only not-XSS today because Yahoo's lookup happens to reject HTML-bearing
 * tickers first. Any change that relaxes that gate would turn it into stored
 * XSS with no frontend change at all. textContent cannot be talked into
 * parsing markup, so the gate stops mattering.
 */
function errorBanner(message) {
  const p = document.createElement("p");
  p.className = "status-banner status-error";
  p.textContent = message;
  return p;
}

/**
 * Adds the headlines panel once it arrives.
 *
 * Deliberately fire-and-forget: it checks the dialog is still showing the same
 * ticker before appending, because opening NVDA and then quickly opening TSLA
 * would otherwise drop NVDA's headlines into TSLA's dialog when the slower
 * request landed.
 */
async function loadTickerNews(symbol) {
  let payload;
  try {
    payload = await api.fetchTickerNews(symbol);
  } catch (err) {
    payload = { error: err.message };
  }
  if (state.detailSymbol !== symbol) return;
  els.detailBody.append(renderTickerNews(payload));
}

/**
 * Shows the last brief written for this ticker, if there is one.
 *
 * Runs on every dialog open and costs nothing -- it is a database read. The
 * button then means "write a NEW one" rather than "find out what is already
 * known", which is the distinction that makes storing them worth the table.
 */
async function loadStoredResearch(symbol) {
  let payload;
  try {
    payload = await api.fetchStoredResearch(symbol);
  } catch {
    return; // a missing brief is not an error worth reporting
  }
  if (state.detailSymbol !== symbol || !payload.latest) return;

  const panel = document.createElement("div");
  panel.className = "research-hint stored-research";
  renderStoredBrief(panel, symbol, payload.latest, payload.history);
  placeByActions(panel);
  // Deliberately NOT scrolled to. The user opened the ticker, not the brief,
  // and yanking the dialog to a panel they did not ask for is its own kind of
  // rude. placeByActions scrolls; this undoes that by restoring the top.
  els.detailDialog.scrollTop = 0;

  els.researchBtn.textContent = payload.latest.stale ? "Research again" : "Research";
}

/** A stored brief, with what has changed since it was written. */
function renderStoredBrief(panel, symbol, latest, history) {
  panel.textContent = "";

  const head = document.createElement("p");
  head.className = "panel-hint";
  const when = String(latest.createdAt).slice(0, 16).replace("T", " ");
  head.textContent = `Last researched ${when}${history?.length > 1 ? ` · ${history.length} briefs on file` : ""}.`;
  panel.append(head);

  // The staleness line is the reason the position snapshot is stored at all.
  // Without it a brief about 10 shares reads as current when 25 are held.
  if (latest.stale) {
    const warn = document.createElement("p");
    warn.className = "status-banner status-warn";
    warn.textContent = `Written against a different position — ${latest.changes.join("; ")}. Press Research again to redo it.`;
    panel.append(warn);
  }

  const pre = document.createElement("pre");
  pre.className = "research-brief";
  pre.textContent = latest.brief;
  panel.append(pre);
}

/**
 * Researches the ticker: fetches missing price history, then runs the skill.
 *
 * The button used to hand over a phrase to type into a chat session, because a
 * skill is instructions rather than code and a web page has nothing to invoke.
 * Joe's reaction was the right one -- "seems weird I cant activate a local
 * skill from the browser". Claude Code's headless mode is the missing process:
 * the server spawns it, it loads the same skill file, and the brief comes back.
 *
 * It takes a minute or two because the skill searches the web. That is why
 * there is a progress line rather than a disabled button -- two minutes of
 * nothing is indistinguishable from broken, which this button has already been
 * accused of once and deserved.
 */
async function showResearchHint() {
  const symbol = state.detailSymbol;
  if (!symbol) return;

  const stored = els.detailDialog.querySelector(".stored-research");
  // A stored brief is being REPLACED, not toggled -- the button was pressed to
  // write a new one, and leaving the old one below it would put two briefs
  // about the same ticker on screen with nothing saying which is which.
  if (stored) stored.remove();

  const existing = els.detailDialog.querySelector(".research-hint");
  if (existing) return existing.remove(); // pressing it again closes it

  const panel = document.createElement("div");
  panel.className = "research-hint";
  placeByActions(panel);

  const status = document.createElement("p");
  status.className = "research-status";
  panel.append(status);

  els.researchBtn.disabled = true;
  try {
    // History first, and only when there is none. The skill reads the app's
    // own record, so fetching this now means the brief can talk about the
    // price path rather than reporting that there is nothing stored.
    if ((state.detailData?.series?.length ?? 0) === 0) {
      status.textContent = `Fetching price history for ${symbol}…`;
      els.researchBtn.textContent = "Fetching…";
      await api.refreshTicker(symbol);
      const refreshed = await api.fetchTickerDetail(symbol);
      state.detailData = refreshed;
    }

    status.textContent = `Researching ${symbol} — reading your position, then searching the web. A minute or two.`;
    els.researchBtn.textContent = "Researching…";

    const result = await api.runResearch(symbol);
    if (state.detailSymbol !== symbol) return; // dialog moved on
    renderResearchBrief(panel, symbol, result);
  } catch (err) {
    if (state.detailSymbol !== symbol) return;
    status.remove();
    panel.append(researchFallback(symbol, err.message));
  } finally {
    els.researchBtn.disabled = false;
    els.researchBtn.textContent = "Research";
  }
}

/** Puts an element immediately above the dialog's action row, and in view. */
function placeByActions(el) {
  if (els.detailActions) els.detailActions.before(el);
  else els.detailBody.append(el);
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * The finished brief.
 *
 * Rendered as preformatted TEXT rather than parsed as markdown. The brief
 * quotes headlines and links from the open web, and this app has no markdown
 * renderer -- adding one would mean either a third dependency or a hand-rolled
 * parser handling somebody else's content, which is the worst of both. A <pre>
 * with textContent shows the structure, cannot execute anything, and is honest
 * about being raw.
 */
function renderResearchBrief(panel, symbol, result) {
  panel.textContent = "";

  const head = document.createElement("p");
  head.className = "panel-hint";
  head.textContent = `Researched ${symbol} in ${(result.ms / 1000).toFixed(0)}s. Position read from this app; news from the open web. Sources are linked in the text.`;

  const pre = document.createElement("pre");
  pre.className = "research-brief";
  pre.textContent = result.brief;

  panel.append(head, pre);
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * What to do when the run could not happen.
 *
 * Falls back to the phrase, which is what the button did before headless mode
 * existed and still works from any Claude session. A failure here should leave
 * the user with a route, not an apology.
 */
function researchFallback(symbol, message) {
  const wrap = document.createElement("div");

  const why = document.createElement("p");
  why.className = "status-banner status-error";
  why.textContent = message;

  const p = document.createElement("p");
  p.textContent = "You can still ask Claude directly:";
  const code = document.createElement("code");
  code.textContent = `research ${symbol}`;

  wrap.append(why, p, code);
  return wrap;
}

async function openDetailFor(symbol) {
  // Remembered so the dialog's own Refresh button knows what to refresh.
  state.detailSymbol = symbol;
  els.detailBody.innerHTML = `<p class="panel-hint">Loading ${symbol}…</p>`;
  els.detailDialog.showModal();
  try {
    const detail = await api.fetchTickerDetail(symbol);
    state.detailData = detail;
    els.detailBody.innerHTML = renderTickerDetail(detail);

    // A brief already written for this ticker, if there is one. Free and
    // instant: the whole point of storing them is that opening a ticker should
    // not cost two minutes to see what was already worked out.
    loadStoredResearch(symbol);

    // Appended after the dialog has already rendered, not awaited alongside
    // the detail fetch. Finnhub is a network call to a third party and the
    // rest of the dialog does not depend on it -- blocking the whole panel on
    // it would make a slow news API look like a slow app.
    loadTickerNews(symbol);
  } catch (err) {
    els.detailBody.replaceChildren(errorBanner(err.message));
  }
}

/**
 * Refreshes just this ticker (quote + history) without re-polling the whole
 * portfolio, then redraws the dialog in place.
 */
async function handleTickerRefresh() {
  if (!state.detailSymbol) return;
  els.tickerRefreshBtn.disabled = true;
  els.tickerRefreshBtn.textContent = "Refreshing…";
  try {
    await api.refreshTicker(state.detailSymbol);
    await openDetailFor(state.detailSymbol);
    // Cards behind the dialog now show a stale price, so refresh those too.
    await reloadDashboardView();
  } catch (err) {
    els.detailBody.prepend(errorBanner(err.message));
  } finally {
    els.tickerRefreshBtn.disabled = false;
    els.tickerRefreshBtn.textContent = "Refresh Data";
  }
}

async function handleRefresh() {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "Refreshing…";
  try {
    await api.refreshPrices();
    await reloadDashboardView();
    banner("Prices refreshed.", false);
  } catch (err) {
    banner(err.message, true);
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "Refresh Prices";
  }
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
