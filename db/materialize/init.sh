#!/bin/sh
# Initialize Materialize: the live context graph over the UPS historian.
#
# Three-tier cluster architecture:
#   ingest  -> the SQL Server CDC source
#   compute -> materialized views (the silver/gold transformations)
#   serving -> indexes that answer point lookups in milliseconds
#
# Pattern:
#   - Regular views for intermediate ("silver") latest-state transformations
#   - Materialized views IN CLUSTER compute for the "gold" context views
#   - Indexes IN CLUSTER serving on whatever the API/copilot reads
set -e

MZ_HOST=${MZ_HOST:-localhost}
MZ_PORT=${MZ_PORT:-6875}
MZ_SQLSERVER_PASSWORD=${MZ_SQLSERVER_PASSWORD:?MZ_SQLSERVER_PASSWORD is required}

run() {
    psql -v ON_ERROR_STOP=1 -h "$MZ_HOST" -p "$MZ_PORT" -U materialize -q -c "$1"
}

echo "Waiting for Materialize to be ready..."
until psql -h "$MZ_HOST" -p "$MZ_PORT" -U materialize -c "SELECT 1" > /dev/null 2>&1; do
    sleep 2
done
echo "Materialize is ready."

if psql -h "$MZ_HOST" -p "$MZ_PORT" -U materialize -t -c "SHOW SOURCES" 2>/dev/null | grep -q ups_source; then
    echo "Source ups_source already exists; skipping initialization."
    exit 0
fi

echo "Creating clusters..."
run "CREATE CLUSTER ingest (SIZE = '50cc');" || true
run "CREATE CLUSTER compute (SIZE = '100cc');" || true
run "CREATE CLUSTER serving (SIZE = '100cc');" || true

echo "Creating SQL Server connection..."
run "CREATE SECRET IF NOT EXISTS sqlserver_pass AS '${MZ_SQLSERVER_PASSWORD}';"
run "CREATE CONNECTION IF NOT EXISTS sqlserver_connection TO SQL SERVER (
    HOST 'sqlserver',
    PORT 1433,
    USER 'materialize',
    PASSWORD SECRET sqlserver_pass,
    DATABASE 'ups'
);"

echo "Creating source (snapshots all CDC-enabled tables)..."
run "CREATE SOURCE ups_source
    IN CLUSTER ingest
    FROM SQL SERVER CONNECTION sqlserver_connection
    FOR ALL TABLES;"

echo "Waiting for the initial snapshot (facilities visible)..."
i=0
until [ "$(psql -h "$MZ_HOST" -p "$MZ_PORT" -U materialize -t -A -c 'SELECT COUNT(*) FROM facilities' 2>/dev/null)" -gt 0 ] 2>/dev/null; do
    i=$((i + 1))
    if [ $i -gt 120 ]; then
        echo "Snapshot did not complete within 4 minutes" >&2
        exit 1
    fi
    sleep 2
done
echo "Snapshot complete."

# ============================================================
# Silver: latest-state views over the raw CDC tables.
# Regular (non-materialized) views: they are fused into the gold
# dataflows, so they cost nothing on their own.
# ============================================================
echo "Creating silver views..."

# Latest sample per historian tag. Temporal filter keeps the arrangement
# bounded on the append-only table (simulator prunes at 60 min; 15 min here).
run "CREATE VIEW latest_tag_values AS
SELECT DISTINCT ON (tag_id) tag_id, ts, value
FROM tag_values
WHERE mz_now() <= ts + INTERVAL '15 minutes'
ORDER BY tag_id, ts DESC;"

# 5-minute rolling stats per (equipment, tag).
run "CREATE VIEW equipment_tag_stats_5m AS
SELECT
    t.equipment_id,
    t.tag_name,
    t.unit,
    AVG(v.value) AS avg_value,
    MIN(v.value) AS min_value,
    MAX(v.value) AS max_value,
    COUNT(*) AS sample_count,
    MAX(v.ts) AS latest_ts
