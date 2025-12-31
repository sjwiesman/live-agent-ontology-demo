-- Materialize Initialization Script (Three-Tier Architecture)
-- Sets up PostgreSQL source connection, clusters, views, and indexes
-- Run this after Materialize starts: psql -h localhost -p 6875 -U materialize -f init_materialize.sql
--
-- Architecture:
--   ingest cluster  -> Sources (PostgreSQL logical replication)
--   compute cluster -> Materialized views (persist transformation results)
--   serving cluster -> Indexes (serve queries with low latency)
--
-- Pattern:
--   - Regular views for intermediate transformations (no cluster)
--   - Materialized views IN CLUSTER compute for "topmost" views that serve results
--   - Indexes IN CLUSTER serving ON materialized views

-- =============================================================================
-- Create secret for PostgreSQL password
-- =============================================================================
CREATE SECRET IF NOT EXISTS pgpass AS 'postgres';

-- =============================================================================
-- Create connection to PostgreSQL
-- =============================================================================
CREATE CONNECTION IF NOT EXISTS pg_connection TO POSTGRES (
    HOST 'db',
    PORT 5432,
    USER 'postgres',
    PASSWORD SECRET pgpass,
    DATABASE 'freshmart'
);

-- =============================================================================
-- Create source from PostgreSQL in ingest cluster
-- (requires publication 'mz_source' to exist in PostgreSQL)
-- =============================================================================
CREATE SOURCE IF NOT EXISTS pg_source
    IN CLUSTER ingest
    FROM POSTGRES CONNECTION pg_connection (PUBLICATION 'mz_source')
    FOR ALL TABLES;

-- =============================================================================
-- Regular Views for Intermediate Transformations
-- These are logical definitions - no cluster specified
-- =============================================================================
CREATE VIEW IF NOT EXISTS customers_flat AS
SELECT
    subject_id AS customer_id,
    MAX(CASE WHEN predicate = 'customer_name' THEN object_value END) AS customer_name,
    MAX(CASE WHEN predicate = 'customer_email' THEN object_value END) AS customer_email,
    MAX(CASE WHEN predicate = 'customer_address' THEN object_value END) AS customer_address,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'customer:%'
GROUP BY subject_id;

CREATE VIEW IF NOT EXISTS stores_flat AS
SELECT
    subject_id AS store_id,
    MAX(CASE WHEN predicate = 'store_name' THEN object_value END) AS store_name,
    MAX(CASE WHEN predicate = 'store_zone' THEN object_value END) AS store_zone,
    MAX(CASE WHEN predicate = 'store_address' THEN object_value END) AS store_address,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'store:%'
GROUP BY subject_id;

CREATE VIEW IF NOT EXISTS delivery_tasks_flat AS
SELECT
    subject_id AS task_id,
    MAX(CASE WHEN predicate = 'task_of_order' THEN object_value END) AS order_id,
    MAX(CASE WHEN predicate = 'assigned_to' THEN object_value END) AS assigned_courier_id,
    MAX(CASE WHEN predicate = 'task_status' THEN object_value END) AS task_status,
    MAX(CASE WHEN predicate = 'eta' THEN object_value END) AS eta,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'task:%'
GROUP BY subject_id;

-- =============================================================================
-- Materialized Views IN CLUSTER compute
-- These are the "topmost" views that persist results for serving
-- =============================================================================
CREATE MATERIALIZED VIEW IF NOT EXISTS orders_flat_mv IN CLUSTER compute AS
SELECT
    subject_id AS order_id,
    MAX(CASE WHEN predicate = 'order_number' THEN object_value END) AS order_number,
    MAX(CASE WHEN predicate = 'order_status' THEN object_value END) AS order_status,
    MAX(CASE WHEN predicate = 'order_store' THEN object_value END) AS store_id,
    MAX(CASE WHEN predicate = 'placed_by' THEN object_value END) AS customer_id,
    MAX(CASE WHEN predicate = 'delivery_window_start' THEN object_value END) AS delivery_window_start,
    MAX(CASE WHEN predicate = 'delivery_window_end' THEN object_value END) AS delivery_window_end,
    MAX(CASE WHEN predicate = 'order_total_amount' THEN object_value END)::DECIMAL(10,2) AS order_total_amount,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'order:%'
