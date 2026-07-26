// General app settings, exchanges, and account holders -- the "reference
// data" side of the Settings tab. Advice sources live in sourcesService.js
// because they're substantial enough to warrant their own file.
import db, { withTransaction } from "../lib/db.js";
import { SCHEMA_VERSION_KEY } from "../lib/schemaVersion.js";

// --- General settings (app_settings key/value) ------------------------------

// Whitelisted so a typo'd key from the UI can't quietly pollute app_settings
// with junk rows that nothing ever reads. schema_version is deliberately NOT
// here -- it's managed by db:init, not user-editable.
export const GENERAL_SETTING_DEFAULTS = {
  app_title: "Strategy Lab",
  default_take_profit_percent: "10",
  default_stop_loss_percent: "5",
  notification_cooldown_minutes: "30",
  theme: "light",
};

const getAllSettings = db.prepare("SELECT key, value FROM app_settings");
const upsertSetting = db.prepare(`
  INSERT INTO app_settings (key, value) VALUES (@key, @value)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);

/** Returns every general setting, falling back to defaults for unset keys. */
export function getGeneralSettings() {
  const stored = Object.fromEntries(getAllSettings.all().map((r) => [r.key, r.value]));
  const result = {};
  for (const [key, fallback] of Object.entries(GENERAL_SETTING_DEFAULTS)) {
    result[key] = stored[key] ?? fallback;
  }
  return result;
}

/**
 * Saves only recognized keys; silently ignores anything else.
 * @returns {{saved: string[], ignored: string[]}}
 */
export function saveGeneralSettings(patch) {
  const saved = [];
  const ignored = [];
  withTransaction(() => {
    for (const [key, value] of Object.entries(patch || {})) {
      if (key === SCHEMA_VERSION_KEY || !(key in GENERAL_SETTING_DEFAULTS)) {
        ignored.push(key);
        continue;
      }
      upsertSetting.run({ key, value: value == null ? null : String(value) });
      saved.push(key);
    }
  });
  return { saved, ignored };
}

// --- Exchanges --------------------------------------------------------------

const listExchangesQuery = db.prepare(`
  SELECT e.*, (SELECT COUNT(*) FROM securities s WHERE s.exchange_id = e.id) AS security_count
  FROM exchanges e ORDER BY e.code
`);
const insertExchange = db.prepare(
  "INSERT INTO exchanges (code, name, mic, timezone) VALUES (@code, @name, @mic, @timezone) RETURNING *",
);
const deleteExchangeStmt = db.prepare("DELETE FROM exchanges WHERE id = ?");

export function listExchanges() {
  return listExchangesQuery.all();
}

export function createExchange({ code, name, mic, timezone }) {
  const trimmedCode = String(code || "").trim().toUpperCase();
  if (!trimmedCode) throw new Error("Exchange code is required");
  return insertExchange.get({
    code: trimmedCode,
    name: String(name || trimmedCode).trim(),
    mic: mic || null,
    timezone: timezone || null,
  });
}

/**
 * securities.exchange_id is ON DELETE SET NULL, so deleting an exchange
 * orphans its securities rather than destroying them. That's recoverable but
 * confusing, so the count is returned for the UI to warn with.
 */
export function deleteExchange(id) {
  const result = deleteExchangeStmt.run(id);
  return { deleted: result.changes };
}

// --- Account holders --------------------------------------------------------

const listHoldersQuery = db.prepare(`
  SELECT h.*,
    (SELECT COUNT(*) FROM watched_items w WHERE w.holder_id = h.id) AS watched_count,
    (SELECT COUNT(*) FROM watchlists wl WHERE wl.holder_id = h.id) AS list_count,
    (SELECT COUNT(*) FROM accounts a WHERE a.holder_id = h.id) AS account_count
  FROM account_holders h ORDER BY h.is_default DESC, h.name
`);
const insertHolder = db.prepare(
  "INSERT INTO account_holders (name, is_default) VALUES (@name, @isDefault) RETURNING *",
);
const clearDefaultHolders = db.prepare("UPDATE account_holders SET is_default = 0");
const setDefaultHolder = db.prepare("UPDATE account_holders SET is_default = 1 WHERE id = ?");
const renameHolderStmt = db.prepare("UPDATE account_holders SET name = ? WHERE id = ?");
const deleteHolderStmt = db.prepare("DELETE FROM account_holders WHERE id = ?");
const countHolders = db.prepare("SELECT COUNT(*) AS n FROM account_holders");

export function listHolders() {
  return listHoldersQuery.all();
}

export function createHolder(name, { makeDefault = false } = {}) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Holder name is required");
  return withTransaction(() => {
    // First holder is always the default -- otherwise nothing would resolve
    // for getOrCreateDefaultHolder().
    const isFirst = countHolders.get().n === 0;
    const shouldDefault = makeDefault || isFirst;
    if (shouldDefault) clearDefaultHolders.run();
    return insertHolder.get({ name: trimmed, isDefault: shouldDefault ? 1 : 0 });
  });
}

export function renameHolder(id, name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) throw new Error("Holder name is required");
  return { updated: renameHolderStmt.run(trimmed, id).changes };
}

export function makeHolderDefault(id) {
  return withTransaction(() => {
    clearDefaultHolders.run();
    return { updated: setDefaultHolder.run(id).changes };
  });
}

/**
 * Deleting a holder CASCADEs to their watchlists, watched items, accounts and
 * transactions -- everything they own. Refuses to delete the last remaining
 * holder, since the app always needs one to resolve against.
 */
export function deleteHolder(id) {
  return withTransaction(() => {
    if (countHolders.get().n <= 1) {
      throw new Error("Cannot delete the only account holder.");
    }
    const wasDefault = db
      .prepare("SELECT is_default FROM account_holders WHERE id = ?")
      .get(id)?.is_default;
    const result = deleteHolderStmt.run(id);
    // Never leave the app with zero defaults -- promote whoever's left.
    if (result.changes > 0 && wasDefault) {
      const next = db.prepare("SELECT id FROM account_holders ORDER BY id LIMIT 1").get();
      if (next) setDefaultHolder.run(next.id);
    }
    return { deleted: result.changes };
  });
}
