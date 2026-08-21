// Fidelity "History for Account" CSV -> normalized rows.
//
// Format notes, all verified against a real export (2026-08-21):
//  - two blank lines precede the header, and a multi-paragraph legal disclaimer
//    follows the data, so neither end can be found by position. The header is
//    located by content, and data ends at the first row whose Run Date is not
//    a date.
//  - the transaction type lives in the Action prose, not a dedicated column:
//    "YOU BOUGHT", "YOU SOLD", "DIVIDEND RECEIVED", "REINVESTMENT",
//    "TRANSFERRED FROM". Some sells carry a confirmation number inline
//    ("YOU SOLD 26168JXHDC ONDAS INC..."), so match on the verb prefix only.
//  - sell quantities are negative and quoted ("-30").
//  - SPAXX is the core money-market sweep, not a position -- every cash
//    movement generates a REINVESTMENT/DIVIDEND pair against it. Importing
//    those would invent a holding that does not exist.
import { parseCsv, num, toIsoDate, fingerprint } from "./csv.js";
import { TRANSFER_OUT_REASON } from "../../lib/constants.js";

export const BROKER = "fidelity";

// Core money-market sweeps. Every cash movement generates reinvestment and
// dividend rows against these; importing them invents a holding in a cash fund.
// FDRXX is the Government Cash Reserves sweep, the sibling of SPAXX.
const CASH_SYMBOLS = new Set(["SPAXX", "FDRXX", "FZFXX", "FCASH"]);

// CUSIP shape: 9 alphanumerics including at least one digit. No ordinary
// ticker matches. Used to spot bonds and CDs, which this app cannot represent.
const CUSIP = /^(?=.*\d)[0-9A-Z]{9}$/;

// Fees and rounding mean quantity*price never exactly equals the cash amount,
// but they should agree closely. A large gap means the row does not follow
// share conventions at all -- which is how a $1,000 CD read as $100,000.
const AMOUNT_TOLERANCE_REL = 0.02;

