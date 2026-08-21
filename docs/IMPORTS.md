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
- **Bonds and CDs are skipped, deliberately.** They are quoted per $100 of face
  value with `Quantity` carrying the face amount in dollars, so a $1,000 CD at
  par reads as `qty 1000 @ px 100`. Stock maths turns that into $100,000 and
  books a **$99,000 phantom loss** on redemption — which is exactly what
  happened before this was caught. The `Amount` column said `1000` throughout.
  This app has no concept of face value, coupons, accrued interest or maturity,
  so such an instrument cannot be represented correctly at all: skipping it is
  honest, mangling it is not. Detected by CUSIP shape (9 alphanumerics
  including a digit). **Consequence worth knowing: a real $1,000 US Bank CD and
  its $32.16 of interest are absent from the ledger.** Tracking CDs properly
  would be a schema feature, not a parser fix.
- **Unit price is extrapolated for sells as well as buys.** Transfers out have
  an empty `Price` column; a buy-only rule left them at price 0 and booked the
  whole cost basis as a realized loss.
- **`quantity * price` is cross-checked against the cash amount**, and a gap
  beyond fees and rounding flags the row. That is a general guard against the
  next instrument whose unit convention nobody anticipated, rather than a fix
  for one known case.

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

## State of play (2026-08-21) — read this first

**Built, tested, committed:** `csv.js` (RFC4180), three broker parsers
(`fidelity.js`, `robinhood.js`, `etrade.js`), `reconcile.js` (the drop policy),
`match.js` (the audit classifier), the accounts service and routes, the
`needs_review` flag columns on `transactions`, and — as of the second session
on 2026-08-21 — `importService.js` and the four import routes.

**Not built:** the UI. Upload, preview and approve screens over the routes,
plus the per-account "latest imported" display described at the end of this
file.

**Nothing has been imported into the live database**, by choice rather than by
blocker. Six accounts, zero transactions. Real exports for all four accounts
sit in `files/` (gitignored) and import correctly end to end — verified against
`VACUUM INTO` snapshots, never against the live file.

**Verified numbers, for checking a change did not break anything:**

| Account | Files | Accepted | Review | Dropped | Positions |
|---|---|---|---|---|---|
| Fidelity IRA `146518557` | `IRA_a.csv` + `IRA_b.csv` | 507 | 6 | 4 | **6/6 vs screenshot** |
| Fidelity `266356256` | `History_for_Account_266356256.csv` | 133 | 3 | 0 | 3/3 |
| E*TRADE `-7178` | `etrade_a.csv` + `etrade_b.csv` | 87 | 0 | 1 | — |
| Robinhood | `Robinhood.csv` | 108 | 0 | 2 | — |

Zero negative positions in any of them. The IRA's expected positions are
ASTS 30, KLAR 100, KTOS 30, MRVL 30, MU 3, RKLB 50.

### Blocker found 2026-08-21, FIXED the same day: external_ref cannot be one-per-broker-row

**Fixed in `import-write-path`.** All three steps below were implemented, and
the IRA now imports 507/507 rows with zero rejections. The description is kept
because the reasoning still explains why the code looks the way it does.

A trial load of the IRA straight through `POST /api/transactions` (skipping
staging) got **302/302 buys in and only 94/204 sells**. 110 sells were rejected
as duplicate constraint violations against an empty database.

Cause: `recordSell` fans a single sale out across the lots it consumes, writing
**one transaction row per lot**. That is correct FIFO behaviour. But every row
in that fan-out carries the same `external_ref`, and the partial
`UNIQUE (account_id, external_ref)` index rejects all but the first.

So the dedupe assumes *one broker row equals one transaction row*, and that is
false for any sale spanning more than one purchase lot -- which in this ledger
is most of them, because the pattern is repeated buys followed by a bulk sell.

The resulting database was **worse than empty**: every buy and under half the
sells, reading as 235 positions and $409,781 of cost basis against a real six
positions and about $24,000. Partial imports are not a safe failure mode here,
which is an argument for staging doing the whole batch in one transaction.

