# Strategy Lab V2 — Status

Last updated: 2026-08-09 (code-reviewed the whole implementation cold —
server.js, every services/*.js file, the frontend — and found real gaps.
Fixed the one correctness bug that actually mattered: stock splits were
never applied to open lots, silently corrupting market value/P&L for
anything held across a real split. See "Orders" row below and
`applySplitToOpenLots`/`recordBuy` in `services/transactionsService.js`.
Everything else found (9 items, ranked by severity) recorded in
`docs/BUGS.md`'s "Open" section rather than fixed blind. Previous entry
(2026-07-27, scheduled alerts + webhook + graceful shutdown) is preserved
below.

Last updated 2026-07-27: scheduled alerts bell clicked through live; added
graceful server shutdown + npm run stop/restart; added webhook auth-header
support for Home Assistant; committed and pushed all of the above; decided to
migrate to the Orchestrator NUC, not yet executed; project shelved for a few
days after this. Read this first in any new session before touching code —
it's the "external brain" for where this project is and why.

## Picking this back up after a break

Everything through the scheduled-alerts feature is built, offline-tested, and
now also verified live in a real browser (see "Clicked through for real
(2026-07-27)" under "Scheduled alerts + webhook delivery" below). Nothing is
mid-edit and nothing is known-broken as of this date — safe to leave as-is.

Two things worth knowing before diving back in:
- **The dev server can outlive its terminal — but there are now scripts for
  this.** `npm start` on Windows runs `node server.js` through an extra
  `cmd.exe` layer (that's how npm itself works on Windows, regardless of
  what the `start` script says), so closing the terminal window doesn't
  always kill the actual `node.exe` grandchild — it can detach and keep
  holding the port with nothing left to `Ctrl+C`. Two fixes, added
  2026-07-27:
  - `server.js` now has `SIGINT`/`SIGTERM` handlers (stop both schedulers,
    close the DB, then exit) — live-tested in the sandbox: sent both
    signals to a running instance, confirmed the shutdown log line prints
    and the process exits almost immediately (not force-killed), and
    confirmed a second instance can rebind the same port right away, so the
    old one isn't left holding it.
  - ~~`npm run stop` / `npm run restart` (`scripts/stop-server.ps1`)~~ —
    **removed 2026-08-21** along with the PowerShell script, when the app
    moved onto the orchestrator NUC. They were Windows-only and dead on
    Linux. The systemd unit replaces them:
    `systemctl --user restart strategylab`, which delivers SIGTERM to the
    handler above. See `docs/MIGRATION.md`.
- **The webhook has a real destination picked now, just not typed in yet.**
  Plan (decided with Joe 2026-07-27, see "Where this webhook is actually
  headed" under "Scheduled alerts + webhook delivery" below): notifications
  go to Home Assistant via its authenticated `/api/services/notify/<target>`
  REST endpoint, and separately Becca (the Gemini voice assistant in
  `ai_orchestrator`) will read alert data for a daily brief and dismiss the
  bell by voice. The code side is fully ready for the HA half — `Settings >
  General` has both `Alert webhook URL` and a new `Alert webhook auth
  header` field (sends whatever's pasted in verbatim as the request's
  `Authorization` header, e.g. `Bearer <ha-long-lived-token>`). **Not done
  yet, and not this app's job to do**: Joe typing his actual HA target +
  token into those two fields himself (entering credentials on someone's
  behalf isn't something to do even when handed them directly — Joe's own
  session rule). The Becca half needs zero new work here at all —
  `GET /api/alerts`, `GET /api/summary`, and the acknowledge endpoints
  already do exactly what that side needs; what's missing is entirely a
  not-yet-built NUC-side service in `ai_orchestrator`.

Suggested first move next session: `npm install && npm start`, confirm it
still runs, then either fill in the HA webhook URL/token in Settings (see
above), start the Imports feature (largest unbuilt piece, see "Suggested
next steps" at the bottom), or click through the other not-yet-clicked-through
UI layers listed in "Module status" below.

## What this project is

A personal trading dashboard, watchlist, and strategy journal. This is Joe's
fourth attempt at this app. The first three (`Strategy_Lab`, an earlier
`StrategyLabV2` false start, and `TradeMentorAI`, all sibling folders under
`C:\Projects`) stalled out — mostly from an AI coding agent (Gemini/GCA)
losing track of its own file state, contradicting itself mid-task, and
slowly tangling the codebase. See `docs/DB_ARCHITECTURE.md`'s "Why it got
messy before" section for specifics, and ask Joe for "the story" if you want
the full history — he has it from an earlier conversation.

Core idea across all attempts, carried into this one: track real holdings
(Dashboard), watch price targets and get alerted (Orders), import broker CSVs
(Imports), and keep a strategy/advice journal that links paper trades to a
specific book/guru/source and can later "execute" them into real transactions
(Journal / Strategy Lab tab).

Explicitly **Phase 2, not started**: AI-assisted trade evaluation and
strategy backtesting. Deferred on purpose until the core app is solid.

## Module status

| Module | Status |
|---|---|
| Database schema | Done, tested |
| Orders / Watchlist (backend service) | Done, tested (including live data) |
| Orders / Watchlist (web UI + API) | Built, **not yet run** — see "verification boundary" below |
| Price data pull (Yahoo/Finnhub) | Done, tested (Yahoo and Finnhub both live-verified) |
| Historical price storage | Backfills 2yr daily OHLCV + dividends/splits on ticker add; `POST /api/refresh-history` re-runs for all watched tickers. Storage/idempotency tested offline; live backfill not yet run |
| Orders (log buys/sells, positions, history) | Built with full lot accounting; services heavily tested offline (371 checks total as of 2026-08-09, up from 360), UI not yet clicked through. **Stock splits are now applied to open lots** (`applySplitToOpenLots`, plus `recordBuy` auto-catches-up a backdated entry against any already-known split) — before 2026-08-09 this was a real, untested gap: the `SPLIT_ADJ` transaction type was modeled in the schema and split events were already being fetched into the `splits` cache table, but nothing ever rescaled a lot's `quantity`/`quantity_remaining` when a held security actually split |
| Dashboard | Card grid + table toggle + click-through ticker detail built; services tested offline, UI not yet clicked through |
| Imports | Not started |
| Journal / Strategy Lab | Service + UI built (strategies many-to-many with sources as of schema v5, paper ideas, execute-into-real-trade); services tested offline, UI not yet clicked through |
| Paper Trade tab | Full paper-trading simulator built on schema v6 (`transactions.strategy_id` + existing `is_paper_trade` scoping); services tested offline (336 checks total), clicked through live (log → promote → lands in Orders) |
| Settings | First pass done: Lists, Advice Sources, Account Holders, Exchanges, General. Services tested offline; UI not yet clicked through |
| Scheduled alerts + webhook delivery | Market-hours polling (15 min, Mon-Fri 9:30-4:00 ET), header bell with acknowledge, generic outbound webhook hook with optional Authorization header (for HA's authenticated notify endpoint). Services tested offline (360 checks total); clicked through live (badge, dismiss, and dismiss-all all confirmed against real fired alerts); webhook URL/token not yet filled in |
| AI trade advisor / backtesting | Not started — Phase 2 |

## Why this tech stack

- **SQLite via Node's built-in `node:sqlite`**, not `better-sqlite3`.
  `better-sqlite3` needs a native binary; Joe's Windows machine doesn't have
  the Visual Studio C++ build tools node-gyp needs to compile it, and no
  prebuilt binary existed for his Node version. `node:sqlite` ships inside
  Node itself — nothing to ever compile. Requires Node >=22.5.0.
- **`yahoo-finance2@^3.15.3`, pinned specifically.** The 2.x line (what an
  unpinned/loose range resolves to) is a slimmer rewrite-in-progress that
  only wires up `quote` + `autoc` — no `chart`, `quoteSummary`, historical,
  dividends, or splits. 3.x has the full module set. If `npm install` ever
  drifts you back to 2.x, that's why `quoteSummary`/`chart` calls will fail
  with "is not a function".
- **Yahoo Finance (unofficial, no key) is the primary data source.** Free,
  no rate-limit paperwork, covers quotes/historical/dividends/splits.
  **Finnhub (official, free tier, needs `FINNHUB_API_KEY`)** is secondary —
  wired up for a real-time top-up but not yet live-tested. Deliberately
  avoided Polygon/Alpha Vantage — their free tiers are what killed the
  earlier open-source-fork attempts Joe tried before this rebuild (Polygon:
  5 calls/min free; Alpha Vantage: 25 calls/day free).
- **Express (`^4.21.1`) for the web layer**, chosen deliberately over a
  framework/build-step approach (React, Next.js). Matches the old
  `Strategy_Lab` app's pattern — the one that actually got real features
  built before it tangled, vs. `TradeMentorAI`'s abandoned Next.js plan
  that never got past docs. `server.js` is deliberately thin: routes parse
  the request and call a `services/*` function, no business logic in the
  route handlers themselves.
- **Frontend JS follows Joe's own "module pattern"** from the old
  `Strategy_Lab_V2_Plan.md` ("LLM Survival Pattern"): each feature gets a
  folder under `public/js/modules/` with `index.js` (conductor — owns
  state, wires listeners), `api.js` (fetch calls only), `render.js` (HTML
  string generation only, no DOM/fetch), `handlers.js` (event handler
  logic, calls `api.js` then a callback into `index.js`). Carried forward
  intentionally since it's a design Joe already reasoned through for
  exactly this failure mode (files getting too large/tangled for an LLM to
  safely edit).

## What's actually been verified (not just written)

Everything below was *run*, not just read for correctness — several real
bugs were caught this way and would not have been caught by review alone:

- `schema.sql` loaded into a live SQLite DB: all 22 tables (including
  `watchlists`, added when the UI went in) create cleanly, `PRAGMA
  foreign_key_check` and `PRAGMA integrity_check` pass, and targeted tests
  confirm CHECK constraints reject bad enum values, `ON DELETE RESTRICT`
  blocks deleting a security or watchlist still in use, `ON DELETE CASCADE`
  correctly cleans up an account holder's accounts/transactions, and
  `UNIQUE(account_id, external_ref)` makes duplicate CSV import a no-op.
- `npm run test:offline` (`scripts/test-offline.js`): 360 checks covering
  `isTriggered()` alert-math logic in isolation, DB wiring (holder/security/
  watched-item creation with no network call), watchlist CRUD (default
  "General" list auto-creation, named lists, duplicate-name rejection,
  filtering items by list), and the alert write path
  (`applyAlertIfTriggered`) — writes exactly one `alerts` row, flips
  `watched_items.status` to `ALERT`, reflected in `listWatchedItems()`.
  Safe to re-run any time; it wipes and rebuilds its own throwaway DB.
- `npm run smoke:watchlist -- <SYMBOL>` (`scripts/smoke-test-watchlist.js`):
  full live run against real Yahoo Finance. Last confirmed run resolved
  AAPL ("Apple Inc.") from a cold DB, pulled a real quote, correctly fired
  an alert against a deliberately-absurd target price, and persisted the
  status change. **This is the one that needs real network access** — it
  won't run in a sandboxed/offline environment.
- **Update: Finnhub path is now live-verified.** Joe got a free API key,
  added it to `.env` (gitignored, never committed -- `.env.example` stays
  the tracked template), and ran the new `scripts/test-finnhub.js` from his
  own machine (this Cowork session's sandbox has an allowlisted egress
  proxy that blocks `finnhub.io` outright, so the live call had to happen on
  Joe's side). Both `getQuote('AAPL')` and `getProfile('AAPL')` returned
  real data, and the calls landed correctly in `api_usage_log` under the
  `finnhub` provider. Nothing in the app currently calls `refreshQuote(...,
  { provider: 'finnhub' })` from the UI yet -- the opt-in plumbing in
  `priceService.js` was already there, this just confirms the provider
  itself actually works against a real key over a real network.
- **A second Finnhub API key exists but is deliberately not wired in.** Joe
  provided it "in case rolling keys are needed"; confirmed with him this is a
  spare for a future problem, not a feature to build now. **If Finnhub's
  50/min budget (`services/usageLog.js`) ever actually gets hit** -- multiple
  tickers refreshing against Finnhub in the same window -- the fix is key
  rotation: store both keys, and have `finnhubProvider.js` alternate between
  them (or fail over to the second on a 429) so the effective budget doubles.
  Not built because there's no evidence yet that one key's limit is a real
  constraint -- this is where to start if it becomes one.

### Verification boundary: server.js / the web UI

Everything above was actually executed. `server.js`, the `/api/*` routes,
and the whole `public/` frontend were **not** — the sandbox this was built
in has no access to the npm registry, so `express` could never actually be
installed and run there (unlike `node:sqlite`, which is built into Node and
needed no install to test). What *was* verified is every service function
the routes call (via `test-offline.js`), and every file passes `node
--check` (syntax only). The route-handling logic, JSON shaping, and the
whole client-side module (`public/js/modules/watchlist/`) are correct on
read-through and follow well-established, stable Express/DOM APIs, but
"correct on read-through" is exactly the category of claim that's bitten
this project before (see "Real bugs found" below) — treat this as unverified
until it's actually run with `npm install && npm start`, opened in a
browser, and clicked through (add a ticker, add a list, hit Refresh
Prices).

**Update**: Joe has since run this successfully — the server starts, the
page loads, adding tickers works, and Refresh Prices pulls live Yahoo
quotes through the API. The startup path of `server.js` was additionally
verified in-sandbox against a stubbed `express` (all three schema-version
cases: current, stale, never-initialized). Individual route handlers and
the browser-side module still haven't been exercised by automated tests —
only by Joe clicking through them.

**Cowork sandbox note**: `npm run test:offline` (or anything else opening
`node:sqlite` with WAL mode) fails with `disk I/O error` when run from a
Cowork session's bash tool against the mounted `C:\Projects` folder
specifically -- confirmed by reproducing it with a two-line `DatabaseSync` +
`PRAGMA journal_mode = WAL` probe against that mount vs. the sandbox's own
local disk (works fine locally, fails only over the mount). This is the
mount bridge, not a code regression -- WAL needs a `-shm` shared-memory file
alongside the `.db`, which this particular network/FUSE-style mount doesn't
support. If `test:offline` ever needs to run from inside a Cowork session
again, run it against a path outside the mounted folder (e.g. copy the repo
into the session's own `outputs`/scratch directory first) rather than
concluding the test suite itself broke.

**Still unverified as of the Settings first pass**: every `/api/settings/*`,
`/api/sources`, `/api/holders`, `/api/exchanges` and watchlist-management
route, and the entire `public/js/modules/settings/` UI. The services behind
them are covered by `test:offline`, and the pure form-mapping functions
(`sourceFormToPayload` / `sourceToFormValues`) are tested directly, but
nothing has clicked a Settings button in a real browser yet.

## Real bugs found by actually running the code (fixed, but good to know the pattern)

1. `getOrCreateSecurity`'s original lookup query used a single SQL clause
   trying to handle both "caller specified an exchange" and "caller
   didn't" via NULL comparison (`exchange_id = ? OR (? IS NULL AND
   exchange_id IS NULL)`). SQL's `NULL = NULL` is never true, so it
   silently failed to find existing securities whenever the caller didn't
   pass an exchange code (the common case) — would have re-hit the network
   on every call instead of using the cache. Fixed: two separate prepared
   queries instead of one clever one.
2. `yahoo-finance2`'s default export is a *class*, not a ready instance —
   first draft called `.quote()` etc. straight on the import, which fails
   for everything. Fixed: `new YahooFinance()`.
3. The version-pin issue above (2.x vs 3.x module availability).
4. **Quotes were only refreshed for watchlisted tickers.** `checkAlerts()`
   built its refresh set from `watched_items` alone, so a ticker you bought
   but never added to a watchlist never received a quote — its Dashboard card
   and detail panel permanently showed no price, and the detail panel
   unhelpfully told you to refresh from the Watchlist tab where it didn't
   appear. Found by Joe using the app. Fixed: the refresh set is now
   "watched OR held".
5. **Column drag-reorder swapped in the wrong label.** `columnPrefs.js`'s
   `onDrop` removed the dragged column from `prefs.order` correctly, but then
   re-inserted the *drop target's own key* instead of the dragged one --
   meaning the dragged column vanished from the list entirely and the target
   column's label appeared twice. It also lacked the index-shift correction
   needed after removing an element earlier in the array. Passed `node
   --check` and looked correct on read-through; only showed up once Joe
   actually dragged a column in the browser and got a duplicate "Name" label
   with "Type" nowhere to be found. Fixed by pulling the array-move math into
   a standalone `reorderKey()` function and running it against plain arrays,
   which also surfaced a related (separate, non-bug) usability gap: with
   simple "insert before the target" semantics, dropping an item onto its
   immediate next sibling was a silent no-op. Fixed by adding pointer-position
   half-row detection (`insertAfter`) so dropping in the bottom half of a row
   inserts after it instead of before.
6. **Journal's source dropdown never showed a source added after page
   load.** `journal/index.js` fetched `state.sources` exactly once, in
   `initializeJournalModule()`, and every dialog (`openIdeaDialog`,
   `openStrategyDialog`) just reused that stale copy instead of re-fetching.
   Add a source in Settings, come back to Journal without a full reload, and
   the new source silently wasn't in the list. `orders/index.js` already had
   the correct pattern (re-fetch sources every time its dialog opens) --
   Journal just didn't follow it. Found by Joe clicking through the actual
   UI, not by anything a syntax check or the offline test suite could catch,
   since `test-offline.js` calls the service functions directly and never
   exercises this fetch-once-at-init frontend behavior. Fixed by re-fetching
   sources on every dialog open and on every return to the Journal tab
   (`reloadJournalView`), matching Orders' approach.
7. **Strategy dialog's background list went stale after an immediate
   add/remove-source in edit mode.** Removing or adding a source tag while
   editing an existing strategy hits the server right away (by design --
   see "Strategies redesign" above), but `handleAddStrategySourceClick`/
   `handleStrategySourceRemoveClick` only refreshed the dialog's own tag
   panel, never the Strategies list sitting behind it. Click Save afterward
   and you'd never notice (Save's own handler refreshes the list); click
   Cancel -- the natural move when there's nothing else to change -- and the
   list kept showing the pre-edit source names even though the removal had
   already persisted. Found by clicking through the real UI (via Claude in
   Chrome against Joe's actual dev server) the first time this dialog was
   ever opened outside `test-offline.js`. Fixed by calling `loadStrategies()`
   right after each immediate mutation, not just on Save.

8. **`dialog label { display: block; }` in `style.css` defeated every
   conditionally-hidden label inside any dialog**, app-wide. Author CSS
   always wins over the browser's built-in `[hidden] { display: none }`
   regardless of selector specificity, so `orders/index.js` and
   `papertrade/index.js` setting `.hidden = true` on "Sell from lot" for a
   BUY (and `journal/index.js` doing the same for "Target price" on a WATCH
   idea) had no visible effect -- the field always showed anyway. Passed
   `node --check` and every offline test (this is a pure CSS/rendering bug,
   invisible to a Node-based test suite that never loads a browser). Only
   found by clicking through the real Log Order / Log Paper Trade dialogs
   and actually scrolling down. Predates the Paper Trade tab -- it just
   happened to be the click-through session that finally scrolled far enough
   to notice it. Fixed with `dialog label:not([hidden])`.

**Pattern worth remembering:** every one of these passed a syntax check
and looked reasonable on read-through. None of them were caught until the
code actually ran. If you're extending this app, prefer running real
code (even against a throwaway/offline DB, like `test-offline.js` does)
over trusting review alone — this codebase has direct receipts on that
distinction mattering.

## File map

```
StrategyLabV2/
  schema.sql                       -- full DB schema, SQLite
  server.js                        -- Express app: static file serving + /api/* routes  (npm start)
  docs/
    DB_ARCHITECTURE.md             -- schema design rationale, what changed from the old app
    STATUS.md                      -- this file
    V2_BACKLOG.md                  -- deferred ideas incl. the ticker research skill, with open questions
  lib/
    db.js                          -- node:sqlite connection, withTransaction(), schema version check
    schemaVersion.js               -- SCHEMA_VERSION constant + changelog. BUMP THIS when schema.sql changes.
  scripts/
    init-db.js                     -- applies schema.sql, seeds NASDAQ/NYSE   (npm run db:init)
    test-offline.js                -- no-network verification suite          (npm run test:offline)
    smoke-test-watchlist.js        -- live end-to-end check against Yahoo     (npm run smoke:watchlist -- SYMBOL)
  services/
    usageLog.js                    -- logs + soft-throttles provider API calls
    holderService.js               -- getOrCreateDefaultHolder() -- no auth, single-user app
    priceService.js                -- getOrCreateSecurity, refreshQuote, backfillHistorical, backfillDividendsSplits
    watchlistService.js            -- watchlist CRUD, watched-item CRUD, duplicate check, alert logic
    settingsService.js             -- general key/value settings, exchanges, account holders
    sourcesService.js              -- advice sources CRUD across base + type-specific detail tables
    transactionsService.js         -- buys/sells/dividends, FIFO lot allocation, positions, realized P&L
    journalService.js              -- strategies CRUD, paper trade ideas, execute-into-real-trade
    tickerDetailService.js         -- everything the Dashboard detail dialog shows (stored data only)
    scheduler.js                   -- nightly maintenance job (history backfill + a courtesy alert check)
    alertScheduler.js              -- market-hours alert polling (15 min, Mon-Fri 9:30-4:00 ET)
    notifyService.js               -- outbound webhook when an alert fires -- generic hook, see own comment
    summaryService.js              -- compact snapshot for Prime_Dashboard (portfolio, movers, alerts)
    providers/
      yahooProvider.js             -- wraps yahoo-finance2 (quote, chart, quoteSummary)
      finnhubProvider.js           -- wraps Finnhub REST (quote, profile2) -- live-verified
      openLibraryProvider.js       -- ISBN -> title/author lookup for the book source dialog, untested live
  public/                          -- served statically by server.js
    index.html                     -- both views (watchlist + settings) live here, toggled by main.js
    css/style.css
    js/
      main.js                      -- bootstraps the app, owns Watchlist/Settings view switching
      modules/dashboard/           -- index (conductor) / api / render  (cards, table, detail dialog, SVG chart)
      modules/watchlist/           -- index (conductor) / api / render / handlers
      modules/orders/              -- same four-file split, for the Orders view
      modules/settings/            -- same four-file split, for the Settings view
      modules/journal/             -- same four-file split, for Journal / Strategy Lab (ideas + strategies)
      modules/papertrade/          -- same four-file split, for the Paper Trade tab (mostly re-exports orders/render.js)
      modules/alerts/              -- header bell: unacknowledged-alert count + dismiss, polls independently of view-switching
      modules/shared/columnPrefs.js -- column reorder/show-hide, shared by Watchlist + Orders tables
      modules/shared/tableRegistry.js -- list of every table + its columns/storage key, feeds Settings
  .env.example                     -- FINNHUB_API_KEY, DB_PATH
  package.json
```

## Deployment target: Synology NAS, or (better) the Orchestrator NUC

Two candidate hosts. **The NUC is the stronger option** — see below.

### Migration: DONE 2026-08-21

Discussed migrating with Joe. **Decision: yes, migrate to the NUC** — he'll
continue development there via VS Code + the Claude Code extension (SSH into
`orchestrator`) rather than this Cowork session, which only has file access
to Joe's PC. Confirmed prerequisites:

- **The Node-version risk below is resolved, not just assumed.**
  `ai_orchestrator/scripts/docs-maintenance.sh` pins
  `$HOME/.nvm/versions/node/v24.18.0/bin/claude` — that's proof the NUC
  actually has Node v24.18.0 installed via nvm, comfortably clearing the
  `>=22.5.0` floor `node:sqlite` needs. Not an inference from that project's
  docs anymore, a fact read directly from a script that runs there today.
- **Git is clean and pushed** (2026-07-27) — `origin/main` on GitHub
  (`JoeOster/StrategyLabV2`) now has everything through the HA
  auth-header work, so a `git clone` on the NUC won't be missing anything.

**~~Not done yet, deliberately held off~~ — executed 2026-08-21.** The app now
runs on the NUC as a user-level systemd unit. `docs/MIGRATION.md` has the full
checklist and the verified preconditions; `deploy/` holds the unit files and the
nightly NAS backup script. Highlights that differ from what was assumed above:

- **The nvm caveat is obsolete.** `/usr/bin/node` on that box is a real system
  binary at v24.18.0, on the default PATH — systemd needs no wrapper or PATH
  shim. The `docs-maintenance.sh` nvm path is not how node resolves there.
- **Zero native dependencies** (`express` + `yahoo-finance2`, both pure JS) is
  what made this trivial — no node-gyp, no rebuild step.
- **Egress verified for real**, not assumed: a live `yahoo-finance2` quote from
  the NUC returned MSFT with 501 history bars through the app's own code path.
- **Started fresh rather than carrying the dev DB** — it held no user data
  (0 transactions, 0 watched items), only cached prices.
- **Nightly backup added**: `node:sqlite`'s `backup()` (hot, WAL-safe) →
  gzip → `/mnt/brain/backups/strategylab/` on the NAS, which inherits the
  Synology Hyper Backup → Google Drive job for offsite. It refuses to run if
  the CIFS mount is absent, since writing to an unmounted path would fill the
  NUC's own disk while reporting success.
- **`scripts/stop-server.ps1` and `npm run stop`/`restart` are gone** — Windows
  only. Use `systemctl --user restart strategylab`.
- **The PC copy has been deleted.** The NUC is now the only working tree;
  development happens over SSH.

**The HA webhook is live and proven (2026-08-21).** It points at an HA *webhook
trigger*, not `notify.<target>` — the payload `{event, triggeredAt, alerts}` has
no `message` field, so a notify service would reject it with a 400. A webhook
trigger takes arbitrary JSON and needs no token, so the auth-header field is
deliberately empty. Verified end to end: a real fired alert POSTed and HA
returned HTTP 200.

### Option A: the Ubuntu NUC (recommended)

Joe already runs an "Orchestrator" host for an AI personal assistant
(`C:\Projects\ai_orchestrator` — read its `docs/ARCHITECTURE.md` and
`STATE.md` for full context). Relevant facts, taken from that project's docs:

- **Ubuntu Server 26.04 LTS**, headless, SSH-only. Node 22+ is readily
  available there, which **eliminates the `node:sqlite` version risk** that
  makes the Synology route uncertain. This alone is a strong argument.
- **Docker is already running** on it (Ollama, Frigate, Wyoming STT/TTS
  containers), so containerised deployment needs no new infrastructure.
- **Let's Encrypt + DuckDNS is already automated** (`joespa.duckdns.org`,
  with a certbot `renew_hook` that redeploys to the HA host). TLS is a
  solved problem on that box.
- **Its architecture doc lists a "trading assistant" as a planned future
  subsystem — that is this project.** Confirmed by Joe. Strategy Lab is not
  a standalone site; it's a subsystem of the wider personal-assistant
  architecture.

### This app feeds Prime_Dashboard

Joe has confirmed that Strategy Lab's data and elements will also be consumed
by **Prime_Dashboard** (`ai_orchestrator/projects/prime-dashboard.md`) — an
always-on TV kiosk page served by a persistent Claude Agent SDK service on
the Orchestrator, aggregating HA sensors, cameras, travel time, calendar and
study material. Portfolio data becomes one more source alongside those.

**Consume it over HTTP, not by reading the SQLite file directly.** Both
services would sit on the same NUC, so this is just `localhost` — and the
reasons to prefer the API are concrete:

- **Schema coupling.** There are no migrations; schema changes mean
  rebuild-and-reseed (guarded by the version check). A dashboard reading
  tables directly would break silently every time the schema moves. The HTTP
  responses are a far more stable contract than the table layout.
- **Derived values live in the service layer, not the database.** Realized
  P&L, unrealized P&L, cost-per-share of remaining shares, and lot
  drawdown are all *computed* in `transactionsService.js` — they are not
  columns. A direct reader would have to reimplement that arithmetic
  correctly, including the FIFO lot rules, and would silently drift from it.
- **Write safety.** WAL mode allows concurrent readers, so reads wouldn't
  corrupt anything, but there's no reason to take the coupling for zero gain.

**`GET /api/summary` is the endpoint built for this consumer**
(`services/summaryService.js`). It returns one compact snapshot:

```jsonc
{
  "asOf": "2026-07-26T17:37:41.278Z",
  "portfolio": {
    "positionCount": 1, "tickerCount": 1,
    "totalCost": 610.16, "totalValue": 3706.78,
    "unrealizedPnl": 3096.62, "unrealizedPnlPercent": 507.51,
    "realizedPnl": 0, "dividendIncome": 0, "totalReturn": 3096.62,
    "dayChange": 157.18, "dayChangePercent": 4.43
  },
  "topMovers": [ /* per-ticker, biggest absolute % move first */ ],
  "alerts": { "activeCount": 0, "unacknowledged": [] },
  "watchlist": { "activeCount": 0 },
  "quotes": { "oldestFetchedAt": "...", "newestFetchedAt": "..." }
}
```

Design points that matter for the consumer:

- **`dayChange` is measured against yesterday's close**, not cost basis —
  that's the number an ambient display usually wants, and it's distinct from
  `unrealizedPnl` (measured against what you paid). Both are present.
- **Lots are rolled up per ticker.** A TV shows "NVDA", not "NVDA lot 1,
  NVDA lot 2".
- **Top movers sort by *absolute* percentage move**, so a large drop ranks
  as prominently as a large gain — an ambient display shouldn't bury bad
  news below good.
- **Empty portfolios return `null` for `dayChange`, not `0`** — "no data" and
  "no movement" are different claims, and a display shouldn't render the
  former as the latter.
- **`quotes.oldestFetchedAt` / `newestFetchedAt`** let the consumer show
  "prices as of ..." or grey out when stale, instead of presenting old
  numbers as though they were live.
- **Read-only and stored-data-only.** It never triggers a provider call, so
  polling it can't burn API budget or block on a slow upstream.
- Query params `?movers=N&alerts=N` cap the list sizes.

`GET /api/positions` (full per-lot detail) and `GET /api/ticker/:symbol`
remain available for anything needing more depth.

Also worth noting for that integration: quote freshness is driven by the
nightly job and manual refreshes, so a TV dashboard polling every minute
would mostly re-read the same cached numbers. If near-live prices matter on
that display, the fix is the refresh cadence in `scheduler.js`, not the
dashboard polling harder.

Two constraints carried over from that project's own hard-won notes:

- **The `joe` account has no passwordless sudo.** Their established pattern
  is **user-level systemd units** (`~/.config/systemd/user/...`) with
  `loginctl enable-linger joe` — already configured. `docs-maintenance.timer`
  (Sun 03:40) and `gmail-rules.timer` (Sun 04:10) follow this. A Strategy Lab
  timer should match, and should pick a slot that doesn't collide.
- **Disk space has bitten that box before** — it once fell to 3.2 GB free of
  116 GB from accumulated Docker images, which caused instability elsewhere.
  This app's own footprint is negligible (SQLite plus two years of daily bars
  is a few MB), but don't assume headroom exists.

**Prefer a systemd timer over the in-process scheduler here.** `scheduler.js`
only runs while the server process is alive, so a restart at the wrong moment
silently skips that night. Their own documented principle — "runs on the
Orchestrator host as a systemd timer or cron job, not an HA automation" —
points the same way. On the NUC: disable the nightly job in
Settings → General and have a user-level systemd timer hit
`POST /api/scheduler/run-now` instead.

### Option B: Synology NAS

**The risk here is Node version.** This app requires **Node >= 22.5.0** for
the built-in `node:sqlite` module. Synology's DSM package centre has
historically shipped older Node releases (18/20), and community packages lag.
Check what's actually available on the target DSM before committing — below
22.5, `node:sqlite` doesn't exist and nothing runs. **Docker** via Container
Manager (DSM 7) sidesteps this by pinning your own Node image.

Also note, from the orchestrator's docs: that NAS already has **storage IOPS
contention** between `/volume1/nvr_recordings` (sequential 4K video writes)
and `/volume1/brain` (random I/O). Adding a database to the same pool is
worth thinking about — put it on SSD/NVMe if available, not the HDD pool
serving Frigate.

**What's already NAS-friendly:**
- No native modules to compile. The earlier switch away from `better-sqlite3`
  means there's nothing architecture-specific — this runs the same on ARM or
  x86 without a build toolchain.
- Only one runtime dependency (`yahoo-finance2`) plus Express.
- `DB_PATH` is already configurable via `.env`, so the database can live on a
  NAS volume rather than beside the code.
- SQLite is a single file — trivially covered by Synology's own snapshot and
  backup tooling.

**What will need attention at deploy time:**
- **Process supervision.** The server needs to survive reboots — Docker with
  a restart policy, or DSM Task Scheduler with a boot-up trigger.
- **The nightly job only runs while the process is alive.** `scheduler.js` is
  an in-process timer, so if the container/process is down at 01:00 that
  night's refresh is simply skipped (it doesn't catch up on next start).
  If that matters, either ensure the process stays up, or drive
  `POST /api/scheduler/run-now` from DSM's own Task Scheduler instead and
  turn the internal scheduler off in Settings.
- **Timezone.** The scheduler uses local server time. A NAS set to UTC will
  run "01:00" at a different real-world moment than a laptop set to local
  time.
- **Authentication.** There is none — every request acts as the default
  account holder. Fine on a trusted LAN; genuinely unsafe if the NAS is
  exposed to the internet or shared with people who shouldn't see this data.
  See `V2_BACKLOG.md`.
- **File permissions.** The old `Strategy_Lab` project hit
  `SQLITE_CANTOPEN` from directory permissions (documented in its
  `docs/settings.md`). Whatever user runs the process needs write access to
  the `data/` directory, not just read.

## Nightly job & API budget

`services/scheduler.js` runs a maintenance pass once a day (default 01:00
local, configurable in Settings → General, and switchable off there too).
It's a self-rearming `setTimeout` rather than a cron library — one schedule
doesn't justify a dependency, and recomputing the delay nightly stays correct
across daylight-saving shifts where a fixed 24h interval would drift.

**History refresh is incremental.** `backfillSecurityHistory()` checks
`MAX(date)` for the security and fetches only from ~5 days before it (a small
overlap, since providers occasionally restate a recent close, and the insert
is idempotent so overlapping is free). A full 2-year pull happens only on a
ticker's first fetch or with `{ full: true }`. Before this, the nightly job
re-downloaded two years of bars to gain one row — roughly 99% waste against
an unofficial endpoint.

**Dividends/splits are fetched weekly, not nightly** (Sundays), which halves
the nightly call count. They change rarely.

**Provider budgets are deliberately different** (`services/usageLog.js`):
Finnhub 50/min because its free tier enforces a real 60/min quota; Yahoo
300/min purely as a politeness ceiling, since it's unofficial with no
published limit. An earlier version gave Yahoo the same cap as Finnhub, which
meant a nightly refresh of more than ~30 tickers would trip a limit that
never applied to it — and `refreshAllHistory` catches per-ticker errors, so
it would have silently half-completed rather than failing visibly.

`POST /api/scheduler/run-now` triggers the job on demand, so it can be tested
without waiting for 01:00.

## Schema changes: bump the version

There is **no migration system**. `schema.sql` is only ever applied to a
fresh database. To keep a stale DB from failing with a cryptic SQLite error
("no such table: watchlists", "CHECK constraint failed: order_type IN
(...)"), the app version-stamps the database:

- `lib/schemaVersion.js` holds `SCHEMA_VERSION` and a changelog of what each
  bump was for.
- `npm run db:init` writes it into `app_settings.schema_version`.
- `server.js` calls `assertSchemaCurrent()` at startup and exits with a
  readable "rebuild your DB" message on a mismatch.

**If you change `schema.sql`, bump `SCHEMA_VERSION` in the same commit.**
Otherwise the check silently passes against a stale DB and you're back to
debugging raw constraint errors.

`npm run db:stamp` marks an *existing* database as current without
rebuilding it — for the case where the DB already matches `schema.sql` but
has no stamp (built before version tracking existed, or hand-patched). It
verifies the expected tables exist and that `watched_items.order_type`
allows `'WATCH'` before stamping, and refuses with a "rebuild instead"
message if either check fails, so it can't be used to paper over a real
mismatch. Prefer `db:init` when there's no data worth keeping.

Note the load-order subtlety in `server.js`: service modules call
`db.prepare()` at module scope, so a stale DB throws during *import*, before
any top-level code runs. That's why `server.js` uses dynamic `await import()`
for the service modules, placed after `assertSchemaCurrent()` — static
imports are hoisted and would defeat the check entirely.

Once there's real data worth keeping, this should graduate to actual
migration files (numbered `.sql` scripts applied in order) rather than
delete-and-recreate.

## Lot accounting (the Orders module)

The transaction model, carried over from the old app's "logged against
specific buy lots":

- A **BUY creates a lot.** `quantity_remaining` starts at the full quantity
  and is drawn down as shares are sold. Fees are folded into `cost_basis`,
  so P&L reflects what the trade actually cost.
- A **SELL is allocated against lots, oldest first (FIFO)** unless a specific
  lot is chosen. Selling 100 shares spanning three lots writes **three** SELL
  rows, each with its own `linked_buy_id`. That's what makes per-lot realized
  P&L and holding periods computable at all. Sell fees are split across the
  generated rows in proportion to how much of the sale each covers.
- **Overselling is refused**, with a message naming how many shares are
  actually held. Allowing it would create negative phantom positions that
  quietly corrupt every downstream total.
- **Realized P&L is derived, never stored.** A stored copy would silently go
  stale if a buy price were later corrected.
- **Deleting a SELL restores the shares** to the lot it drew from. Deleting a
  BUY that has already been partly sold is refused — it would orphan the sell
  rows pointing at it.

- **Editing** keeps the books consistent rather than just overwriting fields:
  a BUY's quantity is locked once any of it has been sold; changing a BUY's
  price or fees **recomputes the cost basis of every sell linked to it**, so
  correcting a typo'd purchase price also corrects the realized P&L of past
  sales; changing a SELL's quantity re-allocates against its lot (restore the
  old draw, take the new one) and is rejected if the lot can't cover it.
  Transaction type can never change — that would invalidate lot links, so
  delete and re-enter instead.

All of the above is covered by `test:offline`, including multi-lot splits
and the exact P&L arithmetic.

## Dashboard

Worth knowing: the old app's Dashboard was **never actually built** —
`public/js/modules/dashboard.js` in `Strategy_Lab` is a single `console.log`
and `_dashboard.html` is a placeholder. The card design existed only as prose
in that project's README and `docs/wiring/dashboard.md`. This implementation
follows that written spec rather than any prior code.

Built: card grid of open position lots (ticker, exchange, qty, entry, value,
days held, colour-coded P&L), a table view over the same data, filters by
text and exchange, a sort dropdown, and a portfolio summary strip. Clicking
any card or row opens a detail dialog with quote stats, 52-week range and
position-in-range bar, an inline SVG price chart, the user's lots for that
ticker, watchlist entries, full trade history and recent dividends.

The chart is hand-rolled SVG in `dashboard/render.js` — deliberately no
charting library, since it's ~20 lines of coordinate math versus a CDN
dependency. Guards against flat series (divide-by-zero) and too-few-points
are tested.

`tickerDetailService.js` reads only stored data — no live provider calls —
so opening a card is instant and free. Freshness comes from the existing
Refresh Prices / Refresh History actions.

The **"Research (coming soon)"** button in the detail dialog is an
intentional placeholder. See `docs/V2_BACKLOG.md` for the planned ticker
research skill behind it.

## Column customization (Watchlist + Orders tables)

Every sortable table (Watchlist, Orders open positions, Orders history) has a
**"⚙ Columns"** button opening a shared dialog (`#column-dialog` in
`index.html`) where columns can be dragged into any order and shown/hidden.
Built from Joe's feedback: the 10-day sparkline should sit right after Symbol
by default, and there should be a way to both reorder columns and reveal more
data than the default table shows.

