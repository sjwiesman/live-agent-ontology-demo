# UPS Historian → Live Context Graph Demo

A demo of how **Materialize** turns a SQL Server–backed historian into a **live context graph** that powers AI copilots for hub workers.

## The scenario

UPS runs an industrial **historian** on SQL Server: time-series telemetry from sortation equipment (belt speed, motor temperature, vibration, throughput, scanner read rates), alarms, and the operational tables around them — packages, scan events, trailers, routes, vehicles, drivers, faults, maintenance orders.

The data lives in three silos that workers correlate by hand today:

1. **Sortation** (the historian): equipment telemetry + alarms
2. **Package flow**: packages, scans, trailers, linehaul routes
3. **Fleet**: tractors, telematics fault codes, maintenance

The questions that matter cross the silos:

> *"Why is package 1Z999AA… at risk?"*
> Because sorter **LOU-SORT-04** in its sort plan has a **JAM alarm** (historian → package), **and** the tractor pulling its outbound trailer has a **low-oil-pressure fault** (fleet → package).

This repo builds that answer as a **continuously-maintained SQL view**. Materialize ingests SQL Server CDC and incrementally maintains cross-silo joins so the pre-assembled answer is always current — no batch ETL, no stale caches, no fan-out queries at request time. An AI copilot reads the graph in millisecond point lookups and **writes back** to the system of record.

```
Simulator ──▶ SQL Server 2022 (historian / ops / fleet schemas, CDC enabled)
                   │  Change Data Capture (~1-2s)
                   ▼
             Materialize
               silver: latest-state views (DISTINCT ON + temporal filters)
               gold:   package_context_mv · hub_health_mv · equipment_status_mv
                       fleet_risk_mv · hub_throughput_minute_mv  (compute cluster)
               serving: indexes for ms point lookups  (serving cluster)
                   │
        ┌──────────┴───────────┐
   FastAPI API :8080      LangGraph copilot :8081
   (dashboard reads)      (9 tools; write-back via SQL Server)
        │                      │
   React dashboard :5173 ── chat widget (SSE)
```

## Quick start

Requirements: Docker with ~6 GB free RAM. On Apple Silicon, enable Rosetta emulation in Docker Desktop (the SQL Server image is amd64-only) and expect a slower first boot.

```bash
git clone <this-repo> && cd <this-repo>
make setup          # creates .env — add ANTHROPIC_API_KEY (or OPENAI_API_KEY) for the copilot
make up             # builds and starts everything (~2-3 min first time)
```

| Service | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| API (Swagger) | http://localhost:8080/docs |
| Copilot | http://localhost:8081 |
| Materialize console | http://localhost:6874 |
| SQL Server | localhost:1433 (`sa` / your `.env` password) |

The simulator seeds 3 hubs (Worldport/Louisville, Chicago, Dallas), 30 pieces of equipment with ~90 historian tags, 30 vehicles, 20 trailers, and keeps a few hundred packages flowing continuously. A conveyor jam auto-fires every ~4 minutes so the dashboard always has a story; trigger your own with the buttons in the header or:

```bash
make jam              # jam LOU-SORT-04 at Worldport
make tractor-fault    # critical engine fault on a tractor with a loading trailer
make scanner-degraded # scanner read-rate drops, MISSORT alarms
```

## Demo walkthrough

1. **Steady state.** Open the dashboard: three hubs HEALTHY, sorters at ~8,000 pph, packages flowing (scans/10m), no alarms. Open **The Ontology** panel at the bottom — this is the explicit map of the context graph, and *exactly* what the copilot loads on every request.

2. **Break something.** `make jam`. Within a couple of seconds: Worldport flips **CRITICAL**, a JAM alarm appears, LOU-SORT-04's chip goes red with collapsed throughput and climbing temperature, and **At-Risk Packages** fills with HIGH-risk packages — packages that are *upstream* of the jammed sorter, linked through their sort plan before they ever reach it.

3. **Ask the copilot.** Click the chat bubble and ask: *"Why is package 1Z… at risk?"* (pick one from the tile). Watch the tool calls stream: it loads the ontology, looks up the package, reads the pre-joined context, and explains the full chain — package → planned sorter → JAM alarm → risk. Then try *"What's happening at Worldport?"* and *"Which packages should we act on first?"* (it uses the promise-window view).

4. **Act through the copilot.** `make tractor-fault`, then ask the copilot about fleet risk — it will find the faulted tractor *and how many packages are sitting on its trailer*. Tell it: *"Acknowledge the jam alarm and open a HIGH priority work order for that tractor — I'm supervisor Dana."* Both write-backs go to **SQL Server** (the system of record), flow back through CDC, and the dashboard updates in seconds: alarm shows `ack: Dana`, vehicle shows an open WO, and the jam clears.

