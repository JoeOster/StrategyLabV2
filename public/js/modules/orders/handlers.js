// The "Listeners & Buttons" file for orders. The form -> payload mapping is
// a pure function so the validation rules can be tested without a browser.

/**
 * FormData -> API payload. Field meaning shifts by transaction type:
 * a DIVIDEND has an amount rather than a per-share price and quantity, and
 * only a SELL can target a specific lot.
 */
export function orderFormToPayload(formData) {
  const transactionType = formData.get("transactionType");
  const base = {
    transactionType,
    symbol: String(formData.get("symbol") || "").trim().toUpperCase(),
    transactionDate: formData.get("transactionDate"),
    sourceId: emptyToNull(formData.get("sourceId")),
    notes: emptyToNull(formData.get("notes")),
  };

  if (transactionType === "DIVIDEND") {
    return { ...base, amount: toNumber(formData.get("price")), quantity: 0 };
  }

  const payload = {
    ...base,
    quantity: toNumber(formData.get("quantity")),
    price: toNumber(formData.get("price")),
    fees: toNumber(formData.get("fees")) ?? 0,
  };

  if (transactionType === "SELL") {
    const lotId = emptyToNull(formData.get("lotId"));
    if (lotId) payload.lotId = Number(lotId);
  }
  return payload;
}

/**
 * Client-side validation. Catches the obvious mistakes before a round trip;
 * the server re-validates regardless, since this can be bypassed.
 * @returns {string|null} error message, or null if valid
 */
export function validateOrderPayload(payload) {
  if (!payload.symbol) return "Ticker is required.";
  if (!payload.transactionDate) return "Date is required.";

  if (payload.transactionType === "DIVIDEND") {
    if (!(payload.amount > 0)) return "Dividend amount must be greater than zero.";
    return null;
  }
  if (!(payload.quantity > 0)) return "Quantity must be greater than zero.";
  if (payload.price == null || payload.price < 0) return "Price must be zero or greater.";
  return null;
}

function toNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(value) {
  const str = value == null ? "" : String(value).trim();
  return str === "" ? null : str;
}
