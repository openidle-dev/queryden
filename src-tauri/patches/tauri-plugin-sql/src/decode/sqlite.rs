// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde_json::Value as JsonValue;
use sqlx::{sqlite::SqliteValueRef, TypeInfo, Value, ValueRef};
use time::{Date, PrimitiveDateTime, Time};

use crate::Error;

pub(crate) fn to_json(v: SqliteValueRef) -> Result<JsonValue, Error> {
    if v.is_null() {
        return Ok(JsonValue::Null);
    }

    let res = match v.type_info().name() {
        "TEXT" => {
            if let Ok(v) = v.to_owned().try_decode() {
                JsonValue::String(v)
            } else {
                JsonValue::Null
            }
        }
        "REAL" => {
            if let Ok(v) = v.to_owned().try_decode::<f64>() {
                super::float_to_json(v)
            } else {
                JsonValue::Null
            }
        }
        "INTEGER" => {
            if let Ok(v) = v.to_owned().try_decode::<i64>() {
                super::int64_to_json(v)
            } else {
                JsonValue::Null
            }
        }
        // NUMERIC affinity stores integers and reals; 1.5 decoded as i64
        // used to come back as NULL.
        "NUMERIC" => {
            let owned = v.to_owned();
            if let Ok(i) = owned.try_decode::<i64>() {
                super::int64_to_json(i)
            } else if let Ok(f) = owned.try_decode::<f64>() {
                super::float_to_json(f)
            } else if let Ok(s) = owned.try_decode_unchecked::<String>() {
                JsonValue::String(s)
            } else {
                JsonValue::Null
            }
        }
        "BOOLEAN" => {
            if let Ok(v) = v.to_owned().try_decode() {
                JsonValue::Bool(v)
            } else {
                JsonValue::Null
            }
        }
        "DATE" => {
            if let Ok(v) = v.to_owned().try_decode::<Date>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "TIME" => {
            if let Ok(v) = v.to_owned().try_decode::<Time>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "DATETIME" => {
            if let Ok(v) = v.to_owned().try_decode::<PrimitiveDateTime>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "BLOB" => {
            if let Ok(v) = v.to_owned().try_decode::<Vec<u8>>() {
                super::bytes_to_json(&v)
            } else {
                JsonValue::Null
            }
        }
        "NULL" => JsonValue::Null,
        _ => {
            let owned = v.to_owned();
            match owned.try_decode_unchecked::<String>() {
                Ok(s) => JsonValue::String(s),
                Err(_) => owned.try_decode_unchecked::<Vec<u8>>().map(|b| super::bytes_to_json(&b)).unwrap_or(JsonValue::Null),
            }
        }
    };

    Ok(res)
}
