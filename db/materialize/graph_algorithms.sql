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


-- =============================================================================
-- THE MUTUAL RECURSION PROBLEM
-- =============================================================================
--
-- We want to find orders that can be bundled together, but:
--   1. Orders can only be bundled if they don't have inventory conflicts
--   2. Inventory conflicts can propagate THROUGH bundles
--   3. Whether something is a valid bundle depends on conflicts
--   4. Whether something is a conflict depends on bundles
--
-- This creates a chicken-and-egg problem that standard SQL cannot solve!
--
-- Datalog rules:
--   can_bundle(O1, O2) :- same_store(O1, O2), compatible_time(O1, O2),
--                         NOT has_conflict(O1, O2).
--   can_bundle(O1, O3) :- can_bundle(O1, O2), can_bundle(O2, O3),
--                         NOT has_conflict(O1, O3).
--   has_conflict(O1, O2) :- shares_product(O1, O2, P), insufficient_stock(P).
--   has_conflict(O1, O3) :- has_conflict(O1, O2), can_bundle(O2, O3).
--
-- Notice: can_bundle references has_conflict, has_conflict references can_bundle
-- This is MUTUAL RECURSION - impossible in standard SQL!
-- =============================================================================


-- =============================================================================
-- DELIVERY BUNDLES WITH CONFLICT DETECTION
-- =============================================================================

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

CREATE INDEX IF NOT EXISTS delivery_bundles_store_idx
    IN CLUSTER serving ON delivery_bundles_mv (store_id);

CREATE INDEX IF NOT EXISTS delivery_bundles_order_idx
    IN CLUSTER serving ON delivery_bundles_mv (order_a);

CREATE INDEX IF NOT EXISTS delivery_bundles_conflict_idx
    IN CLUSTER serving ON delivery_bundles_mv (has_conflict);


-- =============================================================================
-- WHY THIS MATTERS
-- =============================================================================
--
-- 1. STANDARD SQL CANNOT DO THIS
--    WITH RECURSIVE only allows a CTE to reference itself, not other CTEs.
--    You'd need multiple queries, application logic, or stored procedures.
--
-- 2. DATALOG SEMANTICS
--    Materialize evaluates all CTEs together until reaching a fixed point.
--    Changes ripple through automatically - if a bundle becomes invalid,
--    all dependent computations update.
--
-- 3. INCREMENTAL MAINTENANCE
--    As orders come in or inventory changes, Materialize incrementally
--    updates the bundles and conflicts without recomputing everything.
--
-- 4. REAL-TIME CONSISTENCY
--    The mutual recursion ensures bundles and conflicts are always
--    consistent with each other - no race conditions or stale data.
--
-- =============================================================================


-- =============================================================================
-- EXAMPLE QUERIES
-- =============================================================================
--
-- Find all valid bundles (no conflicts):
--   SELECT * FROM delivery_bundles_mv
--   WHERE has_conflict = FALSE
--   ORDER BY store_id, bundle_size DESC;
--
-- Find bundles with inventory conflicts:
--   SELECT * FROM delivery_bundles_mv
--   WHERE has_conflict = TRUE;
--
-- Find the largest possible bundles:
--   SELECT store_id, MAX(bundle_size) as max_bundle
--   FROM delivery_bundles_mv
--   WHERE has_conflict = FALSE
--   GROUP BY store_id;
--
-- =============================================================================
