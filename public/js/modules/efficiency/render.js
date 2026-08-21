// The "View" for the Efficiency report. Pure functions, no DOM, no fetch.
import { money, signedMoney, formatPrice, formatQty, percent } from "../shared/format.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A headline figure with its sample size attached.
 *
 * The N is not decoration. This report becomes useful at a sample size small
 * enough to be badly misleading -- one lucky fill reads as "100% beat rate" --
 * so every figure carries the count it was computed from, and a figure with no
 * data says so rather than showing a confident zero.
 */
function stat(label, value, n, { hint = null, tone = null } = {}) {
  const empty = value == null;
  const cls = empty ? "muted-cell" : tone === "signed" ? "" : tone ?? "";
  return `
    <div class="summary-item">
      <span class="summary-label"${hint ? ` title="${escapeHtml(hint)}"` : ""}>${escapeHtml(label)}</span>
      <span class="summary-value ${cls}">${empty ? "—" : value}</span>
      <span class="summary-label stat-n">${n == null ? "" : `${n} event${n === 1 ? "" : "s"}`}</span>
    </div>`;
}

function signedClass(v) {
  if (v == null) return "";
  return v >= 0 ? "change-up" : "change-down";
}

/** The top strip: the three questions this report exists to answer. */
export function renderEfficiencySummary(report) {
  if (!report || report.overall.events === 0) {
    return `
      <div class="empty-state">
        <p><strong>Nothing to measure yet.</strong></p>
        <p class="panel-hint">
          This report compares what a plan said against what actually happened. It fills in
          once exit rungs start firing, or once a buy is made against a BUY_LIMIT target.
        </p>
      </div>`;
  }

  const o = report.overall;
  const x = report.exits;

  return `
    <div class="summary-strip">
      ${stat(
        "Followed",
        o.followedRate == null ? null : percent(o.followedRate * 100, { signed: false }),
        o.decidedEvents,
        {
          hint:
            "Of the alerts you actually decided on, how many you acted on. Rungs declined as " +
            "'the rung was wrong' are excluded -- correcting a mistake is not a discipline failure. " +
            "Unanswered alerts are excluded too: they are not yet a decision.",
        },
      )}
      ${stat("Gap vs plan", o.gapTotal == null ? null : signedMoney(o.gapTotal), o.scoredEvents, {
        hint:
          "Total difference between the prices your plans named and the prices you got. " +
          "Positive means you did better than the plan.",
        tone: signedClass(o.gapTotal),
      })}
      ${stat(
        "...of which slippage",
        x.slippageTotal == null ? null : signedMoney(x.slippageTotal),
        x.slippageEvents,
        {
          hint:
            "The part of the gap that is yours: what happened between the alert firing and the " +
            "sale being made. The rest is overshoot -- how far past the level the price already " +
            "was when the rung fired, which is polling granularity and overnight gaps, not you.",
          tone: signedClass(x.slippageTotal),
        },
      )}
      ${stat(
        "Beat the plan",
        o.beatPlanRate == null ? null : percent(o.beatPlanRate * 100, { signed: false }),
        o.scoredEvents,
        { hint: "How often the price you got was better than the price the plan named." },
      )}
      ${
        o.acceptedNotBoughtCount > 0
          ? stat("Accepted, never bought", String(o.acceptedNotBoughtCount), null, {
              hint:
                "Entry alerts you accepted and then did not act on. This is the only place " +
                "it shows: there is no position, no P&L row, nothing else in the app that " +
                "records an idea you agreed with and never took.",
              tone: "change-down",
            })
          : ""
      }
      ${
        o.skippedCount > 0
          ? stat("Skipped on judgement", String(o.skippedCount), null, {
              hint: `The plan said act and you chose not to. ${money(o.notionalSkipped)} of shares at the planned prices.`,
              tone: "change-down",
            })
          : ""
      }
      ${
        x.staleCount > 0
          ? stat("Stale rungs", String(x.staleCount), null, {
              hint:
                "Rungs whose level was already well behind the market when they fired. These " +
                "inflate every figure above -- the ladder needs maintenance, it is not that " +
                "execution was good.",
              tone: "change-down",
            })
          : ""
      }
    </div>`;
}

