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
