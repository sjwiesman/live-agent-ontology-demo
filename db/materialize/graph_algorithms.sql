-- =============================================================================
-- Graph Algorithms and Datalog-Style Rules for Materialize
-- =============================================================================
-- This file demonstrates interesting ways to integrate graph algorithms and
-- datalog-style rules using Materialize's WITH MUTUALLY RECURSIVE feature.
--
-- Materialize's WITH MUTUALLY RECURSIVE differs from SQL'99 WITH RECURSIVE:
-- - Supports non-monotonic queries (aggregations, negation)
-- - Allows recursive CTEs to be referenced multiple times
-- - Enables mutual recursion between multiple CTEs
-- - Is Turing complete (can simulate any computation)
--
-- Key Concepts:
-- - Transitive closure: Find all paths through a graph
-- - Fixed-point iteration: Iterate until no new facts are derived
-- - Datalog semantics: Rules that derive new facts from existing facts
-- =============================================================================

-- =============================================================================
-- 1. ENTITY REACHABILITY GRAPH (Transitive Closure)
-- =============================================================================
-- Find all entities reachable from a given entity via entity_ref relationships.
-- This is the classic datalog reachability problem expressed in SQL.
--
-- Datalog equivalent:
--   reachable(X, Y) :- edge(X, Y).
--   reachable(X, Z) :- reachable(X, Y), edge(Y, Z).
-- =============================================================================

-- First, create a view of all entity references as edges in a graph
CREATE VIEW IF NOT EXISTS entity_edges AS
SELECT
    subject_id AS from_entity,
    object_value AS to_entity,
    predicate AS relationship
FROM triples
WHERE object_type = 'entity_ref';

-- Materialized view for transitive closure of entity relationships
-- This computes all directly and transitively connected entities
CREATE MATERIALIZED VIEW IF NOT EXISTS entity_reachability_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    reachable(from_entity TEXT, to_entity TEXT, path_length INT, via_relationship TEXT) AS (
        -- Base case: direct edges
        SELECT
            from_entity,
            to_entity,
            1 AS path_length,
            relationship AS via_relationship
        FROM entity_edges

        UNION

        -- Recursive case: extend paths
        SELECT DISTINCT
            r.from_entity,
            e.to_entity,
            r.path_length + 1 AS path_length,
            r.via_relationship || ' -> ' || e.relationship AS via_relationship
        FROM reachable r
        JOIN entity_edges e ON r.to_entity = e.from_entity
        WHERE r.path_length < 5  -- Limit depth to prevent infinite loops
    )
SELECT
    from_entity,
    to_entity,
    MIN(path_length) AS shortest_path_length,
    -- Keep path with shortest length
    (ARRAY_AGG(via_relationship ORDER BY path_length))[1] AS shortest_path
FROM reachable
GROUP BY from_entity, to_entity;

CREATE INDEX IF NOT EXISTS entity_reachability_from_idx
    IN CLUSTER serving ON entity_reachability_mv (from_entity);

CREATE INDEX IF NOT EXISTS entity_reachability_to_idx
    IN CLUSTER serving ON entity_reachability_mv (to_entity);


-- =============================================================================
-- 2. PRODUCT AFFINITY GRAPH (Market Basket with Transitive Closure)
-- =============================================================================
-- Extend market basket analysis with transitive affinity:
-- If A is frequently bought with B, and B with C, then A has transitive
-- affinity with C (weaker than direct affinity).
--
-- Datalog equivalent:
--   affinity(A, B, S) :- co_purchased(A, B, S), S >= threshold.
--   affinity(A, C, S1*S2*0.5) :- affinity(A, B, S1), affinity(B, C, S2).
-- =============================================================================

-- Direct co-purchase relationships from order lines
CREATE VIEW IF NOT EXISTS product_co_purchases AS
SELECT
    ol1.product_id AS product_a,
    ol2.product_id AS product_b,
    COUNT(DISTINCT ol1.order_id) AS co_purchase_count,
    -- Affinity score: probability of buying B given you bought A
    COUNT(DISTINCT ol1.order_id)::NUMERIC /
        NULLIF((SELECT COUNT(DISTINCT order_id)
                FROM order_lines_flat
                WHERE product_id = ol1.product_id), 0) AS affinity_score
FROM order_lines_flat ol1
JOIN order_lines_flat ol2
    ON ol1.order_id = ol2.order_id
    AND ol1.product_id < ol2.product_id  -- Avoid duplicates
