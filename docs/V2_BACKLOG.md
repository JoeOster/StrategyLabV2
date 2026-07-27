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
  Robinhood.
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
- **Backtesting / AI trade evaluation.** The original Phase 2. The data it
  needs (`historical_prices`, `dividends`, `splits`) is already being
  collected.
