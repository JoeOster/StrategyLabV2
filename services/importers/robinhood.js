// Robinhood account-activity CSV -> normalized rows.
//
// Format notes, verified against a real 267-line export (2026-08-21):
//  - the header is the first row, unlike Fidelity's.
//  - Description fields contain embedded newlines, so those 267 physical lines
//    are only 154 logical rows. Anything that splits on "\n" mangles ~40% of
//    the file without erroring. See csv.js.
//  - money uses accounting negatives: "($5.00)" means -5.00.
//  - quantities can be fractional to 5+ places (dividend reinvestment buys
//    0.00085 shares), so they must not be rounded to whole shares.
//  - Trans Code is a real column here (unlike Fidelity, where the type is
//    buried in prose), but most codes are cash events rather than trades.
import { parseCsv, num, toIsoDate, fingerprint } from "./csv.js";

export const BROKER = "robinhood";

// Only these three move share positions or income that StrategyLab models.
// Everything else in the export is cash-account noise -- counted and reported
// rather than silently dropped, so an import that skips half a file is
// visible instead of looking like a clean run.
const TYPE_BY_CODE = { Buy: "BUY", Sell: "SELL", CDIV: "DIVIDEND" };

// Known-and-deliberately-ignored codes, with what they are, so nobody has to
// re-derive this later:
//   SLIP   stock-lending income -- carries a symbol, but mapping it to
//          DIVIDEND would inflate reported dividend income, so it is skipped
//   INT    cash interest        GOLD   subscription fee
//   FUTSWP futures sweep        RTP/ACH  cash transfers      MISC  adjustments
const KNOWN_NON_TRADE = new Set(["SLIP", "INT", "GOLD", "FUTSWP", "RTP", "ACH", "MISC"]);

export function parse(text) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "Activity Date");
  if (headerIdx === -1) throw new Error("Not a Robinhood activity export: no 'Activity Date' header row found.");

  const col = Object.fromEntries(rows[headerIdx].map((h, i) => [h.trim(), i]));
  const need = ["Activity Date", "Instrument", "Trans Code", "Quantity", "Price", "Amount"];
  const missing = need.filter((h) => !(h in col));
  if (missing.length) throw new Error(`Robinhood export missing expected column(s): ${missing.join(", ")}`);

  const out = [];
  const skipped = { nonTrade: 0, unknownCode: 0, noSymbol: 0 };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = toIsoDate(r[col["Activity Date"]]);
    if (!date) continue;

    const code = (r[col["Trans Code"]] ?? "").trim();
    const symbol = (r[col["Instrument"]] ?? "").trim().toUpperCase();
    const type = TYPE_BY_CODE[code];

    if (!type) {
      if (KNOWN_NON_TRADE.has(code)) skipped.nonTrade++;
      else skipped.unknownCode++;
      continue;
    }
    if (!symbol) { skipped.noSymbol++; continue; }

    const quantity = num(r[col["Quantity"]]);
    const price = num(r[col["Price"]]);
    const amount = num(r[col["Amount"]]);

    const qty = type === "DIVIDEND" ? 0 : Math.abs(quantity ?? 0);
    if (type !== "DIVIDEND" && qty === 0) { skipped.unknownCode++; continue; }

    let unitPrice = price;
    if (type === "DIVIDEND") unitPrice = Math.abs(amount ?? 0);
    else if (unitPrice == null && amount != null && qty > 0) unitPrice = Math.abs(amount) / qty;

    out.push({
      externalRef: fingerprint([date, type, symbol, qty, unitPrice, amount]),
      transactionType: type,
      symbol,
      transactionDate: date,
      quantity: qty,
      // Robinhood charges no commission and the export has no fee column.
      fees: 0,
      price: unitPrice ?? 0,
      notes: null,
      needsReview: false,
      raw: Object.fromEntries(Object.entries(col).map(([h, idx]) => [h, r[idx] ?? ""])),
    });
  }

  return { broker: BROKER, rows: out, skipped };
}