GROUP BY ol1.product_id, ol2.product_id
HAVING COUNT(DISTINCT ol1.order_id) >= 2;  -- Minimum co-purchases

-- Transitive affinity graph using mutual recursion
CREATE MATERIALIZED VIEW IF NOT EXISTS product_affinity_graph_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    affinity(product_a TEXT, product_b TEXT, affinity_score NUMERIC, path_length INT) AS (
        -- Base case: direct co-purchases
        SELECT
            product_a,
            product_b,
            affinity_score,
            1 AS path_length
        FROM product_co_purchases
        WHERE affinity_score >= 0.1  -- Minimum threshold for direct affinity

        UNION

        -- Transitive affinity: A->B->C implies A->C with diminished strength
        SELECT DISTINCT
            a1.product_a,
            a2.product_b,
            -- Transitive affinity diminishes: multiply scores and decay factor
            a1.affinity_score * a2.affinity_score * 0.5 AS affinity_score,
            a1.path_length + 1 AS path_length
        FROM affinity a1
        JOIN affinity a2 ON a1.product_b = a2.product_a
        WHERE a1.product_a != a2.product_b  -- No self-loops
            AND a1.path_length < 3  -- Limit transitivity depth
            AND a1.affinity_score * a2.affinity_score * 0.5 >= 0.05  -- Minimum transitive score
    )
SELECT
    product_a,
    product_b,
    MAX(affinity_score) AS affinity_score,
    MIN(path_length) AS relationship_distance,
    CASE
        WHEN MIN(path_length) = 1 THEN 'DIRECT'
        ELSE 'TRANSITIVE'
    END AS affinity_type
FROM affinity
GROUP BY product_a, product_b;

CREATE INDEX IF NOT EXISTS product_affinity_idx
    IN CLUSTER serving ON product_affinity_graph_mv (product_a);


-- =============================================================================
-- 3. CUSTOMER SIMILARITY NETWORK
-- =============================================================================
-- Find customers who are "similar" based on shared purchasing patterns.
-- Uses mutual recursion to propagate similarity through the network.
--
-- Similarity is defined as:
-- 1. Direct: Customers who bought the same products
-- 2. Transitive: Customers similar to similar customers (with decay)
-- =============================================================================

-- Customer purchase profiles
CREATE VIEW IF NOT EXISTS customer_purchases AS
SELECT DISTINCT
    o.customer_id,
    ol.product_id,
    ol.category
FROM orders_flat_mv o
JOIN order_lines_flat ol ON ol.order_id = o.order_id
WHERE o.order_status = 'DELIVERED';

-- Direct customer similarity based on shared products
CREATE VIEW IF NOT EXISTS customer_similarity_direct AS
SELECT
    cp1.customer_id AS customer_a,
    cp2.customer_id AS customer_b,
    COUNT(DISTINCT cp1.product_id) AS shared_products,
    -- Jaccard similarity: |A ∩ B| / |A ∪ B|
    COUNT(DISTINCT cp1.product_id)::NUMERIC /
        NULLIF(
            (SELECT COUNT(DISTINCT product_id) FROM customer_purchases WHERE customer_id = cp1.customer_id) +
            (SELECT COUNT(DISTINCT product_id) FROM customer_purchases WHERE customer_id = cp2.customer_id) -
            COUNT(DISTINCT cp1.product_id),
            0
        ) AS jaccard_similarity
FROM customer_purchases cp1
JOIN customer_purchases cp2
    ON cp1.product_id = cp2.product_id
    AND cp1.customer_id < cp2.customer_id
GROUP BY cp1.customer_id, cp2.customer_id
HAVING COUNT(DISTINCT cp1.product_id) >= 2;

-- Transitive customer similarity network
CREATE MATERIALIZED VIEW IF NOT EXISTS customer_similarity_network_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    similarity(customer_a TEXT, customer_b TEXT, similarity_score NUMERIC, degree INT) AS (
        -- Base case: direct similarity
        SELECT
            customer_a,
            customer_b,
            jaccard_similarity AS similarity_score,
            1 AS degree
        FROM customer_similarity_direct
        WHERE jaccard_similarity >= 0.2

        UNION

        -- Transitive similarity with decay
        SELECT DISTINCT
            s1.customer_a,
            s2.customer_b,
            s1.similarity_score * s2.similarity_score * 0.6 AS similarity_score,
            s1.degree + 1 AS degree
        FROM similarity s1
        JOIN similarity s2 ON s1.customer_b = s2.customer_a
        WHERE s1.customer_a != s2.customer_b
            AND s1.degree < 2  -- Max 2 degrees of separation
            AND s1.similarity_score * s2.similarity_score * 0.6 >= 0.1
    )
