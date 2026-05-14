-- ============================================================================
-- ISSUE #19 TEST  ―  dollar-quoted trigger body must NOT trigger the dialog
-- ============================================================================
--
-- This is the exact construct that prompted the bug report: a trigger
-- function body, wrapped in $$ ... $$, that contains :: casts AND symbols
-- like NEW.something that look variable-ish to a naive regex.
--
-- WHAT TO DO
--   1. Paste into a QueryDen tab.
--   2. Run with Ctrl+Enter.
--
-- BEFORE THE FIX
--   The Variables dialog pops up asking for :jsonb (and possibly other
--   tokens from inside the function body).
--
-- AFTER THE FIX
--   The function is created silently. No dialog. The dollar-quoted body
--   is treated as opaque text by the variable scanner.
-- ============================================================================

CREATE OR REPLACE FUNCTION app.demo_audit_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    snapshot jsonb;
BEGIN
    snapshot := row_to_json(OLD)::jsonb;

    INSERT INTO app.audit_log (table_name, action, actor, payload)
    VALUES (
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
        'DELETE_DEMO',
        current_user,
        jsonb_build_object(
            'deleted_id',  OLD.id,
            'snapshot',    snapshot,
            'snapshot_at', NOW()::timestamptz
        )
    );

    RETURN OLD;
END;
$$;

-- And verify with a quick lookup:
SELECT
    proname,
    pg_get_function_result(oid)       AS returns,
    pg_get_function_arguments(oid)    AS arguments
FROM pg_proc
WHERE proname = 'demo_audit_delete';