FROM tag_values v
JOIN tags t ON t.tag_id = v.tag_id
WHERE mz_now() <= v.ts + INTERVAL '5 minutes'
GROUP BY t.equipment_id, t.tag_name, t.unit;"

run "CREATE VIEW active_alarms AS
SELECT
    a.alarm_id,
    a.equipment_id,
    e.facility_id,
    e.equipment_type,
    a.alarm_type,
    a.severity,
    a.message,
    a.raised_at,
    a.acknowledged,
    a.acknowledged_by
FROM alarms a
JOIN equipment e ON e.equipment_id = a.equipment_id
WHERE a.cleared_at IS NULL;"

run "CREATE VIEW equipment_alarm_agg AS
SELECT
    equipment_id,
    COUNT(*) AS active_alarm_count,
    COUNT(*) FILTER (WHERE severity = 'CRITICAL') AS critical_alarm_count,
    MAX(CASE severity WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END) AS severity_rank
FROM alarms
WHERE cleared_at IS NULL
GROUP BY equipment_id;"

# Most recent still-active alarm per equipment (for human-readable context).
run "CREATE VIEW latest_active_alarm AS
SELECT DISTINCT ON (equipment_id)
    equipment_id, alarm_id, alarm_type, severity, message, raised_at
FROM alarms
WHERE cleared_at IS NULL
ORDER BY equipment_id, raised_at DESC;"

run "CREATE VIEW latest_package_scan AS
SELECT DISTINCT ON (package_id) package_id, facility_id, equipment_id, scan_type, ts
FROM scan_events
WHERE mz_now() <= ts + INTERVAL '24 hours'
ORDER BY package_id, ts DESC;"

run "CREATE VIEW vehicle_fault_agg AS
SELECT
    vf.vehicle_id,
    COUNT(*) AS active_fault_count,
    COUNT(*) FILTER (WHERE fc.severity = 'CRITICAL') AS critical_fault_count,
    MAX(CASE fc.severity WHEN 'CRITICAL' THEN 3 WHEN 'WARNING' THEN 2 ELSE 1 END) AS severity_rank,
    string_agg(vf.code, ', ' ORDER BY vf.occurred_at) AS fault_codes
FROM vehicle_faults vf
JOIN fault_codes fc ON fc.code = vf.code
WHERE vf.cleared_at IS NULL
GROUP BY vf.vehicle_id;"

run "CREATE VIEW open_work_orders_agg AS
SELECT vehicle_id, COUNT(*) AS open_work_orders
FROM maintenance_orders
WHERE status IN ('OPEN', 'IN_PROGRESS')
GROUP BY vehicle_id;"

# ============================================================
# Gold: cross-silo context views. These are what make the "context
# graph" real — one row pre-joins historian + ops + fleet.
# ============================================================
echo "Creating gold materialized views..."

