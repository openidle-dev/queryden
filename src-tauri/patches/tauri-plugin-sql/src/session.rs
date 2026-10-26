// QueryDen: editor sessions.
//
// The query console used to send every statement through the shared pool,
// so consecutive statements landed on different server connections:
// `BEGIN; UPDATE …; COMMIT` run as separate statements autocommitted the
// UPDATE and left the BEGIN connection idle in transaction; `SET`, temp
// tables and `SET ROLE` did not persist; Stop could not reach the server.
//
// A session pins one dedicated connection per (database URL, editor tab),
// detached from the pool so open tabs never starve the app's own queries.
// Statements run as plain SQL text (no bind parameters), which PostgreSQL
// executes over the simple query protocol and answers in TEXT format —
// exactly what psql shows, for every type — with one result set per
// statement carrying both its rows and its affected-row count. Server
// NOTICEs raised while a statement runs are captured and returned with it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;

use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::{Column, Either, Executor, Row, TypeInfo};
use tokio::sync::Mutex;
use tracing::{field::Field, Event, Level, Metadata, Subscriber};
use tracing_subscriber::layer::{Context, Filter, Layer};
use tracing_subscriber::registry::LookupSpan;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
}

/// One statement's outcome. `columns` is empty for statements that return
/// no rows (UPDATE without RETURNING, DDL, DO, TRUNCATE…).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnInfo>,
    /// Row values in column order (positional, so duplicate column names survive).
    pub rows: Vec<Vec<JsonValue>>,
    pub rows_affected: u64,
    /// More rows existed than `max_rows`; they were read and discarded.
    pub truncated: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOutput {
    pub results: Vec<ResultSet>,
    pub notices: Vec<String>,
}

pub(crate) enum SessionConn {
    #[cfg(feature = "postgres")]
    Postgres(sqlx::PgConnection),
    #[cfg(feature = "mysql")]
    MySql(sqlx::MySqlConnection),
    #[cfg(feature = "sqlite")]
    Sqlite(sqlx::SqliteConnection),
}

pub(crate) struct Session {
    pub(crate) conn: Mutex<SessionConn>,
    /// PostgreSQL backend PID / MySQL connection id, read without the
    /// connection lock so Stop works while a statement is running.
    pub(crate) backend_id: Option<i64>,
    /// When the last statement finished; idle sessions are pinged first.
    pub(crate) last_used: std::sync::Mutex<std::time::Instant>,
}

/// Sessions idle longer than this are pinged before the next run. NATs,
/// firewalls and managed poolers (Supabase, RDS Proxy, pgbouncer) silently
/// drop idle connections well inside a few minutes.
pub(crate) const IDLE_PING_AFTER: std::time::Duration = std::time::Duration::from_secs(30);

impl Session {
    pub(crate) fn new(conn: SessionConn, backend_id: Option<i64>) -> Self {
        Session { conn: Mutex::new(conn), backend_id, last_used: std::sync::Mutex::new(std::time::Instant::now()) }
    }

    /// False when the session sat idle longer than `idle_after` and its
    /// connection no longer answers a ping.
    pub(crate) async fn is_alive(&self, idle_after: std::time::Duration) -> bool {
        let idle = self.last_used.lock().map(|t| t.elapsed()).unwrap_or_default();
        if idle < idle_after {
            return true;
        }
        let mut conn = self.conn.lock().await;
        let ping = match &mut *conn {
            #[cfg(feature = "postgres")]
            SessionConn::Postgres(c) => sqlx::Connection::ping(c).await,
            #[cfg(feature = "mysql")]
            SessionConn::MySql(c) => sqlx::Connection::ping(c).await,
            #[cfg(feature = "sqlite")]
            SessionConn::Sqlite(c) => sqlx::Connection::ping(c).await,
        };
        ping.is_ok()
    }

    fn touch(&self) {
        if let Ok(mut t) = self.last_used.lock() {
            *t = std::time::Instant::now();
        }
    }
}

/// Shown when an idle session's connection had died and a new one was opened.
pub(crate) const RECONNECTED_NOTICE: &str = "QUERYDEN:  The previous connection for this tab was closed by the server or the network while idle; a new one was opened. Session settings (SET …), temporary tables, prepared statements, cursors and any open transaction from before are gone.";

/// Open sessions keyed by (database URL, session id).
#[derive(Default)]
pub struct Sessions(pub(crate) Mutex<HashMap<(String, String), Arc<Session>>>);

macro_rules! collect_results {
    ($conn:expr, $sql:expr, $max_rows:expr, $decode:expr) => {{
        let mut sets: Vec<ResultSet> = Vec::new();
        let mut current = ResultSet::default();
        {
            let mut stream = $conn.fetch_many($sql);
            while let Some(step) = stream.try_next().await? {
                match step {
                    Either::Left(done) => {
                        current.rows_affected = done.rows_affected();
                        sets.push(std::mem::take(&mut current));
                    }
                    Either::Right(row) => {
                        if current.columns.is_empty() {
                            current.columns = row
                                .columns()
                                .iter()
                                .map(|c| ColumnInfo {
                                    name: c.name().to_string(),
                                    type_name: c.type_info().name().to_string(),
                                })
                                .collect();
                        }
                        if current.rows.len() < $max_rows {
                            let mut values = Vec::with_capacity(row.len());
                            for i in 0..row.len() {
                                values.push($decode(row.try_get_raw(i)?));
                            }
                            current.rows.push(values);
                        } else {
                            current.truncated = true;
                        }
                    }
                }
            }
        }
        if !current.columns.is_empty() {
            sets.push(current);
        }
        sets
    }};
}

