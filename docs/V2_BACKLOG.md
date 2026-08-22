# V2 Backlog

Ideas captured but deliberately not built yet. Each entry says enough to pick
up cold, including the open questions that would need answering first.

---

## Ticker research skill -- BUILT 2026-08-21

**Installed at `C:/Users/stree/.claude/skills/ticker-research/SKILL.md`**, on
Joe's Windows machine -- NOT in this repo. A copy is kept here for reference,
but the repo copy is inert: it lives on the NUC, and Claude Code sessions run
from `C:\Projects`, so a skill inside `~/StrategyLabV2/.claude/` would never
be loaded by anything. Putting it there first was a mistake worth recording,
because the skill appeared complete and could not have run.

Invoked by saying "research NVDA" to Claude in any session.

It reads `GET /api/ticker/:symbol` over SSH first -- position, cost basis,
lots, targets, trade history, stored price series -- and only then searches the
web, because the position determines what is worth searching for. An earnings
date means something different to someone holding 400 shares at a loss than to
someone watching from the sidelines.

The brief keeps **what the app knows** and **what the web says** in separate
sections. Mixed together, a cost basis and a stranger's price target read as
equally solid, and the user cannot tell which half is fact about their own
account and which is somebody's guess.

**The three open questions, answered:**

- *Save the brief back into the app?* **Yes, as of schema v22** -- the decision
  got made when Joe asked the obvious question: "if I have 10 axon and I hit
  research, is that data all stored so research is not redone?" It was not.
  `research_notes` keeps every brief with the position it was written against,
  so opening a ticker shows the last one instantly and free, and says "written
  against 10 shares, you now hold 25" when that has stopped being true. The
  SKILL still does not write to the database; the server saves what the skill
  returns, which keeps the subprocess read-only.
- *How much history?* Since the oldest open lot when the ticker is held --
  `position.lots` supplies that date -- and 30 days when it is not. The skill
  states which window it used.
- *Actionable or descriptive?* Descriptive, with factual proximity allowed.
  "Earnings are on the 14th and your stop sits 2% below" is two things the app
  and the calendar already know. "Consider trimming" is advice, and this is a
  journal whose owner has been explicit that it never touches money. The skill
  is told not to recommend a trade, and not to invent a price target.

**The button.** The Dashboard's ticker dialog said "Research (coming soon)" and
opened an alert explaining it did not work. It now says "Research" and reveals
the exact phrase to use with the ticker filled in. A button in the web UI
genuinely cannot run a chat skill -- that is the design, not a gap -- so the
honest thing is to hand over the phrase rather than pretend or stay "coming
soon" indefinitely. Pressing it again dismisses the panel.

**The button also fetches history**, which turned out to matter more than the
hint text. `backfillSecurityHistory` has always pulled two years on a first
fetch and nothing ever called it: 117 of 118 securities had no stored prices,
so every ticker dialog drew an empty chart and reported no 52-week range, and
the benchmark had exactly one security it could measure against. The capability
existed the whole time and was simply never asked for.

Two years rather than the six months requested, because that is the existing
first-fetch default and because six months cannot fill a 52-WEEK range -- the
shorter window would leave the figure most worth having still blank.

Fetched only when there is none. Topping up is what the dialog's own Refresh
button is for, and doing it here as well would be two controls quietly
competing over the same job.

`npm run db:backfill-history` does the same in bulk, defaulting to currently
held securities and taking `--all` and `--dry-run`. Run once on the live data:
23 held securities, 501 bars each except KLAR at 238 (a recent listing), none
failed. Every open position now has a 52-week range.

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

## Finnhub-powered news in the detail panel -- BUILT 2026-08-21

Was blocked on "getting a `FINNHUB_API_KEY` and running the Finnhub provider
path live for the first time". The key had since been added to `.env` and
nobody had noticed the blocker was gone.

`getCompanyNews` on the existing provider, `GET /api/ticker/:symbol/news`, and
a panel appended to the ticker dialog. Twelve headlines over fourteen days,
with dates, sources and links.

**Why it exists alongside the skill.** This is the half of research a browser
can genuinely do: real dated headlines, no model in the loop. It does not
cross-reference anything against the position -- that needs reasoning, which
is what the Claude skill is for -- and the panel says so in as many words,
because a list of headlines sitting under a position invites being read as
analysis of it.

