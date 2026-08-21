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