GROUP BY subject_id;

-- Products flat view (needed for inventory enrichment)
CREATE VIEW IF NOT EXISTS products_flat AS
SELECT
    subject_id AS product_id,
    MAX(CASE WHEN predicate = 'product_name' THEN object_value END) AS product_name,
    MAX(CASE WHEN predicate = 'category' THEN object_value END) AS category,
    MAX(CASE WHEN predicate = 'unit_price' THEN object_value END)::DECIMAL(10,2) AS unit_price,
    MAX(CASE WHEN predicate = 'perishable' THEN object_value END)::BOOLEAN AS perishable,
    MAX(CASE WHEN predicate = 'unit_weight_grams' THEN object_value END)::INT AS unit_weight_grams,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'product:%'
GROUP BY subject_id;

-- Materialized view with product and store enrichment for OpenSearch
-- Drop first to ensure schema updates are applied
DROP MATERIALIZED VIEW IF EXISTS store_inventory_mv CASCADE;
CREATE MATERIALIZED VIEW store_inventory_mv IN CLUSTER compute AS
SELECT
    inv.inventory_id,
    inv.store_id,
    inv.product_id,
    inv.stock_level,
    inv.replenishment_eta,
    inv.effective_updated_at,
    -- Product details
    p.product_name,
    p.category,
    p.unit_price,
    p.perishable,
    p.unit_weight_grams,
    -- Store details
    s.store_name,
    s.store_zone,
    s.store_address,
    -- Availability flags
    CASE
        WHEN inv.stock_level > 10 THEN 'IN_STOCK'
        WHEN inv.stock_level > 0 THEN 'LOW_STOCK'
        ELSE 'OUT_OF_STOCK'
    END AS availability_status,
    (inv.stock_level <= 10 AND inv.stock_level > 0) AS low_stock
FROM (
    SELECT
        subject_id AS inventory_id,
        MAX(CASE WHEN predicate = 'inventory_store' THEN object_value END) AS store_id,
        MAX(CASE WHEN predicate = 'inventory_product' THEN object_value END) AS product_id,
        MAX(CASE WHEN predicate = 'stock_level' THEN object_value END)::INT AS stock_level,
        MAX(CASE WHEN predicate = 'replenishment_eta' THEN object_value END) AS replenishment_eta,
        MAX(updated_at) AS effective_updated_at
    FROM triples
    WHERE subject_id LIKE 'inventory:%'
    GROUP BY subject_id
) inv
LEFT JOIN products_flat p ON p.product_id = inv.product_id
LEFT JOIN stores_flat s ON s.store_id = inv.store_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS orders_search_source_mv IN CLUSTER compute AS
SELECT
    o.order_id,
    o.order_number,
    o.order_status,
    o.store_id,
    o.customer_id,
    o.delivery_window_start,
    o.delivery_window_end,
    o.order_total_amount,
    c.customer_name,
    c.customer_email,
    c.customer_address,
    s.store_name,
    s.store_zone,
    s.store_address,
    dt.assigned_courier_id,
    dt.task_status AS delivery_task_status,
    dt.eta AS delivery_eta,
    GREATEST(o.effective_updated_at, c.effective_updated_at, s.effective_updated_at, dt.effective_updated_at) AS effective_updated_at
FROM orders_flat_mv o
LEFT JOIN customers_flat c ON c.customer_id = o.customer_id
LEFT JOIN stores_flat s ON s.store_id = o.store_id
LEFT JOIN delivery_tasks_flat dt ON dt.order_id = o.order_id;

-- Order timestamps view for joining with tasks
CREATE VIEW IF NOT EXISTS order_timestamps AS
SELECT
    subject_id AS order_id,
    MAX(CASE WHEN predicate = 'order_created_at' THEN object_value END) AS order_created_at,
    MAX(CASE WHEN predicate = 'delivered_at' THEN object_value END) AS delivered_at
FROM triples
WHERE subject_id LIKE 'order:%'
GROUP BY subject_id;

