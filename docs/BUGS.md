# Bugs

## Open (found by the "written but never read" sweep, 2026-08-21)

Found by `scripts/audit-columns.js`, written after BUG 10 turned out to be a
field that was stored and then never selected. That failure is always silent --
the write succeeds, the read simply never happens -- so it cannot be found by
using the app. The sweep is a lead generator, not an oracle: everything below
was verified by hand, and roughly as many candidates were dismissed.

### 13. Three Settings controls do nothing -- TWO NOW FIXED (2026-08-21)

**`default_take_profit_percent` and `default_stop_loss_percent` are consumed.**
They pre-fill the exit ladder, anchored to the thesis's average cost rather
than the live price -- a take-profit is a target relative to what was PAID.
Joe, asked directly: *"yes as thats what they are designed for."*

**`notification_cooldown_minutes` is still dead** and is the worse of the three,
because it reads as a safety control: someone setting "notify me at most every
30 minutes" gets no throttling at all. Either wire it up or take it out of the
UI -- a control that silently does nothing is worse than one that is not there.

Original report follows.

#### Original report

**File:** `public/index.html` (General settings form),
`services/settingsService.js` (`GENERAL_SETTING_DEFAULTS`)

`default_take_profit_percent`, `default_stop_loss_percent` and
`notification_cooldown_minutes` each have a labelled input in Settings > General,
are validated, saved and read back correctly -- and **nothing anywhere consumes
them.** Set "Default stop loss %" to 8 and it has no effect on anything.

The first two are the more annoying now that BUG 10 gave the Add Ticker and New
Idea dialogs a real stop-loss field: the obvious behaviour is for those defaults
to pre-fill it relative to the target price, which is presumably what they were
added for.

The cooldown is separate and slightly worse, because it reads as a safety
control: someone setting "notify me at most every 30 minutes" gets no throttling
at all. Note this is NOT the same gap as BUG 7 (which was two schedulers
overlapping, now fixed) -- a per-alert notification cooldown was never built.

**Fix:** either wire all three up, or take them out of the UI. A control that
silently does nothing is worse than one that is not there.

### 17. Dividend reinvestment bought no shares -- FIXED (2026-08-21)

**File:** `services/importers/fidelity.js`

`REINVESTMENT` was not in the action classification at all, so it fell through
to `skipped.unknownAction`. The matching `DIVIDEND RECEIVED` row imported
normally.

That one-sidedness is what made it quiet. The income appeared, so the account
looked like it was receiving its distributions; only the shares those
distributions bought were missing. A holding on a reinvestment plan therefore
drifts below its true share count by a little more every quarter, and market
value, cost basis and the realized P&L of any later sale all understate by a
margin that grows over time. Nothing throws, and every number on screen looks
reasonable.

Three real rows were affected across the two IRA exports -- FGRTX, FTRNX and
FCNTX. All three funds have since been transferred out and currently sit at
zero, so no open position is wrong today. Joe confirmed reinvestment is
something he does, so this would have recurred.

**Fixed:** `REINVESTMENT` classifies as `BUY`. Safe because the core
money-market sweeps (`SPAXX`, `FDRXX`, `FZFXX`, `FCASH`) are filtered out
before classification -- they generate a reinvestment row for every cash
movement, and treating those as purchases would invent a position in a cash
fund. Eight checks in section 23, including that sweep rows stay skipped.

**Note for the next import.** The three historical rows are still absent from
the ledger; the fix only affects imports run from now on. Re-importing
`IRA_b.csv` would add them, which is a change to closed historical positions
and should be reviewed in the import preview rather than applied blind.

### 14. `securities.asset_type` is never set -- FIXED (2026-08-21)

**File:** `services/priceService.js` (`insertSecurity`), `schema.sql:46`

The column enumerates seven types (`stock`, `etf`, `crypto`, `mutual_fund`,
`bond`, `option`, `cash`) and defaults to `stock`. Nothing ever writes it and
nothing reads it, so **everything in the database is a stock** -- including the
six Fidelity mutual funds that dominate the IRA import.

