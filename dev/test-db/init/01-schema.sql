-- Schema for the QueryDen test database.
-- Runs once on first container start (when the volume is empty).

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.users (
    id           serial PRIMARY KEY,
    email        text NOT NULL UNIQUE,
    full_name    text NOT NULL,
    is_active    boolean NOT NULL DEFAULT true,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    updated_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX users_email_idx     ON app.users (email);
CREATE INDEX users_metadata_idx  ON app.users USING GIN (metadata);

CREATE TABLE app.products (
    id           serial PRIMARY KEY,
    sku          text NOT NULL UNIQUE,
    name         text NOT NULL,
    description  text,
    price        numeric(10,2) NOT NULL,
    in_stock     boolean NOT NULL DEFAULT true,
    attributes   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX products_sku_idx ON app.products (sku);

CREATE TYPE app.order_status AS ENUM (
    'pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'
);

CREATE TABLE app.orders (
    id           serial PRIMARY KEY,
    user_id      integer NOT NULL REFERENCES app.users (id) ON DELETE RESTRICT,
    status       app.order_status NOT NULL DEFAULT 'pending',
    total        numeric(12,2) NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT NOW(),
    shipped_at   timestamptz
);

CREATE INDEX orders_user_id_idx  ON app.orders (user_id);
CREATE INDEX orders_status_idx   ON app.orders (status);
CREATE INDEX orders_created_idx  ON app.orders (created_at DESC);

CREATE TABLE app.order_items (
    id           serial PRIMARY KEY,
    order_id     integer NOT NULL REFERENCES app.orders (id) ON DELETE CASCADE,
    product_id   integer NOT NULL REFERENCES app.products (id) ON DELETE RESTRICT,
    qty          integer NOT NULL CHECK (qty > 0),
    unit_price   numeric(10,2) NOT NULL
);

CREATE INDEX order_items_order_id_idx ON app.order_items (order_id);

-- Audit log table — the audit trigger in 03-functions-triggers.sql writes
-- into this, exercising the OLD::jsonb / NEW::jsonb cast pattern that
-- used to trip QueryDen's variable detector (issue #19).
CREATE TABLE app.audit_log (
    id           bigserial PRIMARY KEY,
    table_name   text NOT NULL,
    action       text NOT NULL,
    actor        text,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_log_table_idx ON app.audit_log (table_name, created_at DESC);

COMMIT;
