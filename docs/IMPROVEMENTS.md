# Improvements and AI automation

Written 2026-08-21 at Joe's request: *"I want to see every improvement you can
think of and added AI automation where possible as well as reasoning."*

Ordered by what would actually move the needle, not by effort. Everything here
is a proposal — nothing below has been built, and several items argue against
themselves. Where an item is already tracked elsewhere it says so rather than
being restated.

The governing constraint throughout is the app's own purpose: **judge how
reliable a source or methodology turned out to be, by comparing plan against
actual.** An improvement that does not serve that, or that makes a wrong number
look authoritative, is not an improvement here even if it would be elsewhere.

---

## Tier 1 — things that are currently wrong or missing, in order

### 1. The monthly import audit cannot complete

Import exists to catch typos in hand-entered trades. `match.js` finds them
precisely — it produces `differences: [{field, ledger: 79.49, broker: 79.94}]`
— and then **nothing can act on them.** `approveBatch` writes only rows
classified `new`; `needs_review` rows are skipped by design.

`updateTransaction` already does exactly the needed job, and its own docstring
says so: correcting a typo'd purchase price fixes the realized P&L of past
sales rather than leaving the books inconsistent. Both halves exist; nothing
connects them.

**Why it is first:** it is the one workflow Joe has said he will run every
month, and it currently dead-ends.

### 2. No benchmark anywhere

"This source returned 8%" cannot be judged without "the market did 11% over the
same holding period." Across different periods, a source measured in a bull run
beats a better one measured in chop. `historical_prices` already holds what a
same-period baseline needs, so this is a query rather than a schema change.

Without it, every source comparison is confounded by market regime, which means
the headline output of the app is not trustworthy.

### 3. Execution efficiency should be the headline report

Already argued in the plan-vs-actual constraints: source reliability needs
hundreds of trades to be measurable, execution gap needs a handful. The data
now exists to compute it — `alerts` records when a level was reached and at
what price, trades record what actually happened.

This is the first genuinely useful *output* the app can produce. Everything
built so far has been input plumbing.

### 4. FIFO sells ignore plan boundaries

Tracked in `V2_BACKLOG.md`. Selling can silently draw down the wrong thesis's
lot, which corrupts attribution — the thing the app exists to do.

### 5. Unknown market value reads as break-even

`summaryService` falls back to `market_value ?? cost_basis`, so a position with
no quote displays as market value equal to cost and **unrealized P&L of exactly
$0.00**. That is not "unknown", it is a specific and wrong claim, and it is the
same failure family as everything else caught this session: a plausible number
that nothing throws on. Missing data should read as `—`.

---

## Tier 2 — real, lower urgency

