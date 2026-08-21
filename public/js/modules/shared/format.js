// Number formatting, in one place.
//
// There were three near-identical copies of `money` across dashboard, orders
// and watchlist, all using toFixed(2) with NO thousands separator. So a
// position worth $1,438.50 printed as "$1438.50" and a cost basis of
// $21,850.70 as "$21850.70".
//
// That is not cosmetic. Joe read "$1444.00" off the Orders table as fourteen
// thousand and reported the figure as wrong -- it was correct, and unreadable.
// A financial app whose numbers can be misread by an order of magnitude has a
// correctness problem wearing a styling costume, and every broker statement it
// gets compared against uses separators.
//
// Intl.NumberFormat rather than a hand-rolled regex: it handles grouping,
// negative zero and locale conventions, and it is built in.

const MONEY = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Prices need finer resolution than totals: sub-dollar tickers and fractional
// quotes like 14.3513 lose real information at two decimals.
const PRICE = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

/** "$1,438.50" / "-$760.50" / "—" for null. */
export function money(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n < 0 ? "-" : ""}$${MONEY.format(Math.abs(n))}`;
}

/** Always signed: "+$6,204.99" / "-$2,969.26". For deltas, never for totals. */
export function signedMoney(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "-"}$${MONEY.format(Math.abs(n))}`;
}

/** A quoted price, keeping up to 4 decimals: "$14.3513". */
export function formatPrice(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `$${PRICE.format(n)}`;
}

/** Share counts. Whole numbers stay whole -- 100 shares is not "100.0000". */
export function formatQty(value) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return MONEY.format(n).replace(/\.00$/, "");
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** "+2.75%" / "-13.59%" / "—". */
export function percent(value, { signed = true } = {}) {
  if (value == null) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${signed && n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}