What makes this more than cosmetic: the Fidelity parser already *knows*.
`CASH_SYMBOLS` identifies money-market sweeps and a CUSIP regex identifies bonds
and CDs, both so they can be skipped. That classification is computed and thrown
away.

Impact today is latent -- nothing filters on it. It becomes real the moment
anything wants to treat a fund differently from a stock, which the backtester
in `V2_BACKLOG.md` certainly will.

**Fix:** have `getOrCreateSecurity` set it from the Yahoo profile's quote type,
and let the importers pass what they already worked out.

**Fixed.** Yahoo returns `quoteType` in the `price` module and the provider
was discarding it -- the data was there the whole time. `getProfile` now
returns it raw, `mapAssetType` translates it into this schema's vocabulary, and
`getOrCreateSecurity` writes it. An explicit `opts.assetType` wins over the
lookup, for a caller who worked it out from the statement.

Unrecognised types default to `stock` rather than null, because that is the
column's own NOT NULL default -- so an unmapped security is indistinguishable
from one written before this existed, which is the honest position. `INDEX`,
`CURRENCY` and `FUTURE` are deliberately left to fall through rather than being
forced into the nearest slot: a futures contract recorded as a stock is a worse
answer than the default.

`npm run db:backfill-asset-types` fills in existing rows, and takes `--dry-run`.
On the live database it reclassified **14 of 117**: nine mutual funds (not the
six this entry originally claimed) and five ETFs, one of them SPY -- the
benchmark every source is now measured against. Everything currently held is a
stock, which matches Joe's own description of how he trades.

The script is idempotent and fails safe. Re-running it immediately hit the
app's own 300-calls-per-60s usage budget; it reported those as "could not be
looked up" and left their stored values alone rather than clobbering them.

### 15. `dividends.pay_date` cannot be filled -- FIXED (2026-08-21, schema v20)

**File:** `services/priceService.js:210`, `services/providers/yahooProvider.js:106`

The column exists; the insert writes `(security_id, ex_date, amount, source)`
only. It is not an oversight that can simply be corrected: Yahoo's chart events
return an ex-date and an amount and no pay date, so there is nothing to put in
it from the current provider.

**Fix:** drop the column, or fill it from a provider that supplies it. Leaving a
column the app structurally cannot populate is the same "schema promises
something" smell as BUG 10.

### 16. `theme` is dead in both directions -- FIXED (2026-08-21, schema v20)

**File:** `services/settingsService.js` (`GENERAL_SETTING_DEFAULTS`)

Defaults to `"light"`. There is no control for it in Settings, nothing reads it,
and `public/css/style.css` contains no dark styling at all. Harmless -- unlike
#13 it promises the user nothing, because it is not on screen -- but it is a
leftover.

**Fix:** remove it, or build the theme it implies.

---

## Deliberately not listed above

Checked and dismissed, recorded so the next sweep does not re-raise them:

- `securities.first_seen_at`, `securities.data_source`,
  `securities.profile_updated_at` -- written automatically, never read.
  Provenance and audit fields; harmless. `profile_updated_at` does imply a
  "refresh stale profiles" feature that was never built.
- `historical_prices.adj_close` -- written and deliberately unused. See
  `services/transactionsService.js`'s note on adj_close/dividend
  double-counting: it is stored for a future backtester and consciously not
  applied. Intent, not neglect.
- Twelve settings form fields (`group_email`, `book_pdfs`, ...) that appear in
  no JavaScript. **False positives**: `sourceFormToPayload` reads them via a
  computed key, so the literal name never occurs in source.

**What this sweep cannot see.** It covers the column and setting axis only.
What made BUG 10 severe was not the missing column -- it was that `status`
doubled as "stop evaluating", so an item that alerted once could never fire its
stop. No column-level audit would have found that. State machines, unreachable
branches and dead conditions need a different pass.

---

## Fixed (found via code review, 2026-08-09)

**All nine were fixed on 2026-08-21.** Every one is recorded below.

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

### 18. Reconcile ignored what the account already held -- FIXED (2026-08-21)

**File:** `services/importers/reconcile.js`, `services/importService.js`

`reconcile()` built its picture of available shares from the buys inside the
file being imported, and nothing else. For a first import into an empty ledger
that is correct. For every import after it, it is wrong.

