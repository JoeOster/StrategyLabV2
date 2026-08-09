# V2 Backlog

Ideas captured but deliberately not built yet. Each entry says enough to pick
up cold, including the open questions that would need answering first.

---

## Ticker research skill

**What Joe asked for:** "a Claude skill in here for ticker research ... for
current news and data affecting stock." Confirmed shape: **a skill file
invoked in a chat session**, not an in-app LLM integration. No API key, no
per-call cost, no server code — you'd say something like "research NVDA" in
a Cowork/Claude Code session and get a written brief back.

**Where it hooks in:** the Dashboard's ticker detail dialog currently has a
disabled-in-spirit **"Research (coming soon)"** button that explains this and
points here. That's the placeholder to replace.

**Sketch of the skill** (`.claude/skills/ticker-research/SKILL.md`):

1. Read the app's own data for the ticker — either by querying
   `data/strategy_lab.dev.db` directly, or by calling the running server's
   `GET /api/ticker/:symbol`, which already returns profile, quote, 52-week
   range, stored price history, the user's lots, trade history and watchlist
   entries. Prefer the API when the server is up; fall back to the DB file.
2. Web-search for recent news, earnings dates, analyst commentary, and
   anything material since the last check.
3. Cross-reference the two: does the news explain a move the stored price
   history shows? Is there an earnings date near a watchlist target?
4. Write a brief that explicitly separates **what the app knows** (position,
   cost basis, targets) from **what the web says** (news, dates, opinion),
   so sourcing stays legible.

**Open questions before building:**

- Should the brief be saved back into the app (a `notes` field, or a new
  `research_notes` table keyed by security + date) or just printed in chat?
  Saving it makes it reviewable later but needs a schema bump.
- How much history to include — last 7 days of news, or since the position
  was opened?
- Should it flag anything actionable (e.g. "earnings in 3 days and you have
  a stop 2% away"), or stay purely descriptive? Actionable framing edges
  toward advice, which is worth being deliberate about.

---

## Fidelity ledger sync via browser automation (idea captured 2026-08-09)

**What Joe described:** the manual process of keeping "what's currently
owned" up to date is a real pain point. Idea: Claude in Chrome could click
Fidelity's own "update"/refresh control, navigate to the activity/ledger
page, and capture the transaction data directly from the rendered page —
sidestepping the fact that "Fidelity has a poor and undocumented API."

**Why this beats hand-writing a Fidelity CSV parser:** the existing **CSV
import** item (see "Other deferred items" below) assumed someone would
export a CSV and write a parser for Fidelity's specific format. Reading the
ledger page directly with browser automation skips needing to reverse-engineer
that format or any undocumented API at all — it reads exactly what a human
would see, using the session you're already logged into. **This is a
different shape of feature than CSV import, not just a different data
source**: it's chat-invoked (you ask for a sync in a session with the Chrome
extension connected), not a server-side file upload — same shape as the
Ticker research skill above, not a new API endpoint.

**The useful design insight:** `import_raw_rows.raw_data` is already just
"JSON blob of the original CSV row" (`schema.sql`) — nothing about that
staging table actually requires the JSON to have come from a CSV file. A
scraped ledger row can land in `import_raw_rows` exactly the same way,
reusing the whole existing reconciliation pipeline (`import_batches` →
`import_raw_rows` → matched/flagged/reconciled into `transactions`) —
**this becomes the second producer for a pipeline the CSV import item
already needs to build**, not a separate mechanism. Whichever gets built
first (CSV parsing or the scrape) should design `import_raw_rows`'
consumption side to not care which one wrote the row.

**Sketch, if built as a Claude Code skill** (mirrors Ticker research skill's
shape — `.claude/skills/fidelity-sync/SKILL.md`):

1. Use the Chrome extension tools against the user's own already-logged-in
   Fidelity session — reading a page you're already authenticated into is
   fine; typing a Fidelity password never is (session rule, not specific to
   this feature).
2. Click through to trigger a refresh, then to the activity/transaction
   ledger view; extract rows (`get_page_text`/`read_page`, not a screenshot
   — need structured text, not pixels).
