-- ============================================================================
-- PERF SMOKE TEST  ―  exercises the lazy-loaded dialogs and schema cache
-- ============================================================================
--
-- This isn't really one script; it's a checklist of UI gestures that
-- exercise the changes in PR #22 against the live data this DB seeded.
--
-- 1. SCHEMA CACHE RESET ON DISCONNECT (issue: stale autocomplete after reconnect)
--      a. Connect to queryden_test (port 5434).
--      b. In a new tab type `SELECT * FROM app.us` — autocomplete should
--         suggest `users` from the app schema.
--      c. Disconnect.
--      d. Connect to a DIFFERENT database (any other you have) and type
--         the same `SELECT * FROM app.us`. The OLD `users` suggestion
--         from queryden_test must NOT appear.
--
-- 2. LAZY-LOADED TOOL DIALOGS (issue: tools forced into the cold-start bundle)
--      Open each of these once. Each one loads its own JS chunk on first
--      open — there should be no perceptible lag the second time you
--      open it.
--        - Compare Dialog
--        - Clone Dialog
--        - Activity Monitor
--        - Multi-Query Dialog
--        - AI Assistant
--        - Open a definition (right-click a table -> View Definition)
--        - Open Local History (right-click in the editor → "Local History | Show History")
--
-- 3. SETTINGS / HELP HEADER BUTTONS (issue: duplicate eager imports)
--      Click the gear icon (Settings) and the question-mark icon (Help)
--      in the header. Both should open. Ctrl+H and Ctrl+Alt+S keyboard
--      shortcuts should also work.
--
-- 4. SHOW-LOCAL-HISTORY LISTENER (issue: leak on every effect re-run)
--      The `show-local-history` event is dispatched from the editor's
--      RIGHT-CLICK context menu (entry "Local History | Show History" near
--      the bottom). No keyboard shortcut is bound to fire it directly.
--
--      Steps:
--        a. Right-click inside the SQL editor.
--        b. Click "Local History | Show History" → dialog opens.
--        c. Close it.
--        d. Type a few characters or switch active query tabs (this triggers
--           the useEffect that registers the listener to re-fire).
--        e. Right-click → "Local History | Show History" again → dialog
--           should open cleanly. Before the fix the listener handler
--           reference changed every re-render so the cleanup didn't match —
--           handlers accumulated. After the fix the handler is stable.
-- ============================================================================

-- Some useful queries to run during the perf smoke test:

SELECT COUNT(*) AS users_count FROM app.users;
SELECT COUNT(*) AS orders_count FROM app.orders;
SELECT COUNT(*) AS items_count FROM app.order_items;

-- The function from 03-functions-triggers.sql:
SELECT * FROM app.top_customers(100);
