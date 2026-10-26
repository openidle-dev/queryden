// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::migrate::Migrator;
use tauri::{command, AppHandle, Runtime, State};

use crate::session::{self, RunOutput, Sessions};
use crate::{DbInstances, DbPool, Error, LastInsertId, Migrations};

#[command]
pub(crate) async fn load<R: Runtime>(
    app: AppHandle<R>,
    db_instances: State<'_, DbInstances>,
    migrations: State<'_, Migrations>,
    db: String,
) -> Result<String, crate::Error> {
    // QueryDen: reuse an already-established pool for this exact connection
    // string. The frontend calls `load()` on every reconnect, on every tab that
    // targets a connection, and on every database switch; upstream connected
    // unconditionally and inserted over the previous entry, which threw away a
    // live connection and leaked the old pool. Re-establishing costs a full
    // TCP + TLS + auth handshake — roughly six sequential round trips, close to
    // two seconds against a server on another continent.
    if db_instances.0.read().await.contains_key(&db) {
        return Ok(db);
    }

    let pool = DbPool::connect(&db, &app).await?;

    if let Some(migrations) = migrations.0.lock().await.remove(&db) {
        let migrator = Migrator::new(migrations).await?;
        pool.migrate(&migrator).await?;
    }

    {
        let mut instances = db_instances.0.write().await;
        // Another task may have connected the same URL while we were still
        // handshaking. Keep the registered pool and discard ours rather than
        // inserting over it and leaking the loser.
        if instances.contains_key(&db) {
            drop(instances);
            pool.close().await;
            return Ok(db);
        }
        instances.insert(db.clone(), pool);
    }

    Ok(db)
}

/// Allows the database connection(s) to be closed; if no database
/// name is passed in then _all_ database connection pools will be
/// shut down.
#[command]
pub(crate) async fn close(
    db_instances: State<'_, DbInstances>,
    sessions: State<'_, Sessions>,
    db: Option<String>,
) -> Result<bool, crate::Error> {
    // Editor sessions ride on these pools' servers; drop them with the pool.
    {
        let mut open = sessions.0.lock().await;
        match &db {
            Some(db) => open.retain(|(session_db, _), _| session_db != db),
            None => open.clear(),
        }
    }
    let mut instances = db_instances.0.write().await;

    let pools = if let Some(db) = db {
        vec![db]
    } else {
        instances.keys().cloned().collect()
    };

    for pool in pools {
        // QueryDen: take the pool *out* of the registry before closing it.
        // Upstream closed it but left the entry in place, so `load()`'s reuse
        // fast path above would hand back a dead handle for the rest of the
        // session.
        let db = instances
            .remove(&pool)
            .ok_or(Error::DatabaseNotLoaded(pool))?;
        db.close().await;
    }

    Ok(true)
}

/// Execute a command against the database
#[command]
pub(crate) async fn execute(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<(u64, LastInsertId), crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.execute(query, values).await
}

#[command]
pub(crate) async fn select(
    db_instances: State<'_, DbInstances>,
    db: String,
    query: String,
    values: Vec<JsonValue>,
) -> Result<Vec<IndexMap<String, JsonValue>>, crate::Error> {
    let instances = db_instances.0.read().await;

    let db = instances.get(&db).ok_or(Error::DatabaseNotLoaded(db))?;
    db.select(query, values).await
}

/// Run editor SQL on the session's own connection (see `session.rs`).
/// Returns one result set per statement plus captured server notices.
#[command]
pub(crate) async fn run(
    db_instances: State<'_, DbInstances>,
    sessions: State<'_, Sessions>,
    db: String,
    session: String,
    query: String,
    max_rows: Option<u32>,
    time_zone: Option<String>,
) -> Result<RunOutput, crate::Error> {
    let key = (db.clone(), session);
    let mut existing = sessions.0.lock().await.get(&key).cloned();
    let mut reconnected = false;
    if let Some(s) = &existing {
        if !s.is_alive(session::IDLE_PING_AFTER).await {
            sessions.0.lock().await.remove(&key);
            existing = None;
            reconnected = true;
        }
    }
    let active = match existing {
        Some(s) => s,
        None => {
            let pool = db_instances
                .0
                .read()
                .await
                .get(&db)
                .cloned()
                .ok_or_else(|| Error::DatabaseNotLoaded(db.clone()))?;
            let opened = pool.open_session(time_zone.as_deref()).await?;
            sessions
                .0
                .lock()
                .await
                .entry(key.clone())
                .or_insert_with(|| std::sync::Arc::new(opened))
                .clone()
        }
    };

    let max_rows = max_rows.map(|m| m as usize).unwrap_or(usize::MAX);
    let (result, mut notices) = session::with_notice_capture(active.run(&query, max_rows)).await;
    if reconnected {
        notices.insert(0, session::RECONNECTED_NOTICE.to_string());
    }
    match result {
        Ok(results) => Ok(RunOutput { results, notices }),
        Err(e) => {
            let mut message = notices.join("\n");
            if !message.is_empty() {
                message.push('\n');
            }
            message.push_str(&session::describe_error(&e));
            if session::is_connection_lost(&e) {
                sessions.0.lock().await.remove(&key);
                message.push_str("\n(The connection was lost; the next run reconnects. Any open transaction was rolled back.)");
            }
            Err(Error::Query(message))
        }
    }
}

/// Cancel the statement running in a session (PostgreSQL `pg_cancel_backend`,
/// MySQL `KILL QUERY`). Never waits for the running statement.
#[command]
pub(crate) async fn cancel(
    db_instances: State<'_, DbInstances>,
    sessions: State<'_, Sessions>,
    db: String,
    session: String,
) -> Result<bool, crate::Error> {
    let Some(backend_id) = sessions
        .0
        .lock()
        .await
        .get(&(db.clone(), session))
        .and_then(|s| s.backend_id)
    else {
        return Ok(false);
    };
    let pool = db_instances.0.read().await.get(&db).cloned();
    match pool {
        Some(pool) => pool.cancel_backend(backend_id).await,
        None => Ok(false),
    }
}

/// Close a session's connection (editor tab closed). An open transaction is
/// rolled back by the server when the connection ends.
#[command]
pub(crate) async fn end_session(
    sessions: State<'_, Sessions>,
    db: String,
    session: String,
) -> Result<bool, crate::Error> {
    Ok(sessions.0.lock().await.remove(&(db, session)).is_some())
}
