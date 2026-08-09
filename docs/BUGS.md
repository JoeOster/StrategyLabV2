# Bugs

## Open (found via code review, 2026-08-09)

Found by reading `server.js`, every `services/*.js` file, and the frontend
under `public/js/` cold, cross-checked against `schema.sql`'s own
constraints -- not from any known-issue list. Two related findings from the
same pass (stock splits never applied to open lots; the HA webhook auth
header returned in plaintext) are **not** in this list -- splits were fixed
same-day (see `applySplitToOpenLots`/`recordBuy` in
`services/transactionsService.js`, verified by `6j`/`6k` in
`scripts/test-offline.js`); the webhook one is recorded below as a
deliberate deferral, not an open bug.

### 4. `/api/scheduler/run-now` always reports success, even when the job fails

**File:** `server.js:617-624` (route), `services/scheduler.js:29-53`
(`runNightlyJob`)

`runNightlyJob()` catches its own errors internally and only
`console.error`s -- it never rethrows, so the route's `catch` block is dead
code. Hitting `POST /api/scheduler/run-now` to manually verify the nightly
job (its own stated purpose, per the route's comment) always returns
`200 {"ok": true}`, even if Yahoo/Finnhub is down or `refreshAllHistory`
throws for every ticker. The only place the real failure shows up is the
server console.

**Fix:** let `runNightlyJob()`'s failure propagate (or return a
success/failure result the route actually checks) so this endpoint can be
trusted as a real health signal.

### 5. Journal idea execution has a double-execute race

**File:** `services/journalService.js:263-297` (`executeJournalIdea`)

No lock between reading `item.status` and writing `EXECUTED`. Two
near-simultaneous calls for the same idea (double-click "Execute", or a
client retry after a slow response) can both pass the status check before
either commits, both call `recordBuy()`, and both mark the idea executed --
recording the same trade twice with no error surfaced.

**Fix:** move the status check + `recordBuy()` + status update into one
`withTransaction`, checking status again as part of the same transaction
(or add a `WHERE status = 'WATCHING'` guard to the update and check
`changes` before proceeding).

### 6. Concurrent "add ticker" for a brand-new symbol can create duplicate `securities` rows

**File:** `services/priceService.js:62-88` (`getOrCreateSecurity`)

`securities` is `UNIQUE (symbol, exchange_id)`, but most callers pass no
exchange, so `exchange_id` is `NULL` -- and SQLite treats two `NULL`s as
distinct, so the constraint doesn't catch it. Two concurrent calls for the
same brand-new symbol (two browser tabs, or a Journal-idea add racing a
Watchlist add) can both miss the pre-insert lookup and both insert, since
`await yahoo.getProfile()` sits in between the check and the insert. A later
`getSecurityBySymbol().get()` (single row, no tie-break) silently picks one,
hiding whatever's attached to the other.

**Fix:** either a real DB-level uniqueness guard on `symbol` alone (a
partial unique index `WHERE exchange_id IS NULL`), or serialize
`getOrCreateSecurity` calls per-symbol in app code (e.g. an in-memory lock
map keyed by symbol) for the lifetime of one request.

### 7. Alert poller has no re-entrancy guard; nightly job and poller don't coordinate