/// A zero-row result carries no column metadata over the wire; for a lone
/// row-returning statement, ask the server to describe it (no execution).
macro_rules! fill_empty_columns {
    ($conn:expr, $sql:expr, $sets:expr) => {{
        if $sets.len() == 1 && $sets[0].columns.is_empty() && returns_rows_hint($sql) {
            if let Ok(described) = $conn.describe($sql).await {
                $sets[0].columns = described
                    .columns()
                    .iter()
                    .map(|c| ColumnInfo {
                        name: c.name().to_string(),
                        type_name: c.type_info().name().to_string(),
                    })
                    .collect();
            }
        }
    }};
}

impl Session {
    pub(crate) async fn run(&self, sql: &str, max_rows: usize) -> Result<Vec<ResultSet>, sqlx::Error> {
        let result = self.run_inner(sql, max_rows).await;
        self.touch();
        result
    }

    async fn run_inner(&self, sql: &str, max_rows: usize) -> Result<Vec<ResultSet>, sqlx::Error> {
        let mut conn = self.conn.lock().await;
        match &mut *conn {
            #[cfg(feature = "postgres")]
            SessionConn::Postgres(c) => run_postgres(c, sql, max_rows).await,
            #[cfg(feature = "mysql")]
            SessionConn::MySql(c) => {
                let mut sets = collect_results!(&mut *c, sql, max_rows, |v| crate::decode::mysql::to_json(v)
                    .unwrap_or(JsonValue::Null));
                fill_empty_columns!(&mut *c, sql, sets);
                Ok(sets)
            }
            #[cfg(feature = "sqlite")]
            SessionConn::Sqlite(c) => {
                let mut sets = collect_results!(&mut *c, sql, max_rows, |v| crate::decode::sqlite::to_json(v)
                    .unwrap_or(JsonValue::Null));
                fill_empty_columns!(&mut *c, sql, sets);
                Ok(sets)
            }
        }
    }
}

#[cfg(feature = "postgres")]
pub(crate) async fn run_postgres(
    conn: &mut sqlx::PgConnection,
    sql: &str,
    max_rows: usize,
) -> Result<Vec<ResultSet>, sqlx::Error> {
    let mut sets = collect_results!(&mut *conn, sql, max_rows, |v| crate::decode::postgres::to_json(v)
        .unwrap_or(JsonValue::Null));
    fill_empty_columns!(&mut *conn, sql, sets);
    Ok(sets)
}

/// Whether `sql` (one statement) can return rows, judged by its first
/// keyword after comments — only used to decide if describing is worthwhile.
pub(crate) fn returns_rows_hint(sql: &str) -> bool {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map(|(_, r)| r).unwrap_or("").trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map(|(_, r)| r).unwrap_or("").trim_start();
        } else {
            break;
        }
    }
    let first: String = rest
        .trim_start_matches('(')
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "SELECT" | "WITH" | "VALUES" | "TABLE" | "SHOW" | "EXPLAIN" | "FETCH" | "DESCRIBE" | "DESC" | "PRAGMA"
    ) || sql.to_ascii_uppercase().contains("RETURNING")
}

/// Errors after which the pinned connection is unusable; the session is
/// dropped so the next run reconnects.
pub(crate) fn is_connection_lost(e: &sqlx::Error) -> bool {
    match e {
        sqlx::Error::Io(_)
        | sqlx::Error::Protocol(_)
        | sqlx::Error::Tls(_)
        | sqlx::Error::PoolClosed
        | sqlx::Error::WorkerCrashed => true,
        // 08xxx connection exceptions; 57P01-03 admin shutdown / crash / cannot connect now.
        sqlx::Error::Database(db) => db
            .code()
            .is_some_and(|c| c.starts_with("08") || matches!(c.as_ref(), "57P01" | "57P02" | "57P03")),
        _ => false,
    }
}

/// psql-style error text: message plus DETAIL / HINT / CONTEXT / POSITION /
/// SQLSTATE when the server sent them (sqlx's Display keeps only the message).
pub(crate) fn describe_error(e: &sqlx::Error) -> String {
    if let sqlx::Error::Database(db) = e {
        #[cfg(feature = "postgres")]
        if let Some(pg) = db.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() {
            let mut out = format!("ERROR:  {}", pg.message());
            if let Some(detail) = pg.detail() {
                out.push_str(&format!("\nDETAIL:  {detail}"));
            }
            if let Some(hint) = pg.hint() {
                out.push_str(&format!("\nHINT:  {hint}"));
            }
            if let Some(context) = pg.r#where() {
                out.push_str(&format!("\nCONTEXT:  {context}"));
            }
            if let Some(sqlx::postgres::PgErrorPosition::Original(position)) = pg.position() {
                out.push_str(&format!("\nPOSITION: {position}"));
            }
            out.push_str(&format!("\nSQLSTATE: {}", pg.code()));
            return out;
        }
        if let Some(code) = db.code() {
            return format!("ERROR {}: {}", code, db.message());
        }
        return format!("ERROR: {}", db.message());
    }
    e.to_string()
}

