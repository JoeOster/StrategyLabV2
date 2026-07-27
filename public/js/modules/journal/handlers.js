// The "Listeners & Buttons" file for Journal. Form -> payload mapping is a
// pure function so validation can be tested without a browser (mirrors
// public/js/modules/orders/handlers.js).

/** FormData -> API payload for the "+ New Idea" form. */
export function ideaFormToPayload(formData) {
  const orderType = formData.get("orderType");
  const payload = {
    symbol: String(formData.get("symbol") || "").trim().toUpperCase(),
    orderType,
    sourceId: emptyToNull(formData.get("sourceId")),
    strategyId: emptyToNull(formData.get("strategyId")),
    notes: emptyToNull(formData.get("notes")),
  };
  if (orderType !== "WATCH") {
    payload.targetPrice = toNumber(formData.get("targetPrice"));
  }
  return payload;
}

/** @returns {string|null} error message, or null if valid */
export function validateIdeaPayload(payload) {
  if (!payload.symbol) return "Ticker is required.";
  if (!payload.sourceId) return "A source is required -- that's the whole point of a Journal entry.";
  if (!["BUY_LIMIT", "SELL_LIMIT", "WATCH"].includes(payload.orderType)) return "Choose an idea type.";
  if (payload.orderType !== "WATCH" && !(payload.targetPrice > 0)) {
    return "Target price must be greater than zero.";
  }
  return null;
}

/** FormData -> API payload for the strategy dialog's base fields (title/notes only -- source tags are handled separately, see the strategySource* helpers below). */
export function strategyFormToPayload(formData) {
  return {
    title: String(formData.get("title") || "").trim(),
    notes: emptyToNull(formData.get("notes")),
  };
}

/** @param {{sources?: Array}} payload the base payload PLUS the pending-sources array (only checked for new strategies; index.js only calls this in create mode) */
export function validateStrategyPayload(payload) {
  if (!payload.title) return "Title is required.";
  if (payload.sources && payload.sources.length === 0) {
    return "At least one source is required.";
  }
  return null;
}

/** Reads the "add a source tag" mini-form inside the strategy dialog. Returns null if no source was chosen (so the caller can no-op instead of erroring). */
export function strategySourceFormToPayload({ sourceId, chapter, pageNumber, notes }) {
  const id = emptyToNull(sourceId);
  if (!id) return null;
  return {
    sourceId: Number(id),
    chapter: emptyToNull(chapter),
    pageNumber: emptyToNull(pageNumber),
    notes: emptyToNull(notes),
  };
}

/** FormData -> API payload for the "Execute" (turn idea into a real trade) dialog. */
export function executeFormToPayload(formData) {
  return {
    transactionDate: formData.get("transactionDate"),
    quantity: toNumber(formData.get("quantity")),
    price: toNumber(formData.get("price")),
    fees: toNumber(formData.get("fees")) ?? 0,
    notes: emptyToNull(formData.get("notes")),
  };
}

export function validateExecutePayload(payload) {
  if (!payload.transactionDate) return "Date is required.";
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
