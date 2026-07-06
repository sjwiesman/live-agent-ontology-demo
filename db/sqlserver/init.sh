#!/bin/bash
# One-shot initializer for the UPS SQL Server database.
# Runs inside the mssql image (has sqlcmd) as the `sqlserver-init` service.
set -e

SQLCMD=/opt/mssql-tools18/bin/sqlcmd
HOST="${MSSQL_HOST:-sqlserver}"
SA_PASSWORD="${MSSQL_SA_PASSWORD:?MSSQL_SA_PASSWORD is required}"
MZ_SQLSERVER_PASSWORD="${MZ_SQLSERVER_PASSWORD:?MZ_SQLSERVER_PASSWORD is required}"

echo "Waiting for SQL Server at ${HOST}..."
until $SQLCMD -C -S "$HOST" -U sa -P "$SA_PASSWORD" -Q "SELECT 1" -b -o /dev/null 2>/dev/null; do
    sleep 3
done
echo "SQL Server is ready."

# Idempotence: if the ups database already has CDC enabled, skip everything.
IS_INIT=$($SQLCMD -C -S "$HOST" -U sa -P "$SA_PASSWORD" -h -1 -W -Q \
    "SET NOCOUNT ON; SELECT COALESCE((SELECT is_cdc_enabled FROM sys.databases WHERE name='ups'), 0);" | tr -d '[:space:]')
if [ "$IS_INIT" = "1" ]; then
    echo "Database 'ups' already initialized with CDC; skipping."
    exit 0
fi

run() {
    echo "--- running $1"
    # -v passes the Materialize password into 03_materialize_user.sql;
    # harmless for the other scripts.
    $SQLCMD -C -S "$HOST" -U sa -P "$SA_PASSWORD" -b \
        -v MZ_SQLSERVER_PASSWORD="$MZ_SQLSERVER_PASSWORD" \
        -i "$1"
}

run /scripts/01_create_database.sql
run /scripts/02_schemas_and_tables.sql
run /scripts/03_materialize_user.sql
run /scripts/04_enable_cdc.sql

# Restart the capture job so the 1s polling interval takes effect. The SQL
# Server Agent sometimes restarts it on its own after the stop in
# 04_enable_cdc.sql; "already running" is success, not failure.
sleep 2
$SQLCMD -C -S "$HOST" -U sa -P "$SA_PASSWORD" \
    -Q "USE ups; EXEC sys.sp_cdc_start_job @job_type='capture';" \
    || echo "capture job already running; new polling interval applies"

echo "SQL Server initialization complete."