// ─── Notice capture ──────────────────────────────────────────────────────────

const NOTICE_TARGET: &str = "sqlx::postgres::notice";

tokio::task_local! {
    static NOTICES: RefCell<Vec<String>>;
}

/// Run `fut` with notice capture enabled for the current task and return
/// its output together with every NOTICE/WARNING the server sent meanwhile.
pub(crate) async fn with_notice_capture<F: Future>(fut: F) -> (F::Output, Vec<String>) {
    NOTICES
        .scope(RefCell::new(Vec::new()), async move {
            let out = fut.await;
            let notices = NOTICES.with(|n| n.take());
            (out, notices)
        })
        .await
}

/// sqlx reports PostgreSQL NOTICE/WARNING messages (RAISE NOTICE in DO
/// blocks and functions) only as `tracing` events. This layer copies them
/// into the running session's buffer. Install it next to the app's other
/// layers; its own filter only ever matches sqlx's notice events.
pub fn notice_capture_layer<S>() -> impl Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    NoticeCaptureLayer.with_filter(NoticeFilter)
}

struct NoticeFilter;

impl<S> Filter<S> for NoticeFilter {
    fn enabled(&self, meta: &Metadata<'_>, _cx: &Context<'_, S>) -> bool {
        meta.target() == NOTICE_TARGET
    }

    fn callsite_enabled(&self, meta: &'static Metadata<'static>) -> tracing::subscriber::Interest {
        if meta.target() == NOTICE_TARGET {
            tracing::subscriber::Interest::always()
        } else {
            tracing::subscriber::Interest::never()
        }
    }
}

struct NoticeCaptureLayer;