# The hero view: one row per active package with everything a copilot
# needs to answer "where is it and why is it at risk?"
#
# The equipment that matters is the *planned sorter* while the package is
# still upstream of sortation (a jam there strands it), and the last
# scanned equipment afterwards.
run "CREATE MATERIALIZED VIEW package_context_mv IN CLUSTER compute AS
WITH pkg AS (
    SELECT
        p.*,
        ls.ts AS last_scan_ts,
        ls.scan_type AS last_scan_type,
        ls.equipment_id AS last_scan_equipment_id,
        CASE
            WHEN p.status IN ('CREATED', 'ARRIVED_ORIGIN', 'INDUCTED')
                THEN p.planned_sort_equipment_id
            ELSE ls.equipment_id
        END AS relevant_equipment_id
    FROM packages p
    LEFT JOIN latest_package_scan ls ON ls.package_id = p.package_id
    WHERE p.status NOT IN ('DELIVERED', 'CANCELLED')
)
SELECT
    p.package_id,
    p.service_level,
    p.status,
    p.promised_delivery,
    p.origin_facility_id,
    p.dest_facility_id,
    p.current_facility_id,
    f.name AS current_facility_name,
    p.last_scan_ts,
    p.last_scan_type,
    p.planned_sort_equipment_id,
    p.relevant_equipment_id AS equipment_id,
    e.name AS equipment_name,
    e.status AS equipment_status,
    COALESCE(ea.active_alarm_count, 0) AS equipment_alarm_count,
    CASE ea.severity_rank WHEN 3 THEN 'CRITICAL' WHEN 2 THEN 'WARNING' WHEN 1 THEN 'INFO' END
        AS equipment_alarm_severity,
    laa.message AS equipment_alarm_message,
    p.assigned_trailer_id AS trailer_id,
    t.status AS trailer_status,
    t.door AS trailer_door,
    t.scheduled_departure AS trailer_scheduled_departure,
    t.tractor_vehicle_id AS tractor_id,
    COALESCE(vf.active_fault_count, 0) AS tractor_fault_count,
    CASE vf.severity_rank WHEN 3 THEN 'CRITICAL' WHEN 2 THEN 'WARNING' WHEN 1 THEN 'INFO' END
        AS tractor_fault_severity,
    vf.fault_codes AS tractor_fault_codes,
    (COALESCE(ea.active_alarm_count, 0) > 0
        AND p.status IN ('CREATED', 'ARRIVED_ORIGIN', 'INDUCTED')) AS equipment_at_risk,
    (COALESCE(vf.critical_fault_count, 0) > 0) AS tractor_at_risk,
    CASE
        WHEN (ea.severity_rank = 3 AND p.status IN ('CREATED', 'ARRIVED_ORIGIN', 'INDUCTED'))
            OR vf.severity_rank = 3 THEN 'HIGH'
        WHEN (COALESCE(ea.active_alarm_count, 0) > 0
                AND p.status IN ('CREATED', 'ARRIVED_ORIGIN', 'INDUCTED'))
            OR COALESCE(vf.active_fault_count, 0) > 0 THEN 'MEDIUM'
        ELSE 'LOW'
    END AS risk_level
FROM pkg p
LEFT JOIN facilities f ON f.facility_id = p.current_facility_id
LEFT JOIN equipment e ON e.equipment_id = p.relevant_equipment_id
LEFT JOIN equipment_alarm_agg ea ON ea.equipment_id = p.relevant_equipment_id
LEFT JOIN latest_active_alarm laa ON laa.equipment_id = p.relevant_equipment_id
LEFT JOIN trailers t ON t.trailer_id = p.assigned_trailer_id
LEFT JOIN vehicle_fault_agg vf ON vf.vehicle_id = t.tractor_vehicle_id;"

