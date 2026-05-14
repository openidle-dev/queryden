-- Seed data for the QueryDen test database. Modest size: enough to make
-- joins/aggregations meaningful, small enough to load in <1s.

BEGIN;

-- 20 users
INSERT INTO app.users (email, full_name, metadata) VALUES
    ('alice@example.com',    'Alice Anderson',    '{"role": "admin",    "tier": "gold"}'::jsonb),
    ('bob@example.com',      'Bob Brown',         '{"role": "customer", "tier": "silver"}'::jsonb),
    ('carol@example.com',    'Carol Chen',        '{"role": "customer", "tier": "bronze"}'::jsonb),
    ('dave@example.com',     'Dave Davies',       '{"role": "customer", "tier": "silver"}'::jsonb),
    ('eve@example.com',      'Eve Edwards',       '{"role": "support",  "tier": "n/a"}'::jsonb),
    ('frank@example.com',    'Frank Fischer',     '{"role": "customer", "tier": "gold"}'::jsonb),
    ('grace@example.com',    'Grace Garcia',      '{"role": "customer", "tier": "bronze"}'::jsonb),
    ('hank@example.com',     'Hank Hughes',       '{"role": "customer", "tier": "silver"}'::jsonb),
    ('iris@example.com',     'Iris Ingram',       '{"role": "customer", "tier": "bronze"}'::jsonb),
    ('jack@example.com',     'Jack Johnson',      '{"role": "customer", "tier": "gold"}'::jsonb),
    ('kate@example.com',     'Kate Kelly',        '{"role": "customer", "tier": "silver"}'::jsonb),
    ('liam@example.com',     'Liam Lopez',        '{"role": "customer", "tier": "bronze"}'::jsonb),
    ('mia@example.com',      'Mia Martinez',      '{"role": "customer", "tier": "gold"}'::jsonb),
    ('nora@example.com',     'Nora Nguyen',       '{"role": "customer", "tier": "silver"}'::jsonb),
    ('oscar@example.com',    'Oscar Olsen',       '{"role": "customer", "tier": "bronze"}'::jsonb),
    ('paula@example.com',    'Paula Patel',       '{"role": "customer", "tier": "silver"}'::jsonb),
    ('quinn@example.com',    'Quinn Quintero',    '{"role": "customer", "tier": "gold"}'::jsonb),
    ('rachel@example.com',   'Rachel Rivera',     '{"role": "customer", "tier": "silver"}'::jsonb),
    ('sam@example.com',      'Sam Singh',         '{"role": "customer", "tier": "bronze"}'::jsonb),
    ('tina@example.com',     'Tina Tanaka',       '{"role": "customer", "tier": "gold"}'::jsonb);

