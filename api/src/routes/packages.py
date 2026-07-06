"""Package context reads: point lookups on the hero view."""

from typing import Optional

from fastapi import APIRouter, HTTPException, Query

from src.db import fetch_dicts

router = APIRouter(tags=["packages"])


@router.get("/packages/at-risk")
async def at_risk_packages(
    facility_id: Optional[str] = Query(None),
    risk_level: Optional[str] = Query(None),
    limit: int = Query(25, ge=1, le=200),
) -> list[dict]:
    query = "SELECT * FROM package_context_mv WHERE risk_level <> 'LOW'"
    args: list = []
    if facility_id:
        args.append(facility_id)
        query += f" AND current_facility_id = ${len(args)}"
    if risk_level:
        args.append(risk_level.upper())
        query = query.replace("risk_level <> 'LOW'", f"risk_level = ${len(args)}")
    args.append(limit)
    query += (
        " ORDER BY CASE risk_level WHEN 'HIGH' THEN 0 ELSE 1 END, promised_delivery"
        f" LIMIT ${len(args)}"
    )
    return await fetch_dicts(query, *args)


@router.get("/packages/{package_id}")
async def package_context(package_id: str) -> dict:
    rows = await fetch_dicts(
        "SELECT * FROM package_context_mv WHERE package_id = $1", package_id
    )
    if not rows:
        raise HTTPException(404, f"package {package_id} not found or already delivered")
    return rows[0]