-- Courier tasks intermediate view
CREATE VIEW IF NOT EXISTS courier_tasks_flat AS
SELECT
    t_assigned.object_value AS courier_id,
    t_task.subject_id AS task_id,
    MAX(CASE WHEN t_task.predicate = 'task_status' THEN t_task.object_value END) AS task_status,
    MAX(CASE WHEN t_task.predicate = 'task_of_order' THEN t_task.object_value END) AS order_id,
    MAX(CASE WHEN t_task.predicate = 'eta' THEN t_task.object_value END) AS eta,
    MAX(CASE WHEN t_task.predicate = 'route_sequence' THEN t_task.object_value END)::INT AS route_sequence
FROM triples t_assigned
JOIN triples t_task ON t_task.subject_id = t_assigned.subject_id
WHERE t_assigned.predicate = 'assigned_to'
    AND t_assigned.object_type = 'entity_ref'
GROUP BY t_assigned.object_value, t_task.subject_id;

-- Courier tasks with order timestamps
CREATE VIEW IF NOT EXISTS courier_tasks_with_timestamps AS
SELECT
    ct.courier_id,
    ct.task_id,
    ct.task_status,
    ct.order_id,
    ct.eta,
    ct.route_sequence,
    ot.order_created_at,
    ot.delivered_at,
    CASE
        WHEN ot.delivered_at IS NOT NULL AND ot.order_created_at IS NOT NULL
        THEN EXTRACT(EPOCH FROM (ot.delivered_at::TIMESTAMPTZ - ot.order_created_at::TIMESTAMPTZ)) / 60
        ELSE NULL
    END AS wait_time_minutes
FROM courier_tasks_flat ct
LEFT JOIN order_timestamps ot ON ot.order_id = ct.order_id;

-- Couriers flat intermediate view
CREATE VIEW IF NOT EXISTS couriers_flat AS
SELECT
    subject_id AS courier_id,
    MAX(CASE WHEN predicate = 'courier_name' THEN object_value END) AS courier_name,
    MAX(CASE WHEN predicate = 'courier_home_store' THEN object_value END) AS home_store_id,
    MAX(CASE WHEN predicate = 'vehicle_type' THEN object_value END) AS vehicle_type,
    MAX(CASE WHEN predicate = 'courier_status' THEN object_value END) AS courier_status,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'courier:%'
GROUP BY subject_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS courier_schedule_mv IN CLUSTER compute AS
SELECT
    cf.courier_id,
    cf.courier_name,
    cf.home_store_id,
    cf.vehicle_type,
    cf.courier_status,
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'task_id', ct.task_id,
                'task_status', ct.task_status,
                'order_id', ct.order_id,
                'eta', ct.eta,
                'wait_time_minutes', ct.wait_time_minutes,
                'order_created_at', ct.order_created_at
            )
        ) FILTER (WHERE ct.task_id IS NOT NULL),
        '[]'::jsonb
    ) AS tasks,
    cf.effective_updated_at
FROM couriers_flat cf
LEFT JOIN courier_tasks_with_timestamps ct ON ct.courier_id = cf.courier_id
GROUP BY cf.courier_id, cf.courier_name, cf.home_store_id, cf.vehicle_type, cf.courier_status, cf.effective_updated_at;

-- Materialized view for stores (for direct store queries)
CREATE MATERIALIZED VIEW IF NOT EXISTS stores_mv IN CLUSTER compute AS
SELECT
    subject_id AS store_id,
    MAX(CASE WHEN predicate = 'store_name' THEN object_value END) AS store_name,
    MAX(CASE WHEN predicate = 'store_zone' THEN object_value END) AS store_zone,
    MAX(CASE WHEN predicate = 'store_address' THEN object_value END) AS store_address,
    MAX(CASE WHEN predicate = 'store_status' THEN object_value END) AS store_status,
    MAX(CASE WHEN predicate = 'store_capacity_orders_per_hour' THEN object_value END)::INT AS store_capacity_orders_per_hour,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'store:%'
GROUP BY subject_id;

