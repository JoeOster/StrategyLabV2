// The "View" for the Patterns report. Pure functions, no DOM, no fetch.
//
// Every string here states what happened. None of it says what to do about it.
// That line is the same one the rest of the app holds: "your average loss is
// 19% larger than your average win" is arithmetic; "cut your losses sooner" is
// advice, and this app has never given any.
import { money, signedMoney, percent } from "../shared/format.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const cls = (v) => (v == null ? "" : v >= 0 ? "change-up" : "change-down");

function stat(label, value, sub, { hint = null, tone = "" } = {}) {
  return `
    <div class="summary-item">
      <span class="summary-label"${hint ? ` title="${escapeHtml(hint)}"` : ""}>${escapeHtml(label)}</span>
      <span class="summary-value ${tone}">${value}</span>
      ${sub ? `<span class="summary-label stat-n">${escapeHtml(sub)}</span>` : ""}
    </div>`;
}

/**
 * The shape of the trading, in four numbers that only mean anything together.
 *
 * A 57% win rate reads like an edge until the average loss turns out to be
 * larger than the average win. Neither figure decides anything alone; the
 * product does, which is why expectancy is shown beside them rather than left
 * for the reader to multiply.
 */
export function renderWinLoss(w) {
  if (!w) return `<p class="panel-hint">No closed sales yet, so there is no shape to report.</p>`;

  return `
    <div class="summary-strip">
      ${stat("Win rate", percent(w.winRate * 100, { signed: false }), `${w.wins} up, ${w.losses} down`, {
        hint: "How often a sale was closed at a profit. On its own this decides nothing — a high rate with small wins and large losses still loses money.",
      })}
      ${stat("Average win", money(w.avgWin), `${w.wins} trades`, { tone: "change-up" })}
      ${stat("Average loss", money(Math.abs(w.avgLoss)), `${w.losses} trades`, { tone: "change-down" })}
      ${stat(
        "Payoff ratio",
        w.payoffRatio == null ? "—" : w.payoffRatio.toFixed(2),
        w.payoffRatio == null ? "" : w.payoffRatio >= 1 ? "wins are bigger" : "losses are bigger",
        {
          hint: "Average win divided by average loss. Above 1 means the wins are larger; below 1 means the losses are.",
          tone: cls(w.payoffRatio == null ? null : w.payoffRatio - 1),
        },
      )}
      ${stat("Expectancy", signedMoney(w.expectancy), "per closed trade", {
        hint: "What the win rate and the two averages come to per trade. This is the figure the other three decide, and the only one of the four that answers whether the pair is a profit.",
        tone: cls(w.expectancy),
      })}
    </div>
    <p class="panel-hint">
      Across ${w.trades} closed sales: ${money(w.grossWins)} won, ${money(Math.abs(w.grossLosses))} lost.
    </p>`;
}

const REPEAT_COLUMNS = ["Ticker", "Net", "Record", "Worst single", "First", "Last"];

export function renderRepeatHead() {
  return REPEAT_COLUMNS.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
}

/**
 * Names sold at a loss again and again.
 *
 * One loss is a trade. Seven in the same ticker is something the ledger knows
 * and a human scrolling a transaction list does not.
 */
export function renderRepeatedLosses(rows) {
  if (!rows || rows.length === 0) {
    return `<tr><td colspan="${REPEAT_COLUMNS.length}" class="empty-row">No ticker has four or more sales that are mostly losses.</td></tr>`;
  }
  return rows
    .map(
      (r) => `
      <tr>
        <td><strong>${escapeHtml(r.symbol)}</strong></td>
        <td class="change-down">${signedMoney(r.net)}</td>
        <td>${r.losses} of ${r.sales} at a loss${r.losses === r.sales ? " <span class=\"thin-tag\">every one</span>" : ""}</td>
        <td class="change-down">${signedMoney(r.worst)}</td>
        <td>${escapeHtml(r.first)}</td>
        <td>${escapeHtml(r.last)}</td>
      </tr>`,
    )
    .join("");
}

/**
 * How long winners and losers were held.
 *
 * Reported without a verdict. The textbook expectation is that losers get held
 * too long, and this ledger says the opposite -- which is worth showing plainly
 * rather than explaining away, because it is a fact about this trader rather
 * than about a study of other people.
 */
export function renderHoldingPeriods(h) {
  if (!h) return `<p class="panel-hint">Not enough closed sales on both sides to compare.</p>`;

  const longer = h.differenceDays > 0 ? "losers" : "winners";
  const gap = Math.abs(h.differenceDays);

  return `
    <div class="summary-strip">
      ${stat("Winners held", `${h.avgWinnerDays.toFixed(1)}d`, `${h.winnerCount} trades`, { tone: "change-up" })}
      ${stat("Losers held", `${h.avgLoserDays.toFixed(1)}d`, `${h.loserCount} trades`, { tone: "change-down" })}
      ${stat("Difference", `${gap.toFixed(1)}d`, `${longer} held longer`, {
        hint: "The commonly described pattern is holding losers longer than winners. This is simply what your own ledger shows, either way.",
      })}
    </div>`;
}

/** Same-day round trips, with what they came to. */
export function renderSameDay(s, totalSales) {
  if (!s) return `<p class="panel-hint">No positions were opened and closed on the same day.</p>`;
  return `
    <div class="summary-strip">
      ${stat("Same-day trades", String(s.count), `${percent((s.count / totalSales) * 100, { signed: false })} of all sales`)}
      ${stat("Net result", signedMoney(s.net), `${s.wins} of ${s.count} up`, { tone: cls(s.net) })}
      ${stat("Tickers", String(s.symbols.length), "involved")}
    </div>
    <p class="panel-hint">
      Counted separately because it is a different activity from holding something, and mixing the two hides both.
    </p>`;
}

/**
 * Open positions with no plan attached.
 *
 * Not a criticism. A trade can exist without a plan by explicit design. It is
 * here because the app cannot measure what it was never told, and each of these
 * is an exit that will be unmeasurable against an intention nobody wrote down.
 */
export function renderUnplanned(u) {
  if (!u || u.lots === 0) {
    return `<p class="panel-hint">Every open position has a plan attached.</p>`;
  }
  return `
    <div class="summary-strip">
      ${stat("Unplanned lots", String(u.lots), `across ${u.symbols} tickers`, { tone: "change-down" })}
      ${stat("Cost basis", money(u.cost), "with no target or stop on record")}
    </div>
    <p class="panel-hint">
      A trade can exist without a plan &mdash; that was a deliberate decision. This is here because
      the app cannot measure an exit against an intention that was never recorded.
      ${u.biggest.length ? `Largest: ${u.biggest.map((b) => `${escapeHtml(b.symbol)} (${money(b.cost)})`).join(", ")}.` : ""}
    </p>`;
}

/** The line above everything, so no figure is read without its sample. */
export function renderPatternsHeader(report) {
  if (!report || report.sampleSize === 0) {
    return `<p class="panel-hint">Nothing closed yet. These patterns need completed round trips to describe.</p>`;
  }
  return `<p class="panel-hint">
    Computed from <strong>${report.sampleSize}</strong> closed sales between
    ${escapeHtml(report.firstSale)} and ${escapeHtml(report.lastSale)}. Everything below is
    a description of what happened, not a suggestion about what to do next.
  </p>`;
}
