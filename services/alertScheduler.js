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
  const settings = getGeneralSettings();
  if (settings.alert_check_enabled !== "1") {
    return { skipped: "disabled" };
  }
  if (!isMarketOpen()) {
    return { skipped: "market-closed" };
  }
  try {
    const fired = await checkAlerts();
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
