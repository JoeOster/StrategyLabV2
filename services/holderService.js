// There's no auth/login system -- this is a single-user personal app. Every
// route that needs a holder_id resolves it through here instead of each
// route reimplementing "find or create the one default holder."
import db from "../lib/db.js";

const getDefault = db.prepare("SELECT * FROM account_holders WHERE is_default = 1 LIMIT 1");
const insertDefault = db.prepare(
  "INSERT INTO account_holders (name, is_default) VALUES ('Me', 1) RETURNING *",
);

export function getOrCreateDefaultHolder() {
  return getDefault.get() ?? insertDefault.get();
}
