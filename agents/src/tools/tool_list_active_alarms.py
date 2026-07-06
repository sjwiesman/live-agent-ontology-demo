"""Active historian alarms."""

from typing import Optional

from langchain_core.tools import tool

from src.tools.mz import mz_fetch


@tool
async def list_active_alarms(
    facility_id: Optional[str] = None, severity: Optional[str] = None
) -> dict:
    """List active (uncleared) historian alarms, newest first.

    Each alarm carries alarm_id (needed for acknowledge_alarm), the
    equipment it was raised on, type (JAM/OVERTEMP/MISSORT/E_STOP),
    severity, message, and whether a worker has acknowledged it.

    Args:
        facility_id: Filter to one hub (e.g. "HUB-LOU").
        severity: Filter to "CRITICAL", "WARNING", or "INFO".

    Returns:
        dict with 'count' and 'alarms'.
    """
    query = "SELECT * FROM active_alarms WHERE 1 = 1"
    args: list = []
    if facility_id:
        args.append(facility_id.strip())
        query += f" AND facility_id = ${len(args)}"
    if severity:
        args.append(severity.strip().upper())
        query += f" AND severity = ${len(args)}"
    query += " ORDER BY raised_at DESC LIMIT 100"
    rows = await mz_fetch(query, *args)
    return {"count": len(rows), "alarms": rows}
