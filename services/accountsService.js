// Brokerage accounts, and the brokerages themselves.
//
// The table has existed since schema v1 but nothing ever created a row -- there
// was no route and no service -- which blocked imports entirely, since
// `import_batches.account_id` is NOT NULL.
//
// Deliberately thin: an account is reference data (which brokerage, which
// number, what to call it), not something with derived values. The interesting
// numbers all live on `transactions` and are computed there.
//
// Brokerages became a table in v15. They were a CHECK-constrained enum, which
// made "I opened an account somewhere new" a schema migration -- v11 exists for
// no other reason than allowing 'schwab' and 'tradestation'. A list of firms is
// data.
import db from "../lib/db.js";

// --- brokerages ------------------------------------------------------------

const listBrokersStmt = db.prepare(`
  SELECT b.*,
         (SELECT COUNT(*) FROM accounts a WHERE a.broker_id = b.id) AS account_count
  FROM brokers b
  ORDER BY b.name
`);

const insertBrokerStmt = db.prepare(`
  INSERT INTO brokers (slug, name, has_parser) VALUES (@slug, @name, @hasParser)
  RETURNING *
`);

const updateBrokerStmt = db.prepare(`
  UPDATE brokers SET name = COALESCE(@name, name)
  WHERE id = @id
  RETURNING *
`);

const getBrokerStmt = db.prepare("SELECT * FROM brokers WHERE id = ?");
const brokerBySlugStmt = db.prepare("SELECT * FROM brokers WHERE slug = ?");

export function listBrokers() {
  return listBrokersStmt.all();
}

/**
 * Slug is derived from the name and then fixed forever.
 *
 * It is the key `importService` selects a parser by, so a brokerage renamed
 * from "E*TRADE" to "Morgan Stanley E*TRADE" must keep pointing at
 * `etrade.js`. Renaming changes the label; it never changes the wiring.
 */