**File:** `services/alertScheduler.js:82` (`setInterval`, no guard),
`services/scheduler.js:45` (nightly job's own `checkAlerts()` call)

Nothing stops a slow `checkAlerts()` cycle (network degradation, a stalled
webhook POST -- no fetch timeout anywhere) from still being in flight when
the next 15-min tick starts, or from overlapping the nightly job's own
`checkAlerts()` call if `nightly_refresh_hour` is ever set inside market
hours (it's user-editable, not restricted). Either overlap can fire the same
alert twice: duplicate `alerts` rows, duplicate HA webhook deliveries.

**Fix:** an in-memory "already running" flag around `checkAlerts()`, checked
by both schedulers.

### 8. An uncaught DB error before the scheduler's own try-block can crash the process or silently stop rescheduling

**File:** `services/alertScheduler.js:59`, `services/scheduler.js:56` +
`:70-73`

`getGeneralSettings()` (a synchronous read that can throw, e.g. on
`SQLITE_BUSY` past `lib/db.js`'s 5s lock timeout) sits *before* either
scheduler's own try/catch. No `process.on("unhandledRejection", ...)`
exists anywhere in the codebase, so Node's default (crash) applies in
`alertScheduler.js`. In `scheduler.js`, the equivalent call is inside
`scheduleNext()` -- called both at startup and recursively after each run --
so the same transient error can permanently stop the nightly job from ever
rescheduling again for the life of the process, with nothing logged to
explain why it just stopped.

**Fix:** wrap the settings read (or the whole scheduler tick) in its own
try/catch that logs and re-arms the timer regardless; add a top-level
`unhandledRejection` handler as a backstop either way.

### 9. Server error text reaches `innerHTML` unescaped in the ticker-detail dialog

**File:** `public/js/modules/dashboard/index.js:185`, `:203-206`; sink
originates at `server.js:611` (interpolates the raw `:symbol` URL param into
a JSON error message with no sanitization)

The only place in the whole frontend that breaks its own escape-everything
convention (every `render.js` routes through a shared `escapeHtml()`).
Today this isn't a one-click PoC -- `symbol` normally only reaches this path
after surviving `getOrCreateSecurity()` -> Yahoo's `quoteSummary()`, which
in practice rejects garbage/HTML-bearing tickers. But the frontend itself
has no defense-in-depth here; any future change that relaxes that gate (a
manual "add without lookup" option, a different provider, direct API access
once this is ever exposed beyond localhost) turns it into immediate
stored/reflected XSS with zero frontend change needed.

**Fix:** use `textContent` (or the existing `escapeHtml()`) instead of
`innerHTML`/`insertAdjacentHTML` in both spots.

### 10. `escape_price` / second take-profit target are stored but never evaluated

**File:** `services/watchlistService.js` -- `insertWatchedItem`/
`addWatchedItem` accept and store `escape_price`, `take_profit_2_low`,
`take_profit_2_high`; `getActiveWatching`'s column list omits all three, and
`isTriggered` never reads them.

A stop-loss (`escape_price`) or second take-profit target you set would
silently never fire -- no error, the data's just structurally excluded from
alert evaluation. Not reachable from the current UI (no `public/js` file
references these fields), so today's actual impact is low, but the backend
gap is real for any future caller (API integration, a UI that does add
these fields).

**Fix:** either wire these into `getActiveWatching`/`isTriggered`, or drop
the columns/inputs until there's a UI for them, so the schema doesn't
promise something the app doesn't do.

### 11. Watchlist's "Add Ticker" / "New List" dialogs don't reset on open or Cancel

**File:** `public/js/modules/watchlist/index.js:118-125` (Add Ticker),
`:391-395` (New List)

Every other "create" dialog in the app calls `.reset()` unconditionally on
open (Orders, Paper Trade, Journal ideas/strategies, Settings sources).
These two only reset on a *successful* submit. Cancel out of "Add Ticker"
with data typed in, reopen it, and the old symbol/price/notes are still
there -- edit just the symbol and submit, and you silently create an entry
with another ticker's leftover target price and notes.

**Fix:** call `.reset()` at the top of both open handlers, matching every
other dialog in the app.

### 12. Route error-handling mislabels unrelated failures as "could not resolve symbol"

**File:** `server.js:136-139` (`POST /api/watched-items`), `:460-463`
(`POST /api/journal/ideas`)

Both catch blocks unconditionally format *any* error from
`addWatchedItem`/`recordJournalIdea` as `502 Could not resolve "<symbol>":
<message>`, even when the real failure has nothing to do with symbol lookup
-- e.g. a stale/deleted `watchlistId` (a FK violation) or a missing
`sourceId` on a Journal idea. Wrong status class (502 implies an upstream
provider failure) and a misleading message that points at the wrong cause.

**Fix:** only use the "could not resolve" wording for errors actually
thrown by `getOrCreateSecurity`; let other errors from these functions keep
their own message and use 400 for bad input.

---

## Deliberately deferred (not forgotten, not urgent given local-only network)

### HA webhook auth header returned in plaintext, unauthenticated

**File:** `services/settingsService.js`, `server.js:228`
(`GET /api/settings/general`)

`alert_webhook_auth_header` (meant to hold a real Home Assistant long-lived
access token once it's filled in) is returned unmasked by an endpoint with
no auth at all -- anything else reachable on the local network could read it
with one GET request. Since HA is another NUC on the same local network
(not exposed outside it, per Joe), this isn't the "anyone on the internet
can read your token" scenario it would be for an internet-facing app -- but
it's still worth masking before the field actually holds a real token,
rather than relying on "nothing's on the LAN that would read it" forever.

**Deferred on purpose**, per Joe (2026-08-09): revisit when scripting the
dashboard side of the HA integration, not before -- that's the natural
moment to harden this API generally rather than as an isolated patch now.

---

## Fixed (historical record)

Kept for the record; nothing in this section is outstanding.

---

## 1. No way to delete from the Orders tab

**Reported:** "On the orders tab, there is no way to delete; you mentioned a
history, and I don't necessarily see where that might be."

Delete currently only exists as a ✕ on rows in the **History** sub-tab
(the tab sits next to "Open Positions" at the top of the Orders view). It is
not reachable at all from Open Positions, which is where you'd naturally look
after entering a bad order.

**Fix:** put a **Delete** button inside the Edit dialog, so it's reachable
from anywhere a transaction can be edited — Open Positions and History both.
Keep the confirm step; deleting a SELL restores shares to its lot, and
deleting an already-sold BUY is refused.

Also worth reconsidering: History being a sub-tab makes it easy to miss. It
may deserve a more obvious label or to be surfaced differently.

---

## 2. Watchlist: add a 10-day sparkline column

**Requested:** a small graph of the last ten days showing **$ change**, sized
to about **90% of the current row height**.

Data is already stored — `historical_prices` has daily bars, and the
Dashboard's detail dialog already renders a dependency-free inline SVG
sparkline (`public/js/modules/dashboard/render.js`, `renderSparkline`). That
function can be adapted rather than written fresh.

Notes for implementation:
- Plot **$ change**, not absolute price — so the baseline is the 10-day-ago
  close and the line shows movement from there.
- Needs the last 10 bars per watched security added to the watchlist list
  query (the current query returns only `history_days` / `history_latest`
  counts, not the series).
- Colour green/red by net direction, matching the existing convention.

---

## 3. (Spotted, not reported) Header buttons show on the wrong tabs

In the screenshot, the header still shows **Refresh History / Refresh Prices /
+ Add Ticker** while the **Orders** tab is active. Those are watchlist-only
actions.

Cause: `main.js` hides them in the view-switch click handler
(`watchlistActions.hidden = target !== "watchlist"`), but never sets the
initial state on page load — and the default view is now Dashboard, not
Watchlist. So they're visible until the first tab click.

**Fix:** set the initial visibility during `setupViewSwitching()` rather than
only on click.

Related: the Orders tab now has two "Refresh Prices" buttons — one in the
header (which shouldn't be there) and one in the panel. Fixing the above
removes the duplicate.
