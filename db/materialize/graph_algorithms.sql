-- =============================================================================
-- Graph Algorithms and Datalog-Style Rules for Materialize
-- =============================================================================
-- This file demonstrates truly mutually recursive algorithms using
-- Materialize's WITH MUTUALLY RECURSIVE feature.
--
-- Key difference from SQL'99 WITH RECURSIVE:
-- - Multiple CTEs can reference EACH OTHER (not just self-reference)
-- - Supports non-monotonic operations (aggregations in recursion)
-- - Fixed-point semantics like Datalog
--
-- Algorithms implemented:
-- 1. Customer Cohorts (Bidirectional Reachability / SCC-like)
-- 2. Influence Network (PageRank-style mutual scoring)
-- 3. Delivery Bundling with Conflict Detection
-- =============================================================================


-- =============================================================================
-- SUPPORTING VIEWS
-- =============================================================================

-- Customer-Product purchase graph (edges)
CREATE VIEW IF NOT EXISTS customer_product_edges AS
SELECT DISTINCT
    o.customer_id,
    ol.product_id,
    o.order_id,
    o.store_id
FROM orders_flat_mv o
JOIN order_lines_flat ol ON ol.order_id = o.order_id
WHERE o.order_status NOT IN ('CANCELLED');

-- Customer-to-customer connections via shared products
CREATE VIEW IF NOT EXISTS customer_connections AS
SELECT
    cp1.customer_id AS customer_a,
    cp2.customer_id AS customer_b,
    COUNT(DISTINCT cp1.product_id) AS shared_products,
    ARRAY_AGG(DISTINCT cp1.product_id) AS via_products
FROM customer_product_edges cp1
JOIN customer_product_edges cp2
    ON cp1.product_id = cp2.product_id
    AND cp1.customer_id < cp2.customer_id
GROUP BY cp1.customer_id, cp2.customer_id
HAVING COUNT(DISTINCT cp1.product_id) >= 1;

-- Store risk levels (base for risk propagation)
CREATE VIEW IF NOT EXISTS store_risk_levels AS
SELECT
    s.store_id,
    s.store_name,
    s.store_status,
    s.store_capacity_orders_per_hour,
    COUNT(o.order_id) AS active_orders,
    CASE
        WHEN s.store_status = 'CLOSED' THEN 'CRITICAL'
        WHEN s.store_status = 'LIMITED' THEN 'HIGH'
        WHEN COUNT(o.order_id) > s.store_capacity_orders_per_hour * 0.9 THEN 'HIGH'
        WHEN COUNT(o.order_id) > s.store_capacity_orders_per_hour * 0.7 THEN 'MEDIUM'
        ELSE 'LOW'
    END AS risk_level
FROM stores_mv s
LEFT JOIN orders_flat_mv o
    ON o.store_id = s.store_id
    AND o.order_status IN ('CREATED', 'PICKING')
GROUP BY s.store_id, s.store_name, s.store_status, s.store_capacity_orders_per_hour;


