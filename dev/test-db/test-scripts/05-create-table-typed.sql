-- ============================================================================
-- ISSUE #19 TEST  ―  Alan's exact reported case
-- ============================================================================
--
-- Reproduces the screenshot from the bug report: a CREATE TABLE whose
-- column defaults use ::jsonb casts. QueryDen was prompting for a :jsonb
-- variable on Run.
--
-- WHAT TO DO
--   1. Paste into a QueryDen tab.
--   2. Run with Ctrl+Enter.
--
-- BEFORE THE FIX
--   "Query Variables" dialog appears with a :jsonb input. The
--   Substitution Preview shows the CREATE TABLE statement but treats the
--   cast as a variable.
--
-- AFTER THE FIX
--   The table is created immediately. No dialog.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app.ticket_time_tracking (
    timeid       serial PRIMARY KEY,
    ticket_id    integer,
    user_id      integer,
    action_id    integer,
    duration_ms  integer,
    metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    tags         text[]      NOT NULL DEFAULT '{}'::text[],
    created_at   timestamptz NOT NULL DEFAULT NOW()::timestamptz,
    notes        text
);

-- Sanity-insert and read back:
INSERT INTO app.ticket_time_tracking (ticket_id, user_id, duration_ms, metadata, tags)
VALUES (101, 1, 1500, '{"source": "manual"}'::jsonb, ARRAY['bug', 'p1']::text[]);

SELECT * FROM app.ticket_time_tracking ORDER BY timeid DESC LIMIT 5;