SELECT
    customer_a,
    customer_b,
    MAX(similarity_score) AS similarity_score,
    MIN(degree) AS degrees_of_separation
FROM similarity
GROUP BY customer_a, customer_b;

CREATE INDEX IF NOT EXISTS customer_similarity_idx
    IN CLUSTER serving ON customer_similarity_network_mv (customer_a);


-- =============================================================================
-- 4. ORDER FULFILLMENT CHAIN (Dependency Graph)
-- =============================================================================
-- Trace the complete fulfillment chain from order to delivery,
-- showing all dependencies and state transitions.
--
-- This demonstrates using recursive SQL to traverse a dependency graph
-- where each entity depends on others to be in certain states.
-- =============================================================================

CREATE VIEW IF NOT EXISTS fulfillment_dependencies AS
-- Order depends on inventory items for all line products
SELECT
    o.order_id AS entity_id,
    'Order' AS entity_type,
    inv.inventory_id AS depends_on_id,
    'InventoryItem' AS depends_on_type,
    'REQUIRES_STOCK' AS dependency_type
FROM orders_flat_mv o
JOIN order_lines_flat ol ON ol.order_id = o.order_id
JOIN store_inventory_mv inv ON inv.product_id = ol.product_id AND inv.store_id = o.store_id

UNION ALL

-- Delivery task depends on order being ready
SELECT
    dt.task_id AS entity_id,
    'DeliveryTask' AS entity_type,
    dt.order_id AS depends_on_id,
    'Order' AS depends_on_type,
    'REQUIRES_ORDER' AS dependency_type
FROM delivery_tasks_flat dt

UNION ALL

-- Courier assignment depends on task
SELECT
    cf.courier_id AS entity_id,
    'Courier' AS entity_type,
    dt.task_id AS depends_on_id,
    'DeliveryTask' AS depends_on_type,
    'ASSIGNED_TO_TASK' AS dependency_type
FROM couriers_flat cf
JOIN delivery_tasks_flat dt ON dt.assigned_courier_id = cf.courier_id
WHERE cf.courier_status IN ('PICKING', 'DELIVERING');

-- Full dependency chain using transitive closure
CREATE MATERIALIZED VIEW IF NOT EXISTS fulfillment_chain_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    chain(
        root_entity_id TEXT,
        root_entity_type TEXT,
        entity_id TEXT,
        entity_type TEXT,
        depth INT,
        path TEXT
    ) AS (
        -- Base case: start from orders
        SELECT
            order_id AS root_entity_id,
            'Order' AS root_entity_type,
            order_id AS entity_id,
            'Order' AS entity_type,
            0 AS depth,
            order_id AS path
        FROM orders_flat_mv
        WHERE order_status NOT IN ('DELIVERED', 'CANCELLED')

        UNION

        -- Recursive case: follow dependencies
        SELECT
            c.root_entity_id,
            c.root_entity_type,
            d.depends_on_id AS entity_id,
            d.depends_on_type AS entity_type,
            c.depth + 1 AS depth,
            c.path || ' -> ' || d.depends_on_id AS path
        FROM chain c
        JOIN fulfillment_dependencies d ON d.entity_id = c.entity_id
        WHERE c.depth < 4  -- Max chain depth
    )
SELECT
    root_entity_id AS order_id,
    entity_id,
    entity_type,
    depth AS dependency_depth,
    path AS dependency_path
FROM chain
WHERE depth > 0;  -- Exclude self-references

CREATE INDEX IF NOT EXISTS fulfillment_chain_idx
    IN CLUSTER serving ON fulfillment_chain_mv (order_id);


-- =============================================================================
-- 5. ONTOLOGY CLASS HIERARCHY (Tree Traversal)
-- =============================================================================
-- Traverse the ontology class hierarchy using parent_class_id.
-- Computes transitive class membership for inheritance.
--
-- Datalog equivalent:
--   subclass(Child, Parent) :- ontology_classes(Child, Parent).
--   subclass(Child, Ancestor) :- subclass(Child, Parent), subclass(Parent, Ancestor).
-- =============================================================================