**Cached in memory for fifteen minutes**, not in a table. News is ephemeral and
nothing reasons over yesterday's headlines, so a `news_cache` table would carry
rows nobody reads twice. It also keeps the free tier honest: opening the same
dialog five times in a minute is one call.

**Fetched after the dialog renders, not with it.** Finnhub is a third party and
the rest of the panel does not depend on it; blocking the dialog on it would
make a slow news API look like a slow app. The late arrival checks the dialog
is still showing the same ticker before appending, or opening NVDA then quickly
opening TSLA drops NVDA's headlines into TSLA's panel.

**This is the first third-party content the app renders.** Headlines, sources
and summaries are set as `textContent` on real nodes rather than interpolated
into HTML -- the same choice `errorBanner` made after BUG 9. Links are built
only when `isSafeNewsUrl` says the scheme is http or https, and that check
PARSES the URL rather than matching a prefix, because `" javascript:alert(1)"`
and `"java	script:alert(1)"` both defeat a prefix test. Thirteen checks cover
that predicate; the structural safety is deliberately not tested, since against
a faked DOM the fake would be what was under test.

---

## Wire the alert webhook up for real (HA + Becca) -- PARKED (Joe, 2026-08-21)

**Maybe pile.** Joe parked this deliberately; it is not an oversight and should
not be raised as an open item again. There is nothing to build in this repo
either way -- the mechanism and its auth header are done, and what remains is
Joe typing his own credentials plus a service in a different project.

Un-park it if he asks. The detail below is kept so nobody has to work it out
twice.

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

## FIFO sells ignore plan boundaries -- RESOLVED 2026-08-21

`recordSell` allocated FIFO across every open lot the holder had in a security,
oldest first, knowing nothing about plans. Two theses holding the same ticker
meant a sale made for one could silently draw its shares from the other, purely
because that lot happened to be older. Position maths stayed correct;
attribution rotted. It also let `planRemainingQuantity` overstate, so the
oversell guard on new rungs under-protected by exactly the stolen amount.

Three options were written down. What shipped is closest to (3) -- refuse and
ask -- because it matches what the codebase already does one axis over, where a
sale spanning two accounts is refused rather than guessed at.

**What it does now:**

- `recordSell` takes an optional `planId`. Given one, allocation is FIFO
  *within that thesis* and nothing else is touched.
- Without one, if the holding spans more than one thesis, the sale is refused
  and the message names the plans. Untagged lots count as their own bucket:
  "some shares under a thesis, some not" is exactly as ambiguous as two named
  theses, and was the case most likely to be waved through.
- A named `lotId` is checked FIRST and never trips the guard. Naming a lot is
  more specific than naming a thesis, and refusing it would have been the
  opposite of true.
- Imports are flagged, not refused. A broker CSV has never heard of theses, so
  refusing would dead-end the monthly audit over a question the file cannot
  answer. Ambiguous imported sales allocate FIFO as a broker would and set
  `needs_review` with a reason naming the plans.
- Sell rows now carry `plan_id`, taken from the lot they drew from. Attribution
  used to live only on the buy side, which would have left the efficiency
  report guessing at the other half of every round trip.
- The sell form's lot picker shares the guard's definition of ambiguous: when a
  holding spans theses it withdraws "Oldest first (FIFO)" as a default and
  labels each lot with its thesis, so the user is shown the question before the
  server has to refuse an answer.

**What is deliberately unchanged.** Cost basis is still per-lot and FIFO within
whatever scope applies, so figures remain comparable to a broker's. This does
not attempt a second parallel P&L basis for tax; that would be a real feature
with a real cost, and nothing here needs it yet.

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

## Promote keeps the paper leg -- BUILT 2026-08-21 (shape 3, schema v23)

`promotePaperTrade` flipped `is_paper_trade` 1 -> 0 on the same row. Nothing was
copied, so the moment a paper trade was promoted there was no record it had
ever been paper.

Now it creates a NEW real transaction and leaves the paper one open and
running, linked by `promoted_from_id`. Both legs live: the paper leg is the
plan followed perfectly, the real leg is what actually happened, and the
divergence is the measurement.

**A fill price is required.** Defaulting it to the paper price would record the
ideal as though it were real and erase the entry gap in the same motion --
which is exactly what `resolveAlert` refuses on the exit side, for the same
reason. The dialog prefills the CURRENT price rather than the paper one,
deliberately: offering the paper price as the default invites accepting it.

