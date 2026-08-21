// Market-hours price-alert polling. Separate from scheduler.js's nightly
// job on purpose: that one runs once a day for history backfill and a
// courtesy alert check; this one exists specifically so a BUY_LIMIT/
// SELL_LIMIT target gets noticed within 15 minutes of actually being hit,
// not just whenever someone happens to click "Refresh Prices" or the
// nightly job happens to run.
//
// Interval is a fixed 15 minutes, not user-configurable. Joe's own call --
// asked directly rather than assumed -- was "every 15 min during market
// hours"; there's no evidence yet that a shorter/longer interval or a
// configurable one is worth the extra Settings surface. If that changes,
// this is the one constant to edit.
import { checkAlerts } from "./watchlistService.js";
import { getGeneralSettings } from "./settingsService.js";

export const CHECK_INTERVAL_MS = 15 * 60 * 1000;

let timer = null;

// BUG 7: nothing used to stop a slow checkAlerts() cycle from still being in
// flight when the next 15-minute tick started, or from overlapping the nightly
// job's own call (nightly_refresh_hour is user-editable and can be set inside
// market hours). Either overlap fires the same alert twice: duplicate `alerts`
// rows and duplicate webhook deliveries to Home Assistant.
//
// One process, one flag. Both schedulers go through checkAlertsGuarded().
let checkInFlight = false;

/**
 * checkAlerts() behind an "already running" flag.
 *
 * @returns the fired-alerts array, or `null` if a check was already in flight
 *          and this call did nothing. Callers must distinguish the two: `null`
 *          is "skipped", `[]` is "ran, nothing fired".
 */
export async function checkAlertsGuarded() {
  if (checkInFlight) return null;
  checkInFlight = true;
  try {
    return await checkAlerts();
  } finally {
    // finally, not after the await: an exception must clear the flag too, or
    // one failed check wedges alerting off for the life of the process.
    checkInFlight = false;
  }
}

/**
 * Is the US stock market open right now? Regular session only (9:30am-4:00pm
 * Eastern, Mon-Fri) -- pre/post-market and 24-hour tickers aren't handled.
 *
 * Deliberately timezone-aware via Intl rather than trusting the server's own
 * clock/timezone: this app's deployment target (STATUS.md's "Deployment
 * target" section) may run in any local timezone, but "market hours" always
 * means Eastern time regardless of where the process happens to live.
 *
 * Known limitation, not fixed here: no market-holiday calendar. Thanksgiving,
 * Christmas, etc. will still be treated as open Mon-Fri sessions -- a wasted
 * poll or two a year, not a correctness bug worth the added complexity of a
 * holiday list yet.
 *
 * @param {Date} [now]
 */
export function isMarketOpen(now = new Date()) {
  const { weekday, hour, minute } = easternParts(now);
  if (weekday === "Sat" || weekday === "Sun") return false;
  const minutesSinceMidnight = hour * 60 + minute;
  const openAt = 9 * 60 + 30; // 9:30am ET
  const closeAt = 16 * 60; // 4:00pm ET
  return minutesSinceMidnight >= openAt && minutesSinceMidnight < closeAt;
}

function easternParts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/** One polling tick: checks the enabled flag and market hours, then defers to checkAlerts(). */
export async function runAlertCheckNow() {
  // BUG 8: getGeneralSettings() is a synchronous DB read that can throw --
  // SQLITE_BUSY past lib/db.js's 5s lock timeout, for one -- and it used to sit
  // OUTSIDE this try. There is no unhandledRejection handler by default, so a
  // throw here took the process down rather than skipping a tick.
  try {
    const settings = getGeneralSettings();
    if (settings.alert_check_enabled !== "1") {
      return { skipped: "disabled" };
    }
    if (!isMarketOpen()) {
      return { skipped: "market-closed" };
    }

    const fired = await checkAlertsGuarded();
    if (fired === null) {
      console.warn("[alertScheduler] Previous check still running -- skipping this tick.");
      return { skipped: "already-running" };
    }
    if (fired.length > 0) {
      console.log(`[alertScheduler] ${fired.length} alert(s) fired.`);
    }
    return { fired };
  } catch (err) {
    // Never let a failed tick kill the interval -- the next one should
    // still try, same reasoning as the nightly job's own try/catch.
    console.error("[alertScheduler] Check failed:", err.message);
    return { error: err.message };
  }
}

export function startAlertScheduler() {
  stopAlertScheduler();
  timer = setInterval(runAlertCheckNow, CHECK_INTERVAL_MS);
  // Don't hold the process open just for this timer.
  if (typeof timer.unref === "function") timer.unref();
}

export function stopAlertScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
