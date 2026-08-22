// Runs the ticker-research skill headlessly and returns the brief.
//
// The Research button could only ever hand over a phrase, because a skill is
// instructions rather than code -- there is no process to invoke from a web
// page. Claude Code's headless mode is the process: `claude -p "research APP"`
// loads the same skill file a chat session would and writes the brief to
// stdout.
//
// This is the one place in the app that executes something. That is worth
// stating plainly, because everything else here is a database read, an HTTP
// GET to a price provider, or a render. The rules below exist because of it.
import { spawn } from "node:child_process";
import db from "../lib/db.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tickers only. Letters, digits, dot and hyphen cover every US symbol form
// including BRK.B and RDS-A, and exclude everything that could be an argument,
// a path, or a shell metacharacter.
//
// Belt and braces: the symbol is validated here AND passed as an argv element
// rather than interpolated into a command line, so no shell ever parses it.
// Either alone would do; both because this is the endpoint that runs a program.
const SYMBOL = /^[A-Za-z0-9.\-]{1,12}$/;

// Web searches make this slow. Three minutes is generous rather than tight --
// the alternative to waiting is a brief that stops mid-sentence.
const TIMEOUT_MS = Number(process.env.RESEARCH_TIMEOUT_MS) || 180000;

// One at a time. Each run is a full model session; a user clicking Research on
// six tickers in quick succession should queue behind itself rather than
// launch six concurrent sessions against one subscription.
let inFlight = null;

export class ResearchUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ResearchUnavailableError";
  }
}

/**
 * @param {string} symbol
 * @returns {Promise<{symbol: string, brief: string, ms: number}>}
 */
export function runTickerResearch(symbol) {
  const clean = String(symbol ?? "").trim().toUpperCase();
  if (!SYMBOL.test(clean)) {
    throw new ResearchUnavailableError(`"${symbol}" is not a ticker symbol.`);
  }
  if (inFlight) {
    throw new ResearchUnavailableError(
      "A research run is already going. Each one is a full model session, so they run one at a time — try again when it finishes.",
    );
  }

  const started = Date.now();
  inFlight = new Promise((resolve, reject) => {
    // The npm user prefix is not on a non-interactive shell's PATH, and this
    // process inherits whatever systemd gave it. Named explicitly so the
    // endpoint does not depend on how the service happened to be started.
    const env = {
      ...process.env,
      PATH: `${process.env.HOME}/.npm-global/bin:${process.env.PATH}`,
    };

    // No shell. The symbol travels as its own argv element, so there is
    // nothing for a shell to interpret even if the regex above were wrong.
    // Exactly the tools the skill uses, and nothing else.
    //
    // A headless session cannot ask for approval, so without this it stops and
    // writes "I need permission" instead of a brief -- which is what the first
    // run did. --permission-mode bypassPermissions would also have worked and
    // is the wrong instrument: this subprocess is launched by a web request,
    // and a web request should not be able to start a session that can write
    // files or run arbitrary commands.
    //
    // curl is scoped to the app's own port. WebSearch and WebFetch are the
    // research half. There is deliberately no Write, no Edit, and no general
    // Bash -- the skill is told not to write to the database, and this makes
    // that structural rather than a matter of it following instructions.
    const allowedTools = [
      "Bash(curl:*)",
      "WebSearch",
      "WebFetch",
    ];

    const child = spawn("claude", ["-p", `research ${clean}`, "--allowedTools", ...allowedTools], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));

    const timer = setTimeout(() => {
      // SIGTERM first: a model session mid-write should be allowed to stop
      // rather than lose the socket, and the hard kill follows if it does not.
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, TIMEOUT_MS);

    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new ResearchUnavailableError(
              "Claude Code is not installed on this machine, so research cannot run here.",
            )
          : e,
      );
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const brief = out.trim();
      // A non-zero exit with usable output still counts. Headless runs can
      // exit oddly while having written a perfectly good brief, and throwing
      // away a finished answer over an exit code would be the wrong trade.
      if (brief) return resolve({ symbol: clean, brief, ms: Date.now() - started });
      reject(
        new ResearchUnavailableError(
          err.trim() || `Research exited with code ${code} and produced nothing.`,
        ),
      );
    });
  }).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/** Whether a run is currently going, for the UI to reflect. */
export function researchInFlight() {
  return inFlight !== null;
}

// --- Stored briefs ---------------------------------------------------------
//
// A brief is only true of the holding it was written against. "You are down 9%
// across two lots" stops being true the moment a third lot is bought, so the
// position is stored beside the text and compared on the way back out.
//
// There is no TTL and nothing expires. An old brief is not wrong, it is old,
// and that difference is the reason to keep it: a position closed at a loss in
// November should still carry the reasoning that was in front of you in June.