3. Turn each extracted row into the same shape a CSV row would produce, and
   insert into `import_raw_rows` under a new `import_batches` row
   (`broker='fidelity'`, no `filename` — or a synthetic one noting it was
   scraped, not uploaded).
4. From there it's the CSV-import reconciliation flow, unmodified: match
   against existing `transactions` (via `external_ref` — Fidelity's own
   transaction id if the ledger page exposes one, otherwise the same
   fingerprint approach CSV import already calls for:
   `(account, ticker, date, type, qty, price)`), flag genuinely new rows,
   let the user confirm before anything promotes into `transactions`. Don't
   auto-commit scraped rows straight through — a page-structure change on
   Fidelity's end should fail loudly (unexpected/missing fields), not
   silently import garbage.

**Open questions before building:**

- Does Fidelity's ledger page expose its own transaction id anywhere in the
  DOM, or is the fingerprint approach the only option? Changes how reliable
  dedup is.
- This only works in a session with Claude in Chrome connected and Fidelity
  already logged in — worth being explicit that it's an on-demand chat
  action ("sync my Fidelity ledger"), not something that runs unattended.
- Whether to build the `import_raw_rows` → `transactions` reconciliation UI
  (needed either way) before or alongside the scraping half — the
  reconciliation side has value on its own once real CSV parsing exists too.

---

## Backtesting / AI trade evaluation — multi-agent design (scoped 2026-08-09)

**Where this came from:** evaluated a paid product, AlphaAgents.ai ("AI
Trading Floor" — 4 Claude Code agents wrapping public strategies like
Minervini VCP / CANSLIM, sold via a Facebook-ad funnel). Verdict: skip
buying it — anonymous seller, no refunds above $7, an aggressive perpetual
license grab on any strategy you submit to their "custom build" service, no
independent reviews. But the underlying pattern (researcher → backtester →
auditor → chart agents) is a reasonable design, worth building against this
app's own schema for free when Phase 2 actually starts. Full writeup of the
product evaluation exists outside this repo if it's ever needed again — the
short version is above.

**Still gated by STATUS.md's Phase 2 rule** ("AI-assisted trade evaluation
and strategy backtesting... deferred on purpose until the core app is
solid") — this section is a design to pick up cold later, not a plan to
start now.

### How the 4-agent pattern maps onto this app

1. **Strategy Agent (Researcher)** — the structured-extraction sibling of
   the "Ticker research skill" above: instead of researching a *ticker*, it
   extracts entry/exit/position-sizing rules from a source (book, video,
   podcast) into a brief. Today `strategies` is just `title` + `notes`
   (free text) — nothing structured enough for a script to execute.
   **Correction to this doc's first draft:** `schema.sql`'s own comment on
   `strategies` and `DB_ARCHITECTURE.md`'s "What this deliberately leaves
   out (Phase 2)" section already answer the "extension table vs. JSON
   column" question — the plan on record is a **`rules_json` column added
   directly to `strategies`**, not a new extension table. The
   `advice_source_*_details` extension-table pattern is for mutually
   exclusive subtypes (a source is a person *or* a book, never both);
   `rules_json` is closer to "one more optional attribute every strategy
   row can eventually have," which is exactly what that column was already
   reserved for. Sketch of its shape (illustrative, not final):
   ```json
   {
     "version": 1,
     "entry_conditions": [
       {"indicator": "close", "op": "crosses_above", "value": "sma_50"},
       {"indicator": "volume", "op": ">", "value": "avg_volume_20 * 1.5"}
     ],
     "exit_conditions": {
       "take_profit_pct": 20,
       "stop_loss_pct": 8,
       "max_hold_days": 90
     },
     "position_sizing": { "method": "fixed_risk_pct", "risk_pct_of_equity": 1.0 },
     "regime_filter": { "market_index": "SPY", "condition": "close > sma_200" }
   }
   ```