export function parse(text) {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r[0]?.trim() === "Run Date" && r.some((c) => c.trim() === "Action"));
  if (headerIdx === -1) throw new Error("Not a Fidelity history export: no 'Run Date'/'Action' header row found.");

  const col = Object.fromEntries(rows[headerIdx].map((h, i) => [h.trim(), i]));
  const need = ["Run Date", "Action", "Symbol", "Price ($)", "Quantity", "Amount ($)"];
  const missing = need.filter((h) => !(h in col));
  if (missing.length) throw new Error(`Fidelity export missing expected column(s): ${missing.join(", ")}`);

  const out = [];
  const skipped = { cash: 0, bond: 0, unknownAction: 0, noSymbol: 0 };

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const date = toIsoDate(r[col["Run Date"]]);
    if (!date) continue; // disclaimer / blank padding

    const action = (r[col["Action"]] ?? "").trim();
    const symbol = (r[col["Symbol"]] ?? "").trim().toUpperCase();
    const quantity = num(r[col["Quantity"]]);
    const price = num(r[col["Price ($)"]]);
    const amount = num(r[col["Amount ($)"]]);
    const fees = (num(r[col["Fees ($)"]]) ?? 0) + (num(r[col["Commission ($)"]]) ?? 0);

    if (!symbol) { skipped.noSymbol++; continue; }
    if (CASH_SYMBOLS.has(symbol)) { skipped.cash++; continue; }

    // Bonds and CDs are quoted per $100 of face value, with Quantity carrying
    // the face amount in dollars -- so a $1,000 CD at par reads as qty 1000 @
    // px 100. Stock maths turns that into $100,000 and books a $99,000 phantom
    // loss on redemption, which is exactly what happened before this check.
    // This app has no concept of face value, coupons, accrued interest or
    // maturity, so such an instrument cannot be represented correctly here --
    // skipping it is honest, mangling it is not.
    if (CUSIP.test(symbol)) { skipped.bond++; continue; }

    const A = action.toUpperCase();
    let type = null;
    let needsReview = false;
    let reviewReason = null;

    if (A.startsWith("YOU BOUGHT")) type = "BUY";
    else if (A.startsWith("YOU SOLD")) type = "SELL";
    else if (A.startsWith("DIVIDEND RECEIVED")) type = "DIVIDEND";
    // Fund capital-gain distributions and bond interest: income against a
    // holding, no share movement. Same shape as a dividend.
    else if (A.startsWith("LONG-TERM CAP GAIN") || A.startsWith("SHORT-TERM CAP GAIN") || A.startsWith("INTEREST")) {
      type = "DIVIDEND";
    }
    // A bond called/matured -- the position genuinely leaves at par.
    else if (A.startsWith("REDEMPTION PAYOUT")) {
      type = "SELL";
    }
    // Shares moved OUT to another account. Found because without it the IRA
    // import implied seven positions that do not exist -- six Fidelity funds
    // and a bond -- while still matching every stock position, which is
    // exactly how a silent importer bug looks. It reduces the position, but it
    // is NOT a sale: there are no proceeds, so letting it compute realized
    // P&L would invent a gain or loss that never happened.
    else if (A.startsWith("TRANSFERRED TO")) {
      type = "SELL";
      needsReview = true;
      reviewReason = TRANSFER_OUT_REASON;
    }
    else if (A.startsWith("TRANSFERRED FROM")) {
      // Shares arriving from another account. Quantity is real; Price is empty
      // and Amount is the transfer *value*, not what was paid for them. Using
      // that as cost basis would silently corrupt realized P&L on every later
      // sale, so this is staged for a human rather than reconciled.
      type = "BUY";
      needsReview = true;
      reviewReason = "Transferred in from another account -- cost basis unknown (Amount is transfer value, not purchase price).";
    } else { skipped.unknownAction++; continue; }

    // DIVIDEND is exempt on purpose. A dividend, a fund capital-gain
    // distribution and bond interest are all income against a holding with NO
    // share movement, so their Quantity column is empty or zero -- which is
    // exactly what this guard rejects.
    //
    // Placed one line earlier, this discarded every dividend immediately after
    // correctly identifying it, and the comment directly below already said
    // "Dividends carry no share quantity". 49 income rows in one IRA's
    // statements vanished into skipped.unknownAction without a word.
    if (type !== "DIVIDEND" && (quantity == null || quantity === 0)) {
      skipped.unknownAction++;
      continue;
    }

    // Dividends carry no share quantity; everything else is a share count that
    // must be positive (direction is carried by `type`, not by the sign).
    const qty = type === "DIVIDEND" ? 0 : Math.abs(quantity);
    let unitPrice = price;
    // Extrapolate for sells too, not only buys. TRANSFERRED TO rows have an
    // empty Price column, so a BUY-only condition left them at price 0 -- which
    // books the whole cost basis as a realized loss. Found by running realized
    // P&L across the real ledger and getting a loss larger than the account.
    if (unitPrice == null && amount != null && qty > 0) unitPrice = Math.abs(amount) / qty;
    if (type === "DIVIDEND") unitPrice = Math.abs(amount ?? 0);

    // Cross-check the share maths against the cash actually moved. They should
    // agree within fees and rounding; a wide gap means the row does not follow
    // share conventions, and the figures cannot be trusted. Flagged rather than
    // dropped, because the trade is real even when the unit convention is not
    // understood -- and a silent 100x error is far worse than a visible flag.
    if (type !== "DIVIDEND" && amount != null && qty > 0 && unitPrice != null) {
      const implied = qty * unitPrice;
      const actual = Math.abs(amount);
      if (actual > 0 && Math.abs(implied - actual) > actual * AMOUNT_TOLERANCE_REL) {
        needsReview = true;
        reviewReason = `Quantity x price (${implied.toFixed(2)}) disagrees with the cash amount (${actual.toFixed(2)}) -- check the unit convention for this instrument.`;
      }
    }

    out.push({
      externalRef: fingerprint([date, type, symbol, qty, unitPrice, amount]),
      transactionType: type,
      symbol,
      transactionDate: date,
      quantity: qty,
      price: unitPrice ?? 0,
      fees: Math.abs(fees),
      notes: needsReview ? reviewReason : null,
      // Also carried on its own field. `notes` gets appended to downstream --
      // reconcile.js adds a line when it reduces a partly-covered sell -- so
      // notes cannot be compared against a known reason. This one is never
      // edited, which is what lets realized P&L recognise a transfer out.
      reviewReason: needsReview ? reviewReason : null,
      needsReview,
      raw: Object.fromEntries(Object.entries(col).map(([h, idx]) => [h, r[idx] ?? ""])),
    });
  }

  return { broker: BROKER, rows: out, skipped };
}
