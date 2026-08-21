// The "Listeners & Buttons" file for settings. The form<->API shape mapping
// lives here as pure functions so it can be tested without a browser.

// The dialog uses flat, prefixed field names (person_email, book_author) so
// every type's fields can coexist in one form. The API wants a nested
// { details: {...} } object with unprefixed keys. These two functions are the
// only place that translation happens.
const DETAIL_FIELDS = {
  person: ["email", "phone", "app_type", "app_handle"],
  group: ["primary_contact", "email", "phone", "app_type", "app_handle"],
  book: ["author", "isbn", "websites", "pdfs"],
  website: ["websites", "pdfs"],
};

/**
 * FormData -> API payload. Only the selected type's fields are read, so
 * leftover values typed into a different type's panel are discarded rather
 * than silently saved.
 */
export function sourceFormToPayload(formData) {
  const type = formData.get("type");
  const details = {};
  for (const field of DETAIL_FIELDS[type] || []) {
    const value = formData.get(`${type}_${field}`);
    details[field] = value != null && String(value).trim() !== "" ? String(value).trim() : null;
  }
  return {
    type,
    name: String(formData.get("name") || "").trim(),
    url: emptyToNull(formData.get("url")),
    description: emptyToNull(formData.get("description")),
    details,
  };
}

/** API source object -> flat field values for populating the edit form. */
export function sourceToFormValues(source) {
  const values = {
    id: source.id,
    type: source.type,
    name: source.name ?? "",
    url: source.url ?? "",
    description: source.description ?? "",
  };
  for (const field of DETAIL_FIELDS[source.type] || []) {
    values[`${source.type}_${field}`] = source.details?.[field] ?? "";
  }
  return values;
}

function emptyToNull(value) {
  const str = value == null ? "" : String(value).trim();
  return str === "" ? null : str;
}

export function generalFormToPayload(formData) {
  return {
    app_title: String(formData.get("app_title") || "").trim(),
    default_take_profit_percent: String(formData.get("default_take_profit_percent") || "").trim(),
    default_stop_loss_percent: String(formData.get("default_stop_loss_percent") || "").trim(),
    nightly_refresh_enabled: String(formData.get("nightly_refresh_enabled") ?? "1"),
    nightly_refresh_hour: String(formData.get("nightly_refresh_hour") || "1").trim(),
    alert_check_enabled: String(formData.get("alert_check_enabled") ?? "1"),
    alert_webhook_url: String(formData.get("alert_webhook_url") || "").trim(),
    alert_webhook_auth_header: String(formData.get("alert_webhook_auth_header") || "").trim(),
  };
}
