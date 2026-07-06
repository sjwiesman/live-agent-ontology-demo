"""Live equipment status: telemetry + alarms for one machine or a hub."""

from typing import Optional

from langchain_core.tools import tool

from src.tools.mz import mz_fetch


@tool
async def get_equipment_status(
    equipment_id: Optional[str] = None, facility_id: Optional[str] = None
) -> dict:
    """Get live status for sortation equipment.

    Per machine: status (RUNNING/DEGRADED/DOWN), the latest historian
    readings (belt speed fpm, motor temp °C, vibration mm/s, throughput
    pph, scanner read rate %), active alarm count/severity, and the
    latest alarm message. Also returns 5-minute rolling min/avg/max per
    tag when a single equipment_id is requested.

    Args:
        equipment_id: One machine (e.g. "LOU-SORT-04").
        facility_id: All machines at one hub (e.g. "HUB-LOU").
        Provide one or the other; equipment_id wins if both.

    Returns:
        dict with 'equipment' rows and optionally 'tag_stats_5m'.
    """
    if equipment_id:
        rows = await mz_fetch(
            "SELECT * FROM equipment_status_mv WHERE equipment_id = $1",
            equipment_id.strip(),
        )
        stats = await mz_fetch(
            "SELECT * FROM equipment_tag_stats_5m WHERE equipment_id = $1 ORDER BY tag_name",
            equipment_id.strip(),
        )
        if not rows:
            return {"error": f"Unknown equipment {equipment_id}"}
        return {"equipment": rows, "tag_stats_5m": stats}
    if facility_id:
        rows = await mz_fetch(
            "SELECT * FROM equipment_status_mv WHERE facility_id = $1 "
            "ORDER BY equipment_type, equipment_id",
            facility_id.strip(),
        )
        return {"equipment": rows}
    rows = await mz_fetch(
        "SELECT * FROM equipment_status_mv ORDER BY facility_id, equipment_type, equipment_id"
    )
    return {"equipment": rows}
