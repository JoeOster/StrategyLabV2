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

## Finnhub-powered news in the detail panel

Separate from the skill above and complementary to it: Finnhub's free tier
includes company news, earnings calendar, and basic sentiment. Those could
populate the detail dialog with real headlines and dates without any LLM
involvement, refreshed by the existing polling machinery.

Blocked on: getting a `FINNHUB_API_KEY` and running the Finnhub provider
path live for the first time — it's written but has never executed (see
STATUS.md).

---

## Other deferred items

- **CSV import** (`import_batches` → `import_raw_rows` → reconciled
  `transactions`). Schema exists and is idempotent-by-construction; no
  parsing code written. Broker formats to support: Fidelity, E-Trade,
  Robinhood.
- **Journal / Strategy Lab module.** Schema supports it today
  (`advice_sources`, `strategies`, and `is_paper_trade=1` on both
  `watched_items` and `transactions`); no service or UI yet. The
  "execute a paper idea into a real trade" flow is the interesting part.
- **Scheduled price/alert checks.** `checkAlerts()` and `refreshAllHistory()`
  exist but only run on a button press. A cron-style timer would make the
  watchlist actually passive.
- **Alert delivery.** The `alerts` table records triggers, but nothing sends
  email/push. Old app had a `notification_cooldown_minutes` setting — that
  key already exists in General settings, unused.
- **Real authentication.** Everything currently acts as the one default
  account holder. Settings can create multiple holders but there's no
  per-request holder switching, and no login at all. Required before this
  could be exposed beyond localhost.
- **Migrations.** `schema.sql` is only applied to fresh databases; schema
  changes currently mean rebuild-and-lose-data (guarded by the version
  check). Once there's data worth keeping, this needs numbered migration
  files.
- **Backtesting / AI trade evaluation.** The original Phase 2. The data it
  needs (`historical_prices`, `dividends`, `splits`) is already being
  collected.
