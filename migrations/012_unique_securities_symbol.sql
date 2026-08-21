-- v11 -> v12: make idx_securities_symbol UNIQUE.
--
-- The table's UNIQUE (symbol, exchange_id) never constrained anything in
-- practice: exchange_id is NULL for nearly every row and SQLite treats NULLs as
-- distinct, so the same ticker could be inserted repeatedly. Silently, because
-- the app reads securities by symbol and takes the first match. See BUGS.md #6.
--
-- Fails loudly if duplicates already exist, which is correct -- they must be
-- merged by hand, and guessing which row to keep would discard whatever hangs
-- off the other.
DROP INDEX IF EXISTS idx_securities_symbol;
CREATE UNIQUE INDEX idx_securities_symbol ON securities(symbol);