2. **Backtesting Agent (Quant)** — not really an LLM job. A script (that an
   agent writes, or a fixed one an agent calls) reads `historical_prices` +
   `dividends`/`splits` for one security and simulates a strategy's
   `rules_json` day-by-day. New tables to hold results, following this
   schema's existing conventions (real FKs, CHECK'd enums, `created_at`):
   ```sql
   CREATE TABLE backtest_runs (
     id              INTEGER PRIMARY KEY,
     strategy_id     INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
     security_id     INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
     rules_snapshot  TEXT NOT NULL,   -- JSON copy of rules_json AT RUN TIME --
                                       -- strategies.rules_json can change later;
                                       -- this keeps a run reproducible regardless
     date_range_start TEXT NOT NULL,
     date_range_end   TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'completed'
                        CHECK (status IN ('completed','failed')),
     total_trades    INTEGER,
     win_rate        REAL,
     avg_r_multiple  REAL,
     sharpe_ratio    REAL,
     max_drawdown_pct REAL,
     total_return_pct REAL,
     created_at      TEXT NOT NULL DEFAULT (datetime('now'))
   );

   CREATE TABLE backtest_trades (
     id              INTEGER PRIMARY KEY,
     backtest_run_id INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
     entry_date      TEXT NOT NULL,
     entry_price     REAL NOT NULL,
     exit_date       TEXT,
     exit_price      REAL,
     quantity        REAL NOT NULL,
     r_multiple      REAL,
     exit_reason     TEXT CHECK (exit_reason IN
                        ('take_profit','stop_loss','signal_exit','end_of_backtest'))
   );
   ```
   Open question deliberately left open: the equity curve itself (a
   date→value series per run) — a JSON blob column on `backtest_runs`, or a
   normalized `backtest_equity_points` table matching how `historical_prices`
   treats OHLCV as real rows rather than a blob? The normalized version is
   more consistent with this schema's own stated philosophy but is a lot
   more rows across many runs — worth deciding against real usage patterns,
   not guessing now. Also out of scope for v1: multi-security/portfolio-level
   backtests (the AlphaAgents pitch's "Portfolio Builder" stacked several
   strategies together) — `backtest_runs` above is deliberately one
   strategy × one security × one date range, matching how `historical_prices`
   itself is keyed.

   **A real correctness trap to design around, not just an auditor's job to
   catch after the fact:** `historical_prices.adj_close` already bakes in
   both dividends *and* splits (standard Yahoo/Finnhub convention), while
   `dividends` and `splits` also exist as their own tables. Computing
   `total_return_pct` from `adj_close` deltas **and** separately adding back
   `dividends` amounts during the hold period would double-count — this is
   exactly the "made a losing strategy look like a 40% annual winner" class
   of bug the AlphaAgents pitch used as its hook. Rule to write into the
   engine itself, not just hope the auditor notices: use `adj_close` alone
   for the equity curve / total-return math; use raw `close` only where the
   backtest needs to simulate an actual fill price (e.g. `entry_price` /
   `exit_price` on `backtest_trades`, so trade-level numbers read like real
   prices a human would recognize on a chart).
