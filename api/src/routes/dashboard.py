"""Dashboard reads: everything the UI polls, in one round trip each."""

from typing import Optional

from fastapi import APIRouter, Query

from src.db import fetch_dicts

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard/summary")
async def dashboard_summary() -> dict:
    """One payload for the 2s dashboard poll: hub health, active alarms,
    at-risk packages, fleet risk, and equipment status."""
    hubs = await fetch_dicts("SELECT * FROM hub_health_mv ORDER BY facility_id")
    alarms = await fetch_dicts(
        "SELECT * FROM active_alarms ORDER BY raised_at DESC LIMIT 25"
    )
    at_risk = await fetch_dicts(
        "SELECT * FROM package_context_mv WHERE risk_level <> 'LOW' "
        "ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 ELSE 1 END, promised_delivery "
        "LIMIT 15"
    )
    at_risk_counts = await fetch_dicts(
        "SELECT risk_level, COUNT(*) AS count FROM package_context_mv GROUP BY risk_level"
    )
    fleet = await fetch_dicts(
        "SELECT * FROM fleet_risk_mv WHERE risk_level <> 'LOW' "
        "ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 ELSE 1 END, vehicle_id LIMIT 15"
    )
    equipment = await fetch_dicts(
        "SELECT * FROM equipment_status_mv ORDER BY facility_id, equipment_type, equipment_id"
    )
    throughput = await fetch_dicts(
        "SELECT * FROM hub_throughput_minute_mv ORDER BY facility_id, minute"
    )
    return {
        "hubs": hubs,
        "alarms": alarms,
        "at_risk_packages": at_risk,
        "package_risk_counts": {r["risk_level"]: r["count"] for r in at_risk_counts},
        "fleet_risk": fleet,
        "equipment": equipment,
        "throughput": throughput,
    }


@router.get("/hubs/{facility_id}/throughput")
async def hub_throughput(facility_id: str) -> list[dict]:
    return await fetch_dicts(
        "SELECT * FROM hub_throughput_minute_mv WHERE facility_id = $1 ORDER BY minute",
        facility_id,
    )


@router.get("/alarms/active")
async def active_alarms(
    facility_id: Optional[str] = Query(None), severity: Optional[str] = Query(None)
) -> list[dict]:
    query = "SELECT * FROM active_alarms WHERE 1 = 1"
    args = []
    if facility_id:
        args.append(facility_id)
        query += f" AND facility_id = ${len(args)}"
    if severity:
        args.append(severity.upper())
        query += f" AND severity = ${len(args)}"
    query += " ORDER BY raised_at DESC LIMIT 100"
    return await fetch_dicts(query, *args)


@router.get("/equipment")
async def equipment(facility_id: Optional[str] = Query(None)) -> list[dict]:
    if facility_id:
        return await fetch_dicts(
            "SELECT * FROM equipment_status_mv WHERE facility_id = $1 "
            "ORDER BY equipment_type, equipment_id",
            facility_id,
        )
    return await fetch_dicts(
        "SELECT * FROM equipment_status_mv ORDER BY facility_id, equipment_type, equipment_id"
    )


@router.get("/fleet/risk")
async def fleet_risk(risk_level: Optional[str] = Query(None)) -> list[dict]:
    if risk_level:
        return await fetch_dicts(
            "SELECT * FROM fleet_risk_mv WHERE risk_level = $1 ORDER BY vehicle_id",
            risk_level.upper(),
        )
    return await fetch_dicts(
        "SELECT * FROM fleet_risk_mv "
        "ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, vehicle_id"
    )