**Fix, for whoever builds the write path:**

1. Check `external_ref` *before* writing anything. If a non-voided transaction
   already has it for this account, skip the whole broker row and report it as
   a duplicate -- do not attempt the write and interpret the constraint error,
   which is what produced the misleading "already-present" count above.
2. Inside `recordSell`'s fan-out, only the first inserted row carries
   `external_ref`; the rest carry null. The constraint then means "this broker
   row has been imported", which is what it was always meant to mean.
3. Load a batch inside a single transaction so a mid-run failure rolls back
   rather than leaving a half-populated ledger.

Note the trial load was otherwise sound: 396 rows written in 14 seconds through
the ordinary API, with FIFO, cost basis and validation applied normally, and
zero unexpected failures. The write path is not far off -- it just cannot treat
one CSV row as one database row.

### What the write path actually needed (2026-08-21, second session)

Three things beyond the fix above, none of which were visible from the design:

1. **`withTransaction` had to become re-entrant.** A batch must commit or roll
   back as one unit, but it is built out of `recordBuy`/`recordSell` calls that
   each open a transaction of their own, and SQLite has no nested `BEGIN`.
   Inner levels now use SAVEPOINTs.

2. **The record functions had to split in half.** `getOrCreateSecurity` does
   network I/O, and `withTransaction` takes a *synchronous* function — awaiting
   inside it lets the transaction commit before the awaited half ever runs,
   which is not atomicity, it only looks like it. Each is now an async wrapper
   (`recordBuy`) around a sync core (`recordBuyWith`) that takes an
   already-resolved security. The importer resolves every symbol up front.

3. **Identical trades fingerprint identically.** Two genuinely identical
   $20,000 FTRNX buys on 2025-01-21 produce the same `external_ref`, and the
   partial unique index rejects the second — the same failure as the fan-out
   blocker, a different cause. `disambiguateRefs` in `csv.js` appends an
   occurrence ordinal, stable across re-imports because the same date-ranged
   export produces the same groups. It shifts only if an export splits an
   identical group across its boundary, which is one more reason to overlap
   exports generously.

A fourth bug was not an import bug at all, but only a real import was ever
going to find it: repeated FIFO subtraction leaves a fully-sold lot holding
~1e-14 shares, and every open-position read filters `quantity_remaining > 0`.
The IRA came out with **eight** positions instead of six, the two extras
sitting at 0.00 shares and $0.00. Drained lots now snap to exactly zero in
`reduceLot`.

**Rows flagged `needsReview` are carried across** into `transactions` with
`needs_review = 1` and the reason preserved. Note the count grows on the way
in: six flagged broker rows became seven flagged transaction rows, because a
flagged sell fans out across the lots it consumes and each row inherits the
flag. That is correct, not a double-count.

**Verified end to end** on all four accounts against snapshots: no negative
positions anywhere, every staged row mapped to a transaction, and a re-import
of the same files classifies all 507 rows as `duplicate` and writes nothing.


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


## Unfinished imports (added 2026-08-21)

Staging writes the batch and its rows to `import_batches` / `import_raw_rows`
immediately. The preview, however, lived only in the browser's memory -- so a
reload, a closed tab, or staging from a script left the batch stranded: present
in the data, invisible in the UI, and reachable only by already knowing its id.

Several accumulated during one afternoon and each had to be deleted by hand
from the database. That was the signal and it went unread for hours.

The Import tab now lists pending batches on every visit, with what each would
add and what it found already present. **Review** reopens exactly the preview
staging produced, from the batch still in the database, so an interrupted
import is finished the same way it would have been finished at the time.
**Discard** throws it away.

Discard is a hard `DELETE`, which nothing else in this app does -- everything
else is voided. It is safe here precisely because a pending batch has written
nothing to the ledger: there is no history to preserve, only a staging area to
clear. It refuses on an approved batch, which IS the provenance of real trades,
and says to void those instead.

The panel renders nothing when nothing is pending, rather than a permanent
"no unfinished imports" heading -- noise on every visit for a state that is
almost always true.
