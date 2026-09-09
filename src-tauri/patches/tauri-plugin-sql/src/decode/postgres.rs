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
                super::int64_to_json(v)
            } else {
                JsonValue::Null
            }
        }
        "INT2[]" => {
            // Decode as Option<i16> so SQL NULL elements survive as JSON null.
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<Option<i16>>>() {
                JsonValue::Array(int_vec_to_json(v))
            } else {
                JsonValue::Null
            }
        }
        "INT4[]" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<Option<i32>>>() {
                JsonValue::Array(int_vec_to_json(v))
            } else {
                JsonValue::Null
            }
        }
        "INT8[]" => {
            // Elements beyond JS safe-integer range become digit-exact
            // strings (see `super::int64_to_json`); SQL NULLs stay JSON null.
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<Option<i64>>>() {
                JsonValue::Array(int64_vec_to_json(v))
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
        "OID" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i32>() {
                JsonValue::Number(v.into())
            } else {
                JsonValue::Null
            }
        }
        "VOID" => JsonValue::Null,
        "regrole" => {
            // regrole is an OID alias — PostgreSQL transmits it as the role name
            // in text mode or as a 4-byte OID in binary mode. In practice the
            // plugin receives the text form, so try as_str first.
            if let Ok(s) = v.as_str() {
                JsonValue::String(s.to_string())
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<String>() {
                JsonValue::String(v)
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<i32>() {
                JsonValue::Number(v.into())
            } else {
                JsonValue::Null
            }
        }
        "INET" => {
            // Decode INET from PostgreSQL binary format.
            // Binary: 1 byte family (2=IPv4, 3=IPv6), 1 byte prefix bits,
            // 1 byte is_cidr flag, 1 byte address length (nb), then nb address bytes.
            if let Ok(bytes) = v.as_bytes() {
                if bytes.len() >= 8 {
                    let family = bytes[0];
                    let nb = bytes[3] as usize;
                    if bytes.len() >= 4 + nb {
                        match family {
                            2 => {
                                let addr = std::net::Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]);
                                JsonValue::String(addr.to_string())
                            }
                            3 if nb == 16 => {
                                let mut octets = [0u8; 16];
                                octets.copy_from_slice(&bytes[4..20]);
                                let addr = std::net::Ipv6Addr::from(octets);
                                JsonValue::String(addr.to_string())
                            }
                            _ => JsonValue::Null,
                        }
                    } else {
                        JsonValue::Null
                    }
                } else {
                    JsonValue::Null
                }
            } else {
                JsonValue::Null
            }
        }
        // Handle custom types (enums, domains, etc.) by trying to decode as string
        _ => {
            let type_name = v.type_info().name().to_string();
            // PostgreSQL transmits ENUMs (like `ansible.log_stream`, `ansible.job_status`)
            // as their text labels even in binary mode. `v.as_str()` reads the raw text
            // buffer directly without requiring a matching string-type OID, so it works
            // for custom ENUMs where `try_decode::<String>()` would fail.
            if let Ok(s) = v.as_str() {
                log::warn!("unsupported type {type_name} decoded as string via as_str");
                JsonValue::String(s.to_string())
            } else if let Ok(v) = ValueRef::to_owned(&v).try_decode::<String>() {
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
                    log::warn!("unsupported type {type_name} — f64 decode failed to convert to JSON number, returning null");
                    JsonValue::Null
                }
            } else {
                log::warn!("unsupported type {type_name} — no fallback decode succeeded, returning null");
                JsonValue::Null
            }
        }
    };

    Ok(res)
}

/// Convert a `Vec<Option<i64>>` into a `Vec<JsonValue>`, preserving the
/// #41 safe-integer contract per element (out-of-range → exact string).
/// SQL NULL elements survive as JSON null.
fn int64_vec_to_json(values: Vec<Option<i64>>) -> Vec<JsonValue> {
    values
        .into_iter()
        .map(|opt| match opt {
            Some(n) => super::int64_to_json(n),
            None => JsonValue::Null,
        })
        .collect()
}

/// Convert a `Vec<Option<T>>` of any integer that fits into `serde_json::Number`
/// into a `Vec<JsonValue>` for use with `JsonValue::Array`.
///
/// All Postgres integer widths we support (INT2 → i16, INT4 → i32, INT8 → i64)
/// implement `Into<serde_json::Number>` directly, so each element becomes a JSON
/// number without lossy float conversion. SQL NULL elements are preserved as
/// `JsonValue::Null`. Mirrors the behaviour of the scalar INT2/INT4/INT8 arms.
fn int_vec_to_json<T>(values: Vec<Option<T>>) -> Vec<JsonValue>
where
    T: Into<serde_json::Number>,
{
    values
        .into_iter()
        .map(|opt| match opt {
            Some(n) => JsonValue::Number(n.into()),
            None => JsonValue::Null,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn some<T>(values: &[T]) -> Vec<Option<T>>
    where
        T: Copy,
    {
        values.iter().copied().map(Some).collect()
    }

    #[test]
    fn int2_array_maps_each_element_to_json_number() {
        let out = int_vec_to_json::<i16>(some(&[i16::MIN, -1, 0, 1, i16::MAX]));
        assert_eq!(
            out,
            vec![
                JsonValue::Number(i16::MIN.into()),
                JsonValue::Number((-1i16).into()),
                JsonValue::Number(0i16.into()),
                JsonValue::Number(1i16.into()),
                JsonValue::Number(i16::MAX.into()),
            ],
        );
    }

    #[test]
    fn int4_array_maps_each_element_to_json_number() {
        let out = int_vec_to_json::<i32>(some(&[i32::MIN, -1, 0, 1, i32::MAX]));
        assert_eq!(out.len(), 5);
        assert_eq!(out[0].as_i64(), Some(i32::MIN as i64));
        assert_eq!(out[4].as_i64(), Some(i32::MAX as i64));
        // Every element must serialise as a JSON number, not a string.
        for v in &out {
            assert!(v.is_number(), "expected JSON number, got {v:?}");
        }
    }

    #[test]
    fn int8_array_applies_safe_integer_contract_per_element() {
        // In-range elements stay JSON numbers; beyond-2^53 elements become
        // digit-exact strings (#41); NULLs stay JSON null.
        let big = 1_i64 << 60;
        let out = int64_vec_to_json(some(&[0, big, i64::MIN]));
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].as_i64(), Some(0));
        assert_eq!(out[1].as_str(), Some(big.to_string()).as_deref());
        assert_eq!(out[2].as_str(), Some(i64::MIN.to_string()).as_deref());

        let out = int64_vec_to_json(vec![Some(7), None]);
        assert_eq!(out[0].as_i64(), Some(7));
        assert!(out[1].is_null());
    }

    #[test]
    fn null_elements_become_json_null() {
        let out = int_vec_to_json::<i32>(vec![Some(1), None, Some(3)]);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].as_i64(), Some(1));
        assert!(out[1].is_null(), "expected JSON null, got {:?}", out[1]);
        assert_eq!(out[2].as_i64(), Some(3));
    }

    #[test]
    fn empty_array_produces_empty_json_array() {
        let out: Vec<JsonValue> = int_vec_to_json::<i32>(vec![]);
        assert!(out.is_empty());
    }
}
