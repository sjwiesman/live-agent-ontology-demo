# Context Engineering with Materialize: A Builder's Guide

This guide teaches you how to build a **live context platform for AI agents** using
Materialize, using this repository (FreshMart same-day grocery delivery) as a worked,
representative example. Every pattern below is drawn from real code in this repo, with
file references so you can study the full implementation. By the end you should be able
to build the same architecture for your own domain.

**The core idea:** agents are only as good as the context you hand them. Instead of
letting an agent fan out dozens of ad-hoc queries against normalized tables (slow, racy,
token-hungry) or reading from a nightly-rebuilt warehouse (stale), you *engineer the
context shape once* as an incrementally-maintained materialized view. Every agent read is
then a single, indexed, millisecond lookup that reflects the business **right now**. The
traditional freshness-vs-latency tradeoff disappears because the read model is
continuously maintained rather than periodically rebuilt.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Step 1 — Model the Domain: Ontology + Triple Store](#2-step-1--model-the-domain-ontology--triple-store)
3. [Step 2 — Validated Writes](#3-step-2--validated-writes)
4. [Step 3 — CDC into Materialize](#4-step-3--cdc-into-materialize)
5. [Step 4 — Three-Tier Cluster Architecture](#5-step-4--three-tier-cluster-architecture)
6. [Step 5 — Build the View Graph (Bronze → Silver → Gold)](#6-step-5--build-the-view-graph-bronze--silver--gold)
7. [Step 6 — Derived Signals: Dynamic Pricing as Live Context](#7-step-6--derived-signals-dynamic-pricing-as-live-context)
8. [Step 7 — The Context Document](#8-step-7--the-context-document)
9. [Step 8 — Wire the Agent](#9-step-8--wire-the-agent)
10. [Step 9 — Optional: Fresh Vector Search](#10-step-9--optional-fresh-vector-search)
11. [Step 10 — Optional: Real-Time UI with SUBSCRIBE](#11-step-10--optional-real-time-ui-with-subscribe)
12. [Operational Lessons and Gotchas](#12-operational-lessons-and-gotchas)
13. [Adapting This to Your Own Domain](#13-adapting-this-to-your-own-domain)

---

## 1. Architecture Overview

The system is CQRS with a knowledge-graph flavor:

```
WRITE PATH (command side)
  Agent / UI / API
        │  validated against ontology
        ▼
  PostgreSQL  ──  one generic `triples` table (subject, predicate, object, type)
        │  logical replication (CDC)
        ▼
  Materialize
    ingest cluster   → Postgres source            (Bronze: raw triples)
    compute cluster  → materialized views          (Silver: entities, Gold: context docs)
    serving cluster  → indexes on those views      (millisecond point lookups)
        │
        ├─ SUBSCRIBE ──→ Zero sync server ──→ WebSocket ──→ live UI
        │
        └─ CREATE SINK (ENVELOPE DEBEZIUM, Avro) ──→ Kafka/Redpanda
                 └─→ Kafka Connect
                       ├─ perfect-embeddings SMT (re-embed only changed text)
                       └─ OpenSearch sink (UPSERT)
                             └─→ OpenSearch: hybrid keyword + 384-dim kNN search

READ PATH (query side — what the agent sees)
  Agent ──→ Materialize serving cluster ──→ pre-assembled context, single indexed read
  Agent ──→ OpenSearch ──→ semantic recall ──→ hydrate live fields from Materialize
```

Three properties make this "context engineering" rather than just a data pipeline:

1. **Governed writes.** Every fact enters through one narrow, ontology-validated door.
   The agent can *discover* the schema (`get_context_graph`) and is *prevented* from
   writing facts the ontology doesn't define.
2. **Pre-assembled context.** The expensive work — joins, aggregation, derived pricing —
   happens incrementally on write inside Materialize, not on read. The agent gets a
   complete business object (order + customer + store + courier + line items + live
   prices) in one lookup.
3. **Freshness everywhere.** The same change stream that updates the read model also
   updates the search index, the embeddings, and the UI — no batch windows, no drift
   between what search returns and what the database says.

Key repo files, by layer:

| Layer | Files |
|---|---|
| Ontology + triples DDL | `db/migrations/010_ontology_schema.sql`, `020_triples_schema.sql` |
| Domain ontology seed | `db/seed/demo_ontology_freshmart.sql` |
| Write validation + API | `api/src/triples/validator.py`, `api/src/triples/service.py`, `api/src/routes/triples.py` |
| CDC publication | `db/migrations/050_materialize_publication.sql` |
| Materialize views/sinks | `db/materialize/init.sh` |
| Agent + tools | `agents/src/graphs/ops_assistant_graph.py`, `agents/src/tools/` |
| Embedding pipeline | `connect/`, `embeddings-shim/`, `os-bootstrap/` |
| Live UI sync | `docker-compose.yml` (`materialize-zero`, `zero-cache`), `web/src/schema.ts` |

---

## 2. Step 1 — Model the Domain: Ontology + Triple Store

### Why triples?

All operational data lives in **one generic table**: RDF-style
subject–predicate–object triples. Entities are namespaced by ID prefix
(`customer:123`, `order:FM-1001`, `inventory:BK-01-P42`).

```sql
-- db/migrations/020_triples_schema.sql
CREATE TABLE triples (
    id BIGSERIAL PRIMARY KEY,
    subject_id   TEXT NOT NULL,   -- 'prefix:id', e.g. 'order:FM-1001'
    predicate    TEXT NOT NULL,   -- property name from ontology_properties
    object_value TEXT NOT NULL,   -- the value (literal or entity reference)
    object_type  TEXT NOT NULL,   -- 'string','int','float','timestamp','date','bool','entity_ref'
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_triple UNIQUE (subject_id, predicate, object_value)
);

CREATE INDEX idx_triples_subject           ON triples(subject_id);
CREATE INDEX idx_triples_predicate         ON triples(predicate);
CREATE INDEX idx_triples_subject_predicate ON triples(subject_id, predicate);
CREATE INDEX idx_triples_object_value      ON triples(object_value) WHERE object_type = 'entity_ref';
```

The payoff: **adding a new entity type or relationship requires zero schema
migrations** — you insert ontology rows and write new views. The cost: an
unconstrained triple table is a semantic free-for-all. That's what the ontology fixes.

Note the unique constraint is on the *full triple value* `(subject, predicate, object)`,
not `(subject, predicate)`. Multi-valued vs single-valued semantics are therefore a
choice made by the **write path** (Section 3), not the table.

### The ontology: guardrails for the graph

Two tables define what may exist:

```sql
-- db/migrations/010_ontology_schema.sql
CREATE TABLE ontology_classes (
    id SERIAL PRIMARY KEY,
    class_name TEXT UNIQUE NOT NULL,   -- 'Customer', 'Order'
    prefix     TEXT UNIQUE NOT NULL,   -- subject-ID prefix: 'customer', 'order'
    description TEXT,
    parent_class_id INT REFERENCES ontology_classes(id)   -- optional inheritance
);

CREATE TABLE ontology_properties (
    id SERIAL PRIMARY KEY,
    prop_name       TEXT UNIQUE NOT NULL,        -- 'order_status', 'placed_by'
    domain_class_id INT NOT NULL REFERENCES ontology_classes(id) ON DELETE CASCADE,
    range_kind      TEXT NOT NULL,               -- literal type, or 'entity_ref'
    range_class_id  INT REFERENCES ontology_classes(id) ON DELETE SET NULL,
    is_multi_valued BOOLEAN NOT NULL DEFAULT TRUE,
    is_required     BOOLEAN NOT NULL DEFAULT FALSE,
    description     TEXT,
    CONSTRAINT chk_entity_ref_has_range CHECK (
        range_kind != 'entity_ref' OR range_class_id IS NOT NULL
    )
);
```

- **Domain** = which class a predicate applies to (`order_status` belongs to `Order`).
- **Range** = the value's type; for `entity_ref`, the class the referenced entity must
  belong to (`placed_by` must point at a `Customer`).
- `prop_name` is globally unique — predicate names double as documentation
  (`customer_name`, `store_zone`), which also makes the flattening views (Section 6)
  unambiguous.

### The FreshMart ontology (representative example)

Eight classes model the delivery business (`db/seed/demo_ontology_freshmart.sql`):

| Class | Prefix | Key properties |
|---|---|---|
| Customer | `customer` | `customer_name`, `customer_email`, `customer_address`, `home_store` → Store |
| Store | `store` | `store_name`, `store_zone`, `store_status`, `store_capacity_orders_per_hour` |
| Product | `product` | `product_name`, `category`, `perishable`, `unit_price`, `unit_weight_grams` |
| InventoryItem | `inventory` | `inventory_store` → Store, `inventory_product` → Product, `stock_level`, plus derived pricing fields |
| Order | `order` | `order_number`, `placed_by` → Customer, `order_store` → Store, `order_status`, `delivery_window_*`, `order_created_at` |
| OrderLine | `orderline` | `line_of_order` → Order, `line_product` → Product, `quantity`, `order_line_unit_price`, `line_sequence` |
| Courier | `courier` | `courier_name`, `vehicle_type`, `courier_status`, `courier_home_store` → Store |
| DeliveryTask | `task` | `task_of_order` → Order, `assigned_to` → Courier, `task_status`, `eta` |

Modeling guidance you can carry to your own domain:

- **One class per business noun**, prefix = lowercase short name.
- **Relationships are `entity_ref` properties**, named for readability from the domain
  side (`placed_by`, `task_of_order`, `assigned_to`).
- **Snapshot vs live values**: `OrderLine.order_line_unit_price` records the price at
  order time; the *current* price is derived downstream in Materialize. Store facts,
  derive opinions.
- **Status fields are plain strings with documented enums** (`CREATED`, `PICKING`,
  `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELLED`) — validation of enum values happens in
  application logic, keeping the ontology small.

---

## 3. Step 2 — Validated Writes

Every write flows through one API (`POST/PUT /triples...`) that validates against the
ontology **before** any SQL. The validator (`api/src/triples/validator.py`) enforces
five rules:

1. Subject prefix must correspond to a valid ontology class.
2. Predicate must exist in `ontology_properties`.
3. Predicate's domain must match the subject's class (subclass-aware — it walks
   `parent_class_id` transitively).
4. `object_type` must match the predicate's `range_kind`.
5. For `entity_ref`, the object's prefix must match the predicate's range class
   (also subclass-aware), plus a format check that the value looks like `prefix:id`.

Plus literal checks (`int(value)`, `float(value)`, bool in `{true,false}`). Errors
accumulate into a structured `ValidationResult` that the API returns as HTTP 400 — and
that the *agent* receives verbatim as a tool result, so the LLM can self-correct.
There's also a dry-run endpoint (`POST /triples/validate`) that validates without
writing.

The domain check, as implemented:

```python
# api/src/triples/validator.py
subject_prefix = triple.subject_id.split(":")[0]
subject_class = await self.ontology.get_class_by_prefix(subject_prefix)
...
prop = await self.ontology.get_property_by_name(triple.predicate)
...
if prop.domain_class_id != subject_class.id:
    if not await self._is_subclass_of(subject_class.id, prop.domain_class_id):
        errors.append(ValidationErrorDetail(
            error_type="domain_violation",
            message=f"Predicate '{triple.predicate}' domain is "
                    f"'{prop.domain_class_name}', but subject is "
                    f"'{subject_class.class_name}'",
            ...))
```

### Three write paths (`api/src/triples/service.py`)

Each HTTP request runs in a single transaction (commit on success, rollback on any
exception — see `get_session` in `api/src/routes/triples.py`).

**(a) Idempotent single create** — `POST /triples`. If the identical triple exists,
just bump `updated_at` (which still produces a CDC event, useful for "touch" semantics):

```sql
INSERT INTO triples (subject_id, predicate, object_value, object_type)
VALUES (:subject_id, :predicate, :object_value, :object_type)
ON CONFLICT (subject_id, predicate, object_value) DO UPDATE
SET updated_at = NOW()
RETURNING *;
```

**(b) Additive batch** — `POST /triples/batch`. One multi-row `INSERT ... ON CONFLICT
DO UPDATE`. Because the conflict target includes `object_value`, a new value for an
existing subject+predicate **adds** a row — this is the multi-valued path.

**(c) Replacing upsert** — `PUT /triples/batch`. The single-valued path, and the one
agents use for status updates: for each `(subject_id, predicate)` pair, bulk-DELETE
existing rows, then bulk-INSERT the new values, all in one transaction. This enforces
single-valued semantics *structurally*, without needing a different unique constraint.

**That's the entire write side.** The application never writes to a read model, a
search index, or a cache. Everything downstream is derived automatically from CDC.

---

## 4. Step 3 — CDC into Materialize

### Postgres side

Logical replication needs three things — WAL level, replica identity, and a
publication:

```sql
-- db/migrations/050_materialize_publication.sql
ALTER TABLE triples REPLICA IDENTITY FULL;   -- required by Materialize

DROP PUBLICATION IF EXISTS mz_source;
CREATE PUBLICATION mz_source FOR TABLE triples;
```

`wal_level=logical` is set on the Postgres container command line
(`docker-compose.yml`, `db` service):

```
postgres -c wal_level=logical -c max_replication_slots=10
         -c max_wal_senders=10 -c wal_writer_delay=10ms
```

Note how small this is: **the publication contains exactly one table.** The triple
model concentrates all CDC into a single stream, which keeps the Materialize source
trivial no matter how many entity types you add later.

### Materialize side

```sql
-- db/materialize/init.sh
CREATE SECRET pgpass AS 'postgres';

CREATE CONNECTION pg_connection TO POSTGRES (
    HOST 'db', PORT 5432, USER 'postgres',
    PASSWORD SECRET pgpass, DATABASE 'freshmart'
);

CREATE SOURCE pg_source
    IN CLUSTER ingest
    FROM POSTGRES CONNECTION pg_connection (PUBLICATION 'mz_source')
    WITH (TIMESTAMP INTERVAL = '100ms');

CREATE TABLE triples
    FROM SOURCE pg_source (REFERENCE public.triples)
    WITH (RETAIN HISTORY FOR '5 minutes');

CREATE INDEX triples_subject_idx IN CLUSTER serving ON triples (subject_id);
```

Details that matter:

- `TIMESTAMP INTERVAL '100ms'` bounds how often the source mints new timestamps —
  the floor on end-to-end propagation latency.
- `RETAIN HISTORY` must be set **at CREATE** for source-derived tables and applies to
  anything that SUBSCRIBEs with a resume watermark (see Section 12).
- The repo uses the v26 `CREATE TABLE ... FROM SOURCE` syntax.

---

## 5. Step 4 — Three-Tier Cluster Architecture

Materialize clusters isolate compute. The repo uses a three-tier layout that you should
copy as-is — it's the standard production pattern:

```
ingest  cluster → sources (Postgres CDC) and Kafka sinks
compute cluster → materialized views (persist transformation results)
serving cluster → indexes (serve queries with low latency); the default cluster
```

The convention (from `db/materialize/init.sh`'s header):

- **Regular views** for intermediate transformations — pure logical definitions, no
  cluster, no cost; they inline into whatever reads them.
- **Materialized views `IN CLUSTER compute`** only for "topmost" views whose results
  must persist (they're read by indexes, sinks, or SUBSCRIBE).
- **Indexes `IN CLUSTER serving` ON the materialized views** so queries never compete
  with view maintenance for CPU.

Sizing, as done in `init.sh`: budget 50% of host CPUs at `1 core = 50cc`, pin
`ingest = 50cc` and `serving = 100cc`, give the remainder to `compute` (capped at
400cc). Isolation is the point — a heavy recomputation in `compute` cannot make an
agent's point lookup in `serving` slow.

Every consumer sets its cluster explicitly. From the agent's store-health tool:

```python
# agents/src/tools/tool_get_store_health.py
conn = await asyncpg.connect(host=settings.mz_host, port=settings.mz_port, ...)
await conn.execute("SET CLUSTER = serving")            # use the indexed tier
await conn.execute("SET transaction_isolation = 'serializable'")
rows = await conn.fetch("SELECT ... FROM store_capacity_health_mv ...")
```

---

## 6. Step 5 — Build the View Graph (Bronze → Silver → Gold)

This is the heart of context engineering: a DAG of SQL views that turns raw triples
into agent-ready documents. The medallion framing maps cleanly:

- **Bronze** — the replicated `triples` table.
- **Silver** — "flat" entity views that pivot triples into wide rows.
- **Gold** — enriched, joined, aggregated context documents and derived signals.

### Silver: the pivot idiom

Every entity gets a flat view using the same pattern —
`MAX(CASE WHEN predicate = '...' THEN object_value END) ... GROUP BY subject_id`:

```sql
-- db/materialize/init.sh
CREATE VIEW customers_flat AS
SELECT
    subject_id AS customer_id,
    MAX(CASE WHEN predicate = 'customer_name'    THEN object_value END) AS customer_name,
    MAX(CASE WHEN predicate = 'customer_email'   THEN object_value END) AS customer_email,
    MAX(CASE WHEN predicate = 'customer_address' THEN object_value END) AS customer_address,
    MAX(updated_at) AS effective_updated_at
FROM triples
WHERE subject_id LIKE 'customer:%'
GROUP BY subject_id;
```

Conventions to copy:

- **Filter by prefix** (`LIKE 'order:%'`) — the prefix *is* the type system.
- **Cast at the edge**: `::DECIMAL(10,2)`, `::TIMESTAMPTZ`, `::INT`, `::BOOLEAN` in the
  flat view, so everything downstream is typed.
- **Carry `MAX(updated_at) AS effective_updated_at`** in every view, and take
  `GREATEST(...)` of all inputs when joining. This freshness watermark propagates to
  the leaves and is how the demo measures "reaction time" (`NOW() -
  effective_updated_at`) — and how consumers order/diff changes.

Silver views that only feed other views stay **regular views**. Ones that are queried,
sunk, or subscribed directly become materialized:

```sql
CREATE MATERIALIZED VIEW stores_mv IN CLUSTER compute AS
SELECT ... FROM triples WHERE subject_id LIKE 'store:%' GROUP BY subject_id;

CREATE INDEX stores_idx IN CLUSTER serving ON stores_mv (store_id);
```

### Gold: joins and aggregation

Entity views join into denormalized read models. Example — orders enriched with
customer, store, and delivery task:

```sql
CREATE MATERIALIZED VIEW orders_search_source_mv IN CLUSTER compute AS
SELECT
    o.order_id, o.order_number, o.order_status, ...,
    c.customer_name, c.customer_email, c.customer_address,
    s.store_name, s.store_zone, s.store_address,
    dt.assigned_courier_id, dt.task_status AS delivery_task_status, dt.eta AS delivery_eta,
    GREATEST(o.effective_updated_at, c.effective_updated_at,
             s.effective_updated_at, dt.effective_updated_at) AS effective_updated_at
FROM orders_flat_mv o
LEFT JOIN customers_flat c ON c.customer_id = o.customer_id
LEFT JOIN stores_flat s   ON s.store_id   = o.store_id
LEFT JOIN delivery_tasks_flat dt ON dt.order_id = o.order_id;
```

Two more Gold patterns worth stealing:

- **Derived facts instead of stored ones.** `orders_flat_mv` *computes*
  `order_total_amount` as `SUM(quantity * order_line_unit_price)` over the order's
  lines rather than trusting a stored total — the read model can't drift from the
  lines.
- **Nested JSON for one-to-many.** `courier_schedule_mv` aggregates each courier's
  tasks into a `jsonb_agg(...)` array so the agent (or UI) gets the whole schedule in
  one row.

### Rolling windows with `mz_now()`

For time-series context (queue depth, wait times per store), the repo uses temporal
filters so windows slide automatically with no cron:

```sql
CREATE MATERIALIZED VIEW store_metrics_by_window_mv IN CLUSTER compute AS
SELECT ob.store_id, ob.window_end,
       COUNT(*) FILTER (WHERE ob.order_status = 'CREATED') AS queue_depth, ...
FROM orders_time_bucketed ob
WHERE mz_now() >= EXTRACT(EPOCH FROM ob.window_end)::bigint * 1000
  AND mz_now() <  EXTRACT(EPOCH FROM ob.window_end)::bigint * 1000 + 1800000
GROUP BY ob.store_id, ob.window_end;
```

Constraint to remember: `mz_now()` may appear only in `WHERE`/`HAVING` — you cannot
`EXTRACT(HOUR FROM mz_now())` in a SELECT/CASE. (That's why the demo's Materialize
pricing has 8 factors while the Postgres comparison view has a 9th time-of-day factor.)

---

## 7. Step 6 — Derived Signals: Dynamic Pricing as Live Context

The most instructive Gold view is the dynamic pricing engine
(`inventory_items_with_dynamic_pricing` → `..._mv` in `db/materialize/init.sh`). It
demonstrates that "context" isn't just denormalized storage — it can be **live business
logic** the agent consumes as plain columns.

`live_price = unit_price ×` eight incrementally-maintained factors:

| Signal | Logic (CTE over the view graph) |
|---|---|
| Zone premium | `CASE store_zone: MAN 1.15, BK 1.05, QNS 1.00, BX 0.98, SI 0.95` |
| Perishability | perishable → `0.95` (move it faster) |
| Local stock scarcity | available ≤ 5 → `1.10`; ≤ 15 → `1.03` |
| Popularity | rank ≤ 3 in category by units sold → `1.20`; 4–10 → `1.10`; else `0.90` |
| Global scarcity | scarcest 3 products across all stores → `1.15`; 4–10 → `1.08` |
| Demand velocity | recent vs prior sales ratio, damped ×0.25, clamped to [0.85, 1.25] |
| Demand premium | above-average sale count → `1.05` |
| Basket affinity | frequently co-purchased "basket drivers" → `0.95` |

Each factor is a CTE over the same Silver views (`order_lines_flat_mv`,
`store_inventory_mv`, `orders_flat_mv`); the final SELECT multiplies them. Because it's
a materialized view, **a sale at one store instantly reprices the product everywhere**
— scarcity ranks, velocity, and popularity all update incrementally.

Two implementation notes from this repo:

- `store_inventory_mv` computes `reserved_quantity` from pending orders and
  `available_quantity = GREATEST(stock - reserved, 0)` — the pricing view keys off
  *available*, not raw stock.
- The composite index
  `inventory_pricing_store_product_idx (store_id, product_id)` exists specifically so
  the per-order pricing join (next section) is a differential join over an existing
  arrangement rather than a scan; the repo measured ~5× p99 inflation without it.
  **Index the join keys your Gold views actually use.**

The agent never computes prices. Its system prompt says: *always quote `live_price`,
never `base_price`* — the context layer owns the business logic; the agent just reads it.

---

## 8. Step 7 — The Context Document

`orders_with_lines_mv` is the flagship: one row per order containing *everything an
agent needs* to answer a question about that order. Abbreviated (full SQL in
`db/materialize/init.sh`):

```sql
CREATE MATERIALIZED VIEW orders_with_lines_mv IN CLUSTER compute AS
SELECT
    o.order_id, o.order_number, o.order_status, o.store_id, o.customer_id,
    o.delivery_window_start, o.delivery_window_end, o.order_created_at,
    o.order_total_amount,
    c.customer_name, c.customer_email, c.customer_address,
    s.store_name, s.store_zone, s.store_address,
    dt.assigned_courier_id, dt.task_status AS delivery_task_status, dt.eta AS delivery_eta,

    -- line items as a JSON array, each merged with LIVE dynamic pricing
    COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'product_id', ol.product_id, 'product_name', ol.product_name,
                'quantity', ol.quantity,
                'unit_price', ol.unit_price,          -- price at order time
                'live_price', ip.live_price,          -- price right now
                'price_change', ip.price_change,
                'current_stock', ip.available_quantity,
                ...
            ) ORDER BY ol.line_sequence
        ) FILTER (WHERE ol.line_id IS NOT NULL),
        '[]'::jsonb
    ) AS line_items,

    -- canonical text the embedding model sees (see Section 10)
    COALESCE(
        string_agg(
            ol.product_name || ' (' || COALESCE(ol.category, '') || ')',
            ' | ' ORDER BY ol.line_sequence
        ) FILTER (WHERE ol.product_name IS NOT NULL AND ol.product_name <> ''),
        ''
    ) AS embedding_text,

    COUNT(ol.line_id) AS line_item_count,
    BOOL_OR(ol.perishable_flag) AS has_perishable_items,
    SUM(ol.quantity * COALESCE(ol.unit_weight_grams, 0)::DECIMAL / 1000.0) AS total_weight_kg,
    GREATEST(o.effective_updated_at, MAX(ol.effective_updated_at),
             c.effective_updated_at, s.effective_updated_at,
             dt.effective_updated_at, MAX(ip.effective_updated_at)) AS effective_updated_at
FROM orders_flat_mv o
LEFT JOIN customers_flat c        ON c.customer_id = o.customer_id
LEFT JOIN stores_flat s           ON s.store_id = o.store_id
LEFT JOIN delivery_tasks_flat dt  ON dt.order_id = o.order_id
LEFT JOIN order_lines_flat_mv ol  ON ol.order_id = o.order_id
LEFT JOIN inventory_items_with_dynamic_pricing_mv ip
       ON ip.product_id = ol.product_id AND ip.store_id = o.store_id
GROUP BY ...;
```

Design principles embodied here:

- **Shape the view like the answer, not like the schema.** The row *is* the context
  the agent needs — no follow-up queries for customer or courier.
- **Carry both historical and live values** (`unit_price` vs `live_price`) so the agent
  can explain price changes rather than being confused by them.
- **Pre-compute agent-relevant aggregates** (`has_perishable_items`,
  `total_weight_kg`, `line_item_count`) — cheap for Materialize to maintain, expensive
  for an LLM to derive from raw rows, and valuable for downstream logic (courier
  vehicle capacity, delivery bundling).
- **Emit the embedding input as a column** (`embedding_text`) — raw text, not a hash.
  This single decision powers the entire "only re-embed when meaning changes" pipeline
  in Section 10.
- **Guard the aggregates**: `FILTER (WHERE ol.line_id IS NOT NULL)` +
  `COALESCE(..., '[]')` yields `[]` for empty orders, not `[null]`.

---

## 9. Step 8 — Wire the Agent

The agent (`agents/`) is a LangGraph ReAct loop: agent node ⇄ tool node, Postgres
checkpointer for conversation memory keyed by `thread_id`, 10-iteration cap, SSE
streaming server. The interesting part for this guide is the **tool design** — each
tool maps onto one layer of the context platform:

| Tool | Reads/writes | Backing |
|---|---|---|
| `get_context_graph` | read | ontology schema (`GET /ontology/schema`) |
| `search_orders`, `search_inventory` | read | OpenSearch (recall over fresh documents) |
| `fetch_order_context` | read | the pre-assembled order documents + live inventory pricing |
| `get_store_health` | read | Materialize directly (`SET CLUSTER = serving`), summary/capacity/inventory-risk views with computed recommendations |
| `create_order`, `manage_order_lines`, `create_customer` | write | high-level API endpoints (which write triples transactionally) |
| `write_triples` | write | validated generic triple writes (status updates etc.) |

### Pattern 1: Ontology-first prompting

The system prompt (`agents/src/graphs/ops_assistant_graph.py`) makes schema discovery
mandatory:

> **ALWAYS call get_context_graph() FIRST before ANY other tool.** ...
> The ontology defines how your business entities connect ... Without this context,
> you cannot provide accurate, relationship-aware responses.

`get_context_graph` returns the classes and properties (name, domain, range, required)
in a compact form. The agent grounds itself in *your* schema at runtime instead of
hallucinating one — and when the ontology evolves, the agent picks it up with no
prompt changes.

### Pattern 2: Validate before write, defense in depth

Before `write_triples`, the prompt requires the agent to check that the predicate
exists and its domain matches the subject's class — and to refuse and suggest a
high-level tool otherwise. The tool itself re-checks client-side and returns
actionable errors (including a sample of valid predicates), and the server validates
again. Three layers: prompt discipline, tool-level checks, server-side enforcement.
The LLM *cannot* corrupt the graph, and when it tries, the error message teaches it
the correct move.

```python
# agents/src/tools/tool_write_triples.py (client-side layer)
if ontology_properties and triple["predicate"] not in ontology_properties:
    results.append({
        "success": False,
        "error": f"Predicate '{triple['predicate']}' does not exist in ontology",
        "suggestion": "Check get_context_graph() for available predicates, "
                      "or use a high-level tool like manage_order_lines",
        "available_predicates_sample": available_predicates[:10],
    })
```

### Pattern 3: High-level tools over raw writes

Multi-triple invariants (an order and its lines, stock checks) live in dedicated tools
(`create_order`, `manage_order_lines`) that call transactional API endpoints. Raw
`write_triples` is reserved for simple single-fact updates like `order_status`.
Give the agent a safe verb for every common operation so it never needs to improvise
at the triple level.

### Pattern 4: Fresh reads are cheap, so mandate them

Because a context read is a millisecond indexed lookup, the prompt can afford rules
like: *"NEVER rely on pricing information from conversation memory or previous tool
calls ... Even if you just searched for a product, search again if asked about its
price."* This rule is only sane because the platform made fresh reads cheap. That's
the whole thesis, operationalized in a prompt.

### Pattern 5: Situational awareness views

`get_store_health` shows how to turn Gold views (`store_capacity_health_mv`,
`inventory_risk_mv`, `pricing_yield_mv`) into an agent-friendly instrument: it queries
Materialize directly, then formats exact counts and attaches *computed
recommendations* ("URGENT: 3 store(s) at CRITICAL capacity — consider closing intake").
The prompt adds a precision rule — report exact counts and named stores, never
generalize — which works because the underlying data is complete and current.

---

## 10. Step 9 — Optional: Fresh Vector Search

Agents also need *recall* — "find orders like X" — which means a search index and
embeddings. The naive approach re-embeds documents on every change (expensive) or
batch-rebuilds nightly (stale). This repo's pipeline keeps embeddings fresh **and**
only re-embeds when the embedded text actually changes.

### 10.1 Normalize types for the sink

Materialize's Avro output doesn't map 1:1 onto search-index mappings, so a thin
`*_sink_v` MV sits between the app-facing view and the sink and does nothing but cast:

```sql
CREATE MATERIALIZED VIEW orders_sink_v IN CLUSTER compute AS
SELECT
    order_id, order_number, order_status, ...,
    -- numeric/DECIMAL encodes as Avro decimal (bytes) → base64 in the sink;
    -- cast to double precision so float fields index correctly
    order_total_amount::double precision AS order_total_amount,
    -- normalize all timestamps to one ISO-8601 UTC string format
    to_char(order_created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS order_created_at,
    line_items, embedding_text, ...
FROM orders_with_lines_mv;
```

Keeping the casts in a dedicated sink view leaves your API/UI-facing views untouched.

### 10.2 Sink as a Debezium change stream

```sql
CREATE CONNECTION kafka_connection TO KAFKA (
    BROKER 'redpanda:29092', SECURITY PROTOCOL = 'PLAINTEXT');
CREATE CONNECTION csr_connection TO CONFLUENT SCHEMA REGISTRY (
    URL 'http://redpanda:8081');

CREATE SINK orders_sink
    IN CLUSTER ingest
    FROM orders_sink_v
    INTO KAFKA CONNECTION kafka_connection (TOPIC 'orders')
    KEY (order_id) NOT ENFORCED
    FORMAT AVRO USING CONFLUENT SCHEMA REGISTRY CONNECTION csr_connection
    ENVELOPE DEBEZIUM;
```

`ENVELOPE DEBEZIUM` is the load-bearing choice: every message carries **before + after
images**, which lets downstream consumers diff individual fields.

### 10.3 Diff-aware embedding (perfect-embeddings SMT)

Kafka Connect runs the Aiven OpenSearch sink with the
[perfect-embeddings](https://github.com/MaterializeInc/perfect-embedding) Single
Message Transform. Per record, per embedded column:

```text
if before is None:                                   # INSERT → embed
    record["embedding_text_embedding"] = embed(after.embedding_text)
elif before.embedding_text != after.embedding_text:  # text changed → embed
    record["embedding_text_embedding"] = embed(after.embedding_text)
else:                                                # unchanged → omit the field
    pass                                             # UPSERT preserves the old vector
```

Connector config (`connect/connectors/orders-opensearch-sink.json`):

```jsonc
{
  "connector.class": "io.aiven.kafka.connect.opensearch.OpensearchSinkConnector",
  "topics": "orders",
  "index.write.method": "upsert",          // partial doc merge → preserves vector
  "transforms": "extractKey,embed",
  "transforms.embed.type": "com.materialize.connect.smt.embedding.EmbeddingDiffTransform",
  "transforms.embed.embedded.columns": "embedding_text",
  "transforms.embed.provider": "openai",
  "transforms.embed.openai.endpoint": "http://embeddings:8080/v1/embeddings",
  "transforms.embed.openai.model": "BAAI/bge-small-en-v1.5",
  "transforms.embed.openai.dimensions": "384"
}
```

The structural insight, restated: **expose the raw embedding input as a view column,
sink it as a Debezium stream, and let a transform diff it.** A price-only edit produces
a change event, but `embedding_text` is byte-identical → the SMT skips the embedding
call and the partial UPSERT leaves the prior vector untouched. The SMT exposes
`EmbeddingsComputed` / `EmbeddingsSkipped` JMX counters so you can quantify the savings
(the demo UI shows "% embedding calls avoided" live).

The endpoint is OpenAI-protocol-compatible but overridable: the demo points it at a
~40-line local shim (`embeddings-shim/app.py`) wrapping `BAAI/bge-small-en-v1.5` via
fastembed/ONNX — zero API cost. Swap in the real OpenAI API by changing
`endpoint`/`api.key`; swap OpenSearch for Elasticsearch with the Confluent ES sink.

### 10.4 Query time: embed → kNN → hydrate from Materialize

```python
# api/src/routes/search.py (conceptual)
query_vector = embedder.embed([query_text])[0]     # SAME model as index time
results = opensearch.knn_search(
    index="orders", field="embedding_text_embedding",
    vector=query_vector, k=10,
    filter={"order_status": status, "store_zone": zone})  # hybrid filters
for hit in results:                                # search finds; Materialize tells the truth
    hit.live_data = materialize.query(order_id=hit.id)
```

Search provides *recall*; Materialize provides *current truth* (live price, status,
timestamps) at hydration time. An optional second stage reranks the top-k with a
cross-encoder (`/vector/orders/reranked`) — scoring each candidate against its
**current** Materialize-maintained state, so reranking never sees stale documents.

One index bootstrap gotcha: the Aiven connector's index auto-create **bypasses index
templates**, so `os-bootstrap/` installs the template (knn_vector mapping, analyzers)
and pre-creates the index *before* registering connectors.

---

## 11. Step 10 — Optional: Real-Time UI with SUBSCRIBE

The same MVs that serve agents can push to humans. The repo chains:

```
Materialize MVs ──SUBSCRIBE(wire port)──► materialize-zero sidecar
    ──WebSocket──► zero-cache (Rocicorp Zero) ──► React UI (useQuery/ZQL)
```

- The sidecar subscribes to 14 leaf MVs (`MATERIALIZE_COLLECTIONS` in
  `docker-compose.yml`) and translates differential updates (`mz_diff = ±1`) into
  Zero's replication protocol.
- The client schema (`web/src/schema.ts`) mirrors the MVs as tables; components issue
  ZQL queries and receive sub-second updates — write a triple, watch the order card
  change.

If you don't use Zero, the primitive is still `SUBSCRIBE`:

```sql
SUBSCRIBE (SELECT * FROM orders_with_lines_mv) WITH (PROGRESS);
```

which streams `(mz_timestamp, mz_diff, row)` — the universal adapter for pushing
context anywhere (WebSockets, caches, notification triggers). The `propagation-tap/`
service shows the consumer side in a few hundred lines of Python: it reads the Debezium
topics and computes field-level change events for the demo's propagation visualizer.

---

## 12. Operational Lessons and Gotchas

Hard-won details from this repo, roughly in order of importance:

**RETAIN HISTORY across the whole chain.** Materialize compacts history after ~1s by
default. Any consumer that reconnects and resumes `SUBSCRIBE ... AS OF <watermark>`
(like the Zero sidecar) will land inside the compacted region and be rejected
(`Timestamp not valid for all inputs`) — and because the check applies to *every
upstream* of the subscribed view, you must extend retention on the **entire dependency
chain**, source table included, not just the leaves:

```sql
ALTER MATERIALIZED VIEW orders_with_lines_mv SET (RETAIN HISTORY FOR '5 minutes');
-- ...repeated for the source table and every MV in the chain (init.sh lines 1687+)
```

**Idempotent, orchestrated init.** All Materialize DDL lives in one script
(`db/materialize/init.sh`) run by a one-shot container that waits for Postgres,
Materialize, and Redpanda health checks, then executes `CREATE ... IF NOT EXISTS`
everywhere (with deliberate `DROP ... CASCADE` + recreate for views whose schema is
still evolving). Downstream services (`materialize-zero`, `zero-cache`, connect
bootstrap) depend on `service_completed_successfully`. Treat your view graph as code
with a deterministic bootstrap.

**Frontiers must advance — stub your optional views.** The delivery-bundling MVs
(`WITH MUTUALLY RECURSIVE`, ~460s of compute) are opt-in. When disabled, they're
replaced by **stub MVs with identical schemas that still reference an upstream table**
(`... FROM orders_flat_mv WHERE order_id = '__stub_never_matches__'`). An empty view
with no upstream would have a stuck frontier and block any SUBSCRIBE that includes it.

**Index the arrangements your joins need.** The composite index on
`(store_id, product_id)` for the pricing view turned the per-order pricing join into a
differential join instead of a repeated scan (~5× p99 difference). Use `EXPLAIN` and
index deliberately; each index costs memory in `serving`.

**Avro type edges.** `numeric` → Avro `decimal` (bytes) → base64 in JSON sinks; mixed
text/`timestamptz` timestamp columns → inconsistent formats. Fix both with a dedicated
`*_sink_v` casting view (Section 10.1). JSONB columns arrive as JSON *strings* — map
them as non-indexed `text` and parse in the consumer.

**kNN deleted-doc bloat.** Frequent UPSERTs tombstone prior Lucene doc versions;
deleted vectors linger in the HNSW graph and eat the `ef_search` budget until recall
collapses. Set `index.merge.policy.deletes_pct_allowed: 10` in the index template so
merges keep the graph mostly live; force-expunge after bursts if needed.

**`mz_now()` restrictions.** Temporal filters only (`WHERE`/`HAVING`). Design derived
signals to avoid wall-clock arithmetic in projections, or accept the signal lives
outside Materialize.

**Measure freshness as a first-class metric.** Because every view carries
`effective_updated_at`, the demo can report *reaction time* (`NOW() -
effective_updated_at`) alongside *response time* for the same query across Postgres
view (fresh/slow), batch matview (fast/stale), and Materialize (fast/fresh) — see
`api/src/routes/query_stats.py`. Build this comparison early; it's how you prove the
architecture to yourself and your stakeholders.

---

## 13. Adapting This to Your Own Domain

A build order that works:

1. **Write the ontology.** List your business nouns (classes + prefixes) and their
   properties with domain/range. Start with 5–10 classes. Seed `ontology_classes` /
   `ontology_properties`.
2. **Stand up the triple store + write API.** Copy the DDL and the three write paths;
   wire the validator. Get `POST /triples` returning structured validation errors.
3. **Connect Materialize.** `wal_level=logical`, `REPLICA IDENTITY FULL`, one
   publication, one source, three clusters.
4. **Write Silver flat views** — one pivot view per class, casts at the edge,
   `effective_updated_at` everywhere.
5. **Design your context documents.** For each question your agent must answer
   ("what's the state of order X?", "can store Y take more load?"), write one Gold MV
   whose row *is* the answer. Add derived signals (your equivalent of dynamic pricing)
   as CTE-composed views. Index them in `serving` on the lookup keys.
6. **Build agent tools 1:1 with views.** A schema-discovery tool, one read tool per
   context document, high-level write tools for invariant-bearing operations, a
   validated generic write tool. Encode the ontology-first + validate-before-write +
   always-read-fresh rules in the system prompt.
7. **Add search when you need recall.** Sink view → Debezium sink → diff-aware
   embedding SMT → UPSERT into a kNN index; hydrate hits from Materialize.
8. **Add SUBSCRIBE consumers when humans need to watch.**

What to change vs keep:

- **Change:** the ontology, the flat views, the context-document shapes, the derived
  signals, the tool set, the embedding text definition.
- **Keep:** the triple table + validator, the three-cluster layout, the regular-view /
  materialized-view / index conventions, `effective_updated_at` propagation, the
  `*_sink_v` + Debezium + diff-embed pipeline, RETAIN HISTORY discipline, the
  idempotent init container.

The one-sentence summary: **model facts once, validate them at the door, let
Materialize continuously assemble them into the shapes your agents need, and make every
consumer — agent, search index, or human — read from that same live view graph.**
