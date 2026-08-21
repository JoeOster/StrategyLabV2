-- v12 -> v13: alerts.trigger_reason.
--
-- WHICH level was crossed, as a column rather than something to be read back
-- out of the message text. This is outcome data: an idea that hit its stop is
-- the opposite result from one that hit its take-profit, and "how did this
-- source's ideas end up?" has to be a GROUP BY rather than a text search.
--
-- ALTER TABLE ADD COLUMN carries the CHECK constraint through, so no table
-- rebuild is needed and no rows are touched.
ALTER TABLE alerts ADD COLUMN trigger_reason TEXT
  CHECK (trigger_reason IN ('STOP','BUY','TAKE_PROFIT','TAKE_PROFIT_2'));
