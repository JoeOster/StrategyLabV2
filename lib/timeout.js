// A ceiling on how long any outbound call may block.
//
// Nothing in this app had one. Every provider call -- Yahoo quotes, Yahoo
// history, Finnhub news, the two book lookups -- would wait indefinitely on a
// server that accepted the connection and then said nothing. TCP alone will
// sit there for minutes.
//
// That matters because of where those calls run. The alert scheduler ticks on
// a timer during market hours and the nightly job runs unattended; one hung
// socket stalls the tick that holds it. The re-entrancy guard added earlier
// stops ticks piling up behind it, which means the visible symptom is not a
// crash or an error but alerts quietly ceasing to fire -- the app looking
// perfectly healthy while doing nothing at all.
//
// A wrong answer is recoverable. Silence is not, because nobody goes looking
// for an alert that never arrived.

// Generous on purpose. This is a backstop against a hung socket, not a
// latency budget: Yahoo's history endpoint legitimately takes several seconds
// for a long range, and a timeout tight enough to be a performance control
// would start failing real requests.
export const DEFAULT_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 20000;

export class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} did not respond within ${ms}ms`);
    this.name = "TimeoutError";
    this.label = label;
    this.timeoutMs = ms;
  }
}

/**
 * Rejects if `promise` has not settled within `ms`.
 *
 * Racing does not cancel the underlying work -- for a library that owns its
 * own socket, like yahoo-finance2, there is nothing to cancel from out here.
 * What it does is stop the CALLER waiting, which is the thing that actually
 * breaks: the scheduler tick moves on and the next one runs.
 *
 * The losing promise is given a no-op catch. Without it, a request that times
 * out here and then fails on its own five minutes later surfaces as an
 * unhandled rejection with no context, long after anything could act on it --
 * a confusing crash caused entirely by the safety net.
 */
export function withTimeout(promise, { ms = DEFAULT_TIMEOUT_MS, label = "request" } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    // Deliberately NOT unref'd, though the instinct is to. An unref'd timer
    // does not hold the event loop open, so when the hung request is the only
    // thing left -- exactly the case in a CLI script or a cron job -- Node
    // exits before the timeout can fire. The caller then gets no error at all,
    // just a process that stops, which is the silent failure this module was
    // written to prevent, reintroduced by its own safety net.
    //
    // The cost of keeping it referenced is bounded by `ms`, and it is cleared
    // the moment the race settles either way.
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    // Attached after the race so it cannot swallow the rejection the caller
    // is about to see.
    Promise.resolve(promise).catch(() => {});
  });
}

/**
 * fetch() that actually aborts.
 *
 * Preferred over withTimeout wherever the call site owns the request, because
 * AbortSignal releases the socket instead of merely abandoning it. A handful
 * of stranded sockets per day is not a crisis, but it is avoidable here.
 */
export async function fetchWithTimeout(url, { ms = DEFAULT_TIMEOUT_MS, label, ...init } = {}) {
  const name = label ?? new URL(url, "http://localhost").host;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    // AbortSignal.timeout raises a DOMException named TimeoutError, which is
    // not this module's TimeoutError and carries no useful message. Rewritten
    // so a log line says which host went quiet and for how long.
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      throw new TimeoutError(name, ms);
    }
    throw err;
  }
}
