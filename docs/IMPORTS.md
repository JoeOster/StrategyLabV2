# Broker CSV imports

**Status (2026-08-21):** parsing and reconciliation are **built and verified**
against four real accounts across three brokers. Persistence is **not built** —
nothing writes to the database yet. See "Remaining work".

This is the feature `STATUS.md` calls "the single largest unbuilt feature at
this point". The half that is done is the half that could fail silently.

## Why parsing was verified before anything was built around it

An importer that mis-maps a column does not throw. It writes plausible-looking
wrong data, and you find out months later when a cost basis makes no sense. So
every parser was checked against ground truth first:

| Account | Rows | Accepted | Dropped | Verification |
|---|---|---|---|---|
| Fidelity IRA `146518557` | 509 | 508 | 4 | **6/6 positions match a live Fidelity screenshot** |
| Fidelity `266356256` | 133 | 133 | 0 | 3/3 positions match |
| E*TRADE `-7178` | 88 | 87 | 1 | — |
| Robinhood | 110 | 108 | 2 | — |

Zero negative positions in any of them.

## Per-broker format notes

Each of these was found the hard way. None would have produced an error.

### Shared

`services/importers/csv.js` is a hand-written RFC4180 parser rather than a
dependency (this app runs on two pure-JS packages). **Multi-line quoted fields
are not optional**: Robinhood puts newlines inside `Description`, so its 267
physical lines are only 154 logical rows. Splitting on newlines mangles ~40% of
that file without erroring.

`external_ref` is a fingerprint of the trade's economic facts, because none of
the three brokers exports its own transaction id. That is what makes
re-importing idempotent.

### Fidelity

- Two blank lines precede the header; a multi-paragraph legal disclaimer
  follows the data. Neither end can be found by position.
- The transaction type lives in the `Action` **prose**, not a column, and some
  sells carry a confirmation number inline (`YOU SOLD 26168JXHDC ONDAS...`), so
  matching is on the verb prefix.
- `SPAXX` is the core money-market sweep. Every cash movement generates a
  REINVESTMENT/DIVIDEND pair against it; importing them invents a holding.
- **`TRANSFERRED TO` was the dangerous one.** Omitting it made the IRA import
  imply seven positions that do not exist — six mutual funds and a bond — while
  *still matching every stock position*. That is exactly what a silent importer
  bug looks like: correct where you check, wrong where you don't.
- Nine action verbs handled, including fund capital-gain distributions and bond
  interest (income, no share movement) and redemptions (position leaves at par).

### Robinhood

- Header is the first row, unlike Fidelity's.
- Quantities are fractional to 5+ places (dividend reinvestment buys 0.00085
  shares) and must not be rounded.
- Money uses accounting negatives: `($5.00)` is -5.00.
- Ten non-trade `Trans Code`s are enumerated and counted, not silently dropped.
  **`SLIP` is stock-lending income and is deliberately not mapped to
  `DIVIDEND`** — doing so would inflate reported dividend income.

### E*TRADE

- Six preamble lines before the header, including a `Total:` line.
- **`--` is the null placeholder, not an empty field.** Unhandled, it becomes a
  literal symbol named `--`.
- `MSBNK` is the cash sweep, the counterpart to Fidelity's `SPAXX`.
- History is split one file per year (Current / Prior), so both are
  concatenated and de-duplicated.

## The drop policy

**Decision (Joe, 2026-08-21):** if there is no corresponding buy and no way to
extrapolate a buy price, drop the row.

Broker exports have a start date, so a position opened before that window
appears as a SELL with no matching BUY. Feeding that to FIFO produces a negative
holding and nonsense realized P&L. This is a research and journalling tool,
explicitly **not used for tax purposes**, so an incomplete-but-consistent ledger
beats a complete-but-wrong one. Drops are always counted and returned, never
silent.

Two details inside `reconcile.js` worth keeping:

- **Buys are processed before sells within the same date.** Brokers list
  same-day activity in arbitrary order, and file order orphans sells whose
  covering buy sits one line below. Real case: IONQ on 2026-01-21, where file
  order would have discarded 69 shares instead of the 27 genuinely unmatched.
- **A partially covered sell keeps the covered portion** rather than being
  discarded whole, with the shortfall recorded.

**Transfers are kept, not dropped.** They carry a quantity and a transfer value,
so a per-share price can be extrapolated — they are flagged instead, because
that value is what the shares were worth on arrival, not what was paid.

## The review flag

`transactions.needs_review` / `review_reason` / `review_resolved_at`
(schema v10), with a partial index over rows still outstanding.

- `GET /api/transactions?needsReview=1` — what is still an estimate
- `POST /api/transactions/:id/resolve-review` — record that it was checked

`resolveReview()` deliberately does **not** clear `needs_review`. The row was
estimated once and erasing that loses the audit trail; `review_resolved_at` is
what removes it from the outstanding list — the same pattern as `voided_at`.
Correcting the actual figures stays a separate `updateTransaction()`, so "we
fixed the numbers" and "we verified this against real records" remain distinct
events.

## How this is actually meant to be used (Joe, 2026-08-21)

**CSV import is an audit, not a loader.** Manual entry is the primary path --
possibly a Jarvis voice command much later -- and the CSV gets pulled
occasionally to catch anything entered wrong and correct it.

That is a different feature from bulk loading, and it changes the design:

**The `external_ref` dedupe does not cover this case.** That fingerprint is
computed from the CSV row, so a manually entered transaction has
`external_ref = NULL` and will not match one. Left as-is, importing a file
containing a trade already entered by hand creates a **duplicate**. The
fingerprint only protects against re-importing the same *file*.

