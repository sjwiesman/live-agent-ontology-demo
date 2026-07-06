"""Find packages whose upstream dependencies are unhealthy."""

from typing import Optional

from langchain_core.tools import tool

from src.tools.mz import mz_fetch


@tool
async def find_at_risk_packages(
    facility_id: Optional[str] = None,
    risk_level: Optional[str] = None,
    approaching_promise: bool = False,
    limit: int = 20,
) -> dict:
    """Find packages currently at risk, with the reason for the risk.

    A package is at risk when the equipment it is routed through has an
    active alarm, or the tractor pulling its trailer has an active fault.

    Args:
        facility_id: Filter to one hub (e.g. "HUB-LOU").
        risk_level: Filter to "HIGH" or "MEDIUM" (default: both).
        approaching_promise: If true, only packages within 4 hours of
            their delivery promise (the ones worth acting on first).
        limit: Max rows (default 20, max 100).

    Returns:
        dict with 'count' and 'packages' (each row includes risk_level,
        equipment_at_risk/tractor_at_risk flags, alarm and fault details).
    """
    limit = max(1, min(limit, 100))
    source = "late_package_risk_v" if approaching_promise else "package_context_mv"
    query = f"SELECT * FROM {source} WHERE risk_level <> 'LOW'"
    args: list = []
    if facility_id:
        args.append(facility_id.strip())
        query += f" AND current_facility_id = ${len(args)}"
    if risk_level:
        args.append(risk_level.strip().upper())
        query = query.replace("risk_level <> 'LOW'", f"risk_level = ${len(args)}")
    args.append(limit)
    query += (
        " ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 ELSE 1 END, promised_delivery"
        f" LIMIT ${len(args)}"
    )
    rows = await mz_fetch(query, *args)
    return {"count": len(rows), "packages": rows}