-- =============================================================================
-- 1. CUSTOMER COHORTS (Bidirectional Reachability)
-- =============================================================================
-- Find strongly connected customer groups where customers are mutually
-- reachable through shared purchase patterns.
--
-- This uses TRUE mutual recursion: forward and backward CTEs reference
-- each other to compute bidirectional reachability simultaneously.
--
-- Datalog equivalent:
--   forward(A, B) :- edge(A, B).
--   forward(A, C) :- forward(A, B), edge(B, C).
--   backward(A, B) :- edge(B, A).
--   backward(A, C) :- backward(A, B), edge(C, B).
--   same_cohort(A, B) :- forward(A, B), backward(A, B).
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS customer_cohorts_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    -- Forward reachability: can customer A reach customer B?
    forward_reach(from_customer TEXT, to_customer TEXT, hops INT) AS (
        -- Base case: direct connection
        SELECT customer_a, customer_b, 1
        FROM customer_connections
        WHERE shared_products >= 2
        UNION
        SELECT customer_b, customer_a, 1
        FROM customer_connections
        WHERE shared_products >= 2
        UNION
        -- Recursive: extend through the graph
        -- MUTUAL: uses backward_reach to prioritize paths that have backward potential
        SELECT DISTINCT
            f.from_customer,
            cc.customer_b,
            f.hops + 1
        FROM forward_reach f
        JOIN customer_connections cc
            ON f.to_customer = cc.customer_a
            AND cc.shared_products >= 2
        WHERE f.hops < 3
            AND f.from_customer != cc.customer_b
            -- Prune paths that won't lead to mutual reachability
            AND EXISTS (
                SELECT 1 FROM backward_reach b
                WHERE b.from_customer = f.from_customer
            )
        UNION
        SELECT DISTINCT
            f.from_customer,
            cc.customer_a,
            f.hops + 1
        FROM forward_reach f
        JOIN customer_connections cc
            ON f.to_customer = cc.customer_b
            AND cc.shared_products >= 2
        WHERE f.hops < 3
            AND f.from_customer != cc.customer_a
    ),

    -- Backward reachability: can customer A be reached FROM customer B?
    -- MUTUAL: references forward_reach to focus on promising paths
    backward_reach(from_customer TEXT, to_customer TEXT, hops INT) AS (
        -- Base case: direct connection (reversed)
        SELECT customer_b, customer_a, 1
        FROM customer_connections
        WHERE shared_products >= 2
        UNION
        SELECT customer_a, customer_b, 1
        FROM customer_connections
        WHERE shared_products >= 2
        UNION
        -- Recursive: extend backward paths
        SELECT DISTINCT
            b.from_customer,
            cc.customer_a,
            b.hops + 1
        FROM backward_reach b
        JOIN customer_connections cc
            ON b.to_customer = cc.customer_b
            AND cc.shared_products >= 2
        WHERE b.hops < 3
            AND b.from_customer != cc.customer_a
            -- Only extend if forward path exists (mutual pruning)
            AND EXISTS (
                SELECT 1 FROM forward_reach f
                WHERE f.from_customer = b.from_customer
            )
    )
-- A and B are in the same cohort if they can reach each other bidirectionally
SELECT DISTINCT
    f.from_customer AS customer_a,
    f.to_customer AS customer_b,
    LEAST(f.hops, b.hops) AS min_distance,
    f.hops AS forward_hops,
    b.hops AS backward_hops,
    'BIDIRECTIONAL' AS connection_type
FROM forward_reach f
JOIN backward_reach b
    ON f.from_customer = b.from_customer
    AND f.to_customer = b.to_customer
WHERE f.from_customer < f.to_customer;  -- Avoid duplicates

CREATE INDEX IF NOT EXISTS customer_cohorts_a_idx
    IN CLUSTER serving ON customer_cohorts_mv (customer_a);

CREATE INDEX IF NOT EXISTS customer_cohorts_b_idx
    IN CLUSTER serving ON customer_cohorts_mv (customer_b);


