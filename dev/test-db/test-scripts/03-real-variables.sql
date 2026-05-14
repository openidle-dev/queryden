-- ============================================================================
-- POSITIVE TEST  ―  real :variables still prompt
-- ============================================================================
--
-- This script has BOTH a :: cast AND a real :user_id variable. The dialog
-- must:
--   - prompt for :user_id (one input field)
--   - NOT prompt for :jsonb (that's a cast, not a variable)
--
-- WHAT TO DO
--   1. Paste into a QueryDen tab.
--   2. Run with Ctrl+Enter.
--   3. When the Variables dialog appears, enter a number for :user_id
--      (try 1, 2, or 3 — those users exist in the seed data) and Execute.
--
-- EXPECTED
--   Dialog shows EXACTLY ONE variable (:user_id). The Substitution Preview
--   panel inside the dialog should show the cast operators intact.
-- ============================================================================

SELECT
    u.id,
    u.email,
    u.full_name,
    u.metadata::jsonb           AS meta,
    u.metadata->>'role'         AS role,
    u.metadata->>'tier'         AS tier,
    u.created_at::date          AS joined
FROM app.users u
WHERE u.id = :user_id
LIMIT 10;
