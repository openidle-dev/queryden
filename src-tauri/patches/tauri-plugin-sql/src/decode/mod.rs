// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use serde_json::Value as JsonValue;

#[cfg(feature = "mysql")]
pub(crate) mod mysql;
#[cfg(feature = "postgres")]
pub(crate) mod postgres;
#[cfg(feature = "sqlite")]
pub(crate) mod sqlite;

/// Largest integer magnitude JavaScript can represent exactly (`2^53 − 1`,
/// `Number.MAX_SAFE_INTEGER`). The Rust→JS boundary is JSON text parsed by
/// `JSON.parse`, which rounds anything beyond it to the nearest float64 —
/// e.g. Postgres `int8 -9223372036854775808` arrived as
/// `-9223372036854776000` (issue #41).
///
/// Contract: in-range integers stay JSON numbers (zero behavior change for
/// sorting, editing, type inference and copy); out-of-range integers are
/// emitted as JSON strings carrying exact digits. Frontend consumers must
/// treat those strings opaquely — never `Number()` them; `inferColumnType`
/// still classifies numeric strings as int/float, and generated
/// `WHERE id = '…'` works via implicit cast on all three engines.
pub(crate) const MAX_SAFE_JS_INT: i64 = (1_i64 << 53) - 1;

/// Encode a signed 64-bit integer for the JS boundary (see above).
pub(crate) fn int64_to_json(v: i64) -> JsonValue {
    if (-MAX_SAFE_JS_INT..=MAX_SAFE_JS_INT).contains(&v) {
        JsonValue::Number(v.into())
    } else {
        JsonValue::String(v.to_string())
    }
}

/// Encode an unsigned 64-bit integer for the JS boundary (MySQL
/// `BIGINT UNSIGNED` reaches 2^64−1, far beyond float64 precision).
pub(crate) fn uint64_to_json(v: u64) -> JsonValue {
    if v <= MAX_SAFE_JS_INT as u64 {
        JsonValue::Number(v.into())
    } else {
        JsonValue::String(v.to_string())
    }
}

/// A decimal rendered as text by the server (PostgreSQL numeric, MySQL
/// DECIMAL, float output). It becomes a JSON number only when that number
/// prints back to exactly the same text; otherwise the exact text is kept:
/// `1.50` (scale), `12345678901234567.89` (beyond f64), `NaN`, `Infinity`.
pub(crate) fn exact_number_or_string(text: &str) -> JsonValue {
    if let Ok(f) = text.parse::<f64>() {
        if f.is_finite() && f.to_string() == text {
            if let Some(n) = serde_json::Number::from_f64(f) {
                return JsonValue::Number(n);
            }
        }
    }
    JsonValue::String(text.to_string())
}

/// A float that may be NaN/±Infinity (JSON has no representation for them).
pub(crate) fn float_to_json(v: f64) -> JsonValue {
    if v.is_nan() {
        return JsonValue::String("NaN".into());
    }
    if v.is_infinite() {
        return JsonValue::String(if v > 0.0 { "Infinity" } else { "-Infinity" }.into());
    }
    serde_json::Number::from_f64(v).map(JsonValue::Number).unwrap_or(JsonValue::Null)
}

/// `bytes` as a JSON array of byte values — the contract the frontend's
/// binary preview expects for bytea / BLOB columns.
pub(crate) fn bytes_to_json(bytes: &[u8]) -> JsonValue {
    JsonValue::Array(bytes.iter().map(|b| JsonValue::Number((*b).into())).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimals_stay_exact() {
        assert_eq!(exact_number_or_string("123.45"), serde_json::json!(123.45));
        assert_eq!(exact_number_or_string("100"), serde_json::json!(100.0));
        assert_eq!(exact_number_or_string("1.50"), serde_json::json!("1.50"));
        assert_eq!(exact_number_or_string("12345678901234567.89"), serde_json::json!("12345678901234567.89"));
        assert_eq!(exact_number_or_string("NaN"), serde_json::json!("NaN"));
        assert_eq!(float_to_json(f64::INFINITY), serde_json::json!("Infinity"));
        assert_eq!(float_to_json(0.25), serde_json::json!(0.25));
    }

    #[test]
    fn safe_range_stays_json_number() {
        for v in [0, 1, -1, MAX_SAFE_JS_INT, -MAX_SAFE_JS_INT] {
            let out = int64_to_json(v);
            assert!(out.is_number(), "expected number for {v}, got {out:?}");
            assert_eq!(out.as_i64(), Some(v));
        }
        let out = uint64_to_json(MAX_SAFE_JS_INT as u64);
        assert!(out.is_number());
    }

    #[test]
    fn out_of_range_becomes_exact_digit_string() {
        // The exact repro from #41: int8 minimum must survive digit-for-digit.
        for v in [MAX_SAFE_JS_INT + 1, -(MAX_SAFE_JS_INT + 1), i64::MIN, i64::MAX] {
            let out = int64_to_json(v);
            assert_eq!(out.as_str(), Some(v.to_string()).as_deref(), "got {out:?}");
        }
        assert_eq!(uint64_to_json(u64::MAX).as_str(), Some(u64::MAX.to_string()).as_deref());
        // Boundary symmetry: MAX_SAFE itself is still a number.
        assert!(int64_to_json(MAX_SAFE_JS_INT).is_number());
    }
}
