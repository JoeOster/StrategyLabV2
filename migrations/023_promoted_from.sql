-- v22 -> v23: a promoted trade keeps its paper leg.
--
-- promotePaperTrade flipped is_paper_trade from 1 to 0 on the same row. Nothing
-- was copied, so the moment a paper trade was promoted there was no longer any
-- record it had ever been paper: same id, same price, same date, reclassified.
--
-- That erases the comparison this app exists to make. The paper leg is the plan
-- followed perfectly -- entered at the price the idea named, exiting when its
-- rung says so. The real leg is what actually happened: a late entry, a worse
-- fill, an exit that got missed. The DIVERGENCE between them is the
-- measurement, and flipping one row into the other destroyed it before it could
-- be taken.
--
-- promoted_from_id links the real trade back to the paper one it came from.
-- Nullable because almost every real trade has no paper leg -- most are logged
-- or imported directly -- and ON DELETE SET NULL because losing the paper row
-- should orphan the link rather than delete a real transaction.
ALTER TABLE transactions
  ADD COLUMN promoted_from_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL;

-- Finding the real leg from the paper one is the common direction: the Paper
-- Trade tab shows a position and needs to say "this was promoted".
CREATE INDEX idx_transactions_promoted_from ON transactions (promoted_from_id)
  WHERE promoted_from_id IS NOT NULL;