-- 30 products
INSERT INTO app.products (sku, name, description, price, attributes) VALUES
    ('SKU-A001', 'Stainless Steel Water Bottle',  '32oz double-walled vacuum insulated',     24.99, '{"color": "silver",  "weight_g": 380}'::jsonb),
    ('SKU-A002', 'Bamboo Cutting Board',          'Large, edge-grain, food-safe oil finish', 39.50, '{"color": "natural", "size":  "L"}'::jsonb),
    ('SKU-A003', 'Ceramic Pour-Over Dripper',     'Single-cup, made in Japan',               18.00, '{"color": "white",   "capacity_ml": 350}'::jsonb),
    ('SKU-A004', 'Cast Iron Skillet 10"',         'Pre-seasoned, lifetime warranty',         32.75, '{"weight_g": 2100}'::jsonb),
    ('SKU-A005', 'French Press 1L',               'Borosilicate glass, stainless mesh',      29.00, '{"capacity_ml": 1000}'::jsonb),
    ('SKU-B001', 'Mechanical Keyboard 65%',       'Hot-swappable, tactile switches',        129.00, '{"layout": "ANSI", "switches": "tactile"}'::jsonb),
    ('SKU-B002', 'USB-C Hub 7-in-1',              'HDMI, SD, 3x USB-A, PD pass-through',     45.99, '{"ports": 7}'::jsonb),
    ('SKU-B003', 'Wireless Mouse',                'Ergonomic, 4-month battery',              59.00, '{"dpi": "4000", "buttons": 6}'::jsonb),
    ('SKU-B004', 'External SSD 1TB',              'NVMe, USB 3.2 Gen 2, 1050 MB/s',         115.00, '{"capacity_gb": 1024, "interface": "USB-C"}'::jsonb),
    ('SKU-B005', 'Monitor Arm',                   'Single, gas-spring, VESA 75/100',         85.00, '{"max_screen_inches": 32}'::jsonb),
    ('SKU-C001', 'Linen Throw Blanket',           '50x60, stonewashed',                      62.00, '{"color": "oatmeal", "material": "linen"}'::jsonb),
    ('SKU-C002', 'Wool Throw',                    'Merino, ribbed weave',                    89.00, '{"color": "charcoal", "material": "wool"}'::jsonb),
    ('SKU-C003', 'Aroma Diffuser',                'Ultrasonic, 300ml, ambient light',        34.00, '{"capacity_ml": 300}'::jsonb),
    ('SKU-C004', 'Beeswax Candle',                'Hand-poured, 60-hour burn',               18.50, '{"burn_hours": 60}'::jsonb),
    ('SKU-C005', 'Sheepskin Rug',                 '2x3 ft, naturally tanned',               140.00, '{"size": "2x3"}'::jsonb),
    ('SKU-D001', 'Hiking Backpack 30L',           'Daypack, rain cover included',           110.00, '{"capacity_l": 30}'::jsonb),
    ('SKU-D002', 'Trail Running Shoes',           'Lugged sole, drainage panels',           125.00, '{"sizes": [8,9,10,11,12]}'::jsonb),
    ('SKU-D003', 'Headlamp Rechargeable',         '350 lumens, 15h on low',                  42.00, '{"lumens": 350}'::jsonb),
    ('SKU-D004', 'Camp Stove',                    'Single burner, canister mount',           58.00, '{"weight_g": 130}'::jsonb),
    ('SKU-D005', 'Sleeping Bag 0°C',              'Mummy cut, synthetic insulation',        180.00, '{"rating_c": 0}'::jsonb),
    ('SKU-E001', 'Hardcover Notebook',            '240 pages, dotted, A5',                   24.00, '{"pages": 240}'::jsonb),
    ('SKU-E002', 'Fountain Pen',                  'Medium nib, piston filler',               72.00, '{"nib": "M"}'::jsonb),
    ('SKU-E003', 'Ink Bottle 50ml',               'Saturated, fast-drying',                  18.00, '{"color": "midnight blue"}'::jsonb),
    ('SKU-E004', 'Desk Lamp',                     'Dimmable LED, color temp shift',          78.00, '{"max_lumens": 800}'::jsonb),
    ('SKU-E005', 'Pencil Case',                   'Roll-up, canvas, leather tie',            32.00, '{"material": "canvas"}'::jsonb),
    ('SKU-F001', 'Espresso Beans 250g',           'Single origin, light roast',              16.00, '{"weight_g": 250, "origin": "Ethiopia"}'::jsonb),
    ('SKU-F002', 'Tea Sampler',                   'Six 50g tins, loose leaf',                48.00, '{"count": 6}'::jsonb),
    ('SKU-F003', 'Dark Chocolate Bar',            '85% cacao, 100g',                          9.50, '{"cacao_pct": 85}'::jsonb),
    ('SKU-F004', 'Olive Oil 500ml',               'Extra virgin, first cold press',          22.00, '{"capacity_ml": 500}'::jsonb),
    ('SKU-F005', 'Sea Salt Flakes',               'Hand-harvested, flaky',                   12.00, '{"weight_g": 120}'::jsonb);

-- 50 orders with varied statuses, distributed across users
INSERT INTO app.orders (user_id, status, total, created_at, shipped_at)
SELECT
    1 + (n % 20),
    CASE n % 6
        WHEN 0 THEN 'pending'::app.order_status
        WHEN 1 THEN 'paid'::app.order_status
        WHEN 2 THEN 'shipped'::app.order_status
        WHEN 3 THEN 'delivered'::app.order_status
        WHEN 4 THEN 'cancelled'::app.order_status
        ELSE 'refunded'::app.order_status
    END,
    0,  -- backfilled by the order_items insert below
    NOW() - (n || ' days')::interval,
    CASE WHEN n % 6 IN (2, 3) THEN NOW() - ((n - 1) || ' days')::interval ELSE NULL END
FROM generate_series(1, 50) AS gs(n);

-- 200 order items distributed across the 50 orders
INSERT INTO app.order_items (order_id, product_id, qty, unit_price)
SELECT
    1 + (gs.n % 50),                   -- order 1..50
    1 + ((gs.n * 7) % 30),             -- pseudo-random product 1..30
    1 + ((gs.n * 3) % 4),              -- qty 1..4
    p.price
FROM generate_series(1, 200) AS gs(n)
JOIN app.products p ON p.id = 1 + ((gs.n * 7) % 30);

-- Backfill order totals from items
UPDATE app.orders o
SET total = sub.total
FROM (
    SELECT order_id, SUM(qty * unit_price) AS total
    FROM app.order_items
    GROUP BY order_id
) sub
WHERE o.id = sub.order_id;

COMMIT;
