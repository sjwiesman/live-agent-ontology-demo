"""Hub health rollup from the historian + package flow."""

from typing import Optional

from langchain_core.tools import tool

from src.tools.mz import mz_fetch


@tool
async def get_hub_health(facility_id: Optional[str] = None) -> dict:
    """Get live operational health for hubs.

    Per hub: scans in the last 10 minutes (flow), active/critical alarm
    counts, equipment down/degraded counts, average sorter throughput
    (packages per hour, from historian telemetry), and an overall
    health_status of HEALTHY, DEGRADED, or CRITICAL.

    Report counts exactly as returned — never generalize. If one hub is
    CRITICAL and two are HEALTHY, say exactly that.

    Args:
        facility_id: One hub (e.g. "HUB-LOU"), or omit for all hubs.

    Returns:
        dict with 'hubs' (health rows) and 'throughput_by_minute' (scan
        counts per minute for the last ~15 minutes, for trend questions).
    """
    if facility_id:
        hubs = await mz_fetch(
            "SELECT * FROM hub_health_mv WHERE facility_id = $1", facility_id.strip()
        )
        tput = await mz_fetch(
            "SELECT * FROM hub_throughput_minute_mv WHERE facility_id = $1 ORDER BY minute",
            facility_id.strip(),
        )
    else:
        hubs = await mz_fetch("SELECT * FROM hub_health_mv ORDER BY facility_id")
        tput = await mz_fetch(
            "SELECT * FROM hub_throughput_minute_mv ORDER BY facility_id, minute"
        )
    return {"hubs": hubs, "throughput_by_minute": tput}
