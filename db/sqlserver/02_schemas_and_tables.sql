-- UPS historian + operations + fleet schema.
--
-- Three schemas mirror the three data silos the context graph unifies:
--   historian : industrial time-series (tag readings) and alarms/events
--   ops       : package flow — facilities, equipment, packages, scans, trailers, routes
--   fleet     : vehicles, drivers, faults, maintenance
--
-- All timestamps are datetime2(3): Materialize's timestamp type carries
-- microsecond precision, so the default datetime2(7) would be rounded on
-- ingest. Millisecond precision avoids that entirely.
USE ups;
GO

CREATE SCHEMA historian;
GO
CREATE SCHEMA ops;
GO
CREATE SCHEMA fleet;
GO

-- ============================================================
-- historian: the "historian system" — tag metadata, time-series
-- samples, and equipment alarms.
-- ============================================================

CREATE TABLE historian.tags (
    tag_id INT NOT NULL PRIMARY KEY,
    tag_name VARCHAR(100) NOT NULL,        -- e.g. 'belt_speed_fpm'
    equipment_id VARCHAR(20) NOT NULL,     -- e.g. 'LOU-SORT-04'
    unit VARCHAR(20) NOT NULL,             -- e.g. 'fpm', 'degC', 'pph'
    description NVARCHAR(200) NULL
);
GO

-- Append-only time-series samples. The simulator prunes rows older than
-- an hour; every Materialize view over this table is temporal-filtered,
-- so the deletes never change query results.
CREATE TABLE historian.tag_values (
    reading_id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    tag_id INT NOT NULL,
    ts DATETIME2(3) NOT NULL,
    value FLOAT NOT NULL
);
GO

CREATE TABLE historian.alarms (
    alarm_id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    equipment_id VARCHAR(20) NOT NULL,
    alarm_type VARCHAR(30) NOT NULL,       -- JAM | OVERTEMP | MISSORT | E_STOP
    severity VARCHAR(10) NOT NULL,         -- INFO | WARNING | CRITICAL
    message NVARCHAR(400) NOT NULL,
    raised_at DATETIME2(3) NOT NULL,
    cleared_at DATETIME2(3) NULL,
    acknowledged BIT NOT NULL DEFAULT 0,
    acknowledged_by NVARCHAR(100) NULL,
    acknowledged_at DATETIME2(3) NULL
);
GO

-- ============================================================
-- ops: package flow through the hub network.
-- ============================================================

CREATE TABLE ops.facilities (
    facility_id VARCHAR(10) NOT NULL PRIMARY KEY,  -- HUB-LOU, HUB-CHI, HUB-DFW
    name NVARCHAR(100) NOT NULL,
    city NVARCHAR(60) NOT NULL,
    state CHAR(2) NOT NULL,
    facility_type VARCHAR(20) NOT NULL             -- HUB
);
GO

CREATE TABLE ops.equipment (
    equipment_id VARCHAR(20) NOT NULL PRIMARY KEY, -- LOU-SORT-04
    facility_id VARCHAR(10) NOT NULL,
    equipment_type VARCHAR(20) NOT NULL,           -- CONVEYOR | SCANNER | SORTER
    name NVARCHAR(100) NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'RUNNING'  -- RUNNING | DEGRADED | DOWN
);
GO

CREATE TABLE ops.routes (
    route_id VARCHAR(12) NOT NULL PRIMARY KEY,     -- RT-LOU-CHI-1
    origin_facility_id VARCHAR(10) NOT NULL,
    dest_facility_id VARCHAR(10) NOT NULL,
    distance_miles INT NOT NULL,
    scheduled_minutes INT NOT NULL
);
GO

CREATE TABLE ops.trailers (
    trailer_id VARCHAR(12) NOT NULL PRIMARY KEY,   -- TRL-1001
    route_id VARCHAR(12) NOT NULL,
    dest_facility_id VARCHAR(10) NOT NULL,
    door VARCHAR(6) NULL,                          -- dock door, e.g. D-17
    status VARCHAR(12) NOT NULL DEFAULT 'OPEN',    -- OPEN | LOADING | DISPATCHED | ARRIVED
    tractor_vehicle_id VARCHAR(12) NULL,
    scheduled_departure DATETIME2(3) NULL
);
GO