- **`public/js/modules/shared/columnPrefs.js`** is the single implementation
  behind all three tables -- pure merge/resolve functions (testable with
  plain objects, no DOM) plus a thin DOM-wiring layer that rebinds fresh
  listeners every time the shared dialog opens and tears them down on close,
  the same pattern the delete/duplicate confirm dialogs already use for a
  reused dialog element.
- **Each table defines its own full column list** (`ALL_COLUMNS` in
  `watchlist/render.js`, `POSITION_COLUMNS`/`HISTORY_COLUMNS` in
  `orders/render.js`) with a `default: false` flag on anything hidden out of
  the box. The array's order **is** the default order -- that's how the
  sparkline ended up as column 2 for Watchlist without needing a separate
  "default order" list.
- **New optional columns were added using data the API already returns** --
  no schema or service changes needed. Watchlist gains List, Notes, Qty,
  Added date, Day Range, Volume, Source. Positions gains Bought date, Orig.
  Qty, Fees, Prev Close, Source, Notes. History gains Exch, From Lot, Ext
  Ref, Notes.
- **Row rendering is now column-driven**, not hardcoded markup: each module
  has a `key -> renderer` map (`CELL_RENDERERS` / `POSITION_CELL_RENDERERS` /
  `HISTORY_CELL_RENDERERS`) so adding a column later means adding one map
  entry, not editing a fixed `<tr>` template.