-- Note: This would need to be run on PostgreSQL where ontology_classes table lives,
-- or replicated to Materialize. Showing the pattern here:

-- CREATE MATERIALIZED VIEW IF NOT EXISTS class_hierarchy_mv IN CLUSTER compute AS
-- WITH MUTUALLY RECURSIVE
--     hierarchy(class_id INT, class_name TEXT, ancestor_id INT, ancestor_name TEXT, depth INT) AS (
--         -- Base case: direct parent relationship
--         SELECT
--             c.id AS class_id,
--             c.class_name,
--             p.id AS ancestor_id,
--             p.class_name AS ancestor_name,
--             1 AS depth
--         FROM ontology_classes c
--         JOIN ontology_classes p ON c.parent_class_id = p.id
--
--         UNION
--
--         -- Recursive case: grandparents and beyond
--         SELECT
--             h.class_id,
--             h.class_name,
--             p.id AS ancestor_id,
--             p.class_name AS ancestor_name,
--             h.depth + 1 AS depth
--         FROM hierarchy h
--         JOIN ontology_classes c ON c.id = h.ancestor_id
--         JOIN ontology_classes p ON c.parent_class_id = p.id
--         WHERE h.depth < 10  -- Max hierarchy depth
--     )
-- SELECT * FROM hierarchy;


-- =============================================================================
-- 6. IMPACT ANALYSIS (Reverse Dependency Propagation)
-- =============================================================================
-- If a product is recalled or a store goes offline, what orders/customers
-- are affected? This uses bidirectional traversal.
--
-- This demonstrates using mutual recursion for bidirectional graph analysis.
-- =============================================================================

-- Forward impact: Given a product, find all affected entities
CREATE MATERIALIZED VIEW IF NOT EXISTS product_impact_analysis_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    impacted(
        source_product_id TEXT,
        impacted_entity_id TEXT,
        impacted_entity_type TEXT,
        impact_path TEXT,
        depth INT
    ) AS (
        -- Base case: product directly impacts order lines
        SELECT
            ol.product_id AS source_product_id,
            ol.line_id AS impacted_entity_id,
            'OrderLine' AS impacted_entity_type,
            ol.product_id || ' -> ' || ol.line_id AS impact_path,
            1 AS depth
        FROM order_lines_flat ol

        UNION

        -- Order lines impact orders
        SELECT
            i.source_product_id,
            ol.order_id AS impacted_entity_id,
            'Order' AS impacted_entity_type,
            i.impact_path || ' -> ' || ol.order_id AS impact_path,
            i.depth + 1 AS depth
        FROM impacted i
        JOIN order_lines_flat ol ON ol.line_id = i.impacted_entity_id
        WHERE i.impacted_entity_type = 'OrderLine'
            AND i.depth < 4

        UNION

        -- Orders impact customers
        SELECT
            i.source_product_id,
            o.customer_id AS impacted_entity_id,
            'Customer' AS impacted_entity_type,
            i.impact_path || ' -> ' || o.customer_id AS impact_path,
            i.depth + 1 AS depth
        FROM impacted i
        JOIN orders_flat_mv o ON o.order_id = i.impacted_entity_id
        WHERE i.impacted_entity_type = 'Order'
            AND i.depth < 4

        UNION

        -- Orders impact delivery tasks
        SELECT
            i.source_product_id,
            dt.task_id AS impacted_entity_id,
            'DeliveryTask' AS impacted_entity_type,
            i.impact_path || ' -> ' || dt.task_id AS impact_path,
            i.depth + 1 AS depth
        FROM impacted i
        JOIN delivery_tasks_flat dt ON dt.order_id = i.impacted_entity_id
        WHERE i.impacted_entity_type = 'Order'
            AND i.depth < 4
    )
SELECT
    source_product_id,
    impacted_entity_id,
    impacted_entity_type,
    MIN(depth) AS impact_distance,
    (ARRAY_AGG(impact_path ORDER BY depth))[1] AS shortest_impact_path
FROM impacted
GROUP BY source_product_id, impacted_entity_id, impacted_entity_type;

CREATE INDEX IF NOT EXISTS product_impact_idx
    IN CLUSTER serving ON product_impact_analysis_mv (source_product_id);


-- =============================================================================
-- 7. STORE COVERAGE NETWORK (Bipartite Graph Analysis)
-- =============================================================================
-- Analyze which stores can cover which products and find optimal store
-- combinations for order fulfillment using graph connectivity.
-- =============================================================================