Reconciliation therefore has to match on the **economic facts** of a trade --
date, symbol, type, quantity, price -- against existing transactions regardless
of where they came from. `import_raw_rows.reconciliation_status` already has
exactly the right four values for this; they were being read too narrowly:

| Status | Meaning |
|---|---|
| `matched` | already entered, and the numbers agree -- do nothing |
| `new` | missing from the ledger -- offer to create |
| `duplicate` | already imported from an earlier file |
| `needs_review` | **entered, but the numbers differ -- a mistake to correct** |

`needs_review` is the point of the whole feature. It is the row that says "you
typed 79.94 and the broker says 79.49".

### Two rules that follow

**Never auto-apply a correction.** A row matching on date/symbol/type but
differing on price is *probably* a typo, but it could equally be the broker
reporting an execution price that differs from what was remembered. Show both
values and let a human choose. Silently rewriting history to match a CSV is how
a journal stops being trustworthy.

**Matching needs tolerance, not equality.** Trade date and settlement date
differ by a day or two and brokers round prices differently, so exact matching
would flag correct entries as discrepancies and the report would be ignored --
which is worse than not having it. Suggested starting point, to be tuned
against real data rather than guessed:

- same symbol and type, `transaction_date` within a few days, quantity equal,
  price within a small tolerance -> `matched`
- same symbol, type and date, but quantity or price outside tolerance ->
  `needs_review`, showing both values side by side
- nothing comparable -> `new`

Note this also means the drop policy interacts with manual entry in a good way:
a sell whose buy predates the export window is dropped by the importer, but if
that buy was entered manually it will be found, and the sell becomes `new`
rather than being discarded.

## Where Claude fits, and where it must not (decided 2026-08-21)

Raised by Joe: should the CSV go to a script or to Claude? Settled as a split,
because the two halves of the problem have different natures.

**Parsing stays deterministic. The numbers must never pass through a language
model.** Reading a CSV has a right answer. A model that transcribes 974.33 as
947.33 produces something plausible, silent and permanent, and nothing
downstream catches it. The script returns the same output for the same file
every time, which is worth more than flexibility in a financial record. Every
hard problem hit while building these parsers was a *format* problem --
multi-line quoted fields, `--` nulls, TRANSFERRED TO reducing a position --
each solved once and staying solved. Those are not things to re-reason per
import.

**A skill earns its place on unknown broker formats.** TradeStation and
thinkorswim accounts already exist (unfunded as of 2026-08-21) and each will
need a parser. Rather than hand-writing one per broker, Claude reads ~20 sample
rows and emits a **column mapping**, which the deterministic parser then
executes forever after.

That inverts the risk deliberately: the model's output is a config that can be
read, checked in and diffed -- not per-row numbers that have to be trusted. A
wrong mapping is wrong visibly and once, rather than silently on row 340 of a
file nobody re-reads. It is also the same shape `V2_BACKLOG.md` already
anticipates for a Fidelity browser-sync: another producer feeding
`import_raw_rows`, with the consumption side indifferent to who wrote the row.

**Claude advises on discrepancies, inside the import screen.** `needs_review`
rows are genuine judgment -- "ledger 56.69, broker 59.66" could be a typo, a
different execution price, or a partial fill averaged differently. Explaining
that is worth a conversation, and `import_raw_rows` already holds the raw JSON,
the classification and the differences for it to reason over.

**Advisory only.** It explains and recommends; it never writes a transaction.
The same boundary already drawn for voice: the model reasons, the human commits.

**Not this:** sending a 500-row CSV to a model on every import. Slow, costly,
and it routes every number through a probabilistic layer to solve something a
fixed column mapping already solves for free.

**Security note.** A broker CSV is externally-authored content, so
`becca-orchestrator-voice-delegation.md`'s hard constraint applies: never
combine untrusted content with actuation in one session. A skill that reads
broker files must not also hold write access to the ledger.

## Remaining work

1. **Accounts.** There is no `/api/accounts` route and nothing anywhere inserts
   into `accounts`, but `import_batches.account_id` is `NOT NULL`. This blocks
   persistence entirely.
2. **Staging.** `import_batches` → `import_raw_rows` → reconciled
   `transactions`. `import_raw_rows.raw_data` is already "a JSON blob of the
   original row", and per `V2_BACKLOG.md` the consumption side must not care
   which producer wrote it — a future Fidelity browser-sync is meant to reuse
   this same pipeline.
3. **Routes and UI** for upload, preview and reconcile.

### Requested: show the latest imported data date per account

Joe, 2026-08-21: the import screen should show the date of the most recent
imported transaction per account, so that next month it is obvious what span to
download.

**Show it as a floor to download from *before*, not a boundary to start at.**
Overlapping exports are already safe — `external_ref` fingerprinting plus the
partial `UNIQUE (account_id, external_ref)` index make a re-import a no-op, and
this is proven: the two Fidelity IRA exports overlapped by exactly one row and
deduplicated cleanly. A gap, by contrast, silently loses transactions and
manufactures orphaned sells that the drop policy then discards. Overlap costs
nothing; a gap costs data.

Suggested wording on the screen: *"Latest imported: 2026-08-17. Download from
a week or so before this — overlapping is safe."*

Backing query is `MAX(transaction_date)` per `account_id`, plus
`import_batches.imported_at` for when the import itself last ran. The two are
different questions and both are worth showing: how current the *data* is, and
when you last *did* anything.
