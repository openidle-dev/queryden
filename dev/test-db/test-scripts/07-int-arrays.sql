-- ============================================================================
-- ISSUE #27 TEST  ―  INT2[] / INT4[] / INT8[] result deserialization
-- ============================================================================
--
-- WHAT TO DO
--   1. Paste this whole file into a new QueryDen tab connected to the
--      `queryden_test` Postgres instance on localhost:5434.
--   2. Select all (Ctrl+A) and run with Ctrl+Enter.
--
-- BEFORE THE FIX
--   The final SELECT fails with "unsupported datatype: _INT4" (or the
--   INT2[] / INT8[] equivalent) and the results grid stays empty.
--
-- AFTER THE FIX
--   The grid renders two rows. Each integer-array column shows a JSON
--   array of numbers (e.g. `[1, 2, 3]`). NULL elements survive as `null`
--   inside the array. INT8 values beyond JavaScript's 2^53 safe-integer
--   range are emitted as JSON numbers — exactly how the scalar BIGINT
--   path already handles them today.
-- ============================================================================

-- Use a dedicated table so re-runs are idempotent: drop, recreate, refill.
DROP TABLE IF EXISTS app.int_arrays;

CREATE TABLE app.int_arrays (
    id       serial PRIMARY KEY,
    label    text     NOT NULL,
    smalls   int2[]   NOT NULL,
    ints     int4[]   NOT NULL,
    bigs     int8[]   NOT NULL
);

INSERT INTO app.int_arrays (label, smalls, ints, bigs) VALUES
    -- Basic case: small, positive, dense arrays.
    ('basic',
     ARRAY[1, 2, 3]::int2[],
     ARRAY[10, 20, 30]::int4[],
     ARRAY[100, 200, 300]::int8[]),

    -- Edge cases: type bounds, negatives, NULL elements, a value that
    -- exceeds JS Number.MAX_SAFE_INTEGER (2^53).
    ('edges',
     ARRAY[(-32768)::int2, 0::int2, NULL, 32767::int2],
     ARRAY[(-2147483648)::int4, 0::int4, NULL, 2147483647::int4],
     ARRAY[(-9223372036854775808)::int8, 0::int8, NULL,
           (1::int8 << 60), 9223372036854775807::int8]);

SELECT id, label, smalls, ints, bigs
FROM app.int_arrays
ORDER BY id;
