// Nightly maintenance job. Deliberately dependency-free -- a cron library
// would be a whole package to express "once a day at 01:00", and this app
// only ever needs the one schedule.
//
// Self-rearming setTimeout rather than a fixed setInterval: recomputing the
// delay each night keeps it correct across daylight-saving shifts, which a
// 24-hour interval would drift through.
import { refreshAllHistory, checkAlerts } from "./watchlistService.js";
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
    const fired = await checkAlerts();
    console.log(
      `[scheduler] Quotes: ${fired.refreshedCount ?? 0} refreshed, ${fired.length} alert(s) fired`,
    );
  } catch (err) {
    // Never let a failed run kill the timer -- tomorrow should still try.
    console.error("[scheduler] Nightly refresh failed:", err.message);
  }
}

function scheduleNext() {
  const settings = getGeneralSettings();
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