`promotedLegs()` reports the gap per share, the total, and how many days late
the real entry was. Same sign convention as the efficiency report -- positive
means better than planned -- so the two never need reconciling in a reader's
head.

**The real leg does not inherit the plan.** A plan owns a ladder of rungs
against a quantity; pointing two legs at one plan would let the paper leg's
automatic exits draw down the real position. The real leg gets its own plan
when one is made for it.

**Promoting a partly-sold paper lot is now allowed.** It used to be refused
because the old in-place flip had no answer for what should happen to the paper
SELLs. Shape 3 answers it -- they stay on the paper leg -- so the refusal was a
stand-in for an undecided design rather than a rule worth keeping.

Twenty-two checks in section 47, plus the rewritten guards in 6h. The one that
matters most: the real book and the paper book each hold only their own leg. A
paper position leaking into real totals is the easiest way for this design to
become a liability instead of a feature.

**The tab marks them.** A promoted paper lot carries a `taken +$1.00` badge
showing the gap against the real fill, coloured by whether the real entry beat
the paper one, with the fill price and date on hover. Without it a position
that WAS acted on looked identical to one that was ignored -- the opposite of
what promotion now records, in the place the user is actually looking.

The sign follows the same convention as the efficiency report and the
benchmark: positive means better than planned. It was negated at first, which
produced a badge whose number contradicted its own colour -- down-red beside a
plus sign. Caught by the test that asserts both together rather than either
alone.

## Log Paper Trade: autofill the price -- BUILT 2026-08-21

Joe: "after putting the ticker in, it should autopopulate the current price
albeit be editable and have a buy limit price checkbox."

The price half is built. Typing a ticker fetches `GET /api/quote/:symbol` and
fills the price in, with three rules that each matter:

- It never overwrites a price the user has typed. A field that rewrites itself
  under the cursor is worse than an empty one.
- The value is marked as a suggestion until touched, so a wrong quote is
  visibly the app's guess rather than the user's entry.
- It says nothing on failure. An unknown ticker is a typo far more often than
  an outage, and an error while someone is still typing "NV" on the way to
  "NVDA" would be noise.

`/api/quote/:symbol` is deliberately separate from `/api/ticker/:symbol`, which
assembles position, lots, trades, series and watched items. A dialog asking
"what is this worth right now" should not pull all of that, and a ticker with
no stored history should still answer. It refetches when the cached quote is
older than the polling interval, because a form prefilling yesterday's close
would be worse than one left blank -- the user would not know to check it.

**The limit checkbox is NOT built, on purpose.** A checkbox that only labels
the price is a control that does nothing, which this codebase has already
removed twice (`notification_cooldown_minutes`, `theme`). For it to mean
anything, a limit buy has to be able to exist as a PENDING order -- Joe:
"limit buy, these are always pending" -- and that is a state the transactions
table does not have. A limit order that has not filled is not a position.

The app can already record that intent today: a `BUY_LIMIT` watched item with
the target price, which alerts when the price is reached. The missing piece is
turning that alert into a filled trade in one step, which is the entry-side
half of the same gap the efficiency report measures.

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

## Import non-trade cash movements -- DONE 2026-08-21 (schema v21)

Broker exports carry far more than trades. Robinhood's three files hold 59 cash
rows between them: a $2,000 instant deposit, two $500 ACH deposits, $55 of Gold
subscription fees, interest, stock-lending income, futures sweeps. All of it
was parsed past and counted as `nonTrade`.

**What it does now.** The Robinhood parser returns a separate `cash` array
alongside `rows`. Those movements bypass `reconcile()` entirely -- there are no
shares to match, so none of its FIFO reasoning applies -- and are classified
only against the account's baseline and against what has already been imported.
`approveBatch` routes them to `recordCash`.

**The ordering rule, which is the part that needed care.** An `OPENING_BALANCE`
says "this much cash was here on this date", so every movement before it is
already inside that figure and importing it would count it twice. Such rows are
reported as `beforeBaseline` rather than silently filtered: "7 movements were
ignored" is something to see and agree with, not to discover later from a
balance that drifted. Verified on the real 2025 file -- all seven of its cash
rows fall before the 2026-08-21 baseline and are correctly absorbed.