-- Store-product coverage matrix
CREATE VIEW IF NOT EXISTS store_product_coverage AS
SELECT
    store_id,
    product_id,
    stock_level,
    CASE WHEN stock_level > 0 THEN TRUE ELSE FALSE END AS in_stock
FROM store_inventory_mv;

-- Products available at multiple stores (for split-order fulfillment)
CREATE MATERIALIZED VIEW IF NOT EXISTS multi_store_product_coverage_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    coverage(product_id TEXT, store_set TEXT, total_stock INT, store_count INT) AS (
        -- Base case: single store coverage
        SELECT
            product_id,
            store_id AS store_set,
            stock_level AS total_stock,
            1 AS store_count
        FROM store_product_coverage
        WHERE stock_level > 0

        UNION

        -- Combine stores for the same product
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
            AND spc.store_id NOT LIKE '%' || c.store_set || '%'
        WHERE c.store_count < 3  -- Max 3 stores per combination
    )
SELECT
    product_id,
    store_set,
    total_stock,
    store_count
FROM coverage;

CREATE INDEX IF NOT EXISTS multi_store_coverage_idx
    IN CLUSTER serving ON multi_store_product_coverage_mv (product_id);


-- =============================================================================
-- 8. TEMPORAL STATE TRANSITIONS (State Machine)
-- =============================================================================
-- Model order status transitions as a graph and validate state machine rules.
-- Uses datalog-style rules to derive valid transitions.
--
-- Datalog equivalent:
--   valid_transition(S1, S2) :- transition_rules(S1, S2).
--   reachable_state(S1, S2) :- valid_transition(S1, S2).
--   reachable_state(S1, S3) :- reachable_state(S1, S2), valid_transition(S2, S3).
-- =============================================================================

-- Define valid order status transitions (state machine rules)
CREATE VIEW IF NOT EXISTS order_transition_rules AS
SELECT * FROM (VALUES
    ('CREATED', 'PICKING'),
    ('CREATED', 'CANCELLED'),
    ('PICKING', 'OUT_FOR_DELIVERY'),
    ('PICKING', 'CANCELLED'),
    ('OUT_FOR_DELIVERY', 'DELIVERED'),
    ('OUT_FOR_DELIVERY', 'CANCELLED')
) AS t(from_status, to_status);

-- Compute all reachable states from any state
CREATE MATERIALIZED VIEW IF NOT EXISTS order_state_reachability_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    reachable(from_status TEXT, to_status TEXT, steps INT, path TEXT) AS (
        -- Base case: direct transitions
        SELECT
            from_status,
            to_status,
            1 AS steps,
            from_status || ' -> ' || to_status AS path
        FROM order_transition_rules

        UNION

        -- Transitive transitions
        SELECT
            r.from_status,
            t.to_status,
            r.steps + 1 AS steps,
            r.path || ' -> ' || t.to_status AS path
        FROM reachable r
        JOIN order_transition_rules t ON r.to_status = t.from_status
        WHERE r.steps < 5
    )
SELECT
    from_status,
    to_status,
    MIN(steps) AS min_steps,
    (ARRAY_AGG(path ORDER BY steps))[1] AS shortest_path
FROM reachable
GROUP BY from_status, to_status;

CREATE INDEX IF NOT EXISTS order_state_reachability_idx
    IN CLUSTER serving ON order_state_reachability_mv (from_status);


-- =============================================================================
-- 9. RECOMMENDATION ENGINE (Collaborative Filtering via Graph)
-- =============================================================================
-- Product recommendations based on graph distance:
-- Products bought by similar customers, with similarity from customer network.
--
-- Combines customer similarity network with product purchases.
-- =============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS product_recommendations_mv IN CLUSTER compute AS
WITH MUTUALLY RECURSIVE
    recommendations(
        for_customer_id TEXT,
        recommended_product_id TEXT,
        recommendation_score NUMERIC,
        via_similar_customer TEXT,
        depth INT
    ) AS (
        -- Base case: products bought by directly similar customers
        SELECT DISTINCT
            csn.customer_a AS for_customer_id,
            cp.product_id AS recommended_product_id,
            csn.similarity_score AS recommendation_score,
            csn.customer_b AS via_similar_customer,
            1 AS depth
        FROM customer_similarity_network_mv csn
        JOIN customer_purchases cp ON cp.customer_id = csn.customer_b
        -- Exclude products the customer already bought
        WHERE NOT EXISTS (
            SELECT 1 FROM customer_purchases cp2
            WHERE cp2.customer_id = csn.customer_a
                AND cp2.product_id = cp.product_id
        )

        UNION

        -- Propagate recommendations through similarity network
        SELECT DISTINCT
            csn.customer_a AS for_customer_id,
            r.recommended_product_id,
            csn.similarity_score * r.recommendation_score * 0.7 AS recommendation_score,
            r.via_similar_customer,
            r.depth + 1 AS depth
        FROM customer_similarity_network_mv csn
        JOIN recommendations r ON r.for_customer_id = csn.customer_b
        WHERE r.depth < 2
            AND csn.similarity_score * r.recommendation_score * 0.7 >= 0.05
            -- Exclude products the customer already bought
            AND NOT EXISTS (
                SELECT 1 FROM customer_purchases cp
                WHERE cp.customer_id = csn.customer_a
                    AND cp.product_id = r.recommended_product_id
            )
    )
