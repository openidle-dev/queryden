// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use indexmap::IndexMap;
use serde_json::Value as JsonValue;
use sqlx::migrate::Migrator;
use tauri::{command, AppHandle, Runtime, State};

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
    db: Option<String>,
) -> Result<bool, crate::Error> {
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