- **Confirmed with Joe (asked directly, not assumed)**: preferences persist to
  `localStorage` (`sl_columns_watchlist`, `sl_columns_orders_positions`,
  `sl_columns_orders_history`), not the database -- he picked this over a
  DB-backed shared default when asked. Consistent with "no auth, single
  browser" being the app's existing model, but it means prefs don't follow
  you to a different browser/machine and aren't included in any future backup
  of the DB. A stored order/visibility set that references a column the
  table no longer has is dropped automatically; a column added to the table
  after prefs were saved is appended at the end rather than lost.

**What's verified**: the pure reorder/merge/visibility logic
(`mergeOrder`, `resolveVisible`, `defaultPrefs`, `visibleColumnsInOrder`,
`loadColumnPrefs`/`saveColumnPrefs` against a stubbed `localStorage`) was
actually run in Node against plain objects, including the "column removed
from the table" and "column added after prefs were saved" edge cases. Every
touched file passes `node --check`. **Not yet verified**: the actual
drag-and-drop in a real browser, and whether the dialog looks right -- this
falls under the same "verification boundary" as the rest of the web UI below.

### Settings → "Table Columns" panel

Joe asked for the per-table column setup to be discoverable from Settings,
organized by table, and to scale to tables added later (Imports, Journal)
without bespoke work each time. Built as a registry, not a hand-written
Settings section per table:

- **`public/js/modules/shared/tableRegistry.js`** is the single list of
  every table with a Columns tool: `{ id, label, columns, storageKey }`.
  It imports `ALL_COLUMNS` from `watchlist/render.js` and
  `POSITION_COLUMNS`/`HISTORY_COLUMNS` from `orders/render.js` directly --
  the registry's copy is the *same array instance*, not a re-declared
  duplicate, so there's no way for Settings' view of a table's columns to
  drift from what that table actually renders. Confirmed by identity check
  (`===`) in a test, not just by reading the code.
- **`COLUMN_STORAGE_KEYS` also moved here** from being separately declared
  inside `watchlist/index.js` and `orders/index.js`. Both modules now import
  the key from this one place instead of hardcoding the string a second time
  -- a typo in a duplicated key string would have silently split a table's
  "own" preferences from what Settings edits, so this was worth centralizing
  even though nothing in the UI forced it.
- **Adding a future table (Imports, Journal) means adding one entry to
  `TABLE_REGISTRY`** -- the Settings panel, the "N of M columns shown"
  summary, and the configure button all come from iterating that array
  generically. No new Settings UI code needed per table.
- **Both entry points stay live on purpose**: the inline "⚙ Columns" button
  still sits on each table's own toolbar (immediate, in-context), and
  Settings → Table Columns is a second, central way to reach the exact same
  dialog for any table. They read/write the same localStorage key, so there's
  no divergence between them -- worth flagging to Joe in case he'd rather the
  inline buttons were removed now that Settings covers it.