CREATE TABLE ops.packages (
    package_id VARCHAR(20) NOT NULL PRIMARY KEY,   -- 1Z999AA1...
    origin_facility_id VARCHAR(10) NOT NULL,
    dest_facility_id VARCHAR(10) NOT NULL,
    service_level VARCHAR(20) NOT NULL,            -- NEXT_DAY_AIR | 2ND_DAY_AIR | GROUND
    status VARCHAR(20) NOT NULL,                   -- lifecycle states, see simulator
    current_facility_id VARCHAR(10) NULL,
    -- The sort plan: which sorter this package is routed through at its
    -- origin hub. Lets the context graph tie a waiting package to a
    -- jammed sorter *before* the package ever reaches it.
    planned_sort_equipment_id VARCHAR(20) NULL,
    assigned_trailer_id VARCHAR(12) NULL,
    promised_delivery DATETIME2(3) NOT NULL,
    created_at DATETIME2(3) NOT NULL,
    updated_at DATETIME2(3) NOT NULL
);
GO

-- Append-only scan history. Pruned after 24h by the simulator; views over
-- it are temporal-filtered.
CREATE TABLE ops.scan_events (
    scan_id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    package_id VARCHAR(20) NOT NULL,
    facility_id VARCHAR(10) NOT NULL,
    equipment_id VARCHAR(20) NULL,                 -- scanner/sorter that produced the scan
    scan_type VARCHAR(20) NOT NULL,                -- ORIGIN | INDUCT | SORT | LOAD | DEPART | ARRIVE | DELIVER
    ts DATETIME2(3) NOT NULL
);
GO

-- ============================================================
-- fleet: tractors, package cars, drivers, faults, maintenance.
-- ============================================================

CREATE TABLE fleet.vehicles (
    vehicle_id VARCHAR(12) NOT NULL PRIMARY KEY,   -- TRC-100, PKG-200
    vehicle_type VARCHAR(15) NOT NULL,             -- TRACTOR | PACKAGE_CAR
    home_facility_id VARCHAR(10) NOT NULL,
    status VARCHAR(15) NOT NULL DEFAULT 'IN_SERVICE',  -- IN_SERVICE | MAINTENANCE
    odometer_miles INT NOT NULL DEFAULT 0
);
GO

CREATE TABLE fleet.drivers (
    driver_id VARCHAR(12) NOT NULL PRIMARY KEY,
    name NVARCHAR(100) NOT NULL,
    home_facility_id VARCHAR(10) NOT NULL,
    status VARCHAR(15) NOT NULL DEFAULT 'ON_DUTY', -- ON_DUTY | OFF_DUTY
    assigned_vehicle_id VARCHAR(12) NULL
);
GO

CREATE TABLE fleet.fault_codes (
    code VARCHAR(12) NOT NULL PRIMARY KEY,         -- SPN-style, e.g. SPN-100
    description NVARCHAR(200) NOT NULL,
    severity VARCHAR(10) NOT NULL,                 -- INFO | WARNING | CRITICAL
    subsystem VARCHAR(30) NOT NULL                 -- ENGINE | BRAKES | ELECTRICAL | EMISSIONS
);
GO

CREATE TABLE fleet.vehicle_faults (
    fault_id BIGINT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    vehicle_id VARCHAR(12) NOT NULL,
    code VARCHAR(12) NOT NULL,
    occurred_at DATETIME2(3) NOT NULL,
    cleared_at DATETIME2(3) NULL
);
GO

-- The copilot's write-back target: it opens work orders here, in the
-- system of record, and the change flows back through CDC into the graph.
CREATE TABLE fleet.maintenance_orders (
    work_order_id VARCHAR(16) NOT NULL PRIMARY KEY, -- WO-<epoch>
    vehicle_id VARCHAR(12) NOT NULL,
    status VARCHAR(15) NOT NULL DEFAULT 'OPEN',     -- OPEN | IN_PROGRESS | CLOSED
    priority VARCHAR(10) NOT NULL,                  -- LOW | MEDIUM | HIGH | URGENT
    description NVARCHAR(400) NOT NULL,
    opened_at DATETIME2(3) NOT NULL,
    created_by NVARCHAR(100) NOT NULL
);
GO