**Direction is decided per row, not per code.** `ACH` is a deposit or a
withdrawal depending on the sign of Amount, and a lookup table mapping the code
to a kind would have booked a withdrawal as a credit. Only `GOLD` has a fixed
direction, because a subscription fee is never a credit. Amount is always
positive and direction lives in `kind`, matching what `cash_transactions`
already enforces.

`source_code` holds the broker's own label so "what have I paid in subscription
fees" stays a `GROUP BY` rather than a search through prose.

**All three brokers now.** The shape is shared; the mapping is per broker,
because the formats differ in kind.

E*TRADE names its activity in a real column, so its mapping is a lookup.
Fidelity buries everything in Action prose and its cash rows are identifiable
only by having no Symbol at all -- which meant they were being discarded by the
no-symbol skip before the action was ever read. That skip is where
**$249,648.72 of 401k rollover** was going, along with a $24,600 early
distribution and $5,400 of tax withheld: the largest figures anywhere in this
database, silently dropped.

Fidelity's list is explicit rather than "anything without a symbol is cash".
An action the parser has not been taught is reported as unknown, not booked as
a deposit for whatever the Amount column happened to say. Guessing the
direction of money is the one place not to be relaxed.

Direction always comes from the sign, never from the label. A rollover is
normally money in and a transfer normally either way, but both reverse, and a
table deciding direction per action books the reversal backwards.

Cash refs are run through `disambiguateRefs` exactly as trades are, which was
not optional: three separate $0.01 stock-lending payments land on the same day,
one per security, with otherwise identical refs. Two of the three were being
swallowed as duplicates of the first.


## Ideas, none urgent (captured 2026-08-21, end of a 14-hour session)

Nothing here is a defect and nothing is blocking. The app is complete, tested
and running. These are the things worth doing next, in the order I would do
them, with enough context that nobody has to re-derive the reasoning.

### 1. Sequence patterns -- the strongest finding in the ledger

The trade after a win averages **+$70.44**; the trade after a loss averages
**-$60.35**. A $130 swing on essentially identical position sizes ($1,529 vs
$1,487), so it is not sizing up after a loss. It is worse *results* after one.

Worse still when re-trading the same name: **-$83.16** staying in the ticker
that just lost, against -$42.76 moving on.

**The caveat has to ship with the number.** Part of this is market regime, not
behaviour: SPY moved +0.19% on the days after his wins and +0.02% after his
losses. Losses cluster in bad tape and so does the next trade. That explains
some of the gap and not all of it, and 540 trades cannot cleanly separate them.
Any panel showing this must show the SPY comparison beside it, or it reads as
proof of tilt when it is partly proof of weather.

Belongs in `patternsService.js` as a `sequencePatterns()` detector.

### 2. Cadence awareness -- the confound found the hard way

Every pattern detector treats each sale as a decision. That assumption breaks
where engagement does. Joe's cadence:

```
2026-05  222 trades      2026-07   13
2026-06   82             2026-08    9
```

He stopped in July -- coursework, and a rough term. So the recent tail is
mostly positions left running rather than choices made, and any pattern
spanning that boundary is partly measuring absence. "Seven KTOS losses stepping
down from $94 to $48" runs March to August and crosses it.

At minimum the Patterns tab should show trades-per-month and let the reader see
where the engaged periods are. Better: a date range, defaulting to something
sensible, so the analysis can be pointed at a period where he was actually
trading. Do this BEFORE building more detectors, since every one of them
inherits the flaw.

### 3. Names traded well, not only badly

Patterns lists the ten names that cost money. It says nothing about RDW
(**49 of 63 sales up, +$5,836**) or CIFR (45 of 61, +$3,373). There are names
here traded genuinely well at real sample sizes, and showing only the failures
is both dispiriting and a worse description of the ledger.

Same table, sorted the other way. Cheap.

### 4. Split `watchlistService.js` -- the only real seam problem

896 lines, 25 exports, three unrelated jobs:

- watchlists and watched items CRUD -- belongs here
- `backfillSecurityHistory`, `refreshAllHistory`, `refreshSingleTicker` --
  belongs in `priceService.js`
- `applyAlertIfTriggered`, `applyExitAlert`, `checkAlerts`, `acknowledgeAlert`,
  `acknowledgeAllAlerts`, `listUnacknowledgedAlerts` -- belongs in
  `alertsService.js`