SELECT
    for_customer_id,
    recommended_product_id,
    MAX(recommendation_score) AS recommendation_score,
    MIN(depth) AS recommendation_depth,
    (ARRAY_AGG(via_similar_customer ORDER BY recommendation_score DESC))[1] AS top_referrer
FROM recommendations
GROUP BY for_customer_id, recommended_product_id;

CREATE INDEX IF NOT EXISTS product_recommendations_idx
    IN CLUSTER serving ON product_recommendations_mv (for_customer_id);


-- =============================================================================
-- 10. SUPPLY CHAIN RISK PROPAGATION (Datalog-Style Rules)
-- =============================================================================
-- Model risk propagation through the supply chain.
-- If a store has capacity issues, propagate risk to orders and customers.
--
-- This demonstrates datalog-style inference rules for business logic.
--
-- Datalog equivalent:
--   at_risk(Order, high) :- order_store(Order, Store), store_risk(Store, high).
--   at_risk(Customer, medium) :- order(Order, Customer), at_risk(Order, high).
--   at_risk(Product, low) :- inventory(Store, Product), at_risk(Store, _).
-- =============================================================================

-- Store risk levels based on capacity utilization
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

-- Risk propagation using datalog-style rules
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
    -- Take the highest risk level for each entity
    CASE
        WHEN BOOL_OR(risk_level = 'CRITICAL') THEN 'CRITICAL'
        WHEN BOOL_OR(risk_level = 'HIGH') THEN 'HIGH'
        WHEN BOOL_OR(risk_level = 'MEDIUM') THEN 'MEDIUM'
        ELSE 'LOW'
    END AS risk_level,
    MIN(propagation_depth) AS risk_distance,
    (ARRAY_AGG(DISTINCT risk_source))[1:3] AS risk_sources
FROM risk
GROUP BY entity_id, entity_type;

CREATE INDEX IF NOT EXISTS supply_chain_risk_idx
    IN CLUSTER serving ON supply_chain_risk_mv (entity_id);

CREATE INDEX IF NOT EXISTS supply_chain_risk_type_idx
    IN CLUSTER serving ON supply_chain_risk_mv (entity_type, risk_level);


-- =============================================================================
-- EXAMPLE QUERIES
-- =============================================================================
-- These queries demonstrate how to use the graph algorithm views:
--
-- 1. Find all entities reachable from a specific order:
--    SELECT * FROM entity_reachability_mv WHERE from_entity = 'order:FM-1001';
--
-- 2. Get product recommendations for a customer:
--    SELECT * FROM product_recommendations_mv
--    WHERE for_customer_id = 'customer:1'
--    ORDER BY recommendation_score DESC
--    LIMIT 10;
--
-- 3. Find which orders are at risk:
--    SELECT * FROM supply_chain_risk_mv
--    WHERE entity_type = 'Order' AND risk_level IN ('HIGH', 'CRITICAL');
--
-- 4. Get the impact chain if a product is recalled:
--    SELECT * FROM product_impact_analysis_mv
--    WHERE source_product_id = 'product:milk-1L'
--    ORDER BY impact_distance;
--
-- 5. Find customers similar to a given customer:
--    SELECT * FROM customer_similarity_network_mv
--    WHERE customer_a = 'customer:1'
--    ORDER BY similarity_score DESC;
--
-- 6. Check valid order state transitions:
--    SELECT * FROM order_state_reachability_mv
--    WHERE from_status = 'PICKING';
-- =============================================================================
