// The "View" for the benchmark comparison. Pure functions, no DOM, no fetch.
import { money, signedMoney, percent } from "../shared/format.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function signedClass(v) {
  if (v == null) return "";
  return v >= 0 ? "change-up" : "change-down";
}

function stat(label, value, n, { hint = null, tone = "" } = {}) {
  const empty = value == null;
  return `
    <div class="summary-item">
      <span class="summary-label"${hint ? ` title="${escapeHtml(hint)}"` : ""}>${escapeHtml(label)}</span>
      <span class="summary-value ${empty ? "muted-cell" : tone}">${empty ? "—" : value}</span>
      <span class="summary-label stat-n">${n == null ? "" : `${n} trip${n === 1 ? "" : "s"}`}</span>
    </div>`;
}

/**
 * The headline comparison.
 *
 * The three return figures are shown together deliberately, and are all
 * computed over the same benchmarked subset so that they subtract: return
 * minus market equals excess, exactly. Any reader will try that arithmetic,
 * and three figures that fail it would cost the whole table its credibility.
 */
export function renderBenchmarkSummary(report) {
  if (!report) return "";
  const b = report.benchmark;
  const o = report.overall;

  if (!b.usable) {
    return `
      <div class="empty-state">
        <p><strong>No benchmark history for ${escapeHtml(b.symbol)}.</strong></p>
        <p class="panel-hint">
          Comparing a source against the market needs the market's daily closes over the same
          days you were holding. Fetch them once and this fills in.
        </p>
        <button type="button" id="benchmark-backfill-btn" class="primary">Fetch ${escapeHtml(b.symbol)} history</button>
      </div>`;
  }

  if (o.trips === 0) {
    return `
      <div class="empty-state">
        <p><strong>No closed round trips yet.</strong></p>
        <p class="panel-hint">
          A source can only be compared against the market once something has been bought
          and sold, so there are two dates to measure between.
        </p>
      </div>`;
  }

  return `
    <div class="summary-strip">
      ${stat("Your return", percent((o.averageReturn ?? 0) * 100), o.benchmarkedTrips, {
        hint: "Average return per closed round trip, across trips where the market could be compared.",
        tone: signedClass(o.averageReturn),
      })}
      ${stat(`${b.symbol} same days`, percent((o.averageMarketReturn ?? 0) * 100), o.benchmarkedTrips, {
        hint:
          `What ${b.symbol} did between the same two dates, matched trip by trip. ` +
          "Not a calendar-year figure -- a trade held nine days is compared against nine days.",
        tone: signedClass(o.averageMarketReturn),
      })}
      ${stat("Excess", percent((o.averageExcessReturn ?? 0) * 100), o.benchmarkedTrips, {
        hint:
          "Your return minus the market's over the same days. The part attributable to the " +
          "idea rather than to the weather. This is the figure a source should be judged on.",
        tone: signedClass(o.averageExcessReturn),
      })}
      ${stat(
        "Beat the market",
        o.beatMarketRate == null ? null : percent(o.beatMarketRate * 100, { signed: false }),
        o.benchmarkedTrips,
        { hint: "How often a round trip did better than simply holding the market for the same days." },
      )}
      ${stat("Realized", o.realizedPnl == null ? null : signedMoney(o.realizedPnl), o.scoredTrips, {
        hint: "Total realized P&L across these round trips. Transfers between accounts are excluded — they move shares, not money.",
        tone: signedClass(o.realizedPnl),
      })}
      ${stat("Avg held", o.averageHeldDays == null ? null : `${o.averageHeldDays.toFixed(0)}d`, null, {
        hint: "Average holding period. Short holds make the benchmark comparison noisier.",
      })}
      ${
        o.unbenchmarked > 0
          ? stat("Unbenchmarked", String(o.unbenchmarked), null, {
              hint:
                "Round trips whose market window could not be resolved — usually same-day trades, " +
                "or dates outside the fetched history. They are excluded from the figures above " +
                "rather than counted as zero.",
              tone: "muted-cell",
            })
          : ""
      }
    </div>`;
}

const COLUMNS = ["", "Trips", "Your return", "Market", "Excess", "Beat", "Realized"];

export function renderBenchmarkGroupHead() {
  return COLUMNS.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
}

/**
 * Attribution table.
 *
 * Sorted by EXCESS rather than raw return, because raw return is the number
 * this whole panel exists to stop people ranking on. Groups too thin to read
 * anything into are marked rather than hidden -- hiding them would misstate
 * how much evidence the ranking rests on.
 */
export function renderBenchmarkGroups(groups, { emptyMessage }) {
  if (!groups || groups.length === 0) {
    return `<tr><td colspan="${COLUMNS.length}" class="empty-row">${escapeHtml(emptyMessage)}</td></tr>`;
  }
  return [...groups]
    .sort((a, b) => (b.averageExcessReturn ?? -Infinity) - (a.averageExcessReturn ?? -Infinity))
    .map((g) => {
      const thin = g.benchmarkedTrips < 20;
      return `
      <tr${thin ? ' class="thin-sample"' : ""}>
        <td>${escapeHtml(g.label)}${
          thin
            ? ` <span class="thin-tag" title="Fewer than 20 benchmarked round trips. Far too few to separate skill from luck — a coin lands heads 20 times in a row often enough to matter here.">thin</span>`
            : ""
        }</td>
        <td>${g.trips}</td>
        <td class="${signedClass(g.averageReturn)}">${g.averageReturn == null ? "—" : percent(g.averageReturn * 100)}</td>
        <td class="${signedClass(g.averageMarketReturn)}">${g.averageMarketReturn == null ? "—" : percent(g.averageMarketReturn * 100)}</td>
        <td class="${signedClass(g.averageExcessReturn)}"><strong>${
          g.averageExcessReturn == null ? "—" : percent(g.averageExcessReturn * 100)
        }</strong></td>
        <td>${g.beatMarketRate == null ? "—" : percent(g.beatMarketRate * 100, { signed: false })}</td>
        <td class="${signedClass(g.realizedPnl)}">${g.realizedPnl == null ? "—" : signedMoney(g.realizedPnl)}</td>
      </tr>`;
    })
    .join("");
}
