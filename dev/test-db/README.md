# QueryDen test database

Throwaway PostgreSQL 16 instance with seed data, plus a set of copy-paste SQL scripts that exercise each of the bugs in the active fix queue (issues [#19](https://github.com/openidle-dev/queryden/issues/19) and [#20](https://github.com/openidle-dev/queryden/issues/20)) and the perf changes from [PR #22](https://github.com/openidle-dev/queryden/pull/22).

Not for production use, not shipped with the app — this lives in `dev/` because it's developer infrastructure.

## Quick start

```bash
cd dev/test-db
docker compose up -d
```

Wait ~5 seconds for the healthcheck to pass (`docker compose ps` will show `(healthy)`), then connect from QueryDen with these credentials:

| Field    | Value           |
|----------|-----------------|
| Type     | PostgreSQL      |
| Host     | `localhost`     |
| Port     | `5434`          |
| Database | `queryden_test` |
| Username | `queryden`      |
| Password | `queryden`      |

Port **5434** (not 5432) so it never clashes with a system-installed Postgres or another test instance.

## What's seeded

The `init/` scripts run automatically on the very first container start (when the data volume is empty). Subsequent restarts reuse the persisted volume.

| Script                        | Contents                                                                |
|-------------------------------|-------------------------------------------------------------------------|
| `01-schema.sql`               | `app` schema with `users`, `products`, `orders`, `order_items`, `audit_log` and indexes |
| `02-seed.sql`                 | 20 users, 30 products, 50 orders, 200 line items                        |
| `03-functions-triggers.sql`   | Generic audit trigger (uses `OLD::jsonb` / `NEW::jsonb` — exercises issue #19), plus `app.top_customers()` and `app.recent_orders()` helper functions |

To wipe and re-seed from scratch:

```bash
docker compose down -v   # -v drops the named volume
docker compose up -d
```

## Test scripts

Open each file in `test-scripts/` in QueryDen, follow the header comment.

| File                              | Verifies                                                                |
|-----------------------------------|-------------------------------------------------------------------------|
| `01-multi-statement.sql`          | **Issue #20** — selecting multiple statements and hitting Run no longer errors with "cannot insert multiple commands into a prepared statement" |
| `02-cast-no-var-dialog.sql`       | **Issue #19** — `::cast` operators stop triggering the Variables dialog |
| `03-real-variables.sql`           | **Positive** — real `:user_id` variables still prompt as expected (and `::cast` in the same query is left alone) |
| `04-trigger-with-cast.sql`        | **Issue #19** — `$$ ... $$` dollar-quoted function bodies are opaque to the variable scanner, even when they contain `:`-like tokens |
| `05-create-table-typed.sql`       | **Issue #19** — Alan's exact reported case: `CREATE TABLE ... DEFAULT '{}'::jsonb` |
| `06-perf-smoke.sql`               | **PR #22** — checklist for the lazy-loaded dialogs, schema cache reset on disconnect, and Settings/Help header buttons |
| `07-int-arrays.sql`               | **Issue #27** — INT2[]/INT4[]/INT8[] columns deserialize as JSON number arrays instead of crashing with "unsupported datatype" |

## Useful Docker commands

```bash
docker compose logs -f postgres        # tail logs
docker compose exec postgres psql -U queryden queryden_test   # psql into the running container
docker compose down                    # stop + remove container, KEEP data
docker compose down -v                 # stop + remove container, WIPE data
docker compose restart                 # restart without losing data
```

## When you're done

```bash
docker compose down
```

The container is gone but the named volume (`queryden-test-data`) survives — your tables and data are still there next time you `up -d`. To completely clean up:

```bash
docker compose down -v
docker volume ls | grep queryden-test  # confirm it's gone
```
