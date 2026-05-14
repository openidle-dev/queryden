-- ============================================================================
-- ISSUE #20 TEST  ―  multi-statement execution
-- ============================================================================
--
-- WHAT TO DO
--   1. Paste this whole file into a new QueryDen tab.
--   2. Select all of it (Ctrl+A).
--   3. Run with Ctrl+Enter (NOT Ctrl+Shift+Enter — we are specifically
--      testing the "selection containing multiple statements" path).
--
-- BEFORE THE FIX
--   Postgres rejects the whole batch with:
--     ERROR: cannot insert multiple commands into a prepared statement
--
-- AFTER THE FIX
--   Each statement runs in order. The results panel shows one row per
--   statement with a ✓ or ✗, and the final SELECT returns three rows.
-- ============================================================================

-- CREATE TEMP TABLE places the table in pg_temp_* (session-local), so no
-- DROP is needed — the table doesn't conflict with anything and disappears
-- when the session ends.
CREATE TEMP TABLE _t20_demo (
    id    serial PRIMARY KEY,
    label text NOT NULL,
    note  text
);

INSERT INTO _t20_demo (label, note) VALUES
    ('alpha', 'first row'),
    ('beta',  'second row'),
    ('gamma', 'third row');

SELECT id, label, note FROM _t20_demo ORDER BY id;
