-- v15 -> v16: an alert can be accepted or declined, not merely silenced.
--
-- `acknowledged_at` means "stop showing me this". It says nothing about what
-- was decided, and the decision is the interesting part:
--
--   * Accepting an exit rung means the sale happened. On a paper leg that is
--     the plan followed mechanically -- the benchmark. On a real position it is
--     what actually occurred, at a price the user enters.
--   * DECLINING is data, not a dismissal. "The plan said sell at $10.75, I
--     passed, it later fell to $9" is precisely the execution gap this app
--     exists to measure. And declining an ENTRY alert is "they called it, I
--     passed" -- the skipped-call record that separates a source's real hit
--     rate from the user's own filter (see the selection-bias constraint in
--     V2_BACKLOG.md). Same button, no extra habit to keep.
--
-- Kept separate from acknowledged_at rather than overloading it: silencing a
-- notification and making a decision about it are different acts, and a user
-- who dismisses the bell without deciding has not declined anything.
--
-- Because the alert froze trigger_price and triggered_at when it fired, acting
-- on it days later still records the correct values. That is what makes an
-- asynchronous accept/decline queue honest rather than a source of drift.

ALTER TABLE alerts ADD COLUMN resolution TEXT
  CHECK (resolution IN ('accepted','declined'));

ALTER TABLE alerts ADD COLUMN resolved_at TEXT;

-- Free text. Why a rung was declined is often the whole story -- "earnings in
-- two days", "thesis changed", "this level was wrong" -- and it is exactly the
-- kind of note that never gets written unless there is a box for it.
ALTER TABLE alerts ADD COLUMN resolution_note TEXT;

-- The transaction an accepted alert produced, when it produced one. Lets the
-- adherence report join plan -> alert -> what actually happened without
-- re-deriving the link from dates and prices.
ALTER TABLE alerts ADD COLUMN resulting_transaction_id INTEGER
  REFERENCES transactions(id) ON DELETE SET NULL;

-- The queue's hot query: what still needs a decision.
CREATE INDEX idx_alerts_unresolved ON alerts (triggered_at) WHERE resolution IS NULL;