const GROUP_COLUMNS = [
  { key: "label", label: "" },
  { key: "events", label: "Events" },
  { key: "followedRate", label: "Followed" },
  { key: "gapTotal", label: "Gap vs plan" },
  { key: "gapPercentAverage", label: "Avg gap" },
  { key: "beatPlanRate", label: "Beat plan" },
];

/**
 * Attribution table, by source or by strategy.
 *
 * Rows below a handful of events are marked rather than hidden. Hiding them
 * would misrepresent how much evidence the report rests on; marking them says
 * "this number exists but do not lean on it", which is the true statement.
 */
export function renderEfficiencyGroups(groups, { emptyMessage }) {
  if (!groups || groups.length === 0) {
    return `<tr><td colspan="${GROUP_COLUMNS.length}" class="empty-row">${escapeHtml(emptyMessage)}</td></tr>`;
  }
  return groups
    .map((g) => {
      const thin = g.events < 5;
      return `
      <tr${thin ? ' class="thin-sample"' : ""}>
        <td>${escapeHtml(g.label)}${
          thin
            ? ` <span class="thin-tag" title="Fewer than 5 events. Too little to read anything into.">thin</span>`
            : ""
        }</td>
        <td>${g.events}</td>
        <td>${g.followedRate == null ? "—" : percent(g.followedRate * 100, { signed: false })}</td>
        <td class="${signedClass(g.gapTotal)}">${g.gapTotal == null ? "—" : signedMoney(g.gapTotal)}</td>
        <td class="${signedClass(g.gapPercentAverage)}">${
          g.gapPercentAverage == null ? "—" : percent(g.gapPercentAverage * 100)
        }</td>
        <td>${g.beatPlanRate == null ? "—" : percent(g.beatPlanRate * 100, { signed: false })}</td>
      </tr>`;
    })
    .join("");
}

export function renderEfficiencyGroupHead() {
  return GROUP_COLUMNS.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
}

const OUTCOME = {
  accepted: { label: "followed", cls: "change-up" },
  declined: { label: "declined", cls: "change-down" },
};

/** The individual events, most recent first. The evidence behind the totals. */
export function renderEfficiencyEvents(events) {
  if (!events || events.length === 0) {
    return `<tr><td colspan="9" class="empty-row">No measurable events yet.</td></tr>`;
  }
  return events
    .map((e) => {
      const outcome = e.pending
        ? { label: "awaiting you", cls: "muted-cell" }
        : e.acceptedNotBought
          ? { label: "accepted, never bought", cls: "change-down" }
          : e.declineKind === "invalid"
            ? { label: e.kind === "ENTRY_ALERT" ? "target was wrong" : "rung was wrong", cls: "muted-cell" }
            : (OUTCOME[e.resolution] ?? { label: "—", cls: "muted-cell" });
      return `
      <tr${e.stale ? ' class="stale-row"' : ""}>
        <td>${escapeHtml(e.actualDate || (e.triggeredAt || "").slice(0, 10))}</td>
        <td><strong>${escapeHtml(e.symbol)}</strong></td>
        <td>${
          e.kind === "ENTRY"
            ? "entry fill"
            : e.kind === "ENTRY_ALERT"
              ? "entry signal"
              : escapeHtml(String(e.rungKind || "").toLowerCase().replace("_", " "))
        }</td>
        <td>${escapeHtml(e.sourceName || e.strategyTitle || "—")}</td>
        <td>${formatPrice(e.plannedPrice)}</td>
        <td>${formatPrice(e.actualPrice)}</td>
        <td>${formatQty(e.quantity)}</td>
        <td class="${signedClass(e.gapTotal)}">${e.gapTotal == null ? "—" : signedMoney(e.gapTotal)}</td>
        <td class="${outcome.cls}">${escapeHtml(outcome.label)}${
          e.stale
            ? ` <span class="thin-tag" title="This rung's level was already well behind the market when it fired, so its gap is overshoot rather than execution.">stale</span>`
            : ""
        }</td>
      </tr>`;
    })
    .join("");
}