**What's verified**: actually imported `tableRegistry.js` in Node (not just
`node --check`) and confirmed the registry has all 3 tables, every
`storageKey` is distinct, `loadColumnPrefs` against each table's real column
list produces the same visible-count a fresh install would show, and the
watchlist entry is array-identical to `ALL_COLUMNS` (sparkline still column
2). **Not yet verified**: clicking "Configure Columns" from the Settings
panel in an actual browser.

## Journal / Strategy Lab

Built out per Joe's one-word "Journal" -- the module `V2_BACKLOG.md` already
scoped: paper trade ideas linked to a specific source (book/guru/site) and,
optionally, a specific strategy from that source, with an "execute" action
that turns an idea into a real trade once you actually act on it. No schema
changes were needed -- `strategies`, `watched_items.is_paper_trade`/
`source_id`/`strategy_id`, `transactions.watched_item_id`, and the
`EXECUTED` status value all already existed, strongly suggesting this exact
design was anticipated when the schema was first written.

- **`services/journalService.js`** is deliberately thin. Paper ideas *are*
  `watched_items` (`is_paper_trade=1`) and executed trades *are*
  `transactions` -- this file doesn't duplicate that storage. It adds
  strategies CRUD, a Journal-specific listing query (joins strategy title +
  source name for display, which the existing watchlist query doesn't do),
  and orchestrates the one genuinely new operation: `executeJournalIdea()`.
- **Execute calls `transactionsService.recordBuy()`** with `isPaperTrade:
  false` and `watchedItemId` set to the idea's id, then flips the idea's
  `status` to `EXECUTED`. The idea and the real transaction stay linked via
  `transactions.watched_item_id`.
- **Judgment calls worth double-checking with Joe** (the "interesting part"
  `V2_BACKLOG.md` flagged, resolved with the schema's own hints rather than
  asked about directly):
  - **v1 only supports executing into a BUY.** A paper `SELL_LIMIT` idea
    still fires its alert normally through the existing `checkAlerts()` path
    -- turning that into an actual sale reuses the Orders "Sell" flow against
    a real holding, which already exists and didn't seem worth a
    Journal-specific duplicate for a first pass.
  - **The execute form requires the real fill (date/quantity/price/fees)
    entered by hand -- nothing is auto-copied from the paper target.** A
    real fill routinely differs from what a book/guru suggested, and
    silently assuming they match is exactly the kind of "looks right"
    shortcut this app has been bitten by before (see "Real bugs found").
    Quantity is pre-filled from the idea if one was set; price never is.
  - **A source is required to log an idea** (`strategyId` is optional). An
    idea with no source at all is just the Watchlist's existing `WATCH`
    type -- Journal's entire reason to exist is the link back to where the
    idea came from.
  - **`GET /api/watched-items` now defaults to `isPaperTrade=false`**
    (`?paper=1` opts into paper items, matching the query param the
    positions/summary/transactions routes already used for this
    distinction). Without this, a Journal idea would have shown up mixed
    into the regular Watchlist tabs the first time someone logged one --
    caught before it ever became a real bug, by tracing how the existing
    endpoint actually filtered (it didn't, at all) rather than assuming it
    already handled paper trades correctly.
  - **Ideas/strategies render as settings-row-style lists, not a sortable
    table.** Chapter/page/notes are text-heavy fields that don't fit a dense
    trading table well, and idea volume is typically low. Doesn't hook into
    the `tableRegistry`/column-customization system built earlier this
    session -- could later, if Journal grows enough entries to want
    sort/filter/hide-columns too.
  - **Abandoning an unexecuted idea just deletes the `watched_item`**,
    reusing the existing delete endpoint and its cascade rules (alert
    history cascades away; a since-executed idea's real transaction survives
    with `watched_item_id` set to NULL) rather than adding a separate
    CANCELLED/EXPIRED status-setter.

**What's verified**: every path above was actually run against a throwaway
DB in `test-offline.js` (30 new checks, all passing) -- strategies CRUD
including rejection of a missing source/title, an idea correctly invisible
to a real-only watched-items query and visible to a paper-only one, execute
refusing a non-paper item and refusing a second execution of an
already-executed idea, the executed transaction landing as a genuine tracked
open position (not a paper one), and deleting a strategy leaving its linked
ideas intact with `strategy_id` cleared. Every touched file passes `node
--check`, and the "every `getElementById` target exists in `index.html`"
regression check (see section 9 of `test-offline.js`) now also covers
`modules/journal/index.js` -- 155 ids checked, all found. **Not yet
verified**: clicking through the actual Ideas/Strategies UI, the source →
strategy cascading dropdown in the idea dialog, and the execute dialog, in a
real browser.

### Strategies redesign: many-to-many with sources (schema v5)

Joe's follow-up: "there is nowhere to define [strategies]... same strategy
could be mentioned from various sources as well... take a strategy and its
source, apply it to paper or real trades and track how well it does." The
original design locked a strategy to exactly one source (`strategies.
source_id NOT NULL`), which couldn't express "Buy the dip" being taught by
both a book AND a podcast. Redesigned as many-to-many, confirmed with Joe via
two questions before touching anything: the join-table schema (over a
comma-separated-list-of-ids alternative), and that the dev DB has test data
only, so a destructive rebuild is fine.

- **Schema v5** (`schema.sql`, `lib/schemaVersion.js`): `strategies` is now
  just `{id, title, notes, created_at}` -- source-independent. A new
  `strategy_sources` join table (`strategy_id, source_id, chapter,
  page_number, notes`, `UNIQUE(strategy_id, source_id)`) holds what used to
  live directly on `strategies`: chapter/page/notes only mean something in
  the context of ONE particular source (a book's chapter 4 vs. a podcast
  episode), so they moved off the strategy and onto the tag. Both FKs
  `ON DELETE CASCADE` -- deleting a strategy drops its tags; deleting a
  source only drops that one tag, the strategy (and its other tags) survive.
  **Requires a DB rebuild** (`Remove-Item -Recurse -Force data; npm run
  db:init`) before the app will start -- confirmed with Joe that the dev DB
  only has test data, nothing worth a manual migration.
- **The actual payoff, worth calling out**: `journalService.listJournalIdeas`
  now joins `strategy_sources` on `(strategy_id, source_id)` matching the
  IDEA's own source, not just the strategy. So the same strategy tagged with
  a book (chapter 4, p.42) and a podcast (no chapter) shows the right
  chapter/page depending on which source that *specific* idea came from --
  actually tested (`scripts/test-offline.js`), not just asserted.
- **`services/journalService.js`**: `createStrategy({title, notes, sources:
  [...]})` requires at least one source tag at creation (same "a strategy
  needs to come from somewhere" reasoning as before, just no longer capped
  at one). `addStrategySource`/`updateStrategySource`/`removeStrategySource`
  manage tags on an existing strategy one at a time; removing the last tag
  is allowed (a strategy can end up source-less rather than being
  force-deleted). `listStrategies({sourceId})` now matches via `EXISTS` on
  the join table and aggregates all tagged source names (`GROUP_CONCAT`,
  alphabetical) for the list view; `getStrategy(id)` returns the strategy
  plus its full `sources[]` array.
- **`server.js`**: added `GET /api/strategies/:id` (didn't exist before --
  needed now to fetch a strategy's full tag list for editing) and
  `POST/PUT/DELETE /api/strategies/:id/sources[/:linkId]` for tag
  management. `POST /api/strategies` payload changed from a flat
  `{sourceId, title, chapter, pageNumber, notes}` to `{title, notes,
  sources: [{sourceId, chapter, pageNumber, notes}, ...]}`.
- **Journal UI** (`modules/journal/`): the Strategy dialog's single Source
  dropdown became a "Sources" sub-list plus an add-source mini-form. Editing
  an existing strategy hits the tag endpoints immediately (add/remove act
  right away, matching Settings' convention elsewhere in this app); creating
  a new strategy collects tags into a client-side pending array first (no
  strategy id exists yet to attach them to) and sends everything in one
  `POST /api/strategies` call on Save. Both modes render through the same
  pure `renderStrategySourceRows()`, unified by a `{key, sourceId,
  sourceName, chapter, pageNumber, notes, linkId}` shape (`linkId: null` =
  pending, unsaved).
- **Found while wiring this up, fixed before it shipped**: `sourcesService.
  listSourcesQuery`'s per-source strategy count still referenced the
  now-gone `strategies.source_id` column -- would have thrown "no such
  column" the moment anyone opened Settings' Sources panel. Caught by
  actually running the full offline suite against the new schema, not by
  reading the diff.
- **What's verified**: 21 new/changed checks in `test-offline.js` (`11.
  Journal / Strategy Lab` now covers the tag CRUD, the per-idea chapter/page
  resolution described above, cascade-on-strategy-delete, and
  cascade-on-source-delete), run against a freshly-initialized v5 DB built
  from `schema.sql` -- 316 checks total, 0 failed. Every touched file passes
  `node --check`, and the element-id regression check confirms every new
  `strategy-source-add-*`/`strategy-sources-list` id referenced by
  `journal/index.js` actually exists in `index.html`.

  **Update: clicked through for real**, via the Claude in Chrome extension
  connected to Joe's actual `localhost:3113` dev server (a first for this
  project -- every prior module's "not yet verified" UI note had been sitting
  unresolved). Joe restarted the server and rebuilt the DB (`npm run db:init`,
  confirmed test-data-only) to pick up schema v5. Walked through: creating a
  source, creating a strategy tagged with two sources (one book with
  chapter/page, one person with just notes) in one save, editing that
  strategy and removing/re-adding tags with the dialog in "immediate" mode,
  the source→strategy cascading dropdown in the New Idea dialog, and a
  logged idea correctly showing "via Trading in the Zone · Buy the dip
  (Chapter 4 · p.42)" -- the exact per-source chapter/page resolution the
  redesign was built for, confirmed live, not just in `test-offline.js`.

  **Two real things this caught, neither visible from reading the diff:**
  1. `GET /api/journal/ideas` 404'd on first load -- turned out to be Joe's
     Node process just needing a restart (it doesn't hot-reload), not a code
     bug, but worth remembering that a stale process can masquerade as a
     routing bug during any future click-through session.
  2. **Real bug, now fixed**: in the Strategy edit dialog, adding or removing
     a source tag hits the server immediately (by design), but the
     background Strategies list behind the dialog was never refreshed to
     match -- only clicking Save (not Cancel) triggered `loadStrategies()`.
     So removing a tag and then hitting Cancel (a very natural thing to do,
     since there's nothing else to "save") left the list showing stale
     source names even though the removal had already persisted. Fixed by
     calling `loadStrategies()` right after each immediate add/remove in
     `journal/index.js`, verified live: the list now updates the instant the
     action completes, Cancel or not.

## Paper Trade tab (schema v6)

Joe's request: "add the Paper trade tab" — clarified via two questions before
building anything. First, how it relates to Journal's existing paper-idea
concept: Joe wanted a **full paper trading simulator**, described directly:
*"it should have a tab similar to 'orders' only it will have the links
showing journal sources and the like, any paper trade that gets promoted to a
purchase should leave the table and join orders (retaining the journal
links)."* Second, whether virtual cash should be constrained: **unconstrained
for v1** (Joe's choice, marked recommended).

- **No new lot-accounting logic was needed.** `transactions.is_paper_trade`
  and every `transactionsService.js` function (`recordBuy`, `recordSell`'s
  FIFO matching, `listOpenPositions`, `listTransactions`,
  `getPortfolioSummary`) already accepted and filtered by `isPaperTrade` —
  built earlier in this project, before the Paper Trade tab was ever
  requested. Building this tab turned out to be almost entirely a frontend +
  tagging exercise, not a lot-accounting one. That's a real de-risking
  discovery, not an assumption: confirmed by reading the service file in full
  before writing anything new.
- **Schema v6**: added `transactions.strategy_id` (nullable, `ON DELETE SET
  NULL`), mirroring the existing `transactions.source_id` column. Threaded
  through `recordBuy`/`recordSell`/`recordDividend`/`updateTransaction` the
  same way `sourceId` already was — including `recordSell`'s existing
  "inherit from the lot if not explicitly given" pattern, now applied to
  `strategyId` too. `openPositionsQuery`/`transactionsQuery` both gained a
  `LEFT JOIN strategies` for `strategy_title`, alongside the existing
  `source_name` join.
- **"Promote" is a single UPDATE, not a delete-and-recreate.**
  `promotePaperTrade(holderId, id)` in `transactionsService.js` runs `UPDATE
  transactions SET is_paper_trade = 0 WHERE id = ?` on the existing row —
  `cost_basis`, `quantity_remaining`, `source_id`, and `strategy_id` all
  carry over untouched, which is exactly Joe's "retaining the journal links"
  requirement. Refuses three cases, each tested: the transaction is already
  real; it isn't a BUY (a dividend or sell can't be "promoted" — there's no
  position to open); the lot has already been partly or fully sold on paper
  (deciding what happens to paper SELLs against a promoted lot is a real
  design question, deliberately left for later rather than guessed at).
- **Frontend (`modules/papertrade/`) is deliberately thin.** `render.js`
  re-exports almost everything from `orders/render.js` (same columns, same
  sort/filter, same cell renderers) rather than duplicating them — Paper
  Trade and Orders show the identical shape of data. The one addition:
  `orders/render.js`'s `renderPositionsRows` now takes an options object
  (`{ showPromote, emptyMessage }`); Paper Trade's own `renderPositionsRows`
  wrapper always passes `showPromote: true`, real Orders' calls are
  unaffected since the option defaults to `false`. `api.js` hits the exact
  same `/api/positions` and `/api/transactions` endpoints Orders uses, just
  with `?paper=1` — a query param convention that already existed
  (`server.js` already branched on `req.query.paper === "1"` before this
  feature; Journal's paper ideas used the same convention on
  `/api/watched-items`). Every write forces `isPaperTrade: true` client-side
  too, so a Paper Trade form submission can never accidentally land as real.
- **Paper Trade gets its own dialog** (`#paper-order-dialog`,
  `#paper-order-form`, etc.), not a shared one with real Orders. Two
  independent `index.js` conductors both trying to own one dialog element
  seemed like exactly the kind of cross-module coupling this app's
  four-file-per-module pattern exists to avoid — the small duplication cost
  was worth it for module independence.
- **Judgment call, not explicitly requested**: added a Strategy field to the
  *real* Orders dialog too (`#order-strategy-select`), for symmetry — a real
  trade can now optionally be tagged with a strategy the same way a paper one
  can, using the exact same `renderStrategyOptions`/`fetchStrategies`
  plumbing. **Confirmed with Joe: keep it.**
- **Column customization extends here too**: `tableRegistry.js` gained
  `paperPositions`/`paperHistory` entries pointing at the *same*
  `POSITION_COLUMNS`/`HISTORY_COLUMNS` array instances Orders uses, but with
  their own `localStorage` keys — Paper Trade and Orders can have
  independently configured visible columns despite sharing column
  definitions, consistent with how Watchlist/Orders already worked before
  this feature.
- **Refresh Prices exists on the Paper Trade tab too**, hitting the same
  `/api/check-alerts` endpoint Orders uses — security prices aren't scoped by
  paper/real (a ticker has one quote regardless of which tab holds a
  position in it), so this was free to add and avoids a paper-only holder
  having no way to refresh prices from within their own tab.

**What's verified**: 6 new `test-offline.js` checks sections (`6h` strategy_id
threading + all four `promotePaperTrade` refusal/success paths, `6i` the pure
`paperOrderFormToPayload`/`renderPositionsRows` Promote-button behavior) — 336
checks total, 0 failed, run against a freshly-initialized v6 DB. The
element-id wiring check (section 9) now also scans
`modules/papertrade/index.js` — 201 ids checked, all found — and confirmed
`.papertrade-panel` markup exists. Every touched file passes `node --check`.
**Update: clicked through for real**, via the Claude in Chrome extension
against Joe's actual `localhost:3113` dev server, after Joe rebuilt the DB
for schema v6. Logged a paper NVDA BUY (qty 10 @ $50) from the new dialog,
confirmed it appeared in Open Paper Positions with working Promote/Sell/Edit
buttons, clicked Promote, and confirmed via the API that `is_paper_trade`
flipped to 0 with `cost_basis`/`quantity_remaining` untouched, that the lot
now shows under real Orders (and the Dashboard), and that it correctly
disappeared from Paper Trade. Test transaction deleted afterward to leave the
DB clean.

**One real bug found and fixed by this click-through, not visible from
reading the diff**: `style.css` had an old, pre-existing rule --
`dialog label { display: block; ... }` -- that unconditionally overrides
every `<label hidden>` inside any `<dialog>`, because author CSS always beats
the browser's built-in `[hidden] { display: none }` regardless of selector
specificity. This meant "Sell from lot" showed on every BUY order (real and
paper) despite the JS correctly setting `.hidden = true`, and the exact same
bug affected Journal's "Target price" label for WATCH-type ideas. This bug
predates the Paper Trade tab entirely -- it was just never noticed because
nobody had scrolled far enough down the Log Order dialog in a real browser
until this session. Fixed with one selector change,
`dialog label:not([hidden])`, verified live on both the real Orders dialog
(toggling Buy → Sell → Buy correctly shows/hides the field) and the new
Paper Trade dialog.

**Environment note, not a code bug**: `window.confirm()` (used by the
Promote button's confirmation) blocks the tab's renderer thread in a way
Claude in Chrome's CDP-based clicking/screenshotting can't reliably dismiss
-- the tab hung until the whole browser connection reset. Promote itself was
still fully verified, just via direct `fetch()` calls to
`/api/transactions/:id/promote` in a second tab rather than clicking through
the confirm dialog in the first one. Worth knowing if testing Promote again:
either accept the risk of a hung tab, or verify via direct API calls.

## Scheduled alerts + webhook delivery

Joe's request: "scheduled alerts would be great," after being asked to pick
between CSV import, this, and a ticker-research skill. Two follow-up
questions before building: check cadence (**every 15 min during market hours**,
his pick over a simpler always-on interval) and delivery channel. His answer
to delivery was "2 and 3" -- both in-app surfacing AND a hook for tying into
his `ai_orchestrator` project's existing automations later, clarified further:
*"as to 3 I would put the hooks in, and when ai_orchestrator is ready for it,
it can hook up easily."* That shaped the whole design: build a generic
webhook, not a specific integration, since this app has no visibility into
what `ai_orchestrator` actually exposes.

- **Two separate schedulers now exist on purpose.** `scheduler.js`'s existing
  nightly job (history backfill + one courtesy alert check at 01:00) is
  unrelated to this. The new `services/alertScheduler.js` runs independently,
  every 15 minutes, specifically so a price target gets noticed same-day
  instead of whenever the nightly job or a manual "Refresh Prices" click
  happens to catch it. Interval is a fixed 15 minutes, not user-configurable
  -- Joe's own call, asked directly rather than assumed; there's no evidence
  yet that a shorter/longer or configurable interval is worth the extra
  Settings surface.
- **Market hours are computed in Eastern time via `Intl.DateTimeFormat`,
  not trusted to the server's own clock/timezone.** The deployment target
  (see "Deployment target" above) could run in any local timezone, but
  "market hours" always means 9:30am-4:00pm Eastern regardless of where the
  process lives. Verified against boundary cases (9:29 vs 9:30, 3:59 vs 4:00,
  Saturday, Sunday), not just read for correctness.
  **Known limitation, not fixed**: no market-holiday calendar. Thanksgiving,
  Christmas, etc. are still treated as open Mon-Fri sessions -- a wasted poll
  or two a year, not worth a holiday list yet.
- **The webhook is deliberately generic** (`services/notifyService.js`):
  when `Settings > General > Alert webhook URL` is set, every
  `checkAlerts()` (both the new 15-min poll and the existing manual
  "Refresh Prices" button) and `refreshSingleTicker()` call that fires at
  least one alert POSTs `{event, triggeredAt, alerts: [...]}` there. This app
  has no idea what's listening -- a curl-to-a-script, an `ai_orchestrator`
  automation once that's ready, Pushover, anything. A failed delivery
  (network error, non-2xx, DNS failure) is caught and logged, never thrown --
  the alert was already recorded in the DB by the time the webhook call
  happens, so a dead endpoint on the other end shouldn't make the app think
  alert-checking itself failed. Verified with a stubbed `global.fetch`:
  confirmed it sends the right payload to the right URL when configured,
  no-ops when the URL is empty (the default), and swallows a simulated
  network failure without throwing.
- **In-app surfacing was the other missing half.** Before this, a fired
  alert only flipped `watched_items.status` to `'ALERT'` -- visible only if
  you happened to be looking at that exact row. Added a header bell
  (`modules/alerts/`) that polls `GET /api/alerts` every 60 seconds
  (cheap -- an indexed query, not a provider call) and shows an
  unacknowledged count badge; clicking it opens a dialog listing them with a
  Dismiss action per row and a Dismiss All. Backed by the `alerts` table's
  existing (and previously unused) `acknowledged_at` column -- no schema
  change needed.
- **Acknowledging an alert doesn't touch the watched_item's own `status`.**
  It stays `'ALERT'` even after the notification is dismissed -- dismissing
  just clears the bell, it isn't the same action as re-arming the watch for
  a future trigger (there's currently no way to move an item back to
  `'WATCHING'` at all; that's a separate, not-yet-requested feature).
- **The bell is always visible, not tied to any view.** Every other module
  in this app only runs while its view is active and reloads via the
  `reloadXView()` pattern main.js calls on tab switch; the bell is the first
  UI piece that needs to work regardless of which tab is open, so it owns
  its own polling loop instead.

**What's verified**: a new `test-offline.js` section (`3f`) covers all of the
above -- `isMarketOpen`'s boundary cases, `deliverAlertWebhook`'s paths (no
alerts, no URL configured, an actual stubbed send/failure, and -- added
2026-07-27 alongside the HA auth-header work -- confirming no `Authorization`
header goes out when unset and that a configured one is sent verbatim), and
the full list/acknowledge/acknowledge-all flow including cross-holder
ownership checks (acknowledging someone else's alert is a no-op). 360 checks
total, 0 failed, run against a freshly-initialized DB. The wiring check
(section 9) now also scans `modules/alerts/index.js` -- 207 ids checked, all
found -- and confirms `.alerts-bell` markup exists. Every touched file passes
`node --check`.

**Clicked through for real (2026-07-27)**: added a BUY_LIMIT watched item
with a deliberately unreachable target (so it fires on the very next check),
hit `/api/check-alerts` against live Yahoo data, and confirmed end to end in
a real browser: the header badge appeared with the right count, opening the
bell rendered the row with the correct message/timestamp, Dismiss removed a
single row and cleared the badge, and Dismiss All cleared multiple rows at
once (re-tested with two more real tickers). Also caught that the dev server
process had detached from its terminal -- `Ctrl+C` no longer stopped it, and
closing the window left it running in the background bound to port 3113; had
to `taskkill` it directly. Not related to the app code, but worth knowing:
"the server's not responding to Ctrl+C" doesn't mean it's not running. This
led directly to the graceful-shutdown handlers and `npm run stop`/`restart`
scripts described under "Picking this back up after a break" at the top of
this doc.
**Still not verified**: the webhook actually firing against a real endpoint
(only exercised via a stubbed `fetch` in tests so far, since `alert_webhook_url`
is unset) -- that's still waiting on `ai_orchestrator` per Joe's plan.

### Where this webhook is actually headed (2026-07-27)

Discussed with Joe what's on the receiving end. Plan: notifications go to
Home Assistant first (Joe's choice: HA's authenticated
`/api/services/notify/<target>` REST endpoint, the same pattern his
`ai_orchestrator` docs already use elsewhere for the cert-renewal script's
notifications -- not an HA webhook-trigger automation, which was the other
option and would've needed no code changes but is a different, unauthenticated
pattern). Separately, "Becca" (the Gemini voice assistant in that same
project) will read alert data for a daily brief and can dismiss the bell via
voice command.

**The Becca side needs no new building here** -- `GET /api/alerts` (raw
unacknowledged list), `GET /api/summary` (bundles portfolio + movers + the
same alerts, better shaped for a daily brief -- already built for a separate
always-on TV dashboard project, "Prime_Dashboard"), `POST
/api/alerts/:id/acknowledge`, and `POST /api/alerts/acknowledge-all` all
already exist and do exactly what that use case needs. What's missing is
entirely on the `ai_orchestrator` side (a persistent NUC service that Becca's
trigger phrases hand off to isn't built yet, per that project's own docs) --
not this project's job to build.

**What *was* built here, to support the HA choice**: HA's
`/api/services/notify/<target>` needs a bearer token, and
`notifyService.js`'s webhook sender had no way to send one. Added:
- `alert_webhook_auth_header` setting (default `""`) alongside
  `alert_webhook_url`. Sent verbatim as the request's `Authorization` header
  when non-empty -- e.g. paste in `Bearer <ha-long-lived-token>` and it goes
  out exactly as-is. Deliberately not split into "scheme" + "token" fields;
  a single opaque string keeps this reusable for any future webhook target
  needing a different auth scheme.
- Settings UI: a password-type input right under the webhook URL field, with
  a hint explaining it's optional and what it's for.
- Two new offline checks (360 total, 0 failed): confirms no `Authorization`
  header is sent when the field is empty, and confirms it's sent verbatim
  when set (`"Bearer test-token-123"` round-tripped through a stubbed
  `fetch` exactly as configured).

**Judgment call worth flagging**: like every other setting in this app, the
token is stored in plain text in `app_settings` and gets echoed back into the
Settings form's password field on load (masked visually, but present in the
page same as any password-type input would be) -- consistent with this app's
existing no-auth, single-user, local-only security posture, but it's a real
credential, unlike everything else currently in that table. Fine for now;
worth a second look if this app is ever exposed beyond localhost.

**Not yet done**: actually entering Joe's real HA target URL and token into
Settings -- that's Joe's to type in himself (per this session's own rule
about never entering credentials/tokens into a field on someone's behalf),
once he's picked the target (`notify.mobile_app_...`, `notify.persistent_notification`,
or whatever HA service he wants to call) and has the long-lived token handy.

## Judgment calls made that are worth double-checking with Joe

These were reasonable defaults, not confirmed requirements — flag if
picking this back up and something here doesn't match intent:

- **Alert trigger semantics** (`watchlistService.js`, `isTriggered()`):
  `BUY_LIMIT` fires when price <= `buy_price_high` (and >= `buy_price_low`
  if a floor is set); `SELL_LIMIT` fires when price >= `take_profit_low`
  (and <= `take_profit_high` if a ceiling is set). A single-number alert
  like "tell me when XYZ hits $11" sets `buy_price_high` (or
  `take_profit_low`) = 11 and leaves the other bound null. `escape_price`
  exists in the schema but isn't wired into any alert logic yet — no
  stop-loss watching yet.
- **Exchange handling**: if a caller doesn't specify an exchange,
  `getOrCreateSecurity` matches by symbol alone (first match wins). Fine
  for a personal watchlist where symbol collisions across exchanges are
  unlikely; would need revisiting for a multi-exchange/international
  portfolio.
- **Provider default**: Yahoo is the default for all polling (free,
  effectively unlimited for personal use). Finnhub is opt-in via
  `{ provider: 'finnhub' }` — intended for a future "real-time top-up on
  something you're actively watching right now" use case, not built yet.
- **Watchlists are one-list-per-item, not tags** (Joe's explicit choice
  when asked): every `watched_item` belongs to exactly one `watchlists`
  row. A holder always has at least one list — "General" — auto-created
  the first time a ticker is added without picking a list.
- **The "Orders" watchlist is virtual, not a real row.** It lists every
  ticker currently held (`quantity_remaining > 0`), derived from positions
  on every read rather than synced into `watched_items`. That means it can
  never drift out of date and there's nothing to migrate when a position
  opens or closes. Its id is the string `"orders"` so it can't collide with
  a numeric list id, and its rows use `order_type: 'HELD'` with
  `is_virtual: 1` and non-numeric ids. Rename/delete/add are all refused in
  the service layer, not just hidden in the UI.

  **Caveat for future work:** `listWatchlists()` now returns this virtual
  entry alongside real ones. Any caller that iterates the result and mutates
  each entry must skip `is_virtual` rows — this already caught a test that
  looped and deleted every list.
- **`order_type` has three values, not two**: `BUY_LIMIT`, `SELL_LIMIT`, and
  `WATCH`. `WATCH` means "just tracking this ticker, no price target, never
  alerts" — `isTriggered()` always returns `false` for it, and the add-form
  doesn't require a target price when it's selected. Added after Joe
  pointed out the original two-option form couldn't represent "just watch
  this" without faking a price target.
- **Duplicate warning is per symbol + order type, and never blocks.** Adding
  a ticker checks `GET /api/watched-items/check` first; if that symbol
  already exists with the *same* type on any list, a dialog lists the
  existing entries and offers Cancel / Add Anyway. Same symbol with a
  *different* type (NVDA as both WATCH and BUY_LIMIT) is a legitimate setup
  and passes silently. `CANCELLED`/`EXPIRED`/`EXECUTED` entries don't count
  — re-watching something you closed out is a new decision. The check is
  advisory only; the POST endpoint deliberately does not enforce it.
- **No auth.** `holderService.getOrCreateDefaultHolder()` just finds or
  creates the one `account_holders` row with `is_default=1` and every route
  uses it. Fine for a single-user personal app; would need real auth before
  this could ever be exposed beyond localhost. Settings lets you create
  multiple holders and switch which is default, but there's no per-request
  holder selection yet — the app always acts as the default holder.
- **Settings guardrails** (all enforced in the service layer, not just the
  UI): general settings are whitelisted so a typo'd key can't pollute
  `app_settings`, and `schema_version` specifically can't be written through
  them; you can't delete your only watchlist or your only account holder;
  deleting a non-empty list requires explicitly choosing to move or delete
  its items; retyping an advice source (person → book) clears the old type's
  detail row so it can't shadow the new one.
- **Advice source detail tables are driven by one map** (`DETAIL_TABLES` in
  `sourcesService.js`). Adding a new source type means adding one entry
  there plus a table — not editing several parallel switch statements.
- **Book/website PDF and link fields are plain newline-separated text.**
  Actual file upload and PDF storage is deliberately deferred (Joe: "can be
  added later"); these columns hold references until that's built.

## Suggested next steps (in no particular order)

- **First thing in a new session**: `npm install && npm start`, open
  `http://localhost:3113`, and actually click through — add a ticker, add a
  list, hit Refresh Prices, try the "⚙ Columns" button on the Watchlist and
  both Orders tables (drag to reorder, check/uncheck to show/hide, Reset to
  Default), try the Journal tab (log an idea, execute it, confirm it becomes
  a real Orders position), and try the Paper Trade tab (log a paper trade
  tagged with a strategy, confirm the Strategy column shows it, then Promote
  it and confirm it moves into Orders with its source/strategy links intact).
  ~~Try the new alerts bell~~ Done -- see "Clicked through for real
  (2026-07-27)" above. This is still the layer of the app (Watchlist/Orders/
  Journal/Paper Trade UI, Settings UI) that mostly exists only as unexecuted
  code -- alerts is the first piece of it now actually verified live.
- ~~Get a Finnhub API key and actually run the Finnhub path once, live.~~
  Done -- see "Finnhub path is now live-verified" above. Decide next: does
  Finnhub get surfaced anywhere in the UI (e.g. a manual "real-time refresh"
  option in the ticker detail dialog), or does it stay backend-only until
  the "Finnhub news in the detail panel" backlog item gets built?
- ~~Wire `checkAlerts()` to run on a timer instead of only on a manual
  "Refresh Prices" click.~~ Done -- see "Scheduled alerts + webhook delivery"
  above. Decide next: once `ai_orchestrator` is ready to receive it, point
  `Settings > General > Alert webhook URL` at whatever endpoint that project
  exposes.
- Build the Imports service (`import_batches` → `import_raw_rows` →
  reconciled `transactions`) — CSV parsing for Fidelity/E-Trade/Robinhood
  formats not started. This is the single largest unbuilt feature at this
  point.