-- =============================================================================
-- 2. INFLUENCE NETWORK (PageRank-Style Mutual Scoring)
-- =============================================================================
-- Compute influence scores where:
-- - Customer influence depends on the quality of products they buy
-- - Product quality depends on the influence of customers who buy them
--
-- This is TRUE mutual recursion: customer_score and product_score
-- reference EACH OTHER in their definitions.
--
-- Datalog equivalent:
--   customer_score(C, 1.0) :- customer(C).  -- base
--   product_score(P, 1.0) :- product(P).    -- base
--   customer_score(C, S * 0.85 + 0.15) :- buys(C, P), product_score(P, S).
--   product_score(P, avg(S) * 0.85 + 0.15) :- buys(C, P), customer_score(C, S).
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS influence_network_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    -- Customer influence score (depends on product quality)
    customer_score(customer_id TEXT, score NUMERIC, iteration INT) AS (
        -- Base case: all customers start with score 1.0
        SELECT DISTINCT customer_id, 1.0::NUMERIC, 0
        FROM customer_product_edges

        UNION

        -- Recursive: customer score = damping * avg(product scores) + (1-damping)
        -- MUTUAL REFERENCE: uses product_score
        SELECT
            cpe.customer_id,
            (0.85 * COALESCE(AVG(ps.score), 1.0) + 0.15)::NUMERIC,
            cs.iteration + 1
        FROM customer_score cs
        JOIN customer_product_edges cpe ON cpe.customer_id = cs.customer_id
        JOIN product_score ps ON ps.product_id = cpe.product_id
            AND ps.iteration = cs.iteration  -- Same iteration
        WHERE cs.iteration < 5  -- Max iterations
        GROUP BY cpe.customer_id, cs.iteration
    ),

    -- Product quality score (depends on customer influence)
    -- MUTUAL REFERENCE: uses customer_score
    product_score(product_id TEXT, score NUMERIC, iteration INT) AS (
        -- Base case: all products start with score 1.0
        SELECT DISTINCT product_id, 1.0::NUMERIC, 0
        FROM customer_product_edges

        UNION

        -- Recursive: product score = damping * avg(customer scores) + (1-damping)
        SELECT
            cpe.product_id,
            (0.85 * COALESCE(AVG(cs.score), 1.0) + 0.15)::NUMERIC,
            ps.iteration + 1
        FROM product_score ps
        JOIN customer_product_edges cpe ON cpe.product_id = ps.product_id
        JOIN customer_score cs ON cs.customer_id = cpe.customer_id
            AND cs.iteration = ps.iteration  -- Same iteration
        WHERE ps.iteration < 5  -- Max iterations
        GROUP BY cpe.product_id, ps.iteration
    )
-- Output final scores (highest iteration)
SELECT
    'customer' AS entity_type,
    customer_id AS entity_id,
    MAX(score) AS influence_score,
    MAX(iteration) AS iterations
FROM customer_score
GROUP BY customer_id

UNION ALL

SELECT
    'product' AS entity_type,
    product_id AS entity_id,
    MAX(score) AS influence_score,
    MAX(iteration) AS iterations
FROM product_score
GROUP BY product_id;

CREATE INDEX IF NOT EXISTS influence_network_type_idx
    IN CLUSTER serving ON influence_network_mv (entity_type);

CREATE INDEX IF NOT EXISTS influence_network_id_idx
    IN CLUSTER serving ON influence_network_mv (entity_id);


