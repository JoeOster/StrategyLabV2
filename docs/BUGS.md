# Bugs

## Open (found via code review, 2026-08-09)

**Seven of the nine were fixed on 2026-08-21** (#4, 5, 7, 8, 9, 11, 12) and are
recorded below under "Fixed". The two left here are the ones that need a
decision rather than a patch.

Found by reading `server.js`, every `services/*.js` file, and the frontend
under `public/js/` cold, cross-checked against `schema.sql`'s own
constraints -- not from any known-issue list. Two related findings from the
same pass (stock splits never applied to open lots; the HA webhook auth
header returned in plaintext) are **not** in this list -- splits were fixed
same-day (see `applySplitToOpenLots`/`recordBuy` in
`services/transactionsService.js`, verified by `6j`/`6k` in
`scripts/test-offline.js`); the webhook one is recorded below as a
deliberate deferral, not an open bug.

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

### 4, 5, 7, 8, 9, 11, 12 — the contained half of the code-review batch (2026-08-21)

Fixed together, with the offline suite going from 372 to 382 checks. Kept as a
record because several of them are the same *shape* of bug and that shape is
worth recognising: **none of the seven would ever have thrown in normal use.**

- **#4 — `run-now` always reported success.** `runNightlyJob()` caught its own
  errors and never rethrew, so the route's `catch` was dead code and the
  endpoint whose entire purpose is verifying the nightly job returned
  `{ok: true}` even when every ticker failed. It now returns a result the route
  checks, and "every ticker failed" counts as a failure even though nothing
  threw.
- **#5 — journal double-execute race.** The status check was a plain read with
  an `await` between it and the write, so two overlapping calls both passed it
  and both recorded a BUY. The status is now re-asserted in the UPDATE's own
  `WHERE`, and zero changed rows aborts the transaction, rolling the loser's
  BUY back. This one only became fixable *properly* this session: recordBuy's
  network lookup used to force the write outside any transaction, and
  `recordBuyWith` now takes an already-resolved security.
  **Regression test:** four checks in `test-offline.js` that fire two executes
  with `Promise.allSettled`. Verified to fail without the fix.
- **#7 — no re-entrancy guard on alert checks.** A slow `checkAlerts()` could
  still be running when the next 15-minute tick started, or overlap the nightly
  job's own call, double-firing alerts and duplicating Home Assistant webhook
  deliveries. Both schedulers now go through `checkAlertsGuarded()` and share
  one in-flight flag, cleared in a `finally` so a failed check cannot wedge
  alerting off permanently.
- **#8 — a transient DB error could stop the nightly job forever.**
  `getGeneralSettings()` sat outside both schedulers' try/catch. In
  `scheduler.js` it is on the recursive re-arm path, so one `SQLITE_BUSY` used
  to end the nightly job for the life of the process with nothing logged. It
  now logs and retries in 5 minutes. A top-level `unhandledRejection` handler
  was added as a backstop, since Node's default is to crash.
- **#9 — server error text into `innerHTML`.** The two spots in the
  ticker-detail dialog now build a real element with `textContent`. Not
  exploitable today only because Yahoo's lookup rejects HTML-bearing tickers
  first; that was a gate, not a defence.
- **#11 — create dialogs didn't reset on open.** Cancelling "Add Ticker" with
  data typed in left it there, so reopening and changing only the symbol
  silently created an entry carrying the previous ticker's target price and
  notes. Both dialogs now `.reset()` on open, matching every other dialog.
- **#12 — route errors mislabelled.** Any failure from `addWatchedItem` /
  `recordJournalIdea` was reported as `502 Could not resolve "<symbol>"`, even
  a dead `watchlistId`. `getOrCreateSecurity` now tags genuine provider
  failures with `code = "SYMBOL_LOOKUP_FAILED"`, and only those get the 502;
  everything else keeps its own message and gets a 400.

**Not covered by the offline suite:** #4, #7 and #8 need network or timer
control the suite does not have. #5, #9, #11 and #12 all have regression
checks.

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
