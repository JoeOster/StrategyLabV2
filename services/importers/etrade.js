// E*TRADE "DownloadTxnHistory" CSV -> normalized rows.
//
// Format notes, verified against two real exports (2026-08-21):
//  - six preamble lines before the header ("All Transactions Activity Types",
//    an account line, a "Total:" line), so the header is located by content.
//  - E*TRADE splits its history by year: one export per "Current Year" and
//    "Prior Year". Both are just concatenated and de-duplicated by external
//    ref, the same as Fidelity's overlapping exports.
//  - "--" is the null placeholder, not an empty field. Left unhandled it
//    becomes a literal symbol named "--", which is the sort of thing that
//    creates a phantom holding rather than an error.
//  - Activity Type is an explicit column (like Robinhood's Trans Code, unlike
//    Fidelity's prose), and sells carry a negative Quantity.
import { parseCsv, num, toIsoDate, fingerprint } from "./csv.js";

export const BROKER = "etrade";

const TYPE_BY_ACTIVITY = {
  Bought: "BUY",
  Sold: "SELL",
  "Qualified Dividend": "DIVIDEND",
  Dividend: "DIVIDEND",
};

// E*TRADE's cash sweep, the counterpart to Fidelity's SPAXX. Interest accrues
// against it constantly; importing it would invent a holding in a bank deposit.
const CASH_SYMBOLS = new Set(["MSBNK", "ETSWEEP"]);

// Known-and-deliberately-ignored activity types. Counted separately from
// genuinely unrecognised ones so a skip count nobody needs to investigate
// does not look like a parser gap -- "Interest Income" is cash-sweep interest
// against MSBNK, not income against a holding.
const KNOWN_NON_TRADE = new Set(["Interest Income", "Transfer", "Journal", "Fee", "Adjustment"]);

/** "--" is E*TRADE's null. */
const clean = (v) => {
  const s = String(v ?? "").trim();
  return s === "--" || s === "" ? null : s;
};

export function parse(text) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "Activity/Trade Date");
  if (headerIdx === -1) throw new Error("Not an E*TRADE transaction export: no 'Activity/Trade Date' header row found.");

  const col = Object.fromEntries(rows[headerIdx].map((h, i) => [h.trim(), i]));
  const need = ["Activity/Trade Date", "Activity Type", "Symbol", "Quantity #", "Price $", "Amount $"];
  const missing = need.filter((h) => !(h in col));
  if (missing.length) throw new Error(`E*TRADE export missing expected column(s): ${missing.join(", ")}`);

  const out = [];
  const skipped = { cash: 0, nonTrade: 0, unknownActivity: 0, noSymbol: 0 };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = toIsoDate(r[col["Activity/Trade Date"]]);
    if (!date) continue; // preamble or trailing padding

    const activity = clean(r[col["Activity Type"]]) ?? "";
    const symbol = (clean(r[col["Symbol"]]) ?? "").toUpperCase();
    const type = TYPE_BY_ACTIVITY[activity];

    if (!type) {
      if (KNOWN_NON_TRADE.has(activity)) skipped.nonTrade++;
      else skipped.unknownActivity++;
      continue;
    }
    if (!symbol) { skipped.noSymbol++; continue; }
    if (CASH_SYMBOLS.has(symbol)) { skipped.cash++; continue; }

    const quantity = num(clean(r[col["Quantity #"]]));
    const price = num(clean(r[col["Price $"]]));
    const amount = num(clean(r[col["Amount $"]]));
    const fees = Math.abs(num(clean(r[col["Commission"]])) ?? 0);

    const qty = type === "DIVIDEND" ? 0 : Math.abs(quantity ?? 0);
    if (type !== "DIVIDEND" && qty === 0) { skipped.unknownActivity++; continue; }

    let unitPrice = price;
    if (type === "DIVIDEND") unitPrice = Math.abs(amount ?? 0);
    else if (unitPrice == null && amount != null && qty > 0) unitPrice = Math.abs(amount) / qty;

    out.push({
      externalRef: fingerprint([date, type, symbol, qty, unitPrice, amount]),
      transactionType: type,
      symbol,
      transactionDate: date,
      quantity: qty,
      price: unitPrice ?? 0,
      fees,
      notes: null,
      needsReview: false,
      raw: Object.fromEntries(Object.entries(col).map(([h, idx]) => [h, r[idx] ?? ""])),
    });
  }

  return { broker: BROKER, rows: out, skipped };
}