-- =============================================================================
-- 3. DELIVERY BUNDLING WITH CONFLICT DETECTION
-- =============================================================================
-- Find orders that can be bundled for efficient delivery, while detecting
-- conflicts (orders competing for same limited inventory).
--
-- Uses mutual recursion between:
-- - bundle_candidates: orders that could be delivered together
-- - inventory_conflicts: orders competing for same scarce inventory
--
-- The conflict detection prunes invalid bundles in real-time.
--
-- Datalog:
--   can_bundle(O1, O2) :- same_store(O1, O2), compatible_time(O1, O2).
--   can_bundle(O1, O3) :- can_bundle(O1, O2), can_bundle(O2, O3), no_conflict(O1, O3).
--   has_conflict(O1, O2) :- shares_scarce_product(O1, O2, P), limited_stock(P).
--   no_conflict(O1, O2) :- can_bundle(O1, O2), NOT has_conflict(O1, O2).
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS delivery_bundles_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    -- Orders that share scarce inventory (conflict detection)
    inventory_conflicts(order_a TEXT, order_b TEXT, product_id TEXT, available_stock INT, total_needed INT) AS (
        -- Base: find orders competing for same low-stock products
        SELECT
            ol1.order_id AS order_a,
            ol2.order_id AS order_b,
            ol1.product_id,
            inv.stock_level AS available_stock,
            (ol1.quantity + ol2.quantity)::INT AS total_needed
        FROM order_lines_flat ol1
        JOIN order_lines_flat ol2
            ON ol1.product_id = ol2.product_id
            AND ol1.order_id < ol2.order_id
        JOIN orders_flat_mv o1 ON o1.order_id = ol1.order_id
        JOIN orders_flat_mv o2 ON o2.order_id = ol2.order_id
        JOIN store_inventory_mv inv
            ON inv.product_id = ol1.product_id
            AND inv.store_id = o1.store_id
        WHERE o1.store_id = o2.store_id
            AND o1.order_status = 'CREATED'
            AND o2.order_status = 'CREATED'
            AND inv.stock_level < (ol1.quantity + ol2.quantity)  -- Not enough for both!

        UNION

        -- Transitive conflicts: if A conflicts with B, and B is bundled with C,
        -- then A may conflict with the bundle
        -- MUTUAL: references bundle_candidates
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

    -- Bundle candidates: orders that can be delivered together
    -- MUTUAL: excludes orders with conflicts
    bundle_candidates(order_a TEXT, order_b TEXT, store_id TEXT, bundle_size INT) AS (
        -- Base: direct bundling candidates (same store, compatible times)
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
        -- Time windows must overlap or be adjacent
        WHERE (o1.delivery_window_start::timestamptz <= o2.delivery_window_end::timestamptz
               AND o1.delivery_window_end::timestamptz >= o2.delivery_window_start::timestamptz)
        -- MUTUAL: Exclude pairs with inventory conflicts
        AND NOT EXISTS (
            SELECT 1 FROM inventory_conflicts ic
            WHERE ic.order_a = o1.order_id AND ic.order_b = o2.order_id
        )

        UNION

        -- Extend bundles: add more orders if no conflicts
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
        WHERE bc.bundle_size < 5  -- Max bundle size
            -- No conflicts with any order in the bundle
            AND NOT EXISTS (
                SELECT 1 FROM inventory_conflicts ic
                WHERE (ic.order_a = bc.order_a AND ic.order_b = o.order_id)
                   OR (ic.order_a = bc.order_b AND ic.order_b = o.order_id)
            )
    )
-- Output bundles with conflict information
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


-- =============================================================================
-- 4. SUPPLY CHAIN RISK PROPAGATION (Datalog-Style Rules)
-- =============================================================================
-- Propagate risk through the supply chain using inference rules.
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS supply_chain_risk_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    risk(entity_id TEXT, entity_type TEXT, risk_level TEXT, risk_source TEXT, propagation_depth INT) AS (
        -- Base case: store-level risks
        SELECT
            store_id AS entity_id,
            'Store' AS entity_type,
            risk_level,
            store_id AS risk_source,
            0 AS propagation_depth
        FROM store_risk_levels
        WHERE risk_level IN ('HIGH', 'CRITICAL')

        UNION

        -- Rule: Orders at risky stores are at risk
        SELECT
            o.order_id AS entity_id,
            'Order' AS entity_type,
            CASE r.risk_level
                WHEN 'CRITICAL' THEN 'HIGH'
                WHEN 'HIGH' THEN 'MEDIUM'
                ELSE 'LOW'
            END AS risk_level,
            r.risk_source,
            r.propagation_depth + 1 AS propagation_depth
        FROM risk r
        JOIN orders_flat_mv o ON o.store_id = r.entity_id
        WHERE r.entity_type = 'Store'
            AND r.propagation_depth < 3
            AND o.order_status NOT IN ('DELIVERED', 'CANCELLED')

        UNION

        -- Rule: Customers with risky orders are at risk
        SELECT
            o.customer_id AS entity_id,
            'Customer' AS entity_type,
            CASE r.risk_level
                WHEN 'HIGH' THEN 'MEDIUM'
                ELSE 'LOW'
            END AS risk_level,
            r.risk_source,
            r.propagation_depth + 1 AS propagation_depth
        FROM risk r
        JOIN orders_flat_mv o ON o.order_id = r.entity_id
        WHERE r.entity_type = 'Order'
            AND r.propagation_depth < 3

        UNION

        -- Rule: Delivery tasks for risky orders are at risk
        SELECT
            dt.task_id AS entity_id,
            'DeliveryTask' AS entity_type,
            r.risk_level,
            r.risk_source,
            r.propagation_depth + 1 AS propagation_depth
        FROM risk r
        JOIN delivery_tasks_flat dt ON dt.order_id = r.entity_id
        WHERE r.entity_type = 'Order'
            AND r.propagation_depth < 3
    )
SELECT
    entity_id,
    entity_type,
    CASE
        WHEN BOOL_OR(risk_level = 'CRITICAL') THEN 'CRITICAL'
        WHEN BOOL_OR(risk_level = 'HIGH') THEN 'HIGH'
        WHEN BOOL_OR(risk_level = 'MEDIUM') THEN 'MEDIUM'
        ELSE 'LOW'
    END AS risk_level,
    MIN(propagation_depth) AS risk_distance,
    ARRAY_AGG(DISTINCT risk_source) AS risk_sources
FROM risk
GROUP BY entity_id, entity_type;

CREATE INDEX IF NOT EXISTS supply_chain_risk_idx
    IN CLUSTER serving ON supply_chain_risk_mv (entity_id);

CREATE INDEX IF NOT EXISTS supply_chain_risk_type_idx
    IN CLUSTER serving ON supply_chain_risk_mv (entity_type, risk_level);


-- =============================================================================
-- 5. MULTI-STORE PRODUCT COVERAGE (Split Fulfillment)
-- =============================================================================

CREATE VIEW IF NOT EXISTS store_product_coverage AS
SELECT
    store_id,
    product_id,
    stock_level,
    CASE WHEN stock_level > 0 THEN TRUE ELSE FALSE END AS in_stock
FROM store_inventory_mv;

CREATE MATERIALIZED VIEW IF NOT EXISTS multi_store_product_coverage_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    coverage(product_id TEXT, store_set TEXT, total_stock INT, store_count INT) AS (
        SELECT
            product_id,
            store_id AS store_set,
            stock_level AS total_stock,
            1 AS store_count
        FROM store_product_coverage
        WHERE stock_level > 0

        UNION

        SELECT DISTINCT
            c.product_id,
            CASE
                WHEN c.store_set < spc.store_id
                THEN c.store_set || ', ' || spc.store_id
                ELSE spc.store_id || ', ' || c.store_set
            END AS store_set,
            c.total_stock + spc.stock_level AS total_stock,
            c.store_count + 1 AS store_count
        FROM coverage c
        JOIN store_product_coverage spc
            ON spc.product_id = c.product_id
            AND spc.stock_level > 0
            AND spc.store_id > c.store_set  -- Avoid duplicates
            AND c.store_set NOT LIKE '%' || spc.store_id || '%'
        WHERE c.store_count < 3
    )
SELECT product_id, store_set, total_stock, store_count
FROM coverage;

CREATE INDEX IF NOT EXISTS multi_store_coverage_idx
    IN CLUSTER serving ON multi_store_product_coverage_mv (product_id);


-- =============================================================================
-- EXAMPLE QUERIES
-- =============================================================================
--
-- 1. Find customer cohorts (bidirectionally connected groups):
--    SELECT * FROM customer_cohorts_mv ORDER BY customer_a, min_distance;
--
-- 2. Get top influential customers:
--    SELECT * FROM influence_network_mv
--    WHERE entity_type = 'customer'
--    ORDER BY influence_score DESC LIMIT 10;
--
-- 3. Get high-quality products:
--    SELECT * FROM influence_network_mv
--    WHERE entity_type = 'product'
--    ORDER BY influence_score DESC LIMIT 10;
--
-- 4. Find delivery bundles without conflicts:
--    SELECT * FROM delivery_bundles_mv
--    WHERE has_conflict = FALSE
--    ORDER BY store_id, bundle_size DESC;
--
-- 5. Find orders with inventory conflicts:
--    SELECT * FROM delivery_bundles_mv
--    WHERE has_conflict = TRUE;
--
-- =============================================================================
