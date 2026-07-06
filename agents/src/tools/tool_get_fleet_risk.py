"""Fleet risk: vehicle faults joined to what each vehicle is hauling."""

from typing import Optional

from langchain_core.tools import tool

from src.tools.mz import mz_fetch


@tool
async def get_fleet_risk(
    vehicle_id: Optional[str] = None, facility_id: Optional[str] = None
) -> dict:
    """Get live fleet risk for vehicles.

    Per vehicle: active fault codes and severity, open maintenance work
    orders, the driver, the attached trailer and its route, how many
    packages are loaded on that trailer right now, and a risk_level.
    This is where a fleet problem becomes a package problem: a CRITICAL
    fault on a tractor puts every package on its trailer at risk.

    Args:
        vehicle_id: One vehicle (e.g. "TRC-110").
        facility_id: Vehicles based at one hub (e.g. "HUB-LOU").

    Returns:
        dict with 'count' and 'vehicles', highest risk first.
    """
    if vehicle_id:
        rows = await mz_fetch(
            "SELECT * FROM fleet_risk_mv WHERE vehicle_id = $1", vehicle_id.strip()
        )
        if not rows:
            return {"error": f"Unknown vehicle {vehicle_id}"}
        return {"count": len(rows), "vehicles": rows}
    query = "SELECT * FROM fleet_risk_mv"
    args: list = []
    if facility_id:
        args.append(facility_id.strip())
        query += f" WHERE home_facility_id = ${len(args)}"
    query += (
        " ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,"
        " vehicle_id LIMIT 100"
    )
    rows = await mz_fetch(query, *args)
    return {"count": len(rows), "vehicles": rows}