-- Materialized view for customers (for direct customer queries)
CREATE MATERIALIZED VIEW IF NOT EXISTS customers_mv IN CLUSTER compute AS
SELECT
    subject_id AS customer_id,
    MAX(CASE WHEN predicate = 'customer_name' THEN object_value END) AS customer_name,
    MAX(CASE WHEN predicate = 'customer_email' THEN object_value END) AS customer_email,
    MAX(CASE WHEN predicate = 'customer_address' THEN object_value END) AS customer_address,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'customer:%'
GROUP BY subject_id;

-- =============================================================================
-- Indexes IN CLUSTER serving ON materialized views
-- These make the materialized views queryable with low latency
-- =============================================================================
CREATE INDEX IF NOT EXISTS orders_flat_idx IN CLUSTER serving ON orders_flat_mv (order_id);
CREATE INDEX IF NOT EXISTS store_inventory_idx IN CLUSTER serving ON store_inventory_mv (inventory_id);
CREATE INDEX IF NOT EXISTS orders_search_source_idx IN CLUSTER serving ON orders_search_source_mv (order_id);
CREATE INDEX IF NOT EXISTS courier_schedule_idx IN CLUSTER serving ON courier_schedule_mv (courier_id);
CREATE INDEX IF NOT EXISTS stores_idx IN CLUSTER serving ON stores_mv (store_id);
CREATE INDEX IF NOT EXISTS customers_idx IN CLUSTER serving ON customers_mv (customer_id);


-- =============================================================================
-- DELIVERY BUNDLING WITH MUTUAL RECURSION
-- =============================================================================
-- Demonstrates Materialize's WITH MUTUALLY RECURSIVE - a capability that goes
-- beyond standard SQL recursive CTEs and implements true Datalog semantics.
--
-- KEY INSIGHT: Standard SQL WITH RECURSIVE only allows self-reference.
-- Materialize allows multiple CTEs to reference EACH OTHER simultaneously.
--
-- This algorithm finds orders that can be bundled for delivery while detecting
-- inventory conflicts that would prevent bundling - and these two computations
-- depend on each other in a way that requires mutual recursion.
-- =============================================================================

-- Order lines flat view needed for delivery bundling
CREATE VIEW IF NOT EXISTS order_lines_flat AS
SELECT
    subject_id AS line_id,
    MAX(CASE WHEN predicate = 'line_of_order' THEN object_value END) AS order_id,
    MAX(CASE WHEN predicate = 'line_product' THEN object_value END) AS product_id,
    MAX(CASE WHEN predicate = 'line_quantity' THEN object_value END)::INT AS quantity,
    MAX(CASE WHEN predicate = 'line_unit_price' THEN object_value END)::DECIMAL(10,2) AS unit_price,
    MAX(CASE WHEN predicate = 'line_amount' THEN object_value END)::DECIMAL(10,2) AS line_amount,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'line:%'
GROUP BY subject_id;