impl<S: Subscriber> Layer<S> for NoticeCaptureLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        struct Message(String);
        impl tracing::field::Visit for Message {
            fn record_str(&mut self, field: &Field, value: &str) {
                if field.name() == "message" {
                    self.0 = value.to_string();
                }
            }
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" && self.0.is_empty() {
                    self.0 = format!("{value:?}");
                }
            }
        }
        let mut message = Message(String::new());
        event.record(&mut message);
        // sqlx maps PostgreSQL severities onto tracing levels; map them back.
        let label = match *event.metadata().level() {
            Level::ERROR => "ERROR",
            Level::WARN => "WARNING",
            Level::INFO => "NOTICE",
            Level::DEBUG => "DEBUG",
            Level::TRACE => "INFO",
        };
        let _ = NOTICES.try_with(|n| n.borrow_mut().push(format!("{label}:  {}", message.0)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_returning_hint() {
        assert!(returns_rows_hint("select 1"));
        assert!(returns_rows_hint("-- c\n /* x */ WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(returns_rows_hint("(SELECT 1)"));
        assert!(returns_rows_hint("DELETE FROM t RETURNING id"));
        assert!(!returns_rows_hint("UPDATE t SET a = 1"));
        assert!(!returns_rows_hint("DO $$ BEGIN END $$"));
    }
}

/// End-to-end tests against a real PostgreSQL server. They run when
/// `QUERYDEN_TEST_PG_URL` is set (e.g. `postgres://user@127.0.0.1:5432/postgres`)
/// and are skipped otherwise. Each test works in its own schema.
#[cfg(all(test, feature = "postgres"))]
mod pg_tests {
    use super::*;
    use sqlx::Connection;
    use tracing_subscriber::layer::SubscriberExt;

    /// One global subscriber, installed before any query — as the app does.
    /// (Thread-local subscribers let tracing cache the notice callsite as
    /// "never" when another test thread hits it first.)
    fn install_notice_layer() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let _ = tracing::subscriber::set_global_default(tracing_subscriber::registry().with(notice_capture_layer()));
        });
    }

    async fn session(schema: &str) -> Option<(Session, sqlx::PgPool)> {
        let url = std::env::var("QUERYDEN_TEST_PG_URL").ok()?;
        install_notice_layer();
        let pool = sqlx::PgPool::connect(&url).await.expect("pool");
        let mut conn = sqlx::PgConnection::connect(&url).await.expect("connect");
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut conn).await.unwrap();
        let s = Session::new(SessionConn::Postgres(conn), Some(pid as i64));
        s.run(&format!("DROP SCHEMA IF EXISTS {schema} CASCADE; CREATE SCHEMA {schema}; SET search_path = {schema}"), usize::MAX)
            .await
            .unwrap();
        Some((s, pool))
    }

    async fn one(s: &Session, sql: &str) -> ResultSet {
        let mut sets = s.run(sql, usize::MAX).await.unwrap_or_else(|e| panic!("{sql}: {}", describe_error(&e)));
        assert_eq!(sets.len(), 1, "{sql}");
        sets.remove(0)
    }

    const FIXTURE: &str = "CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT g, 'v' || g FROM generate_series(1, 5) g";

    #[tokio::test]
    async fn dml_with_and_without_returning() {
        let Some((s, _)) = session("qd_t_dml").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();

        let upd = one(&s, "UPDATE t SET v = 'x' WHERE id <= 2").await;
        assert!(upd.columns.is_empty());
        assert_eq!(upd.rows_affected, 2);

        let del = one(&s, "DELETE FROM t WHERE id = 5 RETURNING id, v").await;
        assert_eq!(del.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "v"]);
        assert_eq!(del.rows, vec![vec![serde_json::json!(5), serde_json::json!("v5")]]);
        assert_eq!(del.rows_affected, 1);

        let ins = one(&s, "INSERT INTO t VALUES (9, 'nine'), (10, 'ten')").await;
        assert_eq!(ins.rows_affected, 2);
    }

    #[tokio::test]
    async fn ctes_including_data_modifying_ones() {
        let Some((s, _)) = session("qd_t_cte").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();

        let read = one(&s, "WITH x AS (SELECT id FROM t WHERE id > 3) SELECT count(*) AS n FROM x").await;
        assert_eq!(read.rows, vec![vec![serde_json::json!(2)]]);

        let moved = one(&s, "WITH d AS (DELETE FROM t WHERE id <= 2 RETURNING *) SELECT count(*) AS deleted FROM d").await;
        assert_eq!(moved.rows, vec![vec![serde_json::json!(2)]]);

        // No RETURNING anywhere: the outer DELETE's count is what matters.
        let chained = one(&s, "WITH d AS (DELETE FROM t WHERE id = 3) DELETE FROM t WHERE id = 4").await;
        assert!(chained.columns.is_empty());
        assert_eq!(chained.rows_affected, 1);
        assert_eq!(one(&s, "SELECT count(*) FROM t").await.rows, vec![vec![serde_json::json!(1)]]);
    }

    #[tokio::test]
    async fn truncate_do_blocks_and_notices() {
        let Some((s, _)) = session("qd_t_do").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();

        let (sets, notices) = with_notice_capture(s.run(
            "DO $$ DECLARE n int; BEGIN DELETE FROM t WHERE id > 3; GET DIAGNOSTICS n = ROW_COUNT; RAISE NOTICE 'removed % rows', n; RAISE WARNING 'careful'; END $$",
            usize::MAX,
        ))
        .await;
        let sets = sets.unwrap();
        assert_eq!(sets.len(), 1);
        assert!(sets[0].columns.is_empty());
        assert_eq!(notices, vec!["NOTICE:  removed 2 rows".to_string(), "WARNING:  careful".to_string()]);

        let tr = one(&s, "TRUNCATE t").await;
        assert!(tr.columns.is_empty());
        assert_eq!(one(&s, "SELECT count(*) FROM t").await.rows, vec![vec![serde_json::json!(0)]]);
    }

    #[tokio::test]
    async fn select_of_a_function_that_deletes() {
        let Some((s, _)) = session("qd_t_fn").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();
        s.run(
            "CREATE FUNCTION purge(keep int) RETURNS int LANGUAGE plpgsql AS $$ DECLARE n int; BEGIN DELETE FROM t WHERE id > keep; GET DIAGNOSTICS n = ROW_COUNT; RETURN n; END $$",
            usize::MAX,
        )
        .await
        .unwrap();
        let r = one(&s, "SELECT purge(2)").await;
        assert_eq!(r.columns[0].name, "purge");
        assert_eq!(r.rows, vec![vec![serde_json::json!(3)]]);
        assert_eq!(one(&s, "SELECT count(*) FROM t").await.rows, vec![vec![serde_json::json!(2)]]);
        let void = one(&s, "SELECT pg_sleep(0)").await;
        assert_eq!(void.rows.len(), 1);
    }

    #[tokio::test]
    async fn transactions_and_session_state_span_runs() {
        let Some((s, _)) = session("qd_t_tx").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();

        one(&s, "BEGIN").await;
        one(&s, "DELETE FROM t").await;
        assert_eq!(one(&s, "SELECT count(*) FROM t").await.rows, vec![vec![serde_json::json!(0)]]);
        one(&s, "ROLLBACK").await;
        assert_eq!(one(&s, "SELECT count(*) FROM t").await.rows, vec![vec![serde_json::json!(5)]]);

        one(&s, "BEGIN").await;
        one(&s, "DELETE FROM t WHERE id = 1").await;
        one(&s, "COMMIT").await;
        assert_eq!(one(&s, "SELECT count(*) FROM t").await.rows, vec![vec![serde_json::json!(4)]]);

        one(&s, "CREATE TEMP TABLE scratch AS SELECT 42 AS answer").await;
        assert_eq!(one(&s, "SELECT answer FROM scratch").await.rows, vec![vec![serde_json::json!(42)]]);
        one(&s, "SET statement_timeout = '1234ms'").await;
        assert_eq!(one(&s, "SHOW statement_timeout").await.rows, vec![vec![serde_json::json!("1234ms")]]);
    }

    #[tokio::test]
    async fn values_are_exactly_what_psql_prints() {
        let Some((s, _)) = session("qd_t_types").await else { return };
        one(&s, "SET TimeZone = 'Africa/Johannesburg'").await;
        let r = one(
            &s,
            "SELECT 1 AS id, 2 AS id, NULL::text AS n, ''::text AS e, \
             12345678901234567.89::numeric AS big, 1.50::numeric AS scaled, 2.5::numeric AS plain, 'NaN'::numeric AS nan, \
             'infinity'::timestamp AS inf, interval '1 year 2 months 3 days 04:05:06.789' AS iv, \
             ARRAY['a','b'] AS arr, 'pg_class'::regclass AS rel, 12.5::money AS cash, '{\"k\": [1, 2]}'::jsonb AS doc, \
             '2024-01-01 10:00:00+00'::timestamptz AS ts, true AS yes, 9007199254740993::int8 AS huge, '\\x4869'::bytea AS raw",
        )
        .await;
        let names: Vec<_> = r.columns.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(&names[..2], ["id", "id"], "duplicate names must both survive");
        let row = &r.rows[0];
        let expect = [
            serde_json::json!(1),
            serde_json::json!(2),
            JsonValue::Null,
            serde_json::json!(""),
            serde_json::json!("12345678901234567.89"),
            serde_json::json!("1.50"),
            serde_json::json!(2.5),
            serde_json::json!("NaN"),
            serde_json::json!("infinity"),
            serde_json::json!("1 year 2 mons 3 days 04:05:06.789"),
            serde_json::json!("{a,b}"),
            serde_json::json!("pg_class"),
            JsonValue::Null, // money: locale-dependent, checked below
            serde_json::json!({"k": [1, 2]}),
            serde_json::json!("2024-01-01 12:00:00+02"),
            serde_json::json!(true),
            serde_json::json!("9007199254740993"),
            serde_json::json!([72, 105]),
        ];
        for (i, want) in expect.iter().enumerate() {
            if names[i] == "cash" {
                // Printed with the server's lc_monetary, exactly as psql shows it.
                assert!(row[i].as_str().unwrap().ends_with("12.50"), "{}", row[i]);
                continue;
            }
            assert_eq!(&row[i], want, "column {} ({})", i, names[i]);
        }
    }

    #[tokio::test]
    async fn session_settings_apply_to_later_statements() {
        let Some((s, _)) = session("qd_t_settings").await else { return };
        one(&s, "SET work_mem = '64MB'").await;
        one(&s, "SET maintenance_work_mem = '256MB'").await;
        one(&s, "SET client_encoding = 'UTF8'").await;
        one(&s, "SET application_name = 'qd-test-tab'").await;
        assert_eq!(one(&s, "SHOW work_mem").await.rows, vec![vec![serde_json::json!("64MB")]]);
        assert_eq!(one(&s, "SHOW maintenance_work_mem").await.rows, vec![vec![serde_json::json!("256MB")]]);
        assert_eq!(one(&s, "SHOW client_encoding").await.rows, vec![vec![serde_json::json!("UTF8")]]);
        assert_eq!(
            one(&s, "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()").await.rows,
            vec![vec![serde_json::json!("qd-test-tab")]]
        );

        // session_replication_role = replica disables ordinary triggers (and
        // FK enforcement) for this session only — the classic bulk-load switch.
        s.run(
            "CREATE TABLE audited (id int); CREATE TABLE audit_log (id int); \
             CREATE FUNCTION log_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit_log VALUES (NEW.id); RETURN NEW; END $$; \
             CREATE TRIGGER audit AFTER INSERT ON audited FOR EACH ROW EXECUTE FUNCTION log_it()",
            usize::MAX,
        )
        .await
        .unwrap();
        one(&s, "INSERT INTO audited VALUES (1)").await;
        one(&s, "SET session_replication_role = replica").await;
        one(&s, "INSERT INTO audited VALUES (2)").await;
        assert_eq!(one(&s, "SHOW session_replication_role").await.rows, vec![vec![serde_json::json!("replica")]]);
        assert_eq!(one(&s, "SELECT array_agg(id ORDER BY id)::text FROM audit_log").await.rows, vec![vec![serde_json::json!("{1}")]]);
        one(&s, "RESET session_replication_role").await;
        one(&s, "INSERT INTO audited VALUES (3)").await;
        assert_eq!(one(&s, "SELECT array_agg(id ORDER BY id)::text FROM audit_log").await.rows, vec![vec![serde_json::json!("{1,3}")]]);

        // SET ROLE persists too.
        s.run("DROP ROLE IF EXISTS qd_reader; CREATE ROLE qd_reader", usize::MAX).await.unwrap();
        one(&s, "SET ROLE qd_reader").await;
        assert_eq!(one(&s, "SELECT current_user").await.rows, vec![vec![serde_json::json!("qd_reader")]]);
        one(&s, "RESET ROLE").await;
    }

    fn first(set: &ResultSet) -> JsonValue {
        set.rows[0][0].clone()
    }

    #[tokio::test]
    async fn timeouts_are_enforced_per_session() {
        let Some((s, _)) = session("qd_t_timeouts").await else { return };
        one(&s, "SET statement_timeout = '200ms'").await;
        let err = s.run("SELECT pg_sleep(2)", usize::MAX).await.unwrap_err();
        assert!(describe_error(&err).contains("canceling statement due to statement timeout"), "{}", describe_error(&err));
        one(&s, "RESET statement_timeout").await;
        one(&s, "SET lock_timeout = '1s'").await;
        one(&s, "SET idle_in_transaction_session_timeout = '10min'").await;
        assert_eq!(first(&one(&s, "SHOW lock_timeout").await), serde_json::json!("1s"));
        assert_eq!(first(&one(&s, "SHOW idle_in_transaction_session_timeout").await), serde_json::json!("10min"));
    }

    #[tokio::test]
    async fn output_format_settings_shape_the_values() {
        let Some((s, _)) = session("qd_t_formats").await else { return };
        one(&s, "SET TimeZone = 'UTC'").await;
        one(&s, "SET DateStyle = 'SQL, DMY'").await;
        assert_eq!(first(&one(&s, "SELECT '2024-03-01 10:00:00+00'::timestamptz").await), serde_json::json!("01/03/2024 10:00:00 UTC"));
        one(&s, "SET IntervalStyle = 'iso_8601'").await;
        assert_eq!(first(&one(&s, "SELECT interval '1 day 2 hours'").await), serde_json::json!("P1DT2H"));
        // PostgreSQL 12+: positive values print shortest-exact; negative ones round.
        one(&s, "SET extra_float_digits = -3").await;
        assert_eq!(first(&one(&s, "SELECT 1.23456789012345678::float8").await), serde_json::json!(1.23456789012));
        one(&s, "SET bytea_output = 'escape'").await;
        assert_eq!(first(&one(&s, "SELECT 'Hi'::bytea").await), serde_json::json!("Hi"));
        one(&s, "RESET ALL").await;
        assert_eq!(first(&one(&s, "SELECT 'Hi'::bytea").await), serde_json::json!([72, 105]));
    }

    #[tokio::test]
    async fn read_only_sessions_custom_gucs_and_set_local() {
        let Some((s, _)) = session("qd_t_gucs").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();

        one(&s, "SET default_transaction_read_only = on").await;
        let err = s.run("INSERT INTO t VALUES (99, 'x')", usize::MAX).await.unwrap_err();
        assert!(describe_error(&err).contains("read-only transaction"), "{}", describe_error(&err));
        one(&s, "RESET default_transaction_read_only").await;

        // Row-level-security style tenant context.
        one(&s, "SET app.tenant_id = '42'").await;
        one(&s, "SELECT set_config('app.user_id', '7', false)").await;
        assert_eq!(
            one(&s, "SELECT current_setting('app.tenant_id') AS tenant, current_setting('app.user_id') AS usr").await.rows,
            vec![vec![serde_json::json!("42"), serde_json::json!("7")]]
        );

        // SET LOCAL lasts until the end of the transaction only.
        one(&s, "SET work_mem = '8MB'").await;
        one(&s, "BEGIN").await;
        one(&s, "SET LOCAL work_mem = '128MB'").await;
        assert_eq!(first(&one(&s, "SHOW work_mem").await), serde_json::json!("128MB"));
        one(&s, "COMMIT").await;
        assert_eq!(first(&one(&s, "SHOW work_mem").await), serde_json::json!("8MB"));

        one(&s, "SET enable_seqscan = off").await;
        assert_eq!(first(&one(&s, "SHOW enable_seqscan").await), serde_json::json!("off"));
        one(&s, "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL REPEATABLE READ").await;
        assert_eq!(first(&one(&s, "SHOW default_transaction_isolation").await), serde_json::json!("repeatable read"));
    }

    #[tokio::test]
    async fn client_min_messages_controls_which_notices_arrive() {
        let Some((s, _)) = session("qd_t_msgs").await else { return };
        let raise = "DO $$ BEGIN RAISE NOTICE 'n'; RAISE WARNING 'w'; END $$";
        one(&s, "SET client_min_messages = warning").await;
        let (_, notices) = with_notice_capture(s.run(raise, usize::MAX)).await;
        assert_eq!(notices, vec!["WARNING:  w".to_string()]);
        one(&s, "SET client_min_messages = notice").await;
        let (_, notices) = with_notice_capture(s.run(raise, usize::MAX)).await;
        assert_eq!(notices, vec!["NOTICE:  n".to_string(), "WARNING:  w".to_string()]);
    }

    #[tokio::test]
    async fn prepared_statements_cursors_and_advisory_locks_live_in_the_session() {
        let Some((s, pool)) = session("qd_t_objects").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();

        one(&s, "PREPARE by_id(int) AS SELECT v FROM t WHERE id = $1").await;
        assert_eq!(one(&s, "EXECUTE by_id(3)").await.rows, vec![vec![serde_json::json!("v3")]]);
        one(&s, "DEALLOCATE by_id").await;

        one(&s, "DECLARE c CURSOR WITH HOLD FOR SELECT id FROM t ORDER BY id").await;
        let page = one(&s, "FETCH 2 FROM c").await;
        assert_eq!(page.rows, vec![vec![serde_json::json!(1)], vec![serde_json::json!(2)]]);
        assert_eq!(one(&s, "FETCH 2 FROM c").await.rows, vec![vec![serde_json::json!(3)], vec![serde_json::json!(4)]]);
        one(&s, "CLOSE c").await;

        one(&s, "SELECT pg_advisory_lock(424242)").await;
        let other: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock(424242)").fetch_one(&pool).await.unwrap();
        assert!(!other, "the lock must be held by this tab's session");
        one(&s, "SELECT pg_advisory_unlock(424242)").await;

        one(&s, "DISCARD ALL").await;
        assert!(s.run("EXECUTE by_id(1)", usize::MAX).await.is_err());
    }

    #[tokio::test]
    async fn dead_idle_sessions_are_detected() {
        let Some((s, pool)) = session("qd_t_dead").await else { return };
        assert!(s.is_alive(std::time::Duration::ZERO).await);
        let pid = s.backend_id.unwrap() as i32;
        let _: bool = sqlx::query_scalar("SELECT pg_terminate_backend($1)").bind(pid).fetch_one(&pool).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        // A recently used session is trusted; an idle one is pinged.
        assert!(s.is_alive(std::time::Duration::from_secs(3600)).await);
        assert!(!s.is_alive(std::time::Duration::ZERO).await);
        let err = s.run("SELECT 1", usize::MAX).await.unwrap_err();
        assert!(is_connection_lost(&err), "{}", describe_error(&err));
    }

    #[tokio::test]
    async fn non_utf8_client_encoding_degrades_visibly_not_to_null() {
        let Some((s, _)) = session("qd_t_enc").await else { return };
        one(&s, "SET client_encoding = 'LATIN1'").await;
        let r = one(&s, "SELECT 'caf' || chr(233) AS word, 'plain' AS ascii").await;
        assert_eq!(r.rows[0][1], serde_json::json!("plain"));
        let word = r.rows[0][0].as_str().expect("non-UTF-8 text must not become NULL");
        assert!(word.starts_with("caf"), "{word}");
        one(&s, "SET client_encoding = 'UTF8'").await;
        assert_eq!(one(&s, "SELECT 'caf' || chr(233) AS word").await.rows, vec![vec![serde_json::json!("café")]]);
    }

    #[tokio::test]
    async fn empty_results_keep_their_columns_and_multi_statement_scripts_split() {
        let Some((s, _)) = session("qd_t_meta").await else { return };
        s.run(FIXTURE, usize::MAX).await.unwrap();
        let empty = one(&s, "SELECT id, v FROM t WHERE false").await;
        assert_eq!(empty.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "v"]);
        assert!(empty.rows.is_empty());

        let sets = s.run("SELECT 1 AS a; UPDATE t SET v = v; SELECT 2 AS b", usize::MAX).await.unwrap();
        assert_eq!(sets.len(), 3);
        assert_eq!(sets[0].columns[0].name, "a");
        assert_eq!(sets[1].rows_affected, 5);
        assert_eq!(sets[2].rows, vec![vec![serde_json::json!(2)]]);

        let capped = s.run("SELECT g FROM generate_series(1, 50) g", 10).await.unwrap().remove(0);
        assert_eq!(capped.rows.len(), 10);
        assert!(capped.truncated);
    }

    #[tokio::test]
    async fn errors_carry_position_and_hint() {
        let Some((s, _)) = session("qd_t_err").await else { return };
        let err = s.run("SELECT * FROM no_such_table", usize::MAX).await.unwrap_err();
        let text = describe_error(&err);
        assert!(text.starts_with("ERROR:  relation \"no_such_table\" does not exist"), "{text}");
        assert!(text.contains("POSITION: 15"), "{text}");
        assert!(text.contains("SQLSTATE: 42P01"), "{text}");
        assert!(!is_connection_lost(&err));

        let err = s.run("SELECT nonexistent_fn(1)", usize::MAX).await.unwrap_err();
        assert!(describe_error(&err).contains("HINT:  No function matches"), "{}", describe_error(&err));

        // The session survives a failed statement.
        assert_eq!(one(&s, "SELECT 1 AS ok").await.rows, vec![vec![serde_json::json!(1)]]);
    }

    #[tokio::test]
    async fn cancel_stops_a_running_statement() {
        let Some((s, pool)) = session("qd_t_cancel").await else { return };
        let s = std::sync::Arc::new(s);
        let pid = s.backend_id.unwrap();
        let running = {
            let s = s.clone();
            tokio::spawn(async move { s.run("SELECT pg_sleep(30)", usize::MAX).await })
        };
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let started = std::time::Instant::now();
        assert!(crate::DbPool::Postgres(pool).cancel_backend(pid).await.unwrap());
        let err = running.await.unwrap().unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(describe_error(&err).contains("canceling statement due to user request"), "{}", describe_error(&err));
        assert_eq!(one(&s, "SELECT 1 AS alive").await.rows, vec![vec![serde_json::json!(1)]]);
    }

    #[tokio::test]
    async fn binary_select_path_decodes_exactly() {
        let Some((_, pool)) = session("qd_t_bin").await else { return };
        let db = crate::DbPool::Postgres(pool);
        let rows = db
            .select(
                "SELECT 12345678901234567.89::numeric AS big, 1.50::numeric AS scaled, 'NaN'::numeric AS nan, \
                 'pg_class'::regclass::oid AS oid, 0.1::float4 AS f4, 'NaN'::float8 AS f8, \
                 '2024-01-01 12:00:00'::timestamp AS ts, 'infinity'::date AS d, \
                 interval '00:00:01.25' AS iv, ARRAY['a', NULL] AS arr"
                    .to_string(),
                vec![],
            )
            .await
            .unwrap();
        let r = &rows[0];
        assert_eq!(r["big"], serde_json::json!("12345678901234567.89"));
        assert_eq!(r["scaled"], serde_json::json!("1.50"));
        assert_eq!(r["nan"], serde_json::json!("NaN"));
        assert_eq!(r["oid"], serde_json::json!(1259));
        assert_eq!(r["f4"], serde_json::json!(0.1));
        assert_eq!(r["f8"], serde_json::json!("NaN"));
        assert_eq!(r["ts"], serde_json::json!("2024-01-01 12:00:00"));
        assert_eq!(r["d"], serde_json::json!("infinity"));
        assert_eq!(r["iv"], serde_json::json!("00:00:01.25"));
        assert_eq!(r["arr"], serde_json::json!(["a", null]));
    }

    /// The explorer's catalogue queries (schemaFetch.ts, ConnectionContext.tsx)
    /// go through `select`; every name must come back as a JSON string.
    #[tokio::test]
    async fn app_catalogue_queries_decode_names() {
        let Some((s, pool)) = session("qd_t_cat").await else { return };
        s.run(
            "CREATE TABLE releases (id int PRIMARY KEY, version varchar(20)); \
             CREATE FUNCTION report(p_env text, p_limit int DEFAULT 10) RETURNS TABLE (env text, n int) \
             LANGUAGE sql AS $$ SELECT p_env, p_limit $$",
            usize::MAX,
        )
        .await
        .unwrap();
        let db = crate::DbPool::Postgres(pool);

        let objects = db
            .select(
                "SELECT 'tables' AS kind, table_schema::text AS sch, table_name::text AS nm \
                   FROM information_schema.tables WHERE table_schema = 'qd_t_cat' AND table_type = 'BASE TABLE' \
                 UNION ALL \
                 SELECT 'functions', routine_schema::text, routine_name::text \
                   FROM information_schema.routines WHERE routine_schema = 'qd_t_cat' AND routine_type = 'FUNCTION' \
                 ORDER BY 1, 2, 3"
                    .to_string(),
                vec![],
            )
            .await
            .unwrap();
        let triples: Vec<_> = objects
            .iter()
            .map(|r| (r["kind"].clone(), r["sch"].clone(), r["nm"].clone()))
            .collect();
        assert_eq!(
            triples,
            vec![
                (serde_json::json!("functions"), serde_json::json!("qd_t_cat"), serde_json::json!("report")),
                (serde_json::json!("tables"), serde_json::json!("qd_t_cat"), serde_json::json!("releases")),
            ]
        );

        let cols = db
            .select(
                "SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name, \
                        format_type(a.atttypid, a.atttypmod) AS data_type \
                   FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid \
                   JOIN pg_namespace n ON c.relnamespace = n.oid \
                  WHERE a.attnum > 0 AND NOT a.attisdropped AND n.nspname = 'qd_t_cat' AND c.relkind = 'r' \
                  ORDER BY a.attnum"
                    .to_string(),
                vec![],
            )
            .await
            .unwrap();
        assert_eq!(cols[1]["table_name"], serde_json::json!("releases"));
        assert_eq!(cols[1]["column_name"], serde_json::json!("version"));
        assert_eq!(cols[1]["data_type"], serde_json::json!("character varying(20)"));

        let ts = db
            .select("SELECT spcname, spcowner::regrole::text AS owner, spcowner::regrole AS owner_oid FROM pg_tablespace LIMIT 1".to_string(), vec![])
            .await
            .unwrap();
        assert!(ts[0]["owner"].is_string(), "{:?}", ts[0]);
        assert!(ts[0]["owner_oid"].is_number(), "{:?}", ts[0]);
    }
}

