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

**Done 2026-08-21, later the same day:** FIFO now respects thesis
boundaries -- a sale across two theses is refused rather than guessed at, and
sell rows record which thesis gave up the shares. See `V2_BACKLOG.md`.

**Done since this file was written:** the monthly import audit now completes
(`applyCorrection`, wired to the preview UI); unknown market value renders as
an em dash instead of break-even, on every surface and now in one shared
renderer; the migration runner exists with a `schema_migrations` ledger and an
`assertMigratable()` guard; the backup has been restored for real, which is
what turned up that guard; `notification_cooldown_minutes` is gone and the two
default-percentage settings pre-fill the exit ladder.

---

## Status, 2026-08-21 (third pass)

Everything in the previous Tier 1 and Tier 2 is built. Verified against the
code rather than remembered, which is what the previous two passes of this file
did not do and why it kept listing solved work as open.

**Built since the second pass:** the execution efficiency report, with the gap
decomposed into overshoot and slippage and discipline measured on both the
entry and exit sides; benchmark comparison against SPY over matched holding
days; FIFO respecting thesis boundaries; provider fetch timeouts; non-trade
cash import for all three brokers; `securities.asset_type`; the market-holiday
calendar; `dividends.pay_date` and the dead `theme` setting both dropped in
v20; the Patterns report; per-ticker lifetime P&L; the ticker-research skill,
its headless runner, and stored briefs.

---

## What is actually left

Nothing on this list is a defect. They are decisions and unbuilt features.

### Needs Joe, not code

- ~~**The alert webhook**~~ -- **parked by Joe on 2026-08-21.** Maybe pile.
  Deliberate, not forgotten. Do not list it as open again unless he raises it.
- **Attribution.** The efficiency and benchmark reports are complete and fill
  in as plans and sources get attached to trades. Joe knows; it has been said
  more than once and does not need saying again.

### Small, and genuinely unbuilt

- **Log Paper Trade does not autofill the price** or flag limit against market.
  Joe asked for this on 2026-08-21: after typing a ticker it should populate
  the current price, editable, with a buy-limit checkbox. The dialog currently
  has symbol, quantity, price, fees and notes and nothing else.

### Designed but not decided

- **Promote destroys the paper leg.** Agreed as a problem, shape not chosen.
  The interesting version keeps the paper leg running alongside the real one so
  the mechanically-followed plan stays visible as a baseline.
- **Fidelity ledger sync via browser automation** -- an idea, not a spec.
- **Backtesting / multi-agent trade evaluation** -- scoped, large, and worth
  nothing until there is attribution to backtest against.

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
