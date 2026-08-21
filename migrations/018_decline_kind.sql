-- v17 -> v18: WHY an alert was declined.
--
-- Joe, on whether declining a paper rung means "this rung shouldn't have fired"
-- or "I wouldn't have sold": "i think both have value". They are different
-- facts and they point at different things, so a single `declined` flag with
-- the reason buried in prose would make neither answerable:
--
--   'invalid'   -- the level was wrong. The rung should not have fired at all,
--                  so it must not count as `hit`, and it should stop firing.
--                  Says nothing about the user's judgement.
--   'judgement' -- the rung was right and the user decided otherwise. On a real
--                  position that is the execution gap. On the PAPER leg it is a
--                  finding about the RULE: the mechanical plan and what the
--                  user would actually do have diverged, which is exactly the
--                  sort of thing a strategy review should surface.
--
-- Nullable, because it only applies to a decline.
ALTER TABLE alerts ADD COLUMN decline_kind TEXT
  CHECK (decline_kind IN ('invalid','judgement'));
