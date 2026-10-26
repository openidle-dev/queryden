// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde_json::Value as JsonValue;
use sqlx::{mysql::MySqlValueRef, TypeInfo, Value, ValueRef};
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};

use crate::Error;

pub(crate) fn to_json(v: MySqlValueRef) -> Result<JsonValue, Error> {
    if v.is_null() {
        return Ok(JsonValue::Null);
    }

    let res = match v.type_info().name() {
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode() {
                JsonValue::String(v)
            } else {
                JsonValue::Null
            }
        }
        "FLOAT" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<f32>() {
                // Through the shortest f32 text, so 0.1f32 is 0.1, not 0.10000000149011612.
                super::exact_number_or_string(&v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "DOUBLE" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<f64>() {
                super::float_to_json(v)
            } else {
                JsonValue::Null
            }
        }
        // DECIMAL travels as text in both protocols. It was missing here, so
        // any result containing one — SUM(), AVG(), `SELECT 1.5`, every
        // price column — failed the whole query as "unsupported datatype".
        "DECIMAL" => match ValueRef::to_owned(&v).try_decode_unchecked::<String>() {
            Ok(text) => super::exact_number_or_string(&text),
            Err(_) => JsonValue::Null,
        },
        "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i64>() {
                super::int64_to_json(v)
            } else {
                JsonValue::Null
            }
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED"
        | "BIGINT UNSIGNED" | "YEAR" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<u64>() {
                super::uint64_to_json(v)
            } else {
                JsonValue::Null
            }
        }
        "BOOLEAN" => {
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
        "DATETIME" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<PrimitiveDateTime>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "TIMESTAMP" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<OffsetDateTime>() {
                JsonValue::String(v.to_string())
            } else {
                JsonValue::Null
            }
        }
        "JSON" => ValueRef::to_owned(&v).try_decode().unwrap_or_default(),
        "TINYBLOB" | "MEDIUMBLOB" | "BLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "GEOMETRY" => {
            match ValueRef::to_owned(&v).try_decode_unchecked::<Vec<u8>>() {
                Ok(bytes) => super::bytes_to_json(&bytes),
                Err(_) => JsonValue::Null,
            }
        }
        // BIT(n): big-endian bytes; shown as the integer MySQL clients print.
        "BIT" => match ValueRef::to_owned(&v).try_decode_unchecked::<Vec<u8>>() {
            Ok(bytes) if bytes.len() <= 8 => super::uint64_to_json(bytes.iter().fold(0u64, |acc, b| (acc << 8) | *b as u64)),
            Ok(bytes) => super::bytes_to_json(&bytes),
            Err(_) => JsonValue::Null,
        },
        "NULL" => JsonValue::Null,
        // SET and anything new: show the server's text rather than failing
        // the entire result set over one column.
        _ => match ValueRef::to_owned(&v).try_decode_unchecked::<String>() {
            Ok(text) => JsonValue::String(text),
            Err(_) => match ValueRef::to_owned(&v).try_decode_unchecked::<Vec<u8>>() {
                Ok(bytes) => super::bytes_to_json(&bytes),
                Err(_) => JsonValue::Null,
            },
        },
    };

    Ok(res)
}
