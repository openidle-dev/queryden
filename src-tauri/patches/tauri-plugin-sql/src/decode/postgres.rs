// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use rust_decimal::prelude::ToPrimitive;
use serde_json::Value as JsonValue;
use sqlx::{postgres::PgValueRef, TypeInfo, Value, ValueRef};
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use uuid::Uuid;

use crate::Error;

pub(crate) fn to_json(v: PgValueRef) -> Result<JsonValue, Error> {
    if v.is_null() {
        return Ok(JsonValue::Null);
    }

    let res = match v.type_info().name() {
        "CHAR" | "VARCHAR" | "TEXT" | "NAME" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode() {
                JsonValue::String(v)
            } else {
                JsonValue::Null
            }
        }
        "UUID" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Uuid>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "FLOAT4" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<f32>() {
                JsonValue::from(v)
            } else {
                JsonValue::Null
            }
        }
        "FLOAT8" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<f64>() {
                JsonValue::from(v)
            } else {
                JsonValue::Null
            }
        }
        "INT2" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i16>() {
                JsonValue::Number(v.into())
            } else {
                JsonValue::Null
            }
        }
        "INT4" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i32>() {
                JsonValue::Number(v.into())
            } else {
                JsonValue::Null
            }
        }
        "INT8" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i64>() {
                JsonValue::Number(v.into())
            } else {
                JsonValue::Null
            }
        }
        "BOOL" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode() {
                JsonValue::Bool(v)
            } else {
                JsonValue::Null
            }
        }
        "DATE" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Date>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "TIME" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Time>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "TIMESTAMP" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<PrimitiveDateTime>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "TIMESTAMPTZ" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<OffsetDateTime>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "JSON" | "JSONB" => ValueRef::to_owned(&v).try_decode().unwrap_or_default(),
        "BYTEA" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<u8>>() {
                JsonValue::Array(v.into_iter().map(|n| JsonValue::Number(n.into())).collect())
            } else {
                JsonValue::Null
            }
        }
        "NUMERIC" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<rust_decimal::Decimal>() {
                if let Some(n) = v.to_f64().and_then(serde_json::Number::from_f64) {
                    JsonValue::Number(n)
                } else {
                    JsonValue::String(v.to_string())
                }
            } else {
                JsonValue::Null
            }
        }
        "INTERVAL" => {
            // Decode INTERVAL from PostgreSQL binary format
            // PgValueRef::as_bytes returns Result<&[u8], Error>
            if let Ok(bytes) = v.as_bytes() {
                if bytes.len() >= 16 {
                    // INTERVAL binary: 8 bytes microseconds (i64 BE), 4 bytes days (i32 BE), 4 bytes months (i32 BE)
                    let microseconds = i64::from_be_bytes([
                        bytes[0], bytes[1], bytes[2], bytes[3],
                        bytes[4], bytes[5], bytes[6], bytes[7],
                    ]);
                    let days = i32::from_be_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
                    let months = i32::from_be_bytes([bytes[12], bytes[13], bytes[14], bytes[15]]);

                    let mut parts = Vec::new();
                    if months != 0 {
                        parts.push(format!("{} mons", months));
                    }
                    if days != 0 {
                        parts.push(format!("{} days", days));
                    }
                    if microseconds != 0 {
                        let total_secs = microseconds / 1_000_000;
                        let hours = (total_secs / 3600).abs();
                        let mins = ((total_secs % 3600) / 60).abs();
                        let secs = (total_secs % 60).abs();
                        if microseconds < 0 {
                            parts.push(format!("-{:02}:{:02}:{:02}", hours, mins, secs));
                        } else {
                            parts.push(format!("{:02}:{:02}:{:02}", hours, mins, secs));
                        }
                    }
                    JsonValue::String(if parts.is_empty() {
                        "00:00:00".to_string()
                    } else {
                        parts.join(" ")
                    })
                } else {
                    JsonValue::Null
                }
            } else {
                JsonValue::Null
            }
        }
        "VOID" => JsonValue::Null,
        // Handle custom types (enums, domains, etc.) by trying to decode as string
        _ => {
            let type_name = v.type_info().name().to_string();
            // Try common unsupported types as strings first
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<String>() {
                log::warn!("unsupported type {type_name} decoded as string");
                JsonValue::String(v)
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<String>>() {
                // Handle ARRAY types by joining elements
                log::warn!("unsupported array type {type_name} decoded as JSON array");
                JsonValue::Array(v.into_iter().map(JsonValue::String).collect())
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i32>() {
                // Handle OID, XID, CID as integers
                JsonValue::Number(v.into())
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i64>() {
                JsonValue::Number(v.into())
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<bool>() {
                JsonValue::Bool(v)
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<f64>() {
                if let Some(n) = serde_json::Number::from_f64(v) {
                    JsonValue::Number(n)
                } else {
                    return Err(Error::UnsupportedDatatype(type_name));
                }
            } else {
                return Err(Error::UnsupportedDatatype(type_name));
            }
        }
    };

    Ok(res)
}
