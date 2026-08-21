-- v19 -> v20: remove two things the schema promises and cannot deliver.
--
-- 1. dividends.pay_date
--
-- The column exists; the insert writes (security_id, ex_date, amount, source)
-- and never touches it. That is not an oversight to be corrected, which is why
-- it sat open: Yahoo's chart events return an ex-date and an amount and NO pay
-- date, so there is nothing to put in it from the only provider wired up.
--
-- Dropped rather than left empty. A nullable column that is structurally
-- unfillable reads to the next person as data that happens to be missing, and
-- they will go looking for the bug. Re-adding it is one ALTER TABLE on the day
-- a provider supplies the field.
--
-- 2. the `theme` setting
--
-- Defaulted to "light". No control in Settings, nothing reads it, and
-- public/css/style.css contains no dark styling at all -- dead in both
-- directions. Unlike notification_cooldown_minutes (v17) it promised the user
-- nothing, because it never appeared on screen. It is simply a leftover.
--
-- Removed rather than implemented: building a theme because a defaulted string
-- exists is the tail wagging the dog. If dark mode is wanted later it is a CSS
-- decision first and a setting second.

ALTER TABLE dividends DROP COLUMN pay_date;

DELETE FROM app_settings WHERE key = 'theme';
