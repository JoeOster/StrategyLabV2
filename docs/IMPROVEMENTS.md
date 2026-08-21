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

## Status, 2026-08-21 (second pass)

Much of the original Tier 1 and Tier 3 was built during the session that
followed. Rewritten against what the code actually does now, verified rather
than remembered.

**Done since this file was written:** the monthly import audit now completes
(`applyCorrection`, wired to the preview UI); unknown market value renders as
an em dash instead of break-even, on every surface and now in one shared
renderer; the migration runner exists with a `schema_migrations` ledger and an
`assertMigratable()` guard; the backup has been restored for real, which is
what turned up that guard; `notification_cooldown_minutes` is gone and the two
default-percentage settings pre-fill the exit ladder.

---

## Tier 1 — still open, in order

### 1. FIFO sells ignore plan boundaries

Selling draws down the oldest lot regardless of which thesis opened it, so a
sale attributed to one source can silently consume another's position. Nothing
in `transactionsService.js` references `plan_id` at all.

**Why it is now first.** Every other item here is a missing output -- annoying,
but the underlying data stays true and the report can be built later. This one
corrupts the attribution *as trades are logged*, and attribution is the entire
point of the app. Records written wrong today cannot be repaired later without
the operator remembering which lot was meant. It gets more expensive every day
the app is used.

### 2. Execution efficiency should be the headline report

Still the first genuinely useful *output* the app can produce, and the thing
Joe described first when asked what he wanted: signal says buy at $10, fill at
$9.95, sell signal at $10.75, missed. `alerts` records when a level was reached
and at what price; trades record what happened. Nothing joins them.

Needs a handful of trades to be meaningful, unlike source reliability which
needs hundreds -- so it is the report that becomes useful soonest.

### 3. No benchmark anywhere

"This source returned 8%" cannot be judged without "the market did 11% over the
same holding period." Without it every source comparison is confounded by
market regime, which means the headline output is not trustworthy.
`historical_prices` already holds what a same-period baseline needs, so this is
a query, not a schema change.

---

## Tier 2 — real, lower urgency

- **`securities.asset_type` is never set** (`BUGS.md` #14). Every mutual fund
  and money-market sweep is recorded as a stock, while the Fidelity parser
  already computes the classification and throws it away.
- **No fetch timeout anywhere.** A hung provider call blocks a scheduler tick
  indefinitely. The re-entrancy guard stops ticks piling up; the stall remains.
- **Non-trade cash rows are not imported** -- deposits, fees, interest. Harmless
  while every such row predates an opening balance, which is true today and
  will not stay true. See `V2_BACKLOG.md`.
- **No market-holiday calendar.** Costs a couple of wasted polls a year.
- **`dividends.pay_date` cannot be filled** from the current provider
  (`BUGS.md` #15). Drop the column or change provider.
- **`theme` is dead in both directions** (`BUGS.md` #16). Remove it, or build
  the theme it implies.

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
