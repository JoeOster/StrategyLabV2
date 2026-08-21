// The portfolio summary strip, in one place.
//
// Orders had a careful version of this -- null-aware, cash-aware, using the
// shared formatters -- and the Dashboard had its own lesser copy that used
// toFixed(2) with no thousands separator, had no notion of an unpriced
// position, and never showed cash at all. So the same portfolio read
// differently depending on which tab you were looking at, and only one of
// them was right.
//
// One strip, both views. The Dashboard inherits every correction Orders
// already had, and any future one lands in both places by construction.
import { money, signedMoney } from "./format.js";

export function renderSummary(s) {
  if (!s) return "";

  // An account can hold no shares and still hold money -- Schwab and
  // TradeStation each sit at $100. Returning early on positionCount === 0
  // printed "No open positions" and dropped the balance, which is the only
  // figure those accounts have. Empty of POSITIONS is not empty of VALUE.
  if (s.positionCount === 0) {
    if (s.cash == null) {
      return `<div class="summary-item"><span class="summary-label">No open positions</span></div>`;
    }
    return `
      <div class="summary-item"><span class="summary-label">Positions</span><span class="summary-value">0</span></div>
      <div class="summary-item"><span class="summary-label"${
        s.cashIsDerived
          ? ' title="Derived from the trade ledger — no opening balance recorded."'
          : ""
      }>Cash${s.cashIsDerived ? " *" : ""}</span><span class="summary-value">${money(s.cash)}</span></div>
      <div class="summary-item"><span class="summary-label">Account Total</span><span class="summary-value">${money(s.cash)}</span></div>`;
  }

  // A missing quote makes market value UNKNOWN, not zero and not equal to
  // cost. Rendering an em dash rather than a number is the whole point: this
  // strip previously showed market value identical to cost basis and
  // unrealized of exactly $0.00 whenever prices had not been fetched, which
  // reads as a confident break-even rather than an absence.
  const unknown = s.totalValue == null;
  const partial = !unknown && s.unpricedCount > 0;

  const unrealClass = unknown ? "" : s.unrealizedPnl >= 0 ? "change-up" : "change-down";
  const realClass = s.realizedPnl >= 0 ? "change-up" : "change-down";
  const totalClass = s.totalReturn >= 0 ? "change-up" : "change-down";

  const valueCell = unknown
    ? `<span class="summary-value" title="No prices fetched yet — use Refresh Prices">—</span>`
    : `<span class="summary-value">${money(s.totalValue)}${
        partial ? `<span class="summary-label"> (${s.pricedCount}/${s.positionCount} priced)</span>` : ""
      }</span>`;

  const unrealCell = unknown
    ? `<span class="summary-value">—</span>`
    : `<span class="summary-value ${unrealClass}">${signedMoney(s.unrealizedPnl)}${
        s.unrealizedPnlPercent == null
          ? ""
          : ` (${s.unrealizedPnlPercent >= 0 ? "+" : ""}${s.unrealizedPnlPercent.toFixed(2)}%)`
      }</span>`;

  return `
    <div class="summary-item"><span class="summary-label">Positions</span><span class="summary-value">${s.positionCount}${s.lotCount > s.positionCount ? `<span class="summary-label"> in ${s.lotCount} lots</span>` : ""}</span></div>
    <div class="summary-item"><span class="summary-label">Cost Basis</span><span class="summary-value">${money(s.totalCost)}</span></div>
    <div class="summary-item"><span class="summary-label">Market Value</span>${valueCell}</div>
    <div class="summary-item"><span class="summary-label" title="On current holdings only — this is the figure comparable to a broker’s total gain/loss.">Unrealized</span>${unrealCell}</div>
    ${
      // Cash and account total only appear for a single account: summing
      // balances across accounts gives a figure no statement shows.
      s.cash == null
        ? ""
        : `<div class="summary-item"><span class="summary-label"${
            s.cashIsDerived
              ? ' title="Derived from the trade ledger — no opening balance recorded, so this assumes the account began empty and every movement since is imported."'
              : ""
          }>Cash${s.cashIsDerived ? " *" : ""}</span><span class="summary-value">${money(s.cash)}</span></div>` +
          `<div class="summary-item"><span class="summary-label" title="Positions plus cash. Shown only when every position is priced — a total built on a partial market value would be a fragment with a confident label.">Account Total</span><span class="summary-value">${money(s.accountTotal)}</span></div>`
    }
    <div class="summary-item"><span class="summary-label">Realized</span><span class="summary-value ${realClass}">${signedMoney(s.realizedPnl)}</span></div>
    <div class="summary-item"><span class="summary-label">Dividends</span><span class="summary-value">${money(s.dividendIncome)}</span></div>
    <div class="summary-item"><span class="summary-label" title="Realized + dividends + unrealized. A broker’s “total gain/loss” is usually unrealized only, so these will not match.">Total Return</span><span class="summary-value ${totalClass}">${signedMoney(s.totalReturn)}${
      unknown ? '<span class="summary-label"> (realized only)</span>' : ""
    }</span></div>`;
}
