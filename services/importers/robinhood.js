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
const TYPE_BY_CODE = { Buy: "BUY", Sell: "SELL", CDIV: "DIVIDEND", REC: "BUY" };

// REC is shares RECEIVED -- a referral or promotional grant. It carries a
// quantity and no price at all, because nothing was paid.
//
// It has to be a BUY, not a skip. It opens a real lot, and skipping it orphans
// the eventual sale: 0.0147 CAT arrived 2025-01-27 and was sold 2025-10-14, and
// with REC unclassified that sale had no covering buy and was dropped. Free
// shares that later sell for money are exactly the kind of thing a journal
// must not lose.
//
// Cost basis is zero, which is what was actually paid. That makes the whole
// eventual proceeds show as gain -- correct for this app, which measures
// outcomes rather than tax, and flagged for review so the figure is never
// mistaken for a purchase price nobody recorded.
const ZERO_COST_CODES = new Set(["REC"]);

// Known-and-deliberately-ignored codes, with what they are, so nobody has to
// re-derive this later:
//   SLIP   stock-lending income -- carries a symbol, but mapping it to
//          DIVIDEND would inflate reported dividend income, so it is skipped
//   INT    cash interest        GOLD   subscription fee
//   FUTSWP futures sweep        RTP/ACH  cash transfers      MISC  adjustments
const KNOWN_NON_TRADE = new Set(["SLIP", "INT", "GOLD", "FUTSWP", "RTP", "ACH", "MISC"]);

// Cash movements worth recording, and what each is. These used to be counted
// as nonTrade and discarded, which was free only while every one of them
// predated an opening balance.
//
// GOLD is the only code with a fixed direction -- a subscription fee is never
// a credit. Everything else takes its direction from the sign of Amount, which
// is why `kind` is decided per row rather than per code: an ACH can be a
// deposit or a withdrawal, and a futures sweep goes both ways.
const CASH_CODES = new Set(["ACH", "RTP", "GOLD", "INT", "SLIP", "FUTSWP", "MISC"]);
const ALWAYS_FEE = new Set(["GOLD"]);

// Description fields carry an embedded newline (the CUSIP sits on line two),
// so only the first line is a usable label.
function firstLine(value) {
  return String(value ?? "").split(String.fromCharCode(10))[0].trim() || null;
}

export function parse(text) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "Activity Date");
  if (headerIdx === -1) throw new Error("Not a Robinhood activity export: no 'Activity Date' header row found.");

  const col = Object.fromEntries(rows[headerIdx].map((h, i) => [h.trim(), i]));
  const need = ["Activity Date", "Instrument", "Trans Code", "Quantity", "Price", "Amount"];
  const missing = need.filter((h) => !(h in col));
  if (missing.length) throw new Error(`Robinhood export missing expected column(s): ${missing.join(", ")}`);

  const out = [];
  const cash = [];
  const skipped = { nonTrade: 0, unknownCode: 0, noSymbol: 0 };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = toIsoDate(r[col["Activity Date"]]);
    if (!date) continue;

    const code = (r[col["Trans Code"]] ?? "").trim();
    const symbol = (r[col["Instrument"]] ?? "").trim().toUpperCase();
    const type = TYPE_BY_CODE[code];

    if (!type) {
      if (CASH_CODES.has(code)) {
        const amount = num(r[col["Amount"]]);
        // No amount means nothing moved, so there is nothing to record. Two
        // such rows exist in the real exports, both with every money column
        // blank.
        if (amount == null || amount === 0) { skipped.nonTrade++; continue; }

        const kind = ALWAYS_FEE.has(code) ? "FEE" : amount > 0 ? "DEPOSIT" : "WITHDRAWAL";
        cash.push({
          recordType: "CASH",
          cashKind: kind,
          // The broker's own label, kept so "what have I paid in subscription
          // fees" stays a GROUP BY rather than a search through prose.
          sourceCode: code,
          transactionDate: date,
          // Always positive; direction lives in cashKind, matching the
          // convention cash_transactions itself enforces.
          amount: Math.abs(amount),
          externalRef: fingerprint([date, "CASH", code, amount]),
          description: firstLine(r[col["Description"]]),
          raw: Object.fromEntries(Object.entries(col).map(([h, idx]) => [h, r[idx] ?? ""])),
        });
        continue;
      }
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

    const zeroCost = ZERO_COST_CODES.has(code);

    let unitPrice = price;
    if (type === "DIVIDEND") unitPrice = Math.abs(amount ?? 0);
    // Granted shares have no price and no amount. Left to the extrapolation
    // below, an empty amount would leave the price null and then default to 0
    // anyway -- but saying so explicitly stops a later change to that fallback
    // from silently inventing a cost for shares that had none.
    else if (zeroCost) unitPrice = 0;
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
      notes: zeroCost
        ? "Shares received at no cost (Robinhood REC). Cost basis recorded as $0, so the whole eventual sale shows as gain."
        : null,
      needsReview: zeroCost,
      raw: Object.fromEntries(Object.entries(col).map(([h, idx]) => [h, r[idx] ?? ""])),
    });
  }

  return { broker: BROKER, rows: out, cash, skipped };
}
