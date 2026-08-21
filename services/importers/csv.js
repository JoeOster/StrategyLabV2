// RFC4180 CSV parser. Written rather than pulled in as a dependency because
// this app deliberately runs on two pure-JS packages and nothing else.
//
// Handling quoted multi-line fields is not optional here: Robinhood's export
// genuinely contains them (a Description of "Oracle\nCUSIP: ...\nDividend
// Reinvestment" spans three physical lines). Splitting on newlines then commas
// silently shifts every column on those rows -- it does not throw, it just
// produces wrong data, which is the worst failure mode for an importer.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Money/quantity strings from broker exports: "$1,234.56", "($5.00)", "-30". */
export function num(raw) {
  let s = String(raw ?? "").trim().replace(/[$,\s]/g, "");
  if (!s) return null;
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) { negative = true; s = s.slice(1, -1); } // accounting negatives
  const v = Number.parseFloat(s);
  if (!Number.isFinite(v)) return null;
  return negative ? -v : v;
}

/** MM/DD/YYYY -> YYYY-MM-DD. Returns null if it isn't that shape. */
export function toIsoDate(raw) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/**
 * Stable fingerprint for a row, used as `transactions.external_ref`. Neither
 * broker export carries its own transaction id, so re-importing the same file
 * has to be a no-op by some other means -- that is what the partial
 * UNIQUE (account_id, external_ref) index over non-voided rows enforces.
 * Deliberately built from the economic facts of the trade only, so a broker
 * re-exporting with cosmetic differences still fingerprints identically.
 */
export function fingerprint(parts) {
  return parts.map((p) => String(p ?? "").trim().toUpperCase()).join("|");
}

/**
 * Makes every row's `externalRef` unique within one import.
 *
 * fingerprint() is built from the economic facts of a trade only, which is
 * what lets a broker re-export with cosmetic differences and still match. The
 * cost is that two GENUINELY identical trades -- same day, same symbol, same
 * quantity, same price, same amount -- fingerprint identically, and the
 * partial UNIQUE (account_id, external_ref) index then rejects the second.
 * Real case: two $20,000 FTRNX buys on 2025-01-21 in the Fidelity IRA.
 *
 * The Nth member of an identical group gets |#N appended. That stays stable
 * across re-imports -- the same file, or an overlapping export covering the
 * same dates, produces the same groups and therefore the same ordinals, so a
 * re-import is still a no-op.
 *
 * It does shift if an export splits an identical group across its boundary,
 * which is one more reason to overlap exports generously rather than trying
 * to abut them exactly (see docs/IMPORTS.md).
 */
export function disambiguateRefs(rows) {
  const seen = new Map();
  return rows.map((row) => {
    const n = (seen.get(row.externalRef) ?? 0) + 1;
    seen.set(row.externalRef, n);
    return n === 1 ? row : { ...row, externalRef: `${row.externalRef}|#${n}` };
  });
}
