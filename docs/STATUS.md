# Strategy Lab V2 — Status

Last updated: 2026-07-24 (watchlist UI added). Read this first in any new
session before touching code — it's the "external brain" for where this
project is and why.

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
| Price data pull (Yahoo/Finnhub) | Done, tested (Yahoo live-verified; Finnhub untested, no API key yet) |
| Historical price storage | Backfills 2yr daily OHLCV + dividends/splits on ticker add; `POST /api/refresh-history` re-runs for all watched tickers. Storage/idempotency tested offline; live backfill not yet run |
| Orders (log buys/sells, positions, history) | Built with full lot accounting; services heavily tested offline, UI not yet clicked through |
| Dashboard | Card grid + table toggle + click-through ticker detail built; services tested offline, UI not yet clicked through |
| Imports | Not started |
| Journal / Strategy Lab | Schema exists (`advice_sources`, `strategies`, `watched_items`/`transactions` with `is_paper_trade=1`); no service code yet |
| Settings | First pass done: Lists, Advice Sources, Account Holders, Exchanges, General. Services tested offline; UI not yet clicked through |
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
- `npm run test:offline` (`scripts/test-offline.js`): 170 checks covering
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
- Finnhub path (`services/providers/finnhubProvider.js`) is written against
  the real Finnhub REST API docs but has **not** been exercised end-to-end —
  no `FINNHUB_API_KEY` available to test with yet.

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
    tickerDetailService.js         -- everything the Dashboard detail dialog shows (stored data only)
    providers/
      yahooProvider.js             -- wraps yahoo-finance2 (quote, chart, quoteSummary)
      finnhubProvider.js           -- wraps Finnhub REST (quote, profile2) -- untested live
  public/                          -- served statically by server.js
    index.html                     -- both views (watchlist + settings) live here, toggled by main.js
    css/style.css
    js/
      main.js                      -- bootstraps the app, owns Watchlist/Settings view switching
      modules/dashboard/           -- index (conductor) / api / render  (cards, table, detail dialog, SVG chart)
      modules/watchlist/           -- index (conductor) / api / render / handlers
      modules/orders/              -- same four-file split, for the Orders view
      modules/settings/            -- same four-file split, for the Settings view
  .env.example                     -- FINNHUB_API_KEY, DB_PATH
  package.json
```

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
  list, hit Refresh Prices. This is the one layer of the app that exists
  only as unexecuted code right now.
- Get a Finnhub API key and actually run the Finnhub path once, live.
- Wire `checkAlerts()` to run on a timer (cron-style) instead of only on a
  manual "Refresh Prices" click.
- Build the Journal/Strategy Lab service layer (schema already supports
  it: `advice_sources`, `strategies`, `watched_items`/`transactions` with
  `is_paper_trade=1`).
- Build the Imports service (`import_batches` → `import_raw_rows` →
  reconciled `transactions`) — CSV parsing for Fidelity/E-Trade/Robinhood
  formats not started.
- Only after transactions/imports exist: build Dashboard (reads open BUY
  lots + `quotes_cache` for live P&L).