# Per-facility health rollup for the dashboard and the copilot.
run "CREATE MATERIALIZED VIEW hub_health_mv IN CLUSTER compute AS
WITH scans_10m AS (
    SELECT facility_id, COUNT(*) AS scans_last_10m
    FROM scan_events
    WHERE mz_now() <= ts + INTERVAL '10 minutes'
    GROUP BY facility_id
),
alarm_rollup AS (
    SELECT
        e.facility_id,
        COUNT(*) AS active_alarms,
        COUNT(*) FILTER (WHERE a.severity = 'CRITICAL') AS critical_alarms
    FROM alarms a
    JOIN equipment e ON e.equipment_id = a.equipment_id
    WHERE a.cleared_at IS NULL
    GROUP BY e.facility_id
),
equip_rollup AS (
    SELECT
        facility_id,
        COUNT(*) AS equipment_total,
        COUNT(*) FILTER (WHERE status = 'DOWN') AS equipment_down,
        COUNT(*) FILTER (WHERE status = 'DEGRADED') AS equipment_degraded
    FROM equipment
    GROUP BY facility_id
),
sorter_throughput AS (
    SELECT e.facility_id, AVG(s.avg_value) AS avg_sorter_throughput_pph
    FROM equipment_tag_stats_5m s
    JOIN equipment e ON e.equipment_id = s.equipment_id
    WHERE s.tag_name = 'throughput_pph' AND e.equipment_type = 'SORTER'
    GROUP BY e.facility_id
)
SELECT
    f.facility_id,
    f.name,
    f.city,
    f.state,
    COALESCE(s.scans_last_10m, 0) AS scans_last_10m,
    COALESCE(a.active_alarms, 0) AS active_alarms,
    COALESCE(a.critical_alarms, 0) AS critical_alarms,
    eq.equipment_total,
    COALESCE(eq.equipment_down, 0) AS equipment_down,
    COALESCE(eq.equipment_degraded, 0) AS equipment_degraded,
    st.avg_sorter_throughput_pph,
    CASE
        WHEN COALESCE(a.critical_alarms, 0) > 0 OR COALESCE(eq.equipment_down, 0) > 0 THEN 'CRITICAL'
        WHEN COALESCE(a.active_alarms, 0) > 0 OR COALESCE(eq.equipment_degraded, 0) > 0 THEN 'DEGRADED'
        ELSE 'HEALTHY'
    END AS health_status
FROM facilities f
LEFT JOIN scans_10m s ON s.facility_id = f.facility_id
LEFT JOIN alarm_rollup a ON a.facility_id = f.facility_id
LEFT JOIN equip_rollup eq ON eq.facility_id = f.facility_id
LEFT JOIN sorter_throughput st ON st.facility_id = f.facility_id;"

# Per-equipment live status: latest telemetry pivoted wide + alarm state.
run "CREATE MATERIALIZED VIEW equipment_status_mv IN CLUSTER compute AS
WITH latest_by_name AS (
    SELECT t.equipment_id, t.tag_name, ltv.value, ltv.ts
    FROM latest_tag_values ltv
    JOIN tags t ON t.tag_id = ltv.tag_id
)
SELECT
    e.equipment_id,
    e.facility_id,
    e.equipment_type,
    e.name,
    e.status,
    MAX(CASE WHEN l.tag_name = 'belt_speed_fpm' THEN l.value END) AS belt_speed_fpm,
    MAX(CASE WHEN l.tag_name = 'motor_temp_c' THEN l.value END) AS motor_temp_c,
    MAX(CASE WHEN l.tag_name = 'vibration_mm_s' THEN l.value END) AS vibration_mm_s,
    MAX(CASE WHEN l.tag_name = 'throughput_pph' THEN l.value END) AS throughput_pph,
    MAX(CASE WHEN l.tag_name = 'read_rate_pct' THEN l.value END) AS read_rate_pct,
    MAX(l.ts) AS latest_reading_ts,
    COALESCE(MAX(ea.active_alarm_count), 0) AS active_alarm_count,
    CASE MAX(ea.severity_rank) WHEN 3 THEN 'CRITICAL' WHEN 2 THEN 'WARNING' WHEN 1 THEN 'INFO' END
        AS alarm_severity,
    MAX(laa.message) AS latest_alarm_message
FROM equipment e
LEFT JOIN latest_by_name l ON l.equipment_id = e.equipment_id
LEFT JOIN equipment_alarm_agg ea ON ea.equipment_id = e.equipment_id
LEFT JOIN latest_active_alarm laa ON laa.equipment_id = e.equipment_id
GROUP BY e.equipment_id, e.facility_id, e.equipment_type, e.name, e.status;"