- **`securities.asset_type` is never set** (`BUGS.md` #14). Every mutual fund
  and money-market sweep is recorded as a stock, while the Fidelity parser
  already computes the classification and discards it.
- **Three dead Settings controls** (`BUGS.md` #13) — default take-profit,
  default stop-loss, notification cooldown. All saved, none consumed. The first
  two now have an obvious home: pre-filling the exit ladder.
- **No fetch timeout anywhere.** A hung provider call blocks a scheduler tick
  indefinitely. The re-entrancy guard added today stops ticks piling up, but the
  underlying stall remains.
- **No market-holiday calendar.** Known and documented; costs a couple of wasted
  polls a year.
- **`dividends.pay_date` cannot be filled** from the current provider
  (`BUGS.md` #15).

---

## Tier 3 — operational, and one of these is more urgent than it looks

### The backup has never been restored

`deploy/backup-db.sh` runs nightly and refuses to write if the NAS is
unmounted, which is careful. But **no restore has ever been performed or
tested.** A backup you have never restored is a hypothesis, not a backup, and
the moment it matters is the worst moment to discover the gzip is truncated or
the schema is three versions stale.

Worth doing once, deliberately: restore last night's file into a scratch
database, start an instance against it, confirm the accounts are there. An
afternoon, once.

### There is no migration system

Every schema change is applied by hand. Two were applied by hand today (v12 and
v13), and a third exists as a one-off script (v14). It worked because the
database is nearly empty; it will not stay that way.

`assertSchemaCurrent` currently tells you to **delete the data directory and
rebuild**, which is reasonable advice today and catastrophic advice the day
after the first real import. A forward-only migration runner — numbered SQL
files, a `schema_migrations` table, applied in order at startup — is perhaps
150 lines and removes an entire category of future accident.

**Recommendation: do this before the first real import, not after.** It is the
cheapest it will ever be, and the failure mode it prevents is total.

---

## AI automation

Joe's standing directive already sets the principle, and it is the right one:

> Let the model produce configuration and judgement, not data. Anything with a
> single correct answer stays deterministic, because a plausible wrong number is
> silent and permanent.

Everything below respects that: the model drafts, a human accepts, and nothing
it produces reaches the ledger without that step.

### Already decided (see `IMPORTS.md`)

- **Unknown-broker column mapping** — reads ~20 sample rows, emits a column
  mapping the deterministic parser then executes forever. Config, not data.
  Near-term need: Schwab and TradeStation accounts exist and are unfunded.
- **Import discrepancy advisor** — explains `needs_review` rows. Advisory only.
- **Reconciliation assistant** for flagged rows once older Fidelity records
  surface.
- **Journal adherence review** — reads the journal and the trades and reports
  where they diverge.

### New: source-call parser — the strongest candidate here

Paste a Telegram message, newsletter line or screenshot caption:

> `BUY XYZ @ 10.00, TP1 10.75, TP2 11.40, SL 9.20`

and get back a **draft plan with its ladder already filled in**, for review
before anything is saved.

Why this one matters more than it looks:

- It is the missing half of Joe's own primary example. There is currently
  nowhere to record "the group said sell at $10.75 on Tuesday", which is exactly
  the event the execution-gap measurement needs.
- Structured extraction from messy human text is squarely what models are good
  at and rules are bad at — every group formats calls differently.
- It is **config-and-judgement, not data**: the output is a proposal on screen,
  and the numbers only become real when accepted.
- It removes the friction that would otherwise kill the habit. Logging every
  call by hand, including ones you skip, is the discipline the selection-bias
  fix depends on — and it will not happen if each one takes ninety seconds.

### New: exit-ladder suggestion from the strategy's own text

When setting exits on a trade tagged to a strategy ("Buy on Volume", from
*Trend Trading with Ai*), the model reads the strategy's recorded notes and
proposes a ladder consistent with it. Accept, edit, or ignore.

Turns a methodology from a label into something that actually shapes the trade,
and makes adherence measurable against the rule as written rather than against
whatever was typed that day.

### New: post-trade retrospective

When a plan closes, draft a short retrospective from the plan, its alerts and
the actual trades:

> Target hit 14 Aug at $10.75. You exited 16 Aug at $10.40 — two days late,
> costing 3.2% against the plan. The stop was never approached.

Reasoning over the user's own data, advisory, and it becomes journal content
that would otherwise never get written. Low risk: every number in it is
computed deterministically, and the model only writes the prose around them.

**That distinction is worth enforcing generally** — let the model phrase, not
calculate. Any figure in generated text should come from a query.

### New: monthly-audit triage

During the import audit, rank discrepancies by whether they look like a typo
(transposed digits, a decimal in the wrong place, an off-by-one date) versus a
broker quirk (settlement date, a fee folded into price). Advisory ordering of a
human's work queue, which is a good use — it changes what gets looked at first,
not what is true.

### A caution, and a way to check it

Every suggestion above is only worth its keep if it is actually accepted. That
is measurable, and this app of all things should measure it: **log what the
model proposed alongside what the human accepted.** If the ladder suggestions
are edited beyond recognition every time, that is a finding, and the honest
response is to remove the feature rather than keep it because it is clever.

The app's whole thesis is that unexamined advice should be checked against
outcomes. That applies to advice from a model exactly as much as to advice from
a Telegram group.

---

## Explicitly not recommended

- **Auto-trading, or auto-selling when a rung fires.** Joe has been clear the
  app will not touch money, and even a paper auto-sell would fabricate a trade
  that did not happen and erase the execution gap the app exists to measure.
- **A model computing P&L, cost basis or position sizes.** Single correct
  answer, silent when wrong, permanent once stored.
- **Auto-applying import corrections.** The discrepancy advisor explains;
  a human accepts. Silently rewriting history to agree with a CSV is how a
  journal stops being trustworthy — the original design note said so and it is
  still right.
- **A published performance artifact by default.** Artifacts are private but
  hosted; real financial data should be a deliberate export each time, never a
  default output.