The actual workflow is a 60-day export once a month. Any sale of a position
bought more than 60 days earlier has its covering buy outside the file, so
reconcile saw an orphan sell and dropped it -- while the lot sat in the ledger
the entire time, plainly visible to any other query in the app.

Caught on the first real 60-day file: 18 KTOS sold 2026-08-04, bought
2026-06-01. Dropping it cost $140.97 of realized loss and left 18 phantom
shares. It was noticed only because the import preview was read this time; the
earlier Robinhood import went through curl with its `dropped` list unexamined,
which is how it survived at all.

**Fixed:** `stageImport` passes the account's current open lots by symbol, and
`reconcile` seeds its availability map with them. Held shares and in-file buys
add rather than replace.

Seeding makes reconcile more permissive, which is the safe direction here. A
row wrongly accepted is still caught downstream -- first by duplicate
classification, then by `recordSell`'s own oversell guard. A row wrongly
dropped is simply gone, and nothing later can notice it is missing.

The drop message changed too. It used to blame the export window exclusively,
which after this fix would name the wrong cause and send the reader off to
re-export a file that was never the problem.

Eleven checks in section 29, including that seeding does not let a sale exceed
what is held, and that one ticker's holdings cannot cover another's sale.

### Resolution of 15 and 16 (schema v20)

Both removed rather than implemented, in migration `020_drop_dead_columns.sql`.

`dividends.pay_date` was never an oversight that could simply be corrected:
Yahoo's chart events return an ex-date and an amount and no pay date, so the
column could not be filled from the only provider wired up. A nullable column
that is structurally unfillable reads to the next person as data that happens
to be missing, and they go looking for a bug that is not there. Re-adding it is
one `ALTER TABLE` on the day a provider supplies the field.

`theme` defaulted to `"light"` with no control, no reader, and no dark CSS
anywhere. Unlike `notification_cooldown_minutes` (v17) it promised the user
nothing, because it never appeared on screen. Building a theme because a
defaulted string exists would be the tail wagging the dog; if dark mode is
wanted it is a CSS decision first and a setting second.

Section 34 now checks that `schema.sql` and the migrations cannot disagree:
every column a migration drops must be absent from `schema.sql` and every
column one adds must be present. That drift has bitten this project twice --
the seed missing the migration ledger, then missing brokerages -- and both
times it surfaced as something unrelated breaking later. Verified separately
that a fresh init and the live migrated database have identical column sets
across all 29 tables; `transactions.plan_id` differs in POSITION only, because
`ALTER TABLE` appends while `schema.sql` declares it inline, and nothing reads
columns positionally.

### Market-holiday calendar -- ADDED (2026-08-21)

`isMarketOpen` treated Thanksgiving and Christmas as ordinary Mon-Fri sessions.
Costing a wasted poll or two a year, it had been documented as a known
limitation rather than fixed.

`lib/marketCalendar.js` computes the ten NYSE holidays from their rules rather
than listing dates. A hardcoded list works until the year it runs out, and then
the app silently starts polling on Thanksgiving again with nothing to say so.

Good Friday is the reason this is more than a lookup table: it has no fixed
date and no weekday-of-month rule, so it needs Easter, and it moves by over a
month between years -- 18 April in 2025, 3 April in 2026, 26 March in 2027.

Two details that a naive implementation gets wrong, both tested:

- A Saturday holiday closes the Friday before, EXCEPT New Year's Day, where
  closing 31 December would shut a session of the previous trading year for a
  holiday belonging to the next one.
- Juneteenth counts only from 2022, its first observed year. Back-projecting it
  marks a day the market was open, which matters if this is ever used to read
  historical price gaps rather than only to decide whether to poll now.

Early closes (1pm on 3 July, the Friday after Thanksgiving, Christmas Eve) are
computed but deliberately NOT consulted by the scheduler: polling those
afternoons costs a dozen fetches a year, against the risk of treating a normal
session as closed. They also had to be filtered against the holidays, since
3 July 2026 and 24 December 2027 are both full holidays -- listed in both
places, a caller would reopen the market for an afternoon it is shut.

Thirty-two checks in section 41.
