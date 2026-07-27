// The "Listeners & Buttons" file for Paper Trade. Reuses Orders' own
// form -> payload mapping (same fields, same validation rules) and just
// adds strategyId + forces isPaperTrade -- see orders/handlers.js.
import { orderFormToPayload, validateOrderPayload } from "../orders/handlers.js";

export function paperOrderFormToPayload(formData) {
  return { ...orderFormToPayload(formData), isPaperTrade: true };
}

export { validateOrderPayload };