# Per-vehicle fleet risk: faults + what the vehicle is hauling right now.
run "CREATE MATERIALIZED VIEW fleet_risk_mv IN CLUSTER compute AS
WITH loaded AS (
    SELECT assigned_trailer_id AS trailer_id, COUNT(*) AS loaded_package_count
    FROM packages
    WHERE status = 'LOADED' AND assigned_trailer_id IS NOT NULL
    GROUP BY assigned_trailer_id
)
SELECT
    v.vehicle_id,
    v.vehicle_type,
    v.home_facility_id,
    v.status,
    v.odometer_miles,
    d.driver_id,
    d.name AS driver_name,
    COALESCE(vf.active_fault_count, 0) AS active_fault_count,
    COALESCE(vf.critical_fault_count, 0) AS critical_fault_count,
    CASE vf.severity_rank WHEN 3 THEN 'CRITICAL' WHEN 2 THEN 'WARNING' WHEN 1 THEN 'INFO' END
        AS fault_severity,
    vf.fault_codes,
    COALESCE(owo.open_work_orders, 0) AS open_work_orders,
    t.trailer_id AS attached_trailer_id,
    t.status AS trailer_status,
    t.route_id,
    t.dest_facility_id AS trailer_dest_facility_id,
    COALESCE(l.loaded_package_count, 0) AS loaded_package_count,
    CASE
        WHEN COALESCE(vf.critical_fault_count, 0) > 0 THEN 'HIGH'
        WHEN COALESCE(vf.active_fault_count, 0) > 0 THEN 'MEDIUM'
        ELSE 'LOW'
    END AS risk_level
FROM vehicles v
LEFT JOIN drivers d ON d.assigned_vehicle_id = v.vehicle_id
LEFT JOIN vehicle_fault_agg vf ON vf.vehicle_id = v.vehicle_id
LEFT JOIN open_work_orders_agg owo ON owo.vehicle_id = v.vehicle_id
LEFT JOIN trailers t ON t.tractor_vehicle_id = v.vehicle_id
LEFT JOIN loaded l ON l.trailer_id = t.trailer_id;"

# Per-minute scan counts for the dashboard throughput sparkline.
run "CREATE MATERIALIZED VIEW hub_throughput_minute_mv IN CLUSTER compute AS
SELECT
    facility_id,
    date_trunc('minute', ts) AS minute,
    COUNT(*) AS scan_count
FROM scan_events
WHERE mz_now() <= ts + INTERVAL '15 minutes'
GROUP BY facility_id, date_trunc('minute', ts);"

# Lateness cannot be a projected column (mz_now() is only legal in
# WHERE/HAVING), so 'promise window approaching' is a filtered view.
run "CREATE VIEW late_package_risk_v AS
SELECT *
FROM package_context_mv
WHERE mz_now() >= promised_delivery - INTERVAL '4 hours';"

# ============================================================
# Serving indexes: what the API and copilot actually read.
# ============================================================
echo "Creating serving indexes..."
run "CREATE INDEX package_context_package_id_idx IN CLUSTER serving ON package_context_mv (package_id);"
run "CREATE INDEX package_context_risk_idx IN CLUSTER serving ON package_context_mv (risk_level);"
run "CREATE INDEX late_package_risk_package_id_idx IN CLUSTER serving ON late_package_risk_v (package_id);"
run "CREATE INDEX hub_health_facility_id_idx IN CLUSTER serving ON hub_health_mv (facility_id);"
run "CREATE INDEX equipment_status_equipment_id_idx IN CLUSTER serving ON equipment_status_mv (equipment_id);"
run "CREATE INDEX equipment_status_facility_id_idx IN CLUSTER serving ON equipment_status_mv (facility_id);"
run "CREATE INDEX fleet_risk_vehicle_id_idx IN CLUSTER serving ON fleet_risk_mv (vehicle_id);"
run "CREATE INDEX active_alarms_equipment_id_idx IN CLUSTER serving ON active_alarms (equipment_id);"
run "CREATE INDEX hub_throughput_facility_id_idx IN CLUSTER serving ON hub_throughput_minute_mv (facility_id);"

echo "Materialize initialization complete."
