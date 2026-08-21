# Bugs

## Open (found via code review, 2026-08-09)

**All nine were fixed on 2026-08-21.** Every one is recorded below under
"Fixed". Nothing from this review is outstanding.

Found by reading `server.js`, every `services/*.js` file, and the frontend
under `public/js/` cold, cross-checked against `schema.sql`'s own
constraints -- not from any known-issue list. Two related findings from the
same pass (stock splits never applied to open lots; the HA webhook auth
header returned in plaintext) are **not** in this list -- splits were fixed
same-day (see `applySplitToOpenLots`/`recordBuy` in
`services/transactionsService.js`, verified by `6j`/`6k` in
`scripts/test-offline.js`); the webhook one is recorded below as a
deliberate deferral, not an open bug.

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

### 10. Stop-loss and second take-profit never evaluated (2026-08-21) — schema v13

`addWatchedItem` accepted and stored `escape_price`, `take_profit_2_low` and
`take_profit_2_high`. `getActiveWatching` did not select them and `isTriggered`
never read them, so **a stop-loss you set was structurally incapable of
firing** — no error, no alert, the data simply excluded from evaluation. For a
stop, silence is the worst possible failure mode.

Wired up on Joe's instruction ("having a stoploss in place is going to be
commonly recorded"). Three things had to happen, and only the first was the
reported bug:

1. **The fields are selected and evaluated.** `isTriggered` is now a thin
   wrapper over `triggerReason`, which returns *which* level was crossed:
   `STOP`, `BUY`, `TAKE_PROFIT` or `TAKE_PROFIT_2`. The alert message names it
   — "target hit" is ambiguous once an item carries an entry, two take-profits
   and a stop, and a stop is the one you least want to read as good news.

   A regression check asserts mechanically that every `item.<field>`
   `triggerReason` reads is a column `getActiveWatching` selects. The unit
   tests pass plain objects straight in, so they would *not* have caught the
   original bug — the evaluator was correct, it was just never given the data.

2. **`alerts.trigger_reason`** (schema v13), a column rather than something to
   parse back out of `message`. This app exists to judge how reliable a source
   or methodology turned out to be, and an idea that hit its stop is the
   opposite outcome from one that hit its target. That has to be a `GROUP BY`.

3. **Items in `ALERT` status are still evaluated** — this one was found while
   testing, and without it the fix would have been cosmetic. `status` records
   what has *already* fired; it was also, wrongly, acting as "stop looking."
   So a plan that hit its take-profit dropped out of evaluation permanently,
   and its stop-loss could never fire afterwards. That is precisely the
   scenario the feature is for: the signal went out, the exit was missed, and
   the price then fell through the floor — in silence. It also made
   `take_profit_2` unreachable, since the first target is always crossed first.

   Now `WATCHING` and `ALERT` are both evaluated, with one alert per *level*
   per item (`alertAlreadyFiredForLevel`), so nothing re-fires on every
   15-minute poll while a price sits in a band. `EXECUTED`/`CANCELLED`/
   `EXPIRED` stay excluded — those plans are closed. Acknowledging an alert
   still does not re-arm anything, which was a deliberate earlier decision and
   is untouched.

**Entry points.** Both dialogs that record a plan — Watchlist "Add Ticker" and
Journal "New Idea" — now have an optional stop-loss field, and both routes
forward it. A stop at or above the target is rejected on both sides: it would
fire the instant it was evaluated and read as the feature being broken. The
field is hidden and cleared for `WATCH` items, which by definition never alert.
The watchlist table gained an optional "Stop" column.

**Migration.** v13 applied in place, like v12. `alerts` was empty, so the table
was dropped and recreated from `schema.sql` verbatim rather than `ALTER`-ed —
`ALTER TABLE ADD COLUMN` works and preserves the CHECK, but appends the column
in a different position than a fresh install, and a migrated database that
differs structurally from a new one is a puzzle waiting to happen. Backup
first, service stopped, `npm run db:stamp` after.

**Regression tests:** 26 checks — the trigger matrix, stop-outranks-target,
BUY_LIMIT stops, WATCH never firing, the reason persisting as a column, and the
missed-exit sequence (target fires, is missed, stop still fires, both on the
record). The structural invariant in point 1 was verified to fail without the
fix, naming the three fields it would have caught.



### 6. Duplicate `securities` rows (2026-08-21) — schema v12

Reported as a concurrency bug. It was two bugs, and the one that was *not* a
race was the easier one to hit.

**The deterministic half.** `getOrCreateSecurity` looked up by
`(symbol, exchange_id)` whenever an exchange was supplied, and by symbol alone
otherwise. Almost every row is stored with `exchange_id` NULL, because almost
no caller passes an exchange — so a single call that *did* supply one missed
the existing row and inserted a second. No concurrency required, fully
repeatable, and silent: the app reads by symbol and takes the first match, so
the duplicate does not error, it just hides whatever is attached to the other
row.

**The race.** `await yahoo.getProfile()` sits between the existence check and
the insert, so two overlapping calls for a brand-new ticker both missed and
both inserted.

**Fixed in three layers**, because each covers a case the others do not:

1. **Lookup is by symbol alone, always.** Symbol is how this app identifies a
   security everywhere else; the exchange-qualified path only ever created
   duplicates. This closes the deterministic half outright.
2. **`idx_securities_symbol` is now UNIQUE** (schema v12). The table's
   `UNIQUE (symbol, exchange_id)` never constrained anything real: NULLs do not
   compare equal, so it permitted unlimited duplicates. It is kept, annotated
   as subsumed, because dropping a table constraint means rebuilding the table.
   The cost is forgoing one ticker on two exchanges, which nothing supports.
3. **An in-flight promise map**, keyed on symbol, so overlapping calls share one
   lookup and both receive the same row. Cleared in a `finally`, or a failed
   lookup would poison every later call for that symbol.

Plus a catch-and-requery around the insert: the in-memory map covers one
process, and scripts run against the same database while the server is up —
the importer resolves a security per ticker, so a cross-process race is real
rather than theoretical. If another process won, its row is the right answer.

**Migration.** This is the first schema change applied *in place* rather than
by rebuilding. It is only an index, so no table rebuild was needed and no data
moved:

```
node -e "import('./lib/db.js').then(m=>m.default.exec(\"VACUUM INTO 'data/backups/strategylab_pre-v12.db'\"))"
systemctl --user stop strategylab
node -e "import('./lib/db.js').then(m=>{const d=m.default;d.exec('DROP INDEX IF EXISTS idx_securities_symbol');d.exec('CREATE UNIQUE INDEX idx_securities_symbol    ON securities(symbol)')})"
npm run db:stamp
systemctl --user start strategylab
```

Check for duplicate symbols *before* creating the index — it will refuse if any
exist. There were none (zero securities rows at the time). The six registered
accounts survived, which a rebuild would have destroyed: `init-db.js` seeds
exchanges, a holder and a watchlist, but **not** accounts.

**Regression tests:** six checks in `test-offline.js` section 2c, covering the
unique constraint, the NULL-exchange lookup, in-flight sharing, and that a
failed lookup does not poison later attempts. Verified to fail without the fix.



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