3. **Auditor Agent (Risk Manager)** — the highest value-to-effort piece, and
   the one to prototype first, independent of the rest. A separate subagent
   context (deliberately not the one that ran the backtest — an agent
   shouldn't grade its own work) reviewing a `backtest_run` for lookahead
   bias, curve-fitting, single-outlier dependency, and regime-only
   performance. Following this schema's own "alerts are a durable log, not
   just a status flag" principle (`DB_ARCHITECTURE.md` point 6) rather than
   bolting an `audit_verdict` column onto `backtest_runs`:
   ```sql
   CREATE TABLE backtest_audits (
     id              INTEGER PRIMARY KEY,
     backtest_run_id INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
     check_type      TEXT NOT NULL CHECK (check_type IN
                        ('lookahead_bias','curve_fitting','outlier_dependency',
                         'regime_dependency','data_leak')),
     verdict         TEXT NOT NULL CHECK (verdict IN ('pass','flagged','failed')),
     notes           TEXT,
     created_at      TEXT NOT NULL DEFAULT (datetime('now'))
   );
   ```
   One row per check per run keeps it queryable ("show every run ever
   flagged for lookahead bias") and supports re-running the audit later
   (e.g. after tightening the auditor's own prompt) without losing history —
   usable standalone against even one hand-built backtest, before the
   Strategy/Chart agents exist.

   **What each `check_type` actually looks for** — worth pinning down now,
   since "the auditor agent checks for X" was doing a lot of unexamined work
   in the original pitch. Most of these are deterministic computation, not
   LLM judgment — the agent's real job is running the check and writing the
   human-readable verdict/notes, not eyeballing numbers and guessing:
   - **`lookahead_bias`** — best caught structurally, not after the fact:
     the backtest engine should only ever be *able* to query
     `historical_prices WHERE date <= as_of_date` while simulating a given
     day (never the whole table at once). The auditor's job then becomes
     either a code-level check that the engine respects that boundary, or a
     spot-replay of a sample of `backtest_trades` rows — re-derive whether
     the entry condition in `rules_snapshot` is actually computable using
     only rows dated on/before that trade's `entry_date`.
   - **`curve_fitting`** — needs a comparison, not a single run: split
     `date_range_start`/`date_range_end` into an in-sample slice (e.g. first
     70%) and out-of-sample slice, run the backtest engine on each
     separately (this is just two `backtest_runs` rows), and flag a sharp
     drop in `sharpe_ratio`/`win_rate` out-of-sample. A cheap first-pass
     heuristic that doesn't need a second run at all: count the tunable
     values in `rules_snapshot` against `total_trades` — very few trades per
     free parameter is itself a red flag.
   - **`outlier_dependency`** — pure arithmetic on `backtest_trades`:
     recompute `total_return_pct`/`win_rate` with the single best trade
     excluded; flag if removing one trade flips the run from profitable to
     not, or accounts for an outsized share of total return.
   - **`regime_dependency`** — needs a benchmark to compare against (SPY is
     the obvious default — worth an `app_settings` key rather than a
     hardcode, matching how `app_settings` already stores things like
     default take-profit percentage). Flag if `backtest_trades.entry_date`
     values cluster almost entirely inside one favorable stretch of the
     benchmark's own `historical_prices` trend rather than spreading across
     multiple regimes/years.
   - **`data_leak`** — mostly a `rules_json` validation problem: reject (at
     Strategy Agent output time, ideally, not just audit time) any
     entry/exit condition referencing a field that isn't actually knowable
     as of the bar in question (e.g. a rule written against "next day's
     open").
4. **Chart Agent (Visual Analyst)** — lowest priority. Plots
   `backtest_trades` over `historical_prices` candles so a strategy's
   numbers can be sanity-checked visually (e.g. a 60% win rate that's
   secretly just catching one regime). Straightforward once
   `backtest_trades` exists.

### Suggested build order, whenever this gets picked up

1. `rules_json` column on `strategies` + a way to hand-enter one strategy's
   rules — skip the "extract from source" automation at first; prove the
   backtest engine on one manually-encoded strategy.
2. `backtest_runs` / `backtest_trades` tables + the backtest engine
   consuming `historical_prices`/`dividends`/`splits`.
3. `backtest_audits` + the auditor agent reviewing a `backtest_run` —
   usable on its own before step 4 or 5 exist.
4. Strategy Agent automation (source → `rules_json`) — same shape as the
   Ticker research skill above; worth sharing conventions between the two
   rather than solving "skill output: saved to DB vs. printed in chat"
   twice.
5. Chart agent last.

---

## Finnhub-powered news in the detail panel

Separate from the skill above and complementary to it: Finnhub's free tier
includes company news, earnings calendar, and basic sentiment. Those could
populate the detail dialog with real headlines and dates without any LLM
involvement, refreshed by the existing polling machinery.

Blocked on: getting a `FINNHUB_API_KEY` and running the Finnhub provider
path live for the first time — it's written but has never executed (see
STATUS.md).

---

## Wire the alert webhook up for real (HA + Becca)

The webhook mechanism and its optional auth header are both built (see
STATUS.md's "Scheduled alerts + webhook delivery" section, "Where this
webhook is actually headed"). What's left is entirely configuration + a
separate project, not StrategyLabV2 code:

- **Home Assistant**: Joe needs to type his real HA target
  (`/api/services/notify/<target>`) and long-lived access token into
  `Settings > General`'s `Alert webhook URL` / `Alert webhook auth header`
  fields himself. Nothing to build.
- **Becca (voice assistant, in `ai_orchestrator`)**: reads alert data for a
  daily brief and dismisses the bell by voice. The StrategyLabV2 API side is
  already complete for this (`GET /api/alerts`, `GET /api/summary`,
  `POST /api/alerts/:id/acknowledge`, `POST /api/alerts/acknowledge-all`) —
  nothing to build here. What's missing is a persistent NUC-side service in
  `ai_orchestrator` that Becca's trigger phrases hand off to, which doesn't
  exist yet per that project's own docs (`projects/becca-orchestrator-voice-
  delegation.md`). That's a future session in that other project, not this
  one.

---

## Other deferred items

- **CSV import** (`import_batches` → `import_raw_rows` → reconciled
  `transactions`). Schema exists and is idempotent-by-construction; no
  parsing code written. Broker formats to support: Fidelity, E-Trade,
  Robinhood. See "Fidelity ledger sync via browser automation" above —
  browser-scraped rows and parsed-CSV rows can share this same
  `import_raw_rows` reconciliation pipeline rather than needing two.
- ~~**Journal / Strategy Lab module.**~~ Built -- see `STATUS.md`'s "Journal
  / Strategy Lab" section for the design and the judgment calls made. Left
  deliberately narrow for v1, worth revisiting: **executing a paper idea only
  supports turning it into a BUY** (a paper `SELL_LIMIT` idea just keeps
  alerting normally; there's no "execute into a real SELL" flow yet, since
  that would need to target a specific existing real lot rather than open a
  new one). Also not built: journal-entry column customization (it renders as
  a plain list, not hooked into the `tableRegistry`/Columns system).
- ~~**Strategies locked to one source.**~~ Redesigned as many-to-many (schema
  v5) -- see `STATUS.md`'s "Strategies redesign" section. A strategy can now
  be tagged with multiple sources (book, person, podcast, ...), each with its
  own chapter/page/notes, and a Journal idea's displayed chapter/page
  resolves from the specific source it actually used.
- ~~**Paper Trade tab.**~~ Built as a full paper-trading simulator (schema
  v6) -- see `STATUS.md`'s "Paper Trade tab" section. Log paper BUY/SELL/
  DIVIDEND transactions tagged with a strategy, "Promote" a paper BUY into a
  real Orders position in place (source/strategy links carry over). v1 is
  unconstrained (no virtual cash balance) per Joe's choice. **Left
  deliberately narrow, worth revisiting**: promoting only works on an
  untouched lot -- a paper position that's already been partly sold (on
  paper) can't be promoted yet, since that raises a real design question
  (what happens to the paper SELL rows against it?) that wasn't worth
  guessing at for v1.
- ~~**Scheduled price/alert checks.**~~ Built: a market-hours-aware 15-min
  scheduler (`services/alertScheduler.js`) now calls `checkAlerts()`
  automatically, no button press needed -- see `STATUS.md`'s "Scheduled
  alerts + webhook delivery" section.
- ~~**Alert delivery.**~~ Built: fired alerts now surface in-app via a header
  bell (badge count, acknowledge/dismiss-all) and fire a generic outbound
  webhook (`services/notifyService.js`, configurable `alert_webhook_url`
  setting) so `ai_orchestrator` or anything else can hook in later -- see
  `STATUS.md`'s "Scheduled alerts + webhook delivery" section.
- **Real authentication.** Everything currently acts as the one default
  account holder. Settings can create multiple holders but there's no
  per-request holder switching, and no login at all. Required before this
  could be exposed beyond localhost.
- **Migrations.** `schema.sql` is only applied to fresh databases; schema
  changes currently mean rebuild-and-lose-data (guarded by the version
  check). Once there's data worth keeping, this needs numbered migration
  files.
- ~~**Backtesting / AI trade evaluation.**~~ The original Phase 2, still not
  started (deliberately — see STATUS.md). Design scoped as a 4-agent
  pipeline -- see "Backtesting / AI trade evaluation — multi-agent design"
  above for the researcher/backtester/auditor/chart-agent breakdown and
  suggested build order.