export function createBroker({ name, slug = null } = {}) {
  const cleanName = String(name ?? "").trim();
  if (!cleanName) throw new Error("A brokerage needs a name.");

  const cleanSlug = String(slug ?? cleanName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (!cleanSlug) throw new Error("Could not derive a key from that name -- give one explicitly.");
  if (brokerBySlugStmt.get(cleanSlug)) throw new Error(`A brokerage with the key "${cleanSlug}" already exists.`);

  // has_parser is not a claim the user gets to make: it is whether a file
  // exists in services/importers/. Set here rather than asked for, so the
  // import screen cannot promise a parser that was never written.
  const hasParser = KNOWN_PARSER_SLUGS.has(cleanSlug) ? 1 : 0;

  return insertBrokerStmt.get({ slug: cleanSlug, name: cleanName, hasParser });
}

// Mirrors the modules in services/importers/. Kept as a constant rather than a
// directory read so it stays honest in a bundled or read-only deployment.
const KNOWN_PARSER_SLUGS = new Set(["fidelity", "etrade", "robinhood"]);

export function updateBroker(id, patch = {}) {
  const row = updateBrokerStmt.get({
    id,
    name: patch.name == null ? null : String(patch.name).trim() || null,
  });
  if (!row) throw new Error("Brokerage not found.");
  return row;
}

// --- accounts --------------------------------------------------------------

const insertAccount = db.prepare(`
  INSERT INTO accounts (holder_id, broker_id, account_number, account_type, nickname)
  VALUES (@holderId, @brokerId, @accountNumber, @accountType, @nickname)
  RETURNING *
`);

// Two different dates, because they answer two different questions and are
// routinely far apart: how current the *data* is, versus when an import last
// ran. An import done yesterday may only have carried data through last month.
//
// `last_transaction_date` is what tells you what to download next time -- see
// docs/IMPORTS.md on why it should be presented as a floor to start *before*
// rather than an exact boundary.
const listAccountsStmt = db.prepare(`
  SELECT
    a.*,
    b.name AS broker_name,
    b.slug AS broker_slug,
    b.has_parser,
    (SELECT COUNT(*) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL)                     AS transaction_count,
    (SELECT MAX(t.transaction_date) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL)                     AS last_transaction_date,
    (SELECT MIN(t.transaction_date) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL)                     AS first_transaction_date,
    (SELECT MAX(ib.imported_at) FROM import_batches ib WHERE ib.account_id = a.id) AS last_imported_at,
    (SELECT COUNT(*) FROM transactions t
      WHERE t.account_id = a.id AND t.voided_at IS NULL
        AND t.needs_review = 1 AND t.review_resolved_at IS NULL)             AS needs_review_count
  FROM accounts a
  JOIN brokers b ON b.id = a.broker_id
  WHERE a.holder_id = ?
  ORDER BY b.name, a.account_number, a.nickname
`);

const getAccountStmt = db.prepare(`
  SELECT a.*, b.name AS broker_name, b.slug AS broker_slug, b.has_parser
  FROM accounts a JOIN brokers b ON b.id = a.broker_id
  WHERE a.id = ? AND a.holder_id = ?
`);

const updateAccountStmt = db.prepare(`
  UPDATE accounts SET
    broker_id      = COALESCE(@brokerId, broker_id),
    account_number = COALESCE(@accountNumber, account_number),
    account_type   = COALESCE(@accountType, account_type),
    nickname       = COALESCE(@nickname, nickname)
  WHERE id = @id AND holder_id = @holderId
  RETURNING *
`);

/**
 * How an account is referred to everywhere: "Fidelity 146518557".
 *
 * Brokerage plus number, because that is how the statements are labelled and
 * how Joe identifies them. The nickname is a note, not the identity -- there
 * are two Fidelity accounts and "Wife brokerage" does not say which statement
 * belongs to it.
 */
export function accountLabel(account) {
  const parts = [account.broker_name ?? account.broker_slug];
  if (account.account_number) parts.push(account.account_number);
  const label = parts.filter(Boolean).join(" ");
  return account.nickname ? `${label} — ${account.nickname}` : label;
}

/** @returns {Array} accounts with import-currency fields attached */
export function listAccounts(holderId) {
  return listAccountsStmt.all(holderId).map((a) => ({ ...a, label: accountLabel(a) }));
}

export function getAccount(holderId, id) {
  const row = getAccountStmt.get(id, holderId);
  return row ? { ...row, label: accountLabel(row) } : null;
}

function resolveBrokerId(input) {
  if (input == null || input === "") return null;
  const asNumber = Number(input);
  if (Number.isInteger(asNumber) && asNumber > 0) {
    const byId = getBrokerStmt.get(asNumber);
    if (byId) return byId.id;
  }
  const bySlug = brokerBySlugStmt.get(String(input).trim().toLowerCase());
  if (bySlug) return bySlug.id;
  // Named explicitly rather than left to the foreign key: a constraint failure
  // surfaces as an opaque SQLite error, which is the exact trap that made ISBN
  // lookup look broken for weeks (see lib/schemaVersion.js v8).
  throw new Error(
    `Unknown brokerage "${input}". Known: ${listBrokers().map((b) => b.slug).join(", ")}`,
  );
}

export function createAccount(holderId, { broker, brokerId, accountNumber = null, accountType = null, nickname = null } = {}) {
  const resolved = resolveBrokerId(brokerId ?? broker);
  if (resolved == null) throw new Error("An account needs a brokerage.");
  return insertAccount.get({
    holderId,
    brokerId: resolved,
    accountNumber: accountNumber ? String(accountNumber).trim() : null,
    accountType: accountType ? String(accountType).trim() : null,
    nickname: nickname ? String(nickname).trim() : null,
  });
}

export function updateAccount(holderId, id, patch = {}) {
  const row = updateAccountStmt.get({
    id,
    holderId,
    brokerId: patch.brokerId != null || patch.broker != null ? resolveBrokerId(patch.brokerId ?? patch.broker) : null,
    accountNumber: patch.accountNumber ?? null,
    accountType: patch.accountType ?? null,
    nickname: patch.nickname ?? null,
  });
  if (!row) throw new Error("Account not found.");
  return row;
}

/**
 * Finds the account a statement filename belongs to.
 *
 * The reason account_number stopped living inside the nickname: a Fidelity
 * export is literally named `History_for_Account_266356256.csv`, so the monthly
 * audit can pick the account itself instead of asking every time.
 *
 * Returns null on anything ambiguous. Attaching a statement to the wrong
 * account would misfile every trade in it, so a guess is worse than a prompt.
 */
export function matchAccountByFilename(holderId, filename) {
  const digits = String(filename ?? "").match(/\d{4,}/g);
  if (!digits) return null;
  const candidates = listAccounts(holderId).filter(
    (a) => a.account_number && digits.some((d) => d === a.account_number || a.account_number.endsWith(d)),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * Accounts are never deleted here. `transactions.account_id` is
 * ON DELETE SET NULL, so removing one would orphan its trades into a nameless
 * pool rather than removing them -- the same "an order is never deleted"
 * reasoning that governs transactions themselves. Rename it instead.
 */
