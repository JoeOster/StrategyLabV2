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

### Concerns raised once a real, incremental course is the source (not just a book)

Raised 2026-08-09 once the actual first source material became concrete:
Joe's paid StockNavigators.com membership (Money Zone Method + Expert Trader
Program), captured via private Plaud transcripts/notes module by module over
time — not a single static book chapter, which is what the design above
implicitly assumed. Four things worth designing around before the Strategy
Agent has real content to chew on:

1. **The Strategy Agent needs its own fidelity check, not just the
   backtest.** The Auditor above only reviews the *backtest*. The more
   consequential failure mode is upstream: the Strategy Agent drifting from
   what the source notes actually said while extracting `rules_json` --
   inventing a threshold, dropping a condition, smoothing over an ambiguous
   instruction. Real risk when the source is paid course content being
   translated into money-affecting rules, not an abstract one. The existing
   human-approval gate ("produces a clean brief for your approval before
   testing") helps but isn't a fidelity check by itself -- worth adding an
   explicit second layer, the same adversarial-verify pattern already
   planned for the Auditor (a check whose only job is "does every claim in
   this brief trace back to the source notes"), applied one step earlier in
   the pipeline.
2. **`rules_json` needs a revision story, not just a snapshot story.**
   `backtest_runs.rules_snapshot` handles reproducibility *after* the fact,
   but there's no design yet for what happens when a later module's notes
   refine or contradict an earlier one -- expected, not edge-case, when a
   13-module course is recorded over several weeks and understanding
   deepens as it goes. Open question, not yet answered: does a revised
   `rules_json` just overwrite in place (relying on `rules_snapshot` to
   preserve old backtest history), or does the strategy itself need an
   explicit version/revision concept?
3. **Position sizing can be recorded before it can be backtested.**
   `rules_json.position_sizing` (e.g. `risk_pct_of_equity`) only means
   something against total capital and current exposure across *all* open
   positions -- and Paper Trade is explicitly "unconstrained, no virtual
   cash balance" per `STATUS.md`. Matters more now specifically because risk
   management is StockNavigators' stated core teaching, not an incidental
   detail. Sharpens the "portfolio-level backtests are out of scope for v1"
   note above into something more exact: v1 can *store* a position-sizing
   rule, but can't *meaningfully backtest* it until a capital model exists --
   otherwise a backtest will silently report as if sizing worked when it was
   never actually modeled.
4. **Don't conflate two different kinds of chart image.** The Chart Agent's
   job (#4 above) is plotting *your* backtested trades over real price data.
   StockNavigators' own annotated screenshots (captured via Plaud's notes
   feature) are teaching reference material, not backtest output -- closer
   to what `strategy_sources.notes` (or a future `advice_sources` image
   field) holds. Noted so a future session doesn't try to make the Chart
   Agent ingest course screenshots.

### Forward-test validation: paper trading a backtested strategy for real (requested 2026-08-09)

**What Joe asked for:** once a strategy has been backtested, automatically
start a live paper-trading validation -- 5-10 real stocks, running for a
configurable window (he suggested ~3 weeks), sized against a configurable
starting capital (he suggested $10,000 default) -- so backtested performance
gets checked against what actually happens going forward, not just historical
simulation. "This will allow us to see actual usage."

This is the piece that makes every disclaimer already threaded through this
design mean something in practice: adj_close double-counting, curve-fitting,
"hypothetical performance... does not reflect execution latency" are all
really saying "a backtest can't prove a strategy works live." This is the
mechanism that actually tests that, spending the app's paper money instead of
real money.

**Where this reuses existing infrastructure, and where it genuinely doesn't:**

- Paper trades themselves need nothing new. `transactions` already supports
  `is_paper_trade = 1` tagged to a `strategy_id` -- the same mechanism the
  Journal/Strategy Lab tab already uses for one manually-entered paper idea,
  just automated and running across several tickers at once.
- **Entry/exit triggering does need something new.** `watched_items` /
  `isTriggered()` today only understand a fixed price bound
  (`buy_price_high`, `take_profit_low`, ...), not an arbitrary `rules_json`
  condition (`close crosses_above sma_50`, etc.). This is the same
  evaluation engine the Backtesting Agent needs to walk `rules_json`
  day-by-day against historical data -- build it once as a shared
  `evaluateRules(rulesJson, priceContext)` function, and it serves both: the
  Backtesting Agent loops it over `historical_prices`, this feature calls it
  once per scheduler tick against *current* data.
- The existing 15-min market-hours scheduler (`alertScheduler.js`) is the
  natural home for the live-checking half, not a new cron path. `BUGS.md`
  items #7 and #8 (no re-entrancy guard on that scheduler; an uncaught error
  can silently stop it rescheduling) get more important once it's also
  carrying live paper-trade evaluation, not just price alerts -- worth fixing
  those before this ships, not just noting they exist.

**New tables:**
```sql
CREATE TABLE forward_test_runs (
  id               INTEGER PRIMARY KEY,
  strategy_id      INTEGER NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  backtest_run_id  INTEGER REFERENCES backtest_runs(id) ON DELETE SET NULL,
  holder_id        INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  starting_capital REAL NOT NULL DEFAULT 10000,
  start_date       TEXT NOT NULL,
  end_date         TEXT NOT NULL,   -- start_date + configurable duration, default 3 weeks
  status           TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','cancelled')),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forward_test_candidates (
  id                   INTEGER PRIMARY KEY,
  forward_test_run_id  INTEGER NOT NULL REFERENCES forward_test_runs(id) ON DELETE CASCADE,
  security_id          INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  allocated_capital    REAL NOT NULL,
  UNIQUE (forward_test_run_id, security_id)
);
```
`transactions` needs one new nullable column, `forward_test_run_id`, so
paper trades this mechanism opens are traceable back to the batch that
opened them -- distinct from a manually-logged Journal paper idea, which has
none.

**Open questions:**

- **How are the 5-10 candidates chosen?** **Refined by Joe (2026-08-09,
  later the same day): scoped by the technique/strategy itself, and never
  the whole market -- exact mechanism still TBD.** He floated market
  sectors/themes (tech, AI, space, etc.) as one shape this could take, not
  a final decision. Worth flagging for whoever builds this: `securities`
  already has `sector`/`industry` columns (standard GICS-style categories
  from Yahoo's profile data), but "AI" and "Space" aren't GICS sectors --
  they're cross-cutting investment themes (a stock can be Technology sector
  *and* tagged AI *and* tagged Space simultaneously). If theme-based scoping
  is the direction this ends up going, it likely needs its own many-to-many
  tag concept, not a reuse of the single `sector` column as-is. Either way,
  this app doesn't have, and free-tier Yahoo/Finnhub don't cheaply support,
  a "scan the whole market" capability -- whatever the scoping mechanism
  turns out to be, it has to work from what's already being tracked
  (watched/held securities) or a small curated list, not a fresh universe
  scan.
- **Selection-bias risk, specific to forward-testing:** picking candidates
  *because* they already look like they're about to trigger the entry
  signal is the live-trading cousin of curve-fitting -- it flatters results
  the same way. Candidates should be chosen independent of current signal
  state (e.g. "the N most liquid names already on the watchlist," fixed
  before checking whether they currently qualify), not cherry-picked after
  peeking. Worth its own audit-style check here too, not just for backtests.
- **"3 weeks" is the run's total window, not each trade's hold time** --
  individual trades open and close within it per the strategy's own
  `exit_conditions.max_hold_days` (already in `rules_json`); a day-trading
  strategy might cycle through many trades per candidate in that window, a
  swing strategy far fewer. Worth being explicit so it isn't read as "hold
  every position for exactly 3 weeks."
- **What triggers a run starting?** User-confirmed after reviewing a
  backtest (ideally after the Auditor hasn't flagged anything major),
  matching the same human-approval-gate pattern already used for the
  Strategy Agent's brief -- not automatic on every backtest, which would
  burn through watchlist/scheduler capacity on every experimental run.
- **Resolves, and depends on, the position-sizing concern logged above:**
  `starting_capital` here is exactly the capital model that was missing for
  backtested position-sizing to mean anything (concern #3 above) -- this
  feature is what actually needs it built, not backtesting itself.

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
6. Forward-test validation (`forward_test_runs`/`forward_test_candidates` +
   the shared `evaluateRules()` engine) — after the backtest engine exists,
   since it reuses that same rule-evaluation logic rather than duplicating
   it. Fix `BUGS.md` #7/#8 (scheduler re-entrancy + crash-on-error) before
   this ships, since it adds real load to the same scheduler.

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

## AI assistance across the app -- standing directive (2026-08-21)

Joe: Claude/Gemini assistance is wanted broadly through Strategy Lab, so
opportunities for skills, agents and artifacts should be raised as they are
noticed rather than waiting to be asked for.

A working principle has already fallen out of the CSV import discussion and is
worth applying generally (full reasoning in `docs/IMPORTS.md`):

**Let the model produce configuration and judgement, not data.** Anything with
a single correct answer -- parsing, arithmetic, position maths -- stays
deterministic, because a plausible wrong number is silent and permanent. The
model is worth reaching for where the output is a *decision a human reviews*, or
a *config that gets checked in and reused*, rather than figures that flow
straight into the ledger.

Two already decided, see `docs/IMPORTS.md`:

- **Unknown-broker column mapping skill** -- reads ~20 sample rows from a
  broker nobody has written a parser for, emits a column mapping that the
  deterministic parser then executes forever. Concrete near-term need:
  TradeStation and thinkorswim accounts exist but are unfunded.
- **Import discrepancy advisor** -- explains `needs_review` rows in the import
  screen. Advisory only; it never writes a transaction.

Noticed and not yet scoped:

- **Reconciliation assistant for `needs_review` rows.** Joe is tracking down
  older Fidelity records that current exports cannot reach. When those arrive,
  matching them against flagged rows -- transferred-in lots with extrapolated
  cost basis, sells whose buys predate an export window -- is exactly the
  fuzzy, one-off, judgement-heavy work a model is good at and a rule is bad at.
  The flag columns (schema v10) already make the outstanding set queryable.
- **Journal adherence review.** Distinct from the backtesting and forward-test
  work above, which asks whether a strategy is any good. This asks a different
  question: *did you actually follow it?* Reading the journal and the trades
  together and reporting where they diverge is reasoning over the user's own
  writing, which is low-risk and squarely a strength.

A caution on artifacts specifically: portfolio and performance reports are an
obvious fit for the format, but this is real financial data. Artifacts are
private by default, though they are still hosted -- so treat a published report
as a deliberate decision each time, not a default output.

## Exit parameters: a minimal plan owning a ladder of rungs -- NEXT PIECE OF WORK

Decided 2026-08-21 after walking the Journal flow end to end. This is the
keystone: nothing in plan-vs-actual can be measured until a trade knows where
it was meant to exit.

Joe's framing: *"a plan should be a button on a trade that allows for high/low
limits/partial sells and the like"*, then *"basically adding parameters to the
existing trade"*, and when asked whether to follow his habits or model it
correctly: *"I almost always sell all or buy individual position, but what is
more correct is what we should do."* So this is modelled for correctness, not
for the common case -- though in the common case the two coincide.

### Exits belong to a THESIS, not to a lot and not to a position

Three candidate owners were considered. The reasoning matters, because the
obvious two are both wrong in this app specifically.

**A position (holder + account + security) is wrong.** Buy INTC twice -- once
because a Telegram group called it, once because the book's pattern appeared --
and those are two theses from two sources. A position-level ladder merges them
into one exit rule and destroys the attribution. `transactions.source_id`
exists per row precisely to keep them distinct; position-level exits would
discard that one layer up. Attribution is the entire purpose of the app, so
anything that merges theses is disqualified.

**A single lot is nearly right, but wrong the other way.** Scaling into ONE
thesis with two buys a week apart is one plan and should be one ladder. Keyed
per-lot it becomes two, which collectively oversell or under-cover.

**So: exits belong to a plan, where a plan is one entry thesis covering one or
more lots.**

### Shape

```
plans
  holder_id, security_id
  source_id?, strategy_id?     -- inherited from the opening trade
  status                       -- open | closed | cancelled
  notes, created_at

plan_exits                     -- the rungs
  plan_id
  kind             TAKE_PROFIT | STOP
  sequence         rung order
  quantity         how much this rung sells
  price_low/high   the band, same convention as the existing targets
  status           pending | hit | cancelled
```

`transactions` gains `plan_id`. Setting exits on a trade with no plan creates
one and attaches that lot; adding to the thesis attaches the new lot to the
same plan. A rung firing calls the existing `recordSell(quantity)` and FIFO
allocates within the plan's lots -- **the accounting engine is untouched.**

In the common case (buy once, sell all) a plan is one lot and one rung, so the
button still reads as "set exits on this trade". The structure only starts
mattering when scaling in or running two theses on one ticker -- which is
exactly when the answer would otherwise be unavailable.

### Why rungs are rows and not columns

Partial sells. "Sell 50 at $110, the other 50 at $120, stop the lot at $90"
cannot be expressed by price bands alone -- there is nowhere to say how MUCH
each target sells. `take_profit_2_low/high` was already the beginning of a
ladder that would otherwise grow a `_3` and a `_4`, each needing its own branch
in the evaluator. That accretion is what produced BUG 10, where the second
take-profit was unreachable in practice.

A stop is simply a rung with `kind = STOP`, normally for the full remaining
quantity. One evaluation path, no special case. `take_profit_2` and its enum
branch retire, and `triggerReason` collapses from four hard-coded cases into
"which rung was crossed".

### Division of labour with watched_items -- read before building

Exits will exist in two places, which is the shape of BUG 10 and must not
become it again. The split is by job, and it is clean:

- **`watched_items` exits govern getting IN.** Entry bands, alerting on a
  position not yet held.
- **`plan_exits` govern getting OUT.** They cannot exist before there is a
  position to exit.

Neither is a copy of the other and neither goes stale. If that ever stops being
true, one of them is wrong.

### What it buys

Adherence becomes exact rather than inferred: *rung 1 said sell 50 at $110; you
sold 50 at $109.20, two days late.* That is the execution-gap measurement the
four constraints say should lead the reporting -- and unlike source reliability,
it is answerable from a handful of trades.

### Scope and consequences

Self-contained. **No signals table, no rewrite of watched_items, no change to
the accounting engine or the importer.** Two new tables, one column on
`transactions`, one button, one dialog, and evaluation reusing the alert engine
wired and tested on 2026-08-21 -- which already fires once per level and records
which level via `alerts.trigger_reason`.

To handle during the build:

- A plan is finished only when its rungs are exhausted or cancelled, so status
  must reflect partial completion rather than firing once.
- Rungs must not oversell: the sum of pending rung quantities should not exceed
  the plan's remaining quantity across its lots.
- Paper and real trades get this identically -- see the paper/real parity
  principle below. Field handling goes through the shared mapper.
- `alerts.watched_item_id` assumes a watched_item. A rung firing is an alert
  against a PLAN, so alerts needs to reference either, or the rung fire needs
  its own record. Decide before building; do not bolt it on.

### This supersedes the earlier `trade_exits` sketch

An earlier version of this entry keyed rungs on `transaction_id` directly. That
was closer to Joe's phrasing but wrong for the reason above: it cannot express
one thesis spanning two lots. The rung shape survived the change unaltered --
only its owner moved.

### Still considered and NOT chosen

- **The full `plans` redesign** absorbing all four jobs `watched_items`
  currently does (watchlist membership, journal idea, trade plan, and "just
  tracking" via the `order_type = 'WATCH'` null-object). The minimal `plans`
  table above is deliberately NOT that -- it owns exits and groups lots, nothing
  more. It is, however, the natural seed for the larger version later.
**ANSWERED 2026-08-21.** Joe: *"these are monitoring of discussion posts, so
completely manual unless an api is available and there wasnt when i looked
before."* So signals exist and are worth recording, but every one is typed by
hand.

Three consequences:

1. **The paste-to-parse skill is not optional, it is the feature.** A form per
   call will not survive a busy channel. Paste the message, get a draft plan,
   accept or discard. Build that WITH the signals table, not after it.
2. **The calls Joe skips are the ones that will not get logged.** Manual entry
   is biased toward what you acted on, because that is when you are already in
   the app. If that happens, source-level numbers measure his filter rather
   than the source -- constraint 2 above, arriving through the back door. Make
   skipping cost one paste and one click, and treat any source hit-rate as
   suspect until skipped calls are genuinely present.
3. **Worth re-checking the API question, specifically for Telegram.** It has
   two doors and the obvious one is the wrong one: a BOT can read a group it
   has been added to (needs admin cooperation), while MTProto client libraries
   let a user account read channels it already follows -- closer to what is
   wanted, but that is automating your own account and sits in a greyer area of
   their terms. Discord splits the same way. Unverified against Joe's actual
   groups; a lead, not a plan.

- **A `signals` table** recording what a source said and when, independent of
  whether it was acted on. Would make Joe's Telegram example measurable (*"the
  sell signal goes out for $10.75 and I miss it"* -- there is nowhere to record
  that they said it), and doubles as the selection-bias fix, since a signal with
  no plan is exactly "they called it, I passed". **Open question, unanswered:**
  whether Joe routinely receives and would log such signals. Do not build until
  answered -- an unfilled table is worse than no table.

## FIFO sells ignore plan boundaries (found 2026-08-21 while building exits)

Surfaced by a test that failed for the right reason. `recordSell` allocates
FIFO across **every open lot the holder has in that security**, oldest first.
It knows nothing about plans.

So if two theses hold the same ticker -- one from a Telegram call, one from a
book pattern -- selling shares attributed to thesis A can silently draw down
thesis B's lot instead, because B's lot happens to be older. The position
maths stays correct; the *attribution* does not. And attribution is the point
of the app.

It also breaks the ladder's own accounting: a plan can report shares it no
longer effectively owns, so `planRemainingQuantity` overstates and the oversell
guard under-protects.

**Not a bug in the FIFO engine.** FIFO is the correct default for cost basis
and is what a broker does. The gap is that nothing tells it which thesis a
sale belongs to.

**The tool already exists.** `recordSell` accepts `lotId` for specific-lot
selling. A plan-aware sell would constrain allocation to the plan's own lots --
FIFO *within* the thesis rather than across the account.

Options, roughly in order of increasing honesty and cost:

1. **Do nothing, document it.** Fine while one thesis per ticker is the norm,
   which it is today. Silently wrong the first time it is not.
2. **Plan-scoped sells.** Selling against a plan allocates only within that
   plan's lots. Correct for attribution; diverges from broker FIFO for cost
   basis, which matters if these numbers are ever compared to a 1099.
3. **Warn at sell time** when the holder has open lots in that security under
   more than one plan, and ask which thesis the sale belongs to. Keeps FIFO
   honest and puts the judgement where it belongs.

(3) fits the app's character best -- it is a journal that asks rather than
assumes -- but it is a UI decision, so it is Joe's call. Until then the test
suite pins the current behaviour by using a dedicated ticker in section 13d,
with a comment saying why.

## Vocabulary and the trade/plan/source model (Joe, 2026-08-21)

**Vocabulary.** A **trade** means both kinds. A paper trade and a real trade
are both trades, differing only by `is_paper_trade`. Use "trade" in code,
comments, UI copy and docs; say "paper" or "real" only when the distinction is
actually the point.

**A trade can exist without a plan, a source or a strategy.** Joe, directly.
That is not a degraded state to be warned about -- it is a normal trade someone
took without writing anything down first.

This settles where exit parameters live. They cannot be mandatory on a trade,
but they must not be duplicated onto `transactions` either -- the same concept
in two tables is how `escape_price` came to be stored in one place and
evaluated in none (BUG 10). The resolution is that plan and source are
separable, which the schema already allows: `watched_items.source_id` and
`.strategy_id` are both nullable, and the Watchlist path already creates plans
with no source. Only the Journal route insists on one, and that is a Journal
rule rather than a schema rule.

So there are four honest states, not a forced hierarchy:

| state | has exits | attributable |
|---|---|---|
| bare trade | no | no |
| trade + plan | yes | no |
| trade + plan + source | yes | to the source |
| trade + plan + source + strategy | yes | to the specific rule |

This makes the measurement question answer itself. A trade with no plan has
nothing to compare against, so plan-vs-actual is genuinely N/A for it -- not
missing data. A trade with a plan but no source still shows the execution gap,
it just cannot credit or blame anyone. Which is exactly right for a trade taken
on a whim that still had a stop on it.

## Paper and real are the same thing (Joe, 2026-08-21) -- governing principle

Joe: *"real orders will follow the conventions as ideally there is no
difference other than one is a real trade and one is paper."* Design for paper
first; real follows. He is happy to update real orders later, so paper leads
and real catches up -- but they must not diverge in meaning.

The schema already honours this: `is_paper_trade` is a flag on `transactions`
and every query partitions on it. So does the payload layer --
`paperOrderFormToPayload` wraps Orders' own `orderFormToPayload` and adds
`isPaperTrade: true`, nothing else.

**What is duplicated is the markup and the wiring**: separate `order-form` and
`paper-order-form` dialogs in `index.html`, and two ~500-line `index.js`
modules. A new field has to be added, and wired, twice.

**So: put every new field through the shared mapper in `orders/handlers.js`
as the paper side is built.** Then bringing real orders up to date is markup
only -- parsing, validation and payload shape are already done and already
covered by the offline tests. Building it the other way round produces two
mappers that agree right up until they do not.

## Promote destroys the paper leg (Joe, 2026-08-21 -- agreed, needs designing)

`promotePaperTrade` flips `is_paper_trade` 1 -> 0 **on the same row**. Nothing
is copied. The moment a paper trade is promoted there is no longer any record
that it was ever paper: same id, same price, same date, reclassified.

That is fine if Promote means "this stopped being hypothetical". It is a
problem for the stated purpose of the app, because it erases exactly the
comparison Joe wants -- how the paper version of a strategy did, versus what he
actually got. Joe: *"good point and yea i think then a new row or new fields
are needed."*

**The deeper issue is that Promote collects no fill.** The current code says so
outright: a paper trade "already IS a fully-specified transaction ... so
there's no separate fill to collect." But if promoting cannot record that the
real fill was $96.40 on Tuesday when the paper leg said $95.99 on Monday, there
is no gap to measure. `executeJournalIdea` already collects a real fill;
Promote should probably work the same way.

**DECIDED (Joe, 2026-08-21): shape 3.** The paper leg keeps running alongside
the real one. The other two are recorded below only to show what was weighed.

Three shapes, increasing in usefulness and cost:

1. **Fields on the same row** -- `paper_price`, `paper_transaction_date`,
   `promoted_at`. Cheapest. Still one row, so the legs cannot diverge after
   promotion and a later missed exit is invisible.
2. **New row, paper leg frozen.** The paper transaction stays as a closed
   historical record; a new real transaction is created and linked back to it
   (`promoted_from_id`). Two legs, comparable as at the moment of promotion.
3. **New row, paper leg keeps running.** The paper position stays OPEN and
   tracks alongside the real one. The paper leg then shows what the strategy
   would have returned if followed mechanically -- including hitting its own
   take-profit on time -- while the real leg records the late entry and the
   missed exit. This is the only shape where "optimal vs real life" is a
   continuous comparison rather than a single snapshot, and the only one where
   a missed exit shows up as a divergence.

Cost of (3): a promoted paper position never leaves the Paper Trade tab without
a state to mark it, and paper P&L must be rigorously kept out of real totals --
`is_paper_trade` already partitions every query, so the machinery exists.

Also still unsupported, and related: promoting a partially-sold paper position
is refused, because what happens to its paper SELL rows is undecided. Shape (3)
answers that question -- the paper sells stay on the paper leg.

**What shape 3 still needs, identified 2026-08-21.** A paper trade has no
targets on it. Take-profit, second take-profit and stop all live on
`watched_items`; a transaction has none. So a paper position today has no
notion of where the strategy said to exit, and a paper leg that cannot exit on
its own just mirrors the real one and demonstrates nothing.

Two ways to give it exits:

- **Link to the watched_item that already carries them.**
  `transactions.watched_item_id` exists and is already set by
  `executeJournalIdea`. This keeps ONE definition of "the plan" -- the idea's
  targets -- and both legs reference it. Preferred.
- **Put targets on the transaction.** Duplicates the fields and invites the two
  copies to drift, which is how `escape_price` ended up stored in one place and
  evaluated nowhere (BUG 10).

Open questions for the build, not to be guessed:

- If the paper leg is 100 shares and only 50 were really bought, the legs
  diverge in quantity as well as price. Is that a partial promotion, or two
  independent positions?
- Does the paper leg auto-sell when its take-profit is reached, or only record
  that the level was hit? Auto-selling makes "optimal" concrete; recording
  keeps the paper tab honest about being a log rather than a simulator.
- When does a promoted paper position stop being shown as open?

**Do not build before the flow walkthrough concludes.**

## Log Paper Trade: autofill the price, and flag limit vs market (Joe, 2026-08-21)

Noticed while walking the Journal flow. Two changes to the Log Paper Trade
dialog (`Paper Trade > + Log Paper Trade`):

1. **Entering a ticker should auto-populate Price per share with the current
   quote, still editable.** Today it is a blank number field, so logging a
   paper trade at today's price means looking the price up by hand and typing
   it -- which both slows the entry down and invites exactly the typo the CSV
   audit exists to catch. `GET /api/tickers/:symbol` already returns a quote,
   so this is frontend work.

2. **A "buy limit price" checkbox.**

**Question to settle before building #2**, because two readings lead to very
different work:

**Joe clarified (2026-08-21):** "limit buy is execute at x dollars, not at
current price necessarily." So the price typed is a TRIGGER, not a fill that
has already happened. That rules out Reading A below. What is still open is
whether the position exists immediately at that price, or not until the market
actually reaches it.

- *Reading A -- a label.* RULED OUT by the clarification above. The box records
  that this fill was a limit rather
  than a market order. The trade still becomes a paper lot immediately at the
  price typed. Small: one flag, one column.
- *Reading B -- a pending order.* Ticking it means "I would place a limit at
  $X", which is not a position until the price is reached. That needs a
  pending state, something to watch for the fill, and a decision about what
  happens if it never fills.

Reading B overlaps heavily with what a Journal idea of type BUY_LIMIT already
is -- a planned buy at a target price, watched, alerting when hit, and
convertible into a real trade via Execute. If B is what is wanted, the honest
question is whether Paper Trade should gain a pending state at all, or whether
that path already exists under Journal and the two are being reinvented side
by side.

Ask before building. Do not guess.

## Plan vs. actual: efficiency against the source (requested 2026-08-21)

**Do not start building this without walking the flow with Joe first.** He has
asked to go through the Journal system top to bottom so the vision is clear
before anything is designed. That walkthrough is the first step, not the
schema.

The idea, in his own examples:

- A Telegram group says buy XYZ at $10; he fills at $9.95. The sell signal goes
  out at $10.75, he misses it, and exits somewhere else. He wants to see his
  **efficiency vs. the plan**.
- Book X describes a pattern. He wants to record the methodology, tie the order
  or paper trade to it until it is sold, and then see **optimal vs. real**.

So the metrics that matter are entry slippage, exit slippage, and
outcome-grouped-by-source — not P&L on its own. This is the point of the whole
app (see STATUS.md): judging how reliable a source or methodology turned out to
be.

**The data model already supports most of it**, which is worth knowing before
anyone proposes new tables:

- `transactions.watched_item_id`, `.source_id` and `.strategy_id` all exist, so
  a fill can be tied back to the plan and to whoever suggested it.
- `watched_items` carries the plan: `buy_price_high` (intended entry),
  `take_profit_low`/`_2_low` (intended exits), `escape_price` (the stop).
- `alerts` records the moment the plan said to act — `triggered_at`,
  `trigger_price`, and as of v13 `trigger_reason`, which distinguishes a stop
  from a target. That is the "optimal exit" datapoint the comparison needs.

So "planned exit $10.75 at 14:02, actual exit $10.40 at 16:20, source =
Telegram group X" is a join away. What is missing is the query and the screen,
not the schema. Confirm that against the walkthrough rather than trusting it.

### Four constraints on this feature (raised 2026-08-21, Joe agreed to all four)

Asked directly whether anything was fundamentally wrong with the vision. These
came out of that, and they change what the reporting should lead with. They
are not optional polish -- 1 and 2 in particular decide whether the numbers
mean anything at all.

**1. There will never be enough trades to judge a source.** Separating a 55%
hit rate from a 45% one takes hundreds of trades. A personal journal produces
tens per source per year. Market noise swamps source quality entirely.

The real risk is not learning nothing -- it is producing a number that looks
authoritative. "6 of 10 from the Telegram group" reads as a verdict and is
statistically indistinguishable from a coin.

But the same data measures something that IS in reach: **the execution gap**.
Entry and exit slippage are low-variance, largely under Joe's control, and
attributable after a handful of trades. "Consistently 40bps late on entries,
missed 3 of 4 exit signals" is actionable from 15 trades; "this source is
good" is not.

**So the reporting leads with execution efficiency, not source ranking.** Source
reliability is the thing wanted; it is also the thing the data can least
support. Any source-level verdict needs a sample-size guard -- suppress it, or
show the uncertainty, below a threshold. Never render a bare win rate over ten
trades as though it settles anything.

**2. As recorded, this measures Joe's filter rather than the source.** Only
acted-on calls get logged. If a group makes 50 calls and Joe takes the 8 that
look good to him, the resulting hit rate belongs to his selection, not to them.

The model already supports the fix: a `WATCHING` idea never executed is exactly
"they called it, I passed." Logging skipped calls makes the source's real hit
rate observable -- and makes the more interesting question answerable, which is
whether the skipping helped or hurt. That is again a fact about Joe, which is
the pattern in all of this.

**3. There is no benchmark anywhere in the schema.** "This source returned 8%"
is meaningless without "the market did 11% over the same holding period". Across
different periods, a source measured in a bull run beats one measured in chop
regardless of quality.

Every comparison needs a baseline return over the same dates -- SPY by default,
configurable. `historical_prices` already holds what is needed, so this can be
computed on demand rather than stored; store it only if the query proves slow.
Raw return without a baseline cannot separate source skill from market regime.

**4. The paper leg measures plan adherence, not optimality.** In shape 3 the
paper leg follows *Joe's own* plan mechanically -- targets and stop that he set
at entry. So it answers "what if I had followed my plan", which is genuinely
useful, and NOT "what was the best available outcome".

A source whose targets are too conservative scores beautifully on adherence
while leaving money on the table, and nothing would surface that. **Name the
metric "plan adherence" in the UI, never "optimal".** The label will shape the
conclusions drawn from it.


Open questions for the walkthrough, not to be answered by guessing:

- What counts as "the plan" when a source revises its target mid-trade?
- Is efficiency measured per trade, per source, per methodology, or all three?
- A missed exit has no transaction at the signal price. Is the benchmark the
  alert price, the day's close, or the best price reached before the exit?
- Paper trades vs real: compared together, separately, or paper as the control?

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
