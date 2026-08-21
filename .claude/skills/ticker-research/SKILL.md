---
name: ticker-research
description: Research a ticker by combining Strategy Lab's own record of it — position, cost basis, targets, trade history — with current web reporting. Use when asked to "research NVDA", brief a holding, or check what is happening with a stock the user owns or is watching.
---

# Ticker research

Produce a brief on one ticker that keeps two things clearly apart: **what this
app already knows** (the user's position, what they paid, what they planned)
and **what the web says** (news, dates, other people's opinions).

That separation is the whole point. Mixing them produces a paragraph where a
cost basis and a stranger's price target carry equal weight, and the user
cannot tell which parts they can act on and which parts are somebody's guess.

## 1. Read the app's own record first

Always start here, before searching. The app's data determines what is worth
searching for — an earnings date matters differently to someone holding 400
shares at a loss than to someone watching from the sidelines.

Strategy Lab runs on the orchestrator NUC. Reach it over SSH:

```bash
ssh orchestrator "curl -s http://localhost:3113/api/ticker/NVDA"
```

That returns, in one payload:

- `security` — name, sector, industry, exchange, business description
- `quote` — last price, previous close, day range, volume, and when it was fetched
- `range` — 52-week high/low and where the price sits within it
- `series` — stored daily closes for charting
- `position` — the user's shares, cost basis, market value, unrealised P&L, and every open lot with its entry price and date
- `trades` — full transaction history for this ticker
- `watchedItems` — any entry or exit targets set
- `dividends` — recorded dividend history

If the server is down, query the database directly instead:

```bash
ssh orchestrator "cd ~/StrategyLabV2 && node -e \"import('./lib/db.js').then(m => console.log(JSON.stringify(m.default.prepare('SELECT * FROM securities WHERE symbol = ?').all('NVDA'))))\""
```

**If `series` is empty and `range` is null**, the app has no price history for
this ticker — it only backfills on demand. Say so in the brief rather than
treating the absence as a flat chart. One call fixes it if history matters:

```bash
ssh orchestrator "curl -s -X POST http://localhost:3113/api/ticker/NVDA/refresh"
```

## 2. Then search the web

With the position in front of you, search for what has actually changed:

- Recent news — company announcements, sector moves, regulatory or legal events
- The next earnings date, and what happened at the last one
- Analyst commentary, clearly attributed to whoever said it
- Anything that plausibly explains a move visible in the stored price series

**How far back.** If the user holds the ticker, cover the period since the
oldest open lot was opened — `position.lots` gives you that date. If they do
not hold it, the last 30 days is enough. Say which window you used.

## 3. Cross-reference before writing

This is the part that makes the brief worth more than a news search:

- Does a news event line up with a move in `series`? Name the date.
- Is there an earnings date close to a target in `watchedItems`?
- Does the user's entry price sit near a level the reporting keeps mentioning?
- Has the thesis behind the position been contradicted by anything?

## 4. Write the brief

Structure it as:

**Position** — what they hold, what they paid, where it stands now. Straight
from the app. If they hold nothing, say so in one line and move on.

**Plan on record** — entry or exit targets from `watchedItems`, and any exit
rungs. If there are none, say that, because a holding with no plan attached is
itself worth noticing.

**What has happened** — the news, dated, with sources linked.

**Where the two meet** — the cross-references from step 3. This section is why
the brief exists; if it is empty, say so rather than padding it.

## Rules

**Never recommend a trade.** Not "consider trimming", not "this looks like a
good entry", not a price target of your own. This app is a journal that
deliberately never touches money, and its owner has been explicit about that.
Report what is true and let him decide.

Stating a fact about proximity is fine and useful — "earnings are on the 14th;
your stop sits 2% below the current price" — because both halves are things the
app and the calendar already know. The line is crossed when you say what should
be done about it.

**Attribute every claim from the web.** An analyst's target is that analyst's
target. Link the source. If two sources disagree, say both.

**Say when you do not know.** A quote fetched three days ago is stale and the
payload tells you when it was fetched. Missing price history is missing, not
flat. An empty cross-reference section is an honest result.

**Do not write to the database.** This skill reads. Recording research back
into the app was considered and deferred — it needs a schema decision that has
not been made. Print the brief in chat.

## Worth knowing

The user's accounts are reconciled against real broker statements, so
`position` is accurate rather than approximate. Prices come from Yahoo and are
refreshed on a schedule during market hours, so `quote.fetched_at` can be hours
old outside them — check it before describing a price as current.
