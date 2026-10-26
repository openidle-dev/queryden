// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde_json::Value as JsonValue;
use sqlx::{
    postgres::{PgTypeKind, PgValueFormat, PgValueRef},
    TypeInfo, Value, ValueRef,
};
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use uuid::Uuid;

use crate::Error;

/// Decode a value received in TEXT format (simple query protocol — the
/// editor console). The text is exactly what psql prints; only types with a
/// natural JSON form are converted, everything else stays verbatim.
pub(crate) fn text_to_json(oid: Option<u32>, text: &str) -> JsonValue {
    match oid {
        Some(16) => JsonValue::Bool(text == "t"),
        Some(21 | 23 | 26) => text.parse::<i64>().map(|v| JsonValue::Number(v.into())).unwrap_or_else(|_| JsonValue::String(text.into())),
        Some(20) => text.parse::<i64>().map(super::int64_to_json).unwrap_or_else(|_| JsonValue::String(text.into())),
        Some(700 | 701 | 1700) => super::exact_number_or_string(text),
        Some(114 | 3802) => serde_json::from_str(text).unwrap_or_else(|_| JsonValue::String(text.into())),
        Some(17) => match text.strip_prefix("\\x").and_then(decode_hex) {
            Some(bytes) => super::bytes_to_json(&bytes),
            None => JsonValue::String(text.into()),
        },
        _ => JsonValue::String(text.into()),
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Decode a value received in BINARY format (prepared statements — the
/// app's own catalog queries and the `select` command).
pub(crate) fn to_json(v: PgValueRef) -> Result<JsonValue, Error> {
    if v.is_null() {
        return Ok(JsonValue::Null);
    }
    if v.format() == PgValueFormat::Text {
        let oid = v.type_info().oid().map(|o| o.0);
        return Ok(match v.as_bytes() {
            Ok(bytes) => match std::str::from_utf8(bytes) {
                Ok(text) => text_to_json(oid, text),
                // The session switched client_encoding away from UTF8: show
                // the value with replacement characters instead of NULL.
                Err(_) => JsonValue::String(String::from_utf8_lossy(bytes).into_owned()),
            },
            Err(_) => JsonValue::Null,
        });
    }

    // sqlx only names `oid` itself; regclass, regrole, xid, … resolve to
    // lowercase catalog names, so recognise the family by type OID.
    if let Some(oid) = v.type_info().oid().map(|o| o.0).filter(|o| is_oid_family(*o)) {
        return Ok(oid_family_binary(oid, v.as_bytes().ok()));
    }

    let res = match v.type_info().name() {
        "CHAR" | "VARCHAR" | "TEXT" | "NAME" | "BPCHAR" | "CITEXT" => {
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
                // Through the shortest f32 text, so 0.1f32 is 0.1, not 0.10000000149011612.
                if v.is_finite() {
                    super::exact_number_or_string(&v.to_string())
                } else {
                    super::float_to_json(v as f64)
                }
            } else {
                JsonValue::Null
            }
        }
        "FLOAT8" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<f64>() {
                super::float_to_json(v)
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
        "TEXT[]" | "VARCHAR[]" | "NAME[]" | "BPCHAR[]" | "CHAR[]" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<Option<String>>>() {
                JsonValue::Array(v.into_iter().map(|s| s.map(JsonValue::String).unwrap_or(JsonValue::Null)).collect())
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
        "DATE" => match v.as_bytes() {
            Ok(b) if b == i32::MAX.to_be_bytes() => JsonValue::String("infinity".into()),
            Ok(b) if b == i32::MIN.to_be_bytes() => JsonValue::String("-infinity".into()),
            _ => ValueRef::to_owned(&v)
                .try_decode::<Date>()
                .map(|d| JsonValue::String(d.to_string()))
                .unwrap_or(JsonValue::Null),
        },
        "TIME" => ValueRef::to_owned(&v)
            .try_decode::<Time>()
            .map(|t| JsonValue::String(format_time(t)))
            .unwrap_or(JsonValue::Null),
        "TIMESTAMP" => match infinity_timestamp(&v) {
            Some(inf) => inf,
            None => ValueRef::to_owned(&v)
                .try_decode::<PrimitiveDateTime>()
                .map(|dt| JsonValue::String(format!("{} {}", dt.date(), format_time(dt.time()))))
                .unwrap_or(JsonValue::Null),
        },
        "TIMESTAMPTZ" => match infinity_timestamp(&v) {
            Some(inf) => inf,
            // Binary timestamptz is UTC; print it the way psql does with TimeZone=UTC.
            None => ValueRef::to_owned(&v)
                .try_decode::<OffsetDateTime>()
                .map(|dt| JsonValue::String(format!("{} {}+00", dt.date(), format_time(dt.time()))))
                .unwrap_or(JsonValue::Null),
        },
        "JSON" | "JSONB" => ValueRef::to_owned(&v).try_decode().unwrap_or_default(),
        "BYTEA" => {
            if let Ok(v) = ValueRef::to_owned(&v).try_decode::<Vec<u8>>() {
                super::bytes_to_json(&v)
            } else {
                JsonValue::Null
            }
        }
        "NUMERIC" => match v.as_bytes().ok().and_then(numeric_binary_to_string) {
            Some(text) => super::exact_number_or_string(&text),
            None => JsonValue::Null,
        },
        "INTERVAL" => match v.as_bytes() {
            Ok(bytes) if bytes.len() >= 16 => {
                let micros = i64::from_be_bytes(bytes[0..8].try_into().unwrap_or_default());
                let days = i32::from_be_bytes(bytes[8..12].try_into().unwrap_or_default());
                let months = i32::from_be_bytes(bytes[12..16].try_into().unwrap_or_default());
                JsonValue::String(format_interval(months, days, micros))
            }
            _ => JsonValue::Null,
        },
        "VOID" => JsonValue::Null,
        "INET" | "CIDR" => {
            // Binary: family (2=IPv4, 3=IPv6), prefix bits, is_cidr, address length, address.
            match v.as_bytes() {
                Ok(bytes) if bytes.len() >= 4 && bytes.len() >= 4 + bytes[3] as usize => {
                    let bits = bytes[1];
                    let addr: Option<std::net::IpAddr> = match (bytes[0], bytes[3]) {
                        (2, 4) => Some(std::net::Ipv4Addr::new(bytes[4], bytes[5], bytes[6], bytes[7]).into()),
                        (3, 16) => {
                            let mut octets = [0u8; 16];
                            octets.copy_from_slice(&bytes[4..20]);
                            Some(std::net::Ipv6Addr::from(octets).into())
                        }
                        _ => None,
                    };
                    match addr {
                        Some(a) => {
                            let full = if a.is_ipv4() { 32 } else { 128 };
                            let show_bits = bits != full || v.type_info().name() == "CIDR";
                            JsonValue::String(if show_bits { format!("{a}/{bits}") } else { a.to_string() })
                        }
                        None => JsonValue::Null,
                    }
                }
                _ => JsonValue::Null,
            }
        }
        _ => {
            let type_info = v.type_info().into_owned();
            // `kind()` panics (unreachable!) on unresolved type declarations,
            // and release builds abort on panic — only ask resolved types.
            let resolved = type_info.oid().is_some() && type_info.name() != "?";
            match resolved.then(|| type_info.kind()) {
                // Enum labels are sent as their text even in binary format.
                Some(PgTypeKind::Enum(_)) => v.as_str().map(|s| JsonValue::String(s.to_string())).unwrap_or(JsonValue::Null),
                _ => {
                    if let Ok(s) = ValueRef::to_owned(&v).try_decode::<String>() {
                        JsonValue::String(s)
                    } else {
                        // Reading other binary payloads as UTF-8 produced
                        // control-character garbage; say what the value is instead.
                        log::warn!("no binary decoder for type {}", type_info.name());
                        JsonValue::String(format!("<{}>", type_info.name().to_lowercase()))
                    }
                }
            }
        }
    };

    Ok(res)
}

/// oid, xid, cid, xid8 and the reg* aliases (regproc … regcollation).
fn is_oid_family(oid: u32) -> bool {
    matches!(oid, 24 | 26 | 28 | 29 | 2202..=2206 | 3734 | 3769 | 4089 | 4096 | 4191 | 5069)
}

/// Binary form is the raw number (4 bytes; xid8 is 8). A reg* value's name
/// only exists in text format, so app queries cast those to `::text`.
fn oid_family_binary(oid: u32, bytes: Option<&[u8]>) -> JsonValue {
    match bytes {
        Some(b) if oid == 5069 && b.len() == 8 => {
            super::int64_to_json(i64::from_be_bytes(b.try_into().unwrap_or_default()))
        }
        Some(b) if b.len() == 4 => JsonValue::Number(u32::from_be_bytes([b[0], b[1], b[2], b[3]]).into()),
        _ => JsonValue::Null,
    }
}

fn infinity_timestamp(v: &PgValueRef) -> Option<JsonValue> {
    match v.as_bytes() {
        Ok(b) if b == i64::MAX.to_be_bytes() => Some(JsonValue::String("infinity".into())),
        Ok(b) if b == i64::MIN.to_be_bytes() => Some(JsonValue::String("-infinity".into())),
        _ => None,
    }
}

/// `HH:MM:SS` plus fractional seconds only when present, trailing zeros
/// trimmed — psql's rendering (`time`'s Display prints `12:00:00.0`).
fn format_time(t: Time) -> String {
    let (h, m, s, micros) = t.as_hms_micro();
    if micros == 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        let frac = format!("{micros:06}");
        format!("{h:02}:{m:02}:{s:02}.{}", frac.trim_end_matches('0'))
    }
}

/// PostgreSQL's default `IntervalStyle = postgres` rendering:
/// `1 year 2 mons 3 days 04:05:06.789`.
fn format_interval(months: i32, days: i32, micros: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    let unit = |n: i64, one: &str, many: &str| format!("{n} {}", if n.abs() == 1 { one } else { many });
    let (years, mons) = (months / 12, months % 12);
    if years != 0 {
        parts.push(unit(years as i64, "year", "years"));
    }
    if mons != 0 {
        parts.push(unit(mons as i64, "mon", "mons"));
    }
    if days != 0 {
        parts.push(unit(days as i64, "day", "days"));
    }
    if micros != 0 || parts.is_empty() {
        let sign = if micros < 0 { "-" } else { "" };
        let total = micros.unsigned_abs();
        let (secs, frac) = (total / 1_000_000, total % 1_000_000);
        let mut time = format!("{sign}{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60);
        if frac != 0 {
            time.push('.');
            time.push_str(format!("{frac:06}").trim_end_matches('0'));
        }
        parts.push(time);
    }
    parts.join(" ")
}

/// Exact text of a binary-format NUMERIC: base-10000 digit groups, a weight
/// (position of the first group), sign/special flags and display scale.
/// Handles NaN/±Infinity and values beyond rust_decimal's 28 digits.
fn numeric_binary_to_string(b: &[u8]) -> Option<String> {
    if b.len() < 8 {
        return None;
    }
    let ndigits = i16::from_be_bytes([b[0], b[1]]) as usize;
    let weight = i16::from_be_bytes([b[2], b[3]]) as i32;
    let sign = u16::from_be_bytes([b[4], b[5]]);
    let dscale = u16::from_be_bytes([b[6], b[7]]) as usize;
    match sign {
        0xC000 => return Some("NaN".into()),
        0xD000 => return Some("Infinity".into()),
        0xF000 => return Some("-Infinity".into()),
        _ => {}
    }
    if b.len() < 8 + ndigits * 2 {
        return None;
    }
    let digit = |i: i32| -> u16 {
        if i < 0 || i as usize >= ndigits {
            0
        } else {
            let at = 8 + i as usize * 2;
            u16::from_be_bytes([b[at], b[at + 1]])
        }
    };

    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    if weight < 0 {
        out.push('0');
    } else {
        for i in 0..=weight {
            if i == 0 {
                out.push_str(&digit(i).to_string());
            } else {
                out.push_str(&format!("{:04}", digit(i)));
            }
        }
    }
    if dscale > 0 {
        let mut frac = String::new();
        let mut i = weight + 1;
        while frac.len() < dscale {
            frac.push_str(&format!("{:04}", digit(i)));
            i += 1;
        }
        frac.truncate(dscale);
        out.push('.');
        out.push_str(&frac);
    }
    if out == "-0" || (out.starts_with("-0") && out[1..].chars().all(|c| c == '0' || c == '.')) {
        out.remove(0);
    }
    Some(out)
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

    fn numeric_bytes(ndigits: i16, weight: i16, sign: u16, dscale: u16, digits: &[i16]) -> Vec<u8> {
        let mut b = Vec::new();
        for v in [ndigits.to_be_bytes(), weight.to_be_bytes(), sign.to_be_bytes(), dscale.to_be_bytes()] {
            b.extend_from_slice(&v);
        }
        for d in digits {
            b.extend_from_slice(&d.to_be_bytes());
        }
        b
    }

    #[test]
    fn numeric_binary_is_exact() {
        // 12345678901234567.89 = groups 1|2345|6789|0123|4567|8900, weight 4
        let b = numeric_bytes(6, 4, 0, 2, &[1, 2345, 6789, 123, 4567, 8900]);
        assert_eq!(numeric_binary_to_string(&b).unwrap(), "12345678901234567.89");
        // 1.50: one group "1" weight 0, fraction group 5000, dscale 2
        assert_eq!(numeric_binary_to_string(&numeric_bytes(2, 0, 0, 2, &[1, 5000])).unwrap(), "1.50");
        // -0.0042: weight -1 (first group is 0042 after the point)
        assert_eq!(numeric_binary_to_string(&numeric_bytes(1, -1, 0x4000, 4, &[42])).unwrap(), "-0.0042");
        assert_eq!(numeric_binary_to_string(&numeric_bytes(0, 0, 0xC000, 0, &[])).unwrap(), "NaN");
        assert_eq!(numeric_binary_to_string(&numeric_bytes(0, 0, 0, 0, &[])).unwrap(), "0");
    }

    #[test]
    fn oid_family_binary_values() {
        // regrole (4096) is named "regrole" by sqlx, not "REGROLE".
        assert!(is_oid_family(4096) && is_oid_family(2205) && is_oid_family(28) && is_oid_family(26));
        assert!(!is_oid_family(23) && !is_oid_family(25));
        assert_eq!(oid_family_binary(4096, Some(&10u32.to_be_bytes())), serde_json::json!(10));
        assert_eq!(oid_family_binary(28, Some(&u32::MAX.to_be_bytes())), serde_json::json!(4294967295u32));
        assert_eq!(oid_family_binary(5069, Some(&742i64.to_be_bytes())), serde_json::json!(742));
        assert_eq!(oid_family_binary(26, Some(&[1, 2])), JsonValue::Null);
    }

    #[test]
    fn intervals_and_times_print_like_psql() {
        assert_eq!(format_interval(14, 3, 14_706_789_000), "1 year 2 mons 3 days 04:05:06.789");
        assert_eq!(format_interval(0, 1, 0), "1 day");
        assert_eq!(format_interval(0, 0, -1_500_000), "-00:00:01.5");
        assert_eq!(format_interval(0, 0, 0), "00:00:00");
        assert_eq!(format_time(Time::from_hms(12, 0, 0).unwrap()), "12:00:00");
        assert_eq!(format_time(Time::from_hms_micro(1, 2, 3, 450_000).unwrap()), "01:02:03.45");
    }

    #[test]
    fn text_format_values() {
        assert_eq!(text_to_json(Some(16), "t"), JsonValue::Bool(true));
        assert_eq!(text_to_json(Some(1700), "1.50"), JsonValue::String("1.50".into()));
        assert_eq!(text_to_json(Some(1700), "2.5"), serde_json::json!(2.5));
        assert_eq!(text_to_json(Some(20), "9223372036854775807"), JsonValue::String("9223372036854775807".into()));
        assert_eq!(text_to_json(Some(3802), "{\"a\": 1}"), serde_json::json!({"a": 1}));
        assert_eq!(text_to_json(Some(17), "\\x4869"), serde_json::json!([72, 105]));
        assert_eq!(text_to_json(Some(2205), "pg_class"), JsonValue::String("pg_class".into()));
        assert_eq!(text_to_json(None, "{a,b}"), JsonValue::String("{a,b}".into()));
    }

    #[test]
    fn empty_array_produces_empty_json_array() {
        let out: Vec<JsonValue> = int_vec_to_json::<i32>(vec![]);
        assert!(out.is_empty());
    }
}
