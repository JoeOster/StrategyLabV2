-- v21 -> v22: keep the research briefs.
--
-- The Research button ran a fresh two-minute model session on every press and
-- kept nothing. Two consequences, and the second is the one that matters:
--
--   Pressing it twice with nothing changed cost two minutes for near-identical
--   output.
--
--   There was no record of what was said. A position closed at a loss in
--   November had no trace of the reasoning that was in front of you in June --
--   which is the same plan-versus-actual question the rest of this app exists
--   to answer, applied to research instead of prices.
--
-- The position snapshot is the point of this table, not decoration. A brief is
-- only true of the holding it was written against: "you are down 9% on two
-- lots" stops being true the moment a third lot is bought. Storing shares and
-- cost basis alongside the text is what lets the app say "written against 10
-- shares, you now hold 25" instead of quietly showing stale prose as current.
--
-- Deliberately NOT a cache keyed by freshness. There is no TTL and nothing
-- expires: an old brief is not wrong, it is old, and the difference is exactly
-- what makes it worth keeping.
CREATE TABLE research_notes (
  id                INTEGER PRIMARY KEY,
  security_id       INTEGER NOT NULL REFERENCES securities(id) ON DELETE CASCADE,
  holder_id         INTEGER NOT NULL REFERENCES account_holders(id) ON DELETE CASCADE,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- The brief as written: markdown, rendered as text. Stored verbatim rather
  -- than parsed, for the same reason it is displayed verbatim.
  brief             TEXT NOT NULL,
  -- How long the run took. Kept because it is the honest cost of pressing the
  -- button, and worth being able to see accumulate.
  duration_ms       INTEGER,
  -- The position this brief was true of. Nullable throughout: a ticker can be
  -- researched while holding none of it, and null means "held nothing" rather
  -- than "unknown", which is why quantity carries a 0 default and price does
  -- not.
  shares_at_time    REAL NOT NULL DEFAULT 0,
  cost_basis_at_time REAL,
  price_at_time     REAL,
  -- Which lots existed, as JSON. Prose in the brief refers to "the August 17
  -- lot", and without this there is no way to tell later which purchase that
  -- was once the lot has been sold and its row drawn down.
  lots_at_time      TEXT
);

CREATE INDEX idx_research_notes_security ON research_notes (security_id, created_at DESC);
