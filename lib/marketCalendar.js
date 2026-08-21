// US equity market holidays, computed rather than listed.
//
// A hardcoded list of dates is the obvious implementation and it has an expiry
// date nobody notices: it works until the year it runs out, and then the app
// silently starts polling on Thanksgiving again with no error to say so. Every
// NYSE holiday follows a rule, so the rules are what is written down.
//
// The cost of getting this wrong is genuinely small -- a handful of wasted
// quote fetches a year against a market that returns Friday's stale prices.
// It is worth doing correctly and not worth doing elaborately, which is why
// there is no exchange feed here and no attempt at foreign markets.

const SUN = 0, MON = 1, THU = 4, FRI = 5, SAT = 6;

/** 'YYYY-MM-DD' for a UTC-constructed date. */
function iso(date) {
  return date.toISOString().slice(0, 10);
}

/** A date built in UTC, so no local timezone can shift the day. */
function utc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

/** The nth given weekday of a month -- 3rd Monday of January, and so on. */
function nthWeekday(year, month, weekday, n) {
  const first = utc(year, month, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utc(year, month, 1 + offset + (n - 1) * 7);
}

/** The last given weekday of a month -- Memorial Day is the last Monday of May. */
function lastWeekday(year, month, weekday) {
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return utc(year, month, last.getUTCDate() - offset);
}

/**
 * Easter Sunday, by the anonymous Gregorian algorithm.
 *
 * Needed only for Good Friday, which is the one NYSE holiday with no fixed
 * date and no weekday-of-month rule. It is also the one people forget: it moves
 * by over a month between years, so any hardcoded list gets it wrong first.
 */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utc(year, month, day);
}

/**
 * Moves a fixed-date holiday to the day the market actually closes.
 *
 * Saturday closes the Friday before, Sunday the Monday after. The exception is
 * New Year's Day: when 1 January falls on a Saturday the market does NOT close
 * on 31 December, because that would shut a day of the previous trading year
 * for a holiday belonging to the next one. Getting this wrong means treating a
 * normal, and unusually busy, final session as a holiday.
 */
function observed(date, { isNewYear = false } = {}) {
  const day = date.getUTCDay();
  if (day === SAT) {
    if (isNewYear) return null;
    return new Date(date.getTime() - 86400000);
  }
  if (day === SUN) return new Date(date.getTime() + 86400000);
  return date;
}

/**
 * Every NYSE holiday in a given year, as 'YYYY-MM-DD'.
 *
 * Juneteenth is included only from 2022, the first year it was observed. A
 * calendar that back-projects it would mark a day the market was open, which
 * matters if this is ever used to interpret historical price gaps rather than
 * only to decide whether to poll right now.
 */
export function marketHolidays(year) {
  const dates = [];
  const add = (d) => { if (d) dates.push(iso(d)); };

  add(observed(utc(year, 1, 1), { isNewYear: true }));      // New Year's Day
  add(nthWeekday(year, 1, MON, 3));                          // MLK Day
  add(nthWeekday(year, 2, MON, 3));                          // Washington's Birthday
  add(new Date(easterSunday(year).getTime() - 2 * 86400000)); // Good Friday
  add(lastWeekday(year, 5, MON));                            // Memorial Day
  if (year >= 2022) add(observed(utc(year, 6, 19)));          // Juneteenth
  add(observed(utc(year, 7, 4)));                             // Independence Day
  add(nthWeekday(year, 9, MON, 1));                          // Labor Day
  add(nthWeekday(year, 11, THU, 4));                         // Thanksgiving
  add(observed(utc(year, 12, 25)));                          // Christmas

  return dates.sort();
}

// Computed once per year on demand. There are ten dates in a year and the
// arithmetic is trivial, but this is called on every scheduler tick during
// market hours and there is no reason to redo it every fifteen minutes.
const cache = new Map();

function holidaySet(year) {
  let set = cache.get(year);
  if (!set) {
    set = new Set(marketHolidays(year));
    cache.set(year, set);
  }
  return set;
}

/**
 * Is this an Eastern-time date the US equity market is closed for?
 *
 * @param {string} easternDate 'YYYY-MM-DD' as reckoned in America/New_York.
 *   A string rather than a Date on purpose: "is it a holiday" is a question
 *   about the calendar day in New York, and passing a Date invites the caller
 *   to resolve that day using the server's own timezone -- which is how a
 *   deployment in another zone would decide the holiday started or ended at
 *   the wrong moment.
 */
export function isMarketHoliday(easternDate) {
  const year = Number(String(easternDate).slice(0, 4));
  if (!Number.isFinite(year)) return false;
  return holidaySet(year).has(easternDate);
}

/**
 * Days the market closes early, at 1:00pm Eastern.
 *
 * Not currently consulted by the scheduler. Polling between 1pm and 4pm on
 * these three days costs a dozen wasted fetches a year, against the risk of
 * treating a normal session as closed if one of these rules is wrong. Recorded
 * because working it out twice would be worse than writing it down once.
 */
export function earlyCloseDays(year) {
  const days = [];
  const july3 = utc(year, 7, 3);
  if (july3.getUTCDay() !== SAT && july3.getUTCDay() !== SUN) days.push(iso(july3));
  const thanksgiving = nthWeekday(year, 11, THU, 4);
  days.push(iso(new Date(thanksgiving.getTime() + 86400000))); // the Friday after
  const dec24 = utc(year, 12, 24);
  if (dec24.getUTCDay() !== SAT && dec24.getUTCDay() !== SUN) days.push(iso(dec24));

  // A day that is already a full holiday is not an early close. The two
  // collide whenever an observance lands on one of these: 3 July 2026 is the
  // observed Independence Day, and 24 December 2027 the observed Christmas.
  // Listed in both places, a caller that trusted this would reopen the market
  // for an afternoon it is shut.
  const holidays = holidaySet(year);
  return days.filter((d) => !holidays.has(d)).sort();
}
