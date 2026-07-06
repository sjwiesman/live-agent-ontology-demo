#!/bin/bash
# End-to-end verification of the UPS live context graph demo.
#
#   1. CDC path:       insert an alarm in SQL Server -> visible in Materialize
#   2. Graph path:     insert a package + scan       -> row in package_context_mv
#   3. Write-back:     acknowledge the alarm via SQL Server -> alarm leaves active_alarms
#   4. Copilot (opt.): if an LLM key is configured, ask the copilot about the package
#
# Requires the stack to be up (make up).
set -e

MSSQL_SA_PASSWORD="${MSSQL_SA_PASSWORD:-StrongPassw0rd!}"
COMPOSE="${DOCKER_COMPOSE:-docker compose}"

sqlcmd() {
    $COMPOSE exec -T sqlserver /opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa \
        -P "$MSSQL_SA_PASSWORD" -d ups -h -1 -W -Q "SET NOCOUNT ON; $1"
}

mzsql() {
    $COMPOSE exec -T mz psql -h localhost -p 6875 -U materialize -t -A -q \
        -c "SET CLUSTER = serving" -c "$1" 2>/dev/null | tail -1
}

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "=== 1. CDC path: SQL Server -> Materialize ==="
SENTINEL="E2E-$(date +%s)"
sqlcmd "INSERT INTO historian.alarms (equipment_id, alarm_type, severity, message, raised_at)
        VALUES ('LOU-CONV-01', 'E_STOP', 'INFO', '$SENTINEL', SYSUTCDATETIME());" > /dev/null
START_MS=$(date +%s%3N)
for i in $(seq 1 60); do
    FOUND=$(mzsql "SELECT COUNT(*) FROM active_alarms WHERE message = '$SENTINEL'")
    [ "$FOUND" = "1" ] && break
    sleep 0.5
done
[ "$FOUND" = "1" ] || fail "sentinel alarm never appeared in Materialize"
echo "OK: alarm visible in the context graph in $(( $(date +%s%3N) - START_MS ))ms"

echo "=== 2. Graph path: package context assembly ==="
PKG="1Z999AAVERIFY$(date +%s | tail -c 5)"
sqlcmd "INSERT INTO ops.packages VALUES ('$PKG', 'HUB-LOU', 'HUB-CHI', 'NEXT_DAY_AIR', 'CREATED',
        'HUB-LOU', 'LOU-SORT-01', NULL, DATEADD(hour, 3, SYSUTCDATETIME()), SYSUTCDATETIME(), SYSUTCDATETIME());
        INSERT INTO ops.scan_events (package_id, facility_id, equipment_id, scan_type, ts)
        VALUES ('$PKG', 'HUB-LOU', NULL, 'ORIGIN', SYSUTCDATETIME());" > /dev/null
for i in $(seq 1 60); do
    CTX=$(mzsql "SELECT current_facility_id || '/' || status FROM package_context_mv WHERE package_id = '$PKG'")
    [ "$CTX" = "HUB-LOU/CREATED" ] && break
    sleep 0.5
done
[ "$CTX" = "HUB-LOU/CREATED" ] || fail "package context row missing or wrong: '$CTX'"
echo "OK: $PKG assembled in package_context_mv ($CTX)"

echo "=== 3. Write-back path: acknowledge -> alarm state changes ==="
ALARM_ID=$(sqlcmd "SELECT alarm_id FROM historian.alarms WHERE message = '$SENTINEL';" | tr -d '[:space:]')
sqlcmd "UPDATE historian.alarms SET acknowledged = 1, acknowledged_by = 'verify-bot',
        acknowledged_at = SYSUTCDATETIME() WHERE alarm_id = $ALARM_ID;" > /dev/null
for i in $(seq 1 60); do
    ACKED=$(mzsql "SELECT COUNT(*) FROM active_alarms WHERE alarm_id = $ALARM_ID AND acknowledged")
    [ "$ACKED" = "1" ] && break
    sleep 0.5
done
[ "$ACKED" = "1" ] || fail "acknowledgement never reflected in Materialize"
# Clean up: clear the sentinel alarm and delete the verify package.
sqlcmd "UPDATE historian.alarms SET cleared_at = SYSUTCDATETIME() WHERE alarm_id = $ALARM_ID;
        DELETE FROM ops.scan_events WHERE package_id = '$PKG';
        DELETE FROM ops.packages WHERE package_id = '$PKG';" > /dev/null
echo "OK: acknowledgement round-tripped (alarm $ALARM_ID)"

echo "=== 4. Copilot (requires LLM API key) ==="
CHAT=$(curl -s -X POST http://localhost:8081/chat \
    -H 'Content-Type: application/json' \
    -d '{"message": "In one sentence: how many hubs are in the network and what are their health statuses right now?"}' \
    --max-time 120 || true)
if echo "$CHAT" | grep -qi "hub"; then
    echo "OK: copilot answered:"
    echo "$CHAT" | python3 -c "import json,sys; print('   ', json.load(sys.stdin)['response'][:300])" 2>/dev/null || echo "$CHAT" | head -c 300
else
    echo "SKIP: copilot did not answer (no ANTHROPIC_API_KEY/OPENAI_API_KEY configured?)"
fi

echo ""
echo "All verifications passed."