The alert split is the sharp end: alert code lives in **both** files today.
`watchlistService` raises and acknowledges; `alertsService` lists and resolves.
"Where does alert logic go" has two answers, which is how it ends up in a third
next time.

Nothing is broken, which is why it has not bitten. It is a mechanical move with
969 tests behind it, and it gets more expensive with every feature that lands
on top.

### 5. Dust positions

Roughly twenty fractional lots from one bulk buy on 2026-05-19 -- 0.067 AXON,
0.00085 ORCL, 0.000033 DDS. Each is a full row in every position view and worth
cents. A grouping, a threshold, or a "hide dust" toggle would clear real
clutter without deleting anything.

### 6. Entry alerts exist and have never been used

Zero `BUY_LIMIT` watched items. The whole entry-side path -- target, alert,
"did I actually buy it" discipline, the `entryAlerts` section of the efficiency
report -- is built, tested, and idle. This is not something to build; it is
something to use, and worth a nudge rather than a feature.

### Deliberately not on this list

Anything that forecasts prices. The measured edge is +$9.36 a trade across 540
trades and it comes from frequency and discipline, which is what this app
measures. A forecast bolted on would be a fourth opinion competing with the
three already here, and unmeasurable until it had been traded for months. If it
is ever wanted, the right shape is a SOURCE whose calls get logged and scored
like any other -- which needs no new code at all.

### 7. Move alerts, announced through Becca

Joe: *"hey dummy dropped 20%"* / *"hey X on the watchlist is blowing up"*.

**This is a different trigger from everything built.** Every alert in the app
today fires on a level named in advance -- a buy limit, a take-profit rung, a
stop. This one needs no plan at all: it is magnitude, not a target. A stock
moving 20% is worth knowing about precisely when you had no view on it.

That makes it the first alert that can fire on a ticker with nothing set up,
which is also what makes it useful -- the positions that hurt are rarely the
ones being watched closely.

**What it would need:**

- A percentage threshold, probably two: one for held positions, a looser one
  for watchlist-only tickers. The move is against the previous close, which
  `quotes_cache` already stores as `prev_close` alongside `last_price`.
- **Once per ticker per day.** The poller runs every fifteen minutes, so a
  stock that crosses the threshold at 10:00 would announce itself twenty-four
  more times before the close. This is the whole difficulty of the feature and
  everything else is easy. The `alerts` table already carries `triggered_at`,
  so the check is "has this ticker already fired a move alert today".
- Market hours only, which `isMarketOpen()` now answers correctly including
  holidays.
- A magnitude that has to be crossed going OUT, not re-announced while it sits
  there. A stock down 22% at 10:00 and down 21% at 14:00 has not done anything
  new.

**Delivery: emit structured data, never prose.** StrategyLab should post
`{symbol, changePercent, lastPrice, prevClose, positionValue, unrealizedDelta}`
to the webhook and let Becca decide how to say it. Two reasons, and the second
matters more than it looks. Voice phrasing belongs to the thing that speaks --
the same alert reads differently at 09:35 than at 15:55, and Becca knows that
context while this app does not. And the app's own rule is that outcome data
lives in queryable columns rather than prose; a sentence is exactly the format
that cannot later be grouped, counted or measured.

**The webhook is already built** -- `alert_webhook_url` and its optional auth
header, currently PARKED because it needs Joe's Home Assistant token. This
feature is the reason to un-park it, and the honest sequencing is: build the
detector first, watch it fire into the notifications tab for a week, and only
then point it at a voice that will interrupt him. An announcement that turns
out to be noisy is much more annoying than a row in a list that turns out to
be noisy.

**DECIDED (Joe, 2026-08-21): global settings, two thresholds.** Not a
per-ticker row. One threshold for watchlist tickers and a separate one for
positions actually held, because they are different questions -- a 20% move on
something being watched is news, and the same move on something owned is a
change in what he has. He will want to hear about the second sooner.

That means two keys in `app_settings` alongside the existing whitelist,
something like `move_alert_percent_orders` and `move_alert_percent_watchlist`,
with an empty value meaning off -- the same convention `alert_webhook_url`
already uses for "not configured".

This also avoids the trap the per-ticker version would have walked into. A move
alert has no target price, no quantity and no plan, so a `watched_items` row
for one would be mostly null columns -- which is precisely how `escape_price`
ended up stored in one place and evaluated in none (BUG 10).
