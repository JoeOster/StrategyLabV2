// Nightly maintenance job. Deliberately dependency-free -- a cron library
// would be a whole package to express "once a day at 01:00", and this app
// only ever needs the one schedule.
//
// Self-rearming setTimeout rather than a fixed setInterval: recomputing the
// delay each night keeps it correct across daylight-saving shifts, which a
// 24-hour interval would drift through.
import { refreshAllHistory } from "./watchlistService.js";
// Via alertScheduler rather than watchlistService: both schedulers must share
// one in-flight flag, or they can double-fire the same alert (BUG 7).
import { checkAlertsGuarded } from "./alertScheduler.js";
import { getGeneralSettings } from "./settingsService.js";

let timer = null;

/** ms until the next occurrence of `hour`:00 local time. */
export function msUntilNextRun(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Dividends and splits change rarely, so the nightly job only asks for them
 * once a week rather than every run -- halving the nightly call count.
 */
function shouldFetchEvents(now = new Date()) {
  return now.getDay() === 0; // Sunday
}

/**
 * @returns {Promise<object>} a result the caller can actually check. It does
 *   not throw: the nightly timer must re-arm no matter what happened. But
 *   swallowing the outcome entirely made `POST /api/scheduler/run-now` -- whose
 *   whole purpose is verifying this job works -- report `{ok: true}` even when
 *   every ticker failed or the provider was down (BUG 4). `ok` now means it.
 */
async function runNightlyJob() {
  const startedAt = new Date();
  console.log(`[scheduler] Nightly refresh starting at ${startedAt.toISOString()}`);

  try {
    const withEvents = shouldFetchEvents(startedAt);
    const results = await refreshAllHistory({ withEvents });
    const failed = results.filter((r) => r.error);
    const newBars = results.reduce((sum, r) => sum + (r.barCount || 0), 0);
    console.log(
      `[scheduler] History: ${results.length - failed.length}/${results.length} tickers ok, ` +
        `${newBars} bars checked${withEvents ? " (incl. dividends/splits)" : ""}` +
        `${failed.length ? `, ${failed.length} failed` : ""}`,
    );

    // Refresh quotes too, so alerts evaluated overnight use fresh prices.
    const fired = await checkAlertsGuarded();
    if (fired === null) {
      console.warn("[scheduler] Alert check skipped: the 15-minute poller is mid-check.");
    } else {
      console.log(
        `[scheduler] Quotes: ${fired.refreshedCount ?? 0} refreshed, ${fired.length} alert(s) fired`,
      );
    }

    // Every ticker failing is not a successful run, even though nothing threw.
    // That is precisely the "provider is down" case this endpoint exists to
    // catch, and it comes back as a full result set of per-ticker errors.
    const totalFailure = results.length > 0 && failed.length === results.length;
    return {
      ok: !totalFailure,
      error: totalFailure ? `All ${results.length} ticker(s) failed to refresh.` : undefined,
      tickers: results.length,
      failed: failed.length,
      newBars,
      alertsFired: fired?.length ?? null,
      withEvents,
    };
  } catch (err) {
    // Never let a failed run kill the timer -- tomorrow should still try.
    console.error("[scheduler] Nightly refresh failed:", err.message);
    return { ok: false, error: err.message };
  }
}

// How long to wait before trying again when we could not even read the
// settings. Short enough that a transient lock costs one delayed run, long
// enough not to spin.
const RETRY_DELAY_MS = 5 * 60 * 1000;

function scheduleNext() {
  // BUG 8: this read sits on the recursive path -- scheduleNext() is called at
  // startup AND after every run -- so one transient SQLITE_BUSY used to stop
  // the nightly job for the life of the process, with nothing logged to say
  // why it had gone quiet. Failing to read the settings must delay the job,
  // never end it.
  let settings;
  try {
    settings = getGeneralSettings();
  } catch (err) {
    console.error(
      `[scheduler] Could not read settings (${err.message}); retrying in ` +
        `${RETRY_DELAY_MS / 60000} min rather than giving up.`,
    );
    timer = setTimeout(scheduleNext, RETRY_DELAY_MS);
    if (typeof timer.unref === "function") timer.unref();
    return;
  }

  if (settings.nightly_refresh_enabled !== "1") {
    console.log("[scheduler] Nightly refresh disabled (Settings > General).");
    return;
  }

  const hour = clampHour(settings.nightly_refresh_hour);
  const delay = msUntilNextRun(hour);
  const runAt = new Date(Date.now() + delay);
  console.log(
    `[scheduler] Next nightly refresh at ${runAt.toLocaleString()} ` +
      `(in ${(delay / 3600000).toFixed(1)}h)`,
  );

  timer = setTimeout(async () => {
    await runNightlyJob();
    scheduleNext(); // re-read settings each night, so changes take effect
  }, delay);

  // Don't hold the process open just for this timer.
  if (typeof timer.unref === "function") timer.unref();
}

function clampHour(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 1;
}

export function startScheduler() {
  stopScheduler();
  scheduleNext();
}

export function stopScheduler() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Exposed so the job can be triggered manually for testing. */
export { runNightlyJob };
