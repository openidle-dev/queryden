-- ============================================================================
-- ISSUE #19 TEST  ―  :: cast operator must NOT trigger the Variables dialog
-- ============================================================================
--
-- WHAT TO DO
--   1. Paste into a QueryDen tab.
--   2. Run with Ctrl+Enter.
--
-- BEFORE THE FIX
--   A "Query Variables" modal pops up asking for values for :jsonb,
--   :numeric, :date. The query won't run until you cancel.
--
-- AFTER THE FIX
--   The query executes immediately. No dialog.
-- ============================================================================

SELECT
    '{"hello": "world", "count": 42}'::jsonb        AS payload,
    '42.50'::numeric(10, 2)                          AS price,
    NOW()::date                                      AS today,
    '00:00:30'::interval                             AS half_minute;
-- Note: an `ARRAY[1, 2, 3]::int[]` column would prove the cast operator
-- against array types too, but QueryDen's deserializer trips on INT4[]
-- today (issue #27). The four casts above (jsonb, numeric, date,
-- interval) are sufficient to prove #19.