-- Delivery bundles with conflict detection using mutual recursion
CREATE MATERIALIZED VIEW IF NOT EXISTS delivery_bundles_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    -- =========================================================================
    -- CTE 1: INVENTORY CONFLICTS
    -- Orders that compete for the same scarce inventory
    -- REFERENCES: bundle_candidates (for transitive conflict propagation)
    -- =========================================================================
    inventory_conflicts(order_a TEXT, order_b TEXT, product_id TEXT, available_stock INT, total_needed INT) AS (
        -- Base case: direct conflicts
        -- Two orders want the same product but store doesn't have enough for both
        SELECT
            ol1.order_id AS order_a,
            ol2.order_id AS order_b,
            ol1.product_id,
            inv.stock_level AS available_stock,
            (ol1.quantity + ol2.quantity)::INT AS total_needed
        FROM order_lines_flat ol1
        JOIN order_lines_flat ol2
            ON ol1.product_id = ol2.product_id
            AND ol1.order_id < ol2.order_id  -- Avoid duplicates
        JOIN orders_flat_mv o1 ON o1.order_id = ol1.order_id
        JOIN orders_flat_mv o2 ON o2.order_id = ol2.order_id
        JOIN store_inventory_mv inv
            ON inv.product_id = ol1.product_id
            AND inv.store_id = o1.store_id
        WHERE o1.store_id = o2.store_id           -- Same store
            AND o1.order_status = 'CREATED'        -- Only active orders
            AND o2.order_status = 'CREATED'
            AND inv.stock_level < (ol1.quantity + ol2.quantity)  -- NOT ENOUGH!

        UNION

        -- Transitive conflicts: if A conflicts with B, and B is bundled with C,
        -- then the conflict propagates to affect A-C relationship too!
        --
        -- THIS IS THE MUTUAL REFERENCE: conflicts depend on bundles
        SELECT DISTINCT
            ic.order_a,
            bc.order_b,
            ic.product_id,
            ic.available_stock,
            ic.total_needed
        FROM inventory_conflicts ic
        JOIN bundle_candidates bc ON bc.order_a = ic.order_b
        WHERE ic.order_a != bc.order_b
            AND ic.available_stock < ic.total_needed
    ),

    -- =========================================================================
    -- CTE 2: BUNDLE CANDIDATES
    -- Orders that can potentially be delivered together
    -- REFERENCES: inventory_conflicts (to exclude conflicting pairs)
    -- =========================================================================
    bundle_candidates(order_a TEXT, order_b TEXT, store_id TEXT, bundle_size INT) AS (
        -- Base case: pairs of orders that could be bundled
        SELECT
            o1.order_id AS order_a,
            o2.order_id AS order_b,
            o1.store_id,
            2 AS bundle_size
        FROM orders_flat_mv o1
        JOIN orders_flat_mv o2
            ON o1.store_id = o2.store_id
            AND o1.order_id < o2.order_id
            AND o1.order_status = 'CREATED'
            AND o2.order_status = 'CREATED'
        -- Time windows must overlap (can deliver together)
        WHERE o1.delivery_window_start::timestamptz <= o2.delivery_window_end::timestamptz
            AND o1.delivery_window_end::timestamptz >= o2.delivery_window_start::timestamptz
        -- THIS IS THE MUTUAL REFERENCE: bundles exclude conflicts
        AND NOT EXISTS (
            SELECT 1 FROM inventory_conflicts ic
            WHERE ic.order_a = o1.order_id AND ic.order_b = o2.order_id
        )

        UNION

        -- Extend bundles: grow the bundle by adding more orders
        SELECT DISTINCT
            bc.order_a,
            o.order_id AS order_b,
            bc.store_id,
            bc.bundle_size + 1
        FROM bundle_candidates bc
        JOIN orders_flat_mv o
            ON o.store_id = bc.store_id
            AND o.order_id > bc.order_b
            AND o.order_status = 'CREATED'
        WHERE bc.bundle_size < 5  -- Max 5 orders per bundle
            -- No conflicts with any existing order in the bundle
            AND NOT EXISTS (
                SELECT 1 FROM inventory_conflicts ic
                WHERE (ic.order_a = bc.order_a AND ic.order_b = o.order_id)
                   OR (ic.order_a = bc.order_b AND ic.order_b = o.order_id)
            )
    )
-- Final output: all bundles with their conflict status
SELECT
    bc.order_a,
    bc.order_b,
    bc.store_id,
    bc.bundle_size,
    CASE WHEN ic.order_a IS NOT NULL THEN TRUE ELSE FALSE END AS has_conflict,
    ic.product_id AS conflict_product,
    ic.available_stock,
    ic.total_needed
FROM bundle_candidates bc
LEFT JOIN inventory_conflicts ic
    ON ic.order_a = bc.order_a AND ic.order_b = bc.order_b;

-- Indexes for delivery bundles
CREATE INDEX IF NOT EXISTS delivery_bundles_store_idx
    IN CLUSTER serving ON delivery_bundles_mv (store_id);

CREATE INDEX IF NOT EXISTS delivery_bundles_order_idx
    IN CLUSTER serving ON delivery_bundles_mv (order_a);

CREATE INDEX IF NOT EXISTS delivery_bundles_conflict_idx
    IN CLUSTER serving ON delivery_bundles_mv (has_conflict);
