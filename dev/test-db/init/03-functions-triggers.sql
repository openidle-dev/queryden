-- Functions and triggers for the QueryDen test DB.
--
-- The audit_row_change trigger is deliberately constructed to exercise the
-- exact pattern that broke QueryDen's variable detector before issue #19
-- was fixed:
--   - dollar-quoted function body (`$$ ... $$`)
--   - `OLD::jsonb` / `NEW::jsonb` cast operators
--   - colon-prefixed identifiers that LOOK like :variables but aren't
--
-- Open the function definition in QueryDen via the explorer; the Variables
-- dialog must NOT appear when running anything that contains this trigger.

BEGIN;

-- Generic row-change auditor. Writes the previous and/or next row image as
-- jsonb into app.audit_log, tagged with the operation and table name.
CREATE OR REPLACE FUNCTION app.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    payload jsonb;
BEGIN
    IF TG_OP = 'DELETE' THEN
        payload := jsonb_build_object(
            'before', row_to_json(OLD)::jsonb,
            'after',  NULL
        );
    ELSIF TG_OP = 'INSERT' THEN
        payload := jsonb_build_object(
            'before', NULL,
            'after',  row_to_json(NEW)::jsonb
        );
    ELSE  -- UPDATE
        payload := jsonb_build_object(
            'before', row_to_json(OLD)::jsonb,
            'after',  row_to_json(NEW)::jsonb
        );
    END IF;

    INSERT INTO app.audit_log (table_name, action, actor, payload)
    VALUES (
        TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
        TG_OP,
        current_user,
        payload
    );

    -- AFTER triggers ignore the return value, but PL/pgSQL requires one.
    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attach the auditor to the tables most likely to change.
CREATE TRIGGER trg_users_audit
AFTER INSERT OR UPDATE OR DELETE ON app.users
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

CREATE TRIGGER trg_orders_audit
AFTER INSERT OR UPDATE OR DELETE ON app.orders
FOR EACH ROW EXECUTE FUNCTION app.audit_row_change();

-- A second function that returns a result set, useful for testing the
-- result-grid rendering. Note the dollar-quoted body again.
CREATE OR REPLACE FUNCTION app.top_customers(min_total numeric DEFAULT 0)
RETURNS TABLE (
    user_id     integer,
    full_name   text,
    order_count bigint,
    revenue     numeric
)
LANGUAGE sql
AS $body$
    SELECT
        u.id,
        u.full_name,
        COUNT(o.id),
        COALESCE(SUM(o.total), 0)
    FROM app.users u
    LEFT JOIN app.orders o ON o.user_id = u.id
    GROUP BY u.id, u.full_name
    HAVING COALESCE(SUM(o.total), 0) >= min_total
    ORDER BY COALESCE(SUM(o.total), 0) DESC;
$body$;

-- A tiny utility, helpful when manually exercising the DELETE-with-WHERE
-- safety check in QueryDen settings.
CREATE OR REPLACE FUNCTION app.recent_orders(days integer DEFAULT 7)
RETURNS SETOF app.orders
LANGUAGE sql
AS $$
    SELECT *
    FROM app.orders
    WHERE created_at >= NOW() - (days || ' days')::interval
    ORDER BY created_at DESC;
$$;

COMMIT;