#[cfg(all(test, feature = "sqlite"))]
mod sqlite_tests {
    use super::*;
    use sqlx::Connection;

    async fn session() -> Session {
        let conn = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        Session::new(SessionConn::Sqlite(conn), None)
    }

    #[tokio::test]
    async fn scripts_transactions_and_types() {
        let s = session().await;
        let sets = s
            .run("CREATE TABLE t (id INTEGER PRIMARY KEY, price NUMERIC, note TEXT); INSERT INTO t VALUES (1, 1.5, ''), (2, 3, NULL)", usize::MAX)
            .await
            .unwrap();
        assert_eq!(sets.last().unwrap().rows_affected, 2);

        s.run("BEGIN", usize::MAX).await.unwrap();
        s.run("DELETE FROM t", usize::MAX).await.unwrap();
        s.run("ROLLBACK", usize::MAX).await.unwrap();

        let r = s.run("SELECT id, price, note FROM t ORDER BY id", usize::MAX).await.unwrap().remove(0);
        assert_eq!(r.rows[0], vec![serde_json::json!(1), serde_json::json!(1.5), serde_json::json!("")]);
        assert_eq!(r.rows[1], vec![serde_json::json!(2), serde_json::json!(3), JsonValue::Null]);

        let empty = s.run("SELECT id, note FROM t WHERE 0", usize::MAX).await.unwrap().remove(0);
        assert_eq!(empty.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "note"]);

        let del = s.run("DELETE FROM t WHERE id = 2 RETURNING id", usize::MAX).await.unwrap().remove(0);
        assert_eq!(del.rows, vec![vec![serde_json::json!(2)]]);
    }

    #[tokio::test]
    async fn per_connection_pragmas_and_attachments_persist() {
        let s = session().await;
        s.run("PRAGMA foreign_keys = ON", usize::MAX).await.unwrap();
        s.run(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (pid INTEGER REFERENCES parent(id))",
            usize::MAX,
        )
        .await
        .unwrap();
        // Enforced only because the PRAGMA from the earlier run is still active.
        assert!(s.run("INSERT INTO child VALUES (1)", usize::MAX).await.is_err());

        s.run("ATTACH DATABASE ':memory:' AS side; CREATE TABLE side.notes (n TEXT)", usize::MAX).await.unwrap();
        s.run("INSERT INTO side.notes VALUES ('kept')", usize::MAX).await.unwrap();
        let r = s.run("SELECT n FROM side.notes", usize::MAX).await.unwrap().remove(0);
        assert_eq!(r.rows, vec![vec![serde_json::json!("kept")]]);
    }
}
