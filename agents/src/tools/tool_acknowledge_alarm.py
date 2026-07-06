"""Write-back: acknowledge a historian alarm in SQL Server."""

from datetime import datetime, timezone

from langchain_core.tools import tool

from src.tools.mssql import mssql_execute


@tool
async def acknowledge_alarm(alarm_id: int, acknowledged_by: str) -> dict:
    """Acknowledge an active alarm in the historian (the system of record).

    Acknowledging tells the floor the alarm is being handled; for jam
    alarms it also releases the equipment back to service once the jam is
    cleared. The change is written to SQL Server and flows back through
    CDC into the live context graph within seconds.

    Confirm with the user before acknowledging, and pass their name or
    identifier as acknowledged_by.

    Args:
        alarm_id: The alarm to acknowledge (from list_active_alarms).
        acknowledged_by: Who is acknowledging (worker name or id).

    Returns:
        dict describing the result.
    """
    acknowledged_by = acknowledged_by.strip()[:100]
    if not acknowledged_by:
        return {"error": "acknowledged_by is required"}

    def do(cur):
        cur.execute(
            "SELECT equipment_id, severity, acknowledged, cleared_at "
            "FROM historian.alarms WHERE alarm_id = %s",
            (alarm_id,),
        )
        row = cur.fetchone()
        if row is None:
            return {"error": f"Alarm {alarm_id} does not exist."}
        equipment_id, severity, acknowledged, cleared_at = row
        if cleared_at is not None:
            return {"error": f"Alarm {alarm_id} is already cleared."}
        if acknowledged:
            return {"error": f"Alarm {alarm_id} is already acknowledged."}
        cur.execute(
            "UPDATE historian.alarms SET acknowledged = 1, acknowledged_by = %s, "
            "acknowledged_at = %s WHERE alarm_id = %s",
            (acknowledged_by, datetime.now(timezone.utc).replace(tzinfo=None), alarm_id),
        )
        return {
            "result": "acknowledged",
            "alarm_id": alarm_id,
            "equipment_id": equipment_id,
            "severity": severity,
            "acknowledged_by": acknowledged_by,
            "note": "Written to SQL Server; the context graph reflects it within seconds.",
        }

    return await mssql_execute(do)