5. **Prove it's real.** `make shell-sqlserver` and insert an alarm by hand:
   ```sql
   INSERT INTO historian.alarms (equipment_id, alarm_type, severity, message, raised_at)
   VALUES ('CHI-SORT-01', 'OVERTEMP', 'CRITICAL', 'manual demo alarm', SYSUTCDATETIME());
   GO
   ```
   It's on the dashboard before you can alt-tab. `make verify` runs this proof end-to-end and prints the measured CDC latency.

## How it works

### SQL Server (the historian)

`db/sqlserver/` creates database `ups` with three schemas — `historian` (tags, tag_values, alarms), `ops` (facilities, equipment, routes, trailers, packages, scan_events), `fleet` (vehicles, drivers, fault_codes, vehicle_faults, maintenance_orders) — enables CDC on all 14 tables, and creates the `materialize` login with the documented grants. The CDC capture job's polling interval is tuned from 5s to 1s.

Notable modeling choice: `packages.planned_sort_equipment_id` (the **sort plan**) links every package to the sorter it *will* go through. That's what lets a jam put packages at risk *before* they reach the machine — the cross-silo edge that makes this a graph instead of three dashboards.

### Materialize (the context graph)

`db/materialize/init.sh` builds a three-tier topology:

- **ingest** cluster: one `CREATE SOURCE … FROM SQL SERVER CONNECTION … FOR ALL TABLES`
- **compute** cluster: silver views use idiomatic latest-value patterns (`DISTINCT ON` under `mz_now()` temporal filters, so arrangements stay bounded on append-only historian data); gold materialized views pre-join the silos:
  - **`package_context_mv`** — the hero view: one row per active package with its facility, last scan, planned sorter + that sorter's alarm state, trailer, tractor + that tractor's faults, and a computed `risk_level`
  - `hub_health_mv`, `equipment_status_mv` (telemetry pivoted wide), `fleet_risk_mv` (faults ⋈ trailer ⋈ loaded-package count), `hub_throughput_minute_mv`
  - `late_package_risk_v` — packages within 4h of their delivery promise (`mz_now()` filter; lateness can't be a stored column)
- **serving** cluster: indexes on everything the API/copilot reads — point lookups answer in milliseconds regardless of write load

### The copilot

`agents/` is a LangGraph ReAct agent (FastAPI + SSE at :8081). Its system prompt forces `get_context_graph()` first — the ontology (`ontology/ontology.yaml`) tells it how entities connect, so its reasoning follows real relationships. Seven read tools query Materialize directly (asyncpg, `SET CLUSTER = serving`); two write-back tools (`acknowledge_alarm`, `create_maintenance_order`) write to SQL Server via pymssql — **observe from the graph, act on the system of record**.

### The simulator

`simulator/` plays the physical world: historian samples every 2s, a package lifecycle state machine (CREATED → … → DELIVERED, with scans tied to specific equipment), trailer dispatch/arrival cycles, fleet fault noise, and a scenario engine (`POST :8085/scenario/{name}`) that bends the telemetry, raises alarms, and freezes affected packages. Acknowledging a jam alarm releases the equipment — closing the copilot's action loop.

## Repo layout

```
ontology/ontology.yaml     the explicit ontology (classes, relationships, view bindings)
db/sqlserver/              DDL + CDC enablement + materialize user (one-shot init)
db/materialize/init.sh     clusters, source, silver/gold views, serving indexes
simulator/                 data generator + scenario engine (:8085)
api/                       FastAPI read layer over the graph (:8080)
agents/                    LangGraph copilot, 9 tools, SSE chat (:8081)
web/                       React dashboard + chat widget (:5173)
scripts/verify.sh          end-to-end proof (CDC latency, graph, write-back)
```

## Operational notes

- **CDC latency**: expect 1–3s end-to-end. The floor is SQL Server's CDC capture job (tuned to 1s polling); Materialize adds ~100ms.
- **Idle databases snapshot slowly**: SQL Server CDC only notifies idle consumers every 5 minutes, so the compose file starts the simulator *before* `materialize-init` — live writes keep the snapshot fast.
- **Timestamps** are `datetime2(3)` everywhere; SQL Server's default `datetime2(7)` exceeds Materialize's microsecond precision and would be rounded.
- **Retention**: the simulator prunes `tag_values` (>60 min) and `scan_events` (>24h). Safe because every view over them is temporal-filtered to a shorter window — deletes never change a result.
- **Corporate proxies**: all Dockerfiles trust any `*.crt` placed in their build context, if your network intercepts TLS.
- `make clean` resets everything (drops volumes) for a fresh start.
