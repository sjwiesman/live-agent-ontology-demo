# Graph Algorithms and Datalog-Style Rules in Materialize

This document explains how to integrate graph algorithms and datalog-style rules using Materialize's `WITH MUTUALLY RECURSIVE` feature with the FreshMart ontology.

## Overview

Materialize extends SQL with `WITH MUTUALLY RECURSIVE`, which provides:
- **Transitive closure** computation (find all paths through a graph)
- **Fixed-point iteration** (iterate until no new facts are derived)
- **Datalog semantics** (rules that derive new facts from existing facts)
- **Non-monotonic queries** (aggregations, negation within recursion)
- **Mutual recursion** (multiple CTEs that reference each other)

Unlike standard SQL'99 `WITH RECURSIVE`, Materialize's implementation:
- Allows recursive CTEs to be referenced multiple times
- Supports aggregations and window functions
- Enables bidirectional graph traversals
- Is Turing complete

## Key Concepts

### 1. Transitive Closure

The classic graph reachability problem: find all nodes reachable from a starting node.

**Datalog equivalent:**
```prolog
reachable(X, Y) :- edge(X, Y).
reachable(X, Z) :- reachable(X, Y), edge(Y, Z).
```

**SQL equivalent:**
```sql
WITH MUTUALLY RECURSIVE
  reachable(src TEXT, dst TEXT) AS (
    SELECT from_entity, to_entity FROM edges  -- Base case
    UNION
    SELECT r.src, e.to_entity                 -- Recursive case
    FROM reachable r
    JOIN edges e ON r.dst = e.from_entity
  )
SELECT * FROM reachable;
```

### 2. Fixed-Point Semantics

Materialize evaluates recursive CTEs by:
1. Starting with empty relations
2. Iterating until all relations stabilize (no new tuples)
3. Returning the final fixed point

This matches Datalog's bottom-up evaluation strategy.

### 3. Incremental Maintenance

Unlike traditional databases that recompute recursive queries from scratch, Materialize **incrementally maintains** the results. When source data changes, only the affected portions of the result are updated.

## Implemented Graph Algorithms

### 1. Entity Reachability Graph

Computes transitive closure of entity references in the triple store.

**Use case:** Find all entities connected to a given entity through any chain of relationships.

```sql
SELECT * FROM entity_reachability_mv
WHERE from_entity = 'order:FM-1001';
```

### 2. Product Affinity Graph

Extends market basket analysis with transitive affinity relationships.

**Use case:** If product A is often bought with B, and B with C, then A has indirect affinity with C.

```sql
SELECT * FROM product_affinity_graph_mv
WHERE product_a = 'product:milk-1L'
ORDER BY affinity_score DESC;
```

### 3. Customer Similarity Network

Finds similar customers based on shared purchasing patterns with transitive similarity.

**Use case:** Build customer segments and find "look-alike" audiences for marketing.

```sql
SELECT * FROM customer_similarity_network_mv
WHERE customer_a = 'customer:1'
ORDER BY similarity_score DESC;
```

### 4. Order Fulfillment Chain

Traces dependencies through the order fulfillment process.

**Use case:** Understand what inventory and resources an order depends on.

```sql
SELECT * FROM fulfillment_chain_mv
WHERE order_id = 'order:FM-1001'
ORDER BY dependency_depth;
```

### 5. Product Impact Analysis

Propagates impact analysis through the entity graph.

**Use case:** If a product is recalled, which orders and customers are affected?

```sql
SELECT * FROM product_impact_analysis_mv
WHERE source_product_id = 'product:milk-1L'
ORDER BY impact_distance;
```

### 6. Supply Chain Risk Propagation

Uses datalog-style inference rules to propagate risk through the supply chain.

**Use case:** If a store has capacity issues, which orders and customers are at risk?

```sql
SELECT * FROM supply_chain_risk_mv
WHERE risk_level IN ('HIGH', 'CRITICAL')
ORDER BY entity_type, risk_level DESC;
```

### 7. Order State Reachability

Models order status transitions as a state machine graph.

**Use case:** Determine which states are reachable from the current state.

```sql
SELECT * FROM order_state_reachability_mv
WHERE from_status = 'PICKING';
```

### 8. Product Recommendations

Collaborative filtering using the customer similarity network.

**Use case:** Recommend products based on what similar customers bought.

```sql
SELECT * FROM product_recommendations_mv
WHERE for_customer_id = 'customer:1'
ORDER BY recommendation_score DESC
LIMIT 10;
```

## Datalog-Style Rule Patterns

### Pattern 1: Base Case + Recursive Case

```sql
WITH MUTUALLY RECURSIVE
  derived_fact(...) AS (
    -- Base case: direct facts from source data
    SELECT ... FROM source_table

    UNION

    -- Recursive case: derive new facts from existing facts
    SELECT ...
    FROM derived_fact df
    JOIN source_table s ON ...
    WHERE ... -- termination condition
  )
```

### Pattern 2: Multi-Rule Derivation

```sql
WITH MUTUALLY RECURSIVE
  rule1(...) AS (...),
  rule2(...) AS (
    -- Can reference rule1
    SELECT ... FROM rule1 r1 JOIN ...
  ),
  rule3(...) AS (
    -- Can reference both rule1 and rule2
    SELECT ... FROM rule1 r1 JOIN rule2 r2 ON ...
  )
```

### Pattern 3: Propagation with Decay

```sql
WITH MUTUALLY RECURSIVE
  propagated(entity, score, depth) AS (
    SELECT entity, initial_score, 0 FROM sources

    UNION

    SELECT
      target.entity,
      p.score * decay_factor,  -- Score diminishes
      p.depth + 1
    FROM propagated p
    JOIN edges e ON ...
    WHERE p.depth < max_depth
      AND p.score * decay_factor >= min_threshold
  )
```

## Performance Considerations

1. **Depth Limits**: Always include a depth limit to prevent infinite recursion
2. **Threshold Pruning**: Prune weak relationships to limit explosion
3. **Indexing**: Create indexes on join columns for efficient lookups
4. **Cluster Placement**: Use `IN CLUSTER compute` for materialized views, `IN CLUSTER serving` for indexes

## References

- [Materialize Recursive CTEs Documentation](https://materialize.com/docs/sql/select/recursive-ctes/)
- [Recursion in Materialize Blog](https://materialize.com/blog/recursion-in-materialize/)
- [Recursive SQL Queries in Materialize](https://materialize.com/blog/recursive-ctes-in-materialize/)
- [DBSP: Automatic Incremental View Maintenance](https://www.vldb.org/pvldb/vol16/p1601-budiu.pdf)