const insertNote = db.prepare(`
  INSERT INTO research_notes
    (security_id, holder_id, brief, duration_ms, shares_at_time, cost_basis_at_time,
     price_at_time, lots_at_time)
  VALUES
    (@securityId, @holderId, @brief, @durationMs, @shares, @costBasis, @price, @lots)
  RETURNING *
`);

const latestNote = db.prepare(`
  SELECT r.* FROM research_notes r
  JOIN securities s ON s.id = r.security_id
  WHERE s.symbol = @symbol AND r.holder_id = @holderId
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 1
`);

const noteHistory = db.prepare(`
  SELECT r.id, r.created_at, r.shares_at_time, r.cost_basis_at_time, r.price_at_time, r.duration_ms
  FROM research_notes r
  JOIN securities s ON s.id = r.security_id
  WHERE s.symbol = @symbol AND r.holder_id = @holderId
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT @limit
`);

/** The holding a brief is about, as it stands right now. */
function positionSnapshot(holderId, symbol) {
  const lots = db
    .prepare(
      `SELECT t.id AS lot_id, t.transaction_date, t.quantity_remaining, t.price, t.cost_basis
         FROM transactions t JOIN securities s ON s.id = t.security_id
        WHERE t.holder_id = ? AND s.symbol = ? AND t.transaction_type = 'BUY'
          AND t.quantity_remaining > 0 AND t.voided_at IS NULL
        ORDER BY t.transaction_date, t.id`,
    )
    .all(holderId, symbol);

  const price = db
    .prepare(
      "SELECT q.last_price FROM quotes_cache q JOIN securities s ON s.id = q.security_id WHERE s.symbol = ?",
    )
    .get(symbol)?.last_price ?? null;

  return {
    shares: lots.reduce((sum, l) => sum + l.quantity_remaining, 0),
    costBasis: lots.length
      ? lots.reduce((sum, l) => sum + (l.cost_basis / l.quantity_remaining) * l.quantity_remaining, 0)
      : null,
    price,
    lots,
  };
}

/**
 * The most recent brief for a ticker, and whether the position has moved since.
 *
 * @returns {null|{brief: string, createdAt: string, sharesAtTime: number,
 *   sharesNow: number, stale: boolean, changes: string[]}}
 */
export function latestResearch(holderId, symbol) {
  const clean = String(symbol ?? "").trim().toUpperCase();
  const note = latestNote.get({ symbol: clean, holderId });
  if (!note) return null;

  const now = positionSnapshot(holderId, clean);
  const changes = [];

  // A tolerance, not equality. Fractional share counts carry float noise, and
  // reporting "10.000000000000002 shares, now 10" as a change would make the
  // staleness flag meaningless within a week.
  if (Math.abs((note.shares_at_time ?? 0) - now.shares) > 1e-6) {
    changes.push(
      `held ${note.shares_at_time} share(s) then, ${now.shares} now`,
    );
  }
  // Price is reported when it has moved enough to matter to prose that quotes
  // it. Five percent rather than any movement: a brief is not wrong because
  // the stock ticked.
  if (note.price_at_time != null && now.price != null && note.price_at_time > 0) {
    const move = (now.price - note.price_at_time) / note.price_at_time;
    if (Math.abs(move) >= 0.05) {
      changes.push(
        `price was $${note.price_at_time.toFixed(2)}, now $${now.price.toFixed(2)} (${move >= 0 ? "+" : ""}${(move * 100).toFixed(1)}%)`,
      );
    }
  }

  return {
    id: note.id,
    brief: note.brief,
    createdAt: note.created_at,
    durationMs: note.duration_ms,
    sharesAtTime: note.shares_at_time,
    sharesNow: now.shares,
    priceAtTime: note.price_at_time,
    priceNow: now.price,
    lotsAtTime: note.lots_at_time ? JSON.parse(note.lots_at_time) : null,
    // Stale means "the thing it describes has changed", never "it is old".
    // Time alone does not make a brief wrong.
    stale: changes.length > 0,
    changes,
  };
}

/** Every brief written for a ticker, newest first, without their text. */
export function researchHistory(holderId, symbol, { limit = 20 } = {}) {
  return noteHistory.all({ symbol: String(symbol).trim().toUpperCase(), holderId, limit });
}

/** Stores a brief against the position it was written about. */
export function saveResearch(holderId, symbol, { brief, durationMs }) {
  const clean = String(symbol).trim().toUpperCase();
  const security = db.prepare("SELECT id FROM securities WHERE symbol = ?").get(clean);
  if (!security) throw new Error(`No security on file for ${clean}.`);

  const snap = positionSnapshot(holderId, clean);
  return insertNote.get({
    securityId: security.id,
    holderId,
    brief,
    durationMs: durationMs ?? null,
    shares: snap.shares,
    costBasis: snap.costBasis,
    price: snap.price,
    lots: JSON.stringify(snap.lots),
  });
}
