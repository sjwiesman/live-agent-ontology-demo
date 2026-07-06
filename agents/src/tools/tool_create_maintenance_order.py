"""Write-back: open a maintenance work order in SQL Server."""

import time
from datetime import datetime, timezone

from langchain_core.tools import tool

from src.tools.mssql import mssql_execute

VALID_PRIORITIES = {"LOW", "MEDIUM", "HIGH", "URGENT"}


@tool
async def create_maintenance_order(
    vehicle_id: str, priority: str, description: str, created_by: str
) -> dict:
    """Open a maintenance work order for a vehicle in the system of record.

    Use this after diagnosing a vehicle fault (see get_fleet_risk) so the
    shop can act. The work order is inserted into SQL Server and appears
    in the vehicle's live fleet-risk context within seconds.

    Confirm with the user before creating, and pass their name or
    identifier as created_by.

    Args:
        vehicle_id: The vehicle needing service (e.g. "TRC-110").
        priority: LOW, MEDIUM, HIGH, or URGENT.
        description: What needs attention (include fault codes).
        created_by: Who is opening the order (worker name or id).

    Returns:
        dict with the new work_order_id.
    """
    priority = priority.strip().upper()
    if priority not in VALID_PRIORITIES:
        return {"error": f"priority must be one of {sorted(VALID_PRIORITIES)}"}
    vehicle_id = vehicle_id.strip()
    description = description.strip()[:400]
    created_by = created_by.strip()[:100]
    if not (vehicle_id and description and created_by):
        return {"error": "vehicle_id, description, and created_by are all required"}

    work_order_id = f"WO-{int(time.time())}"

    def do(cur):
        cur.execute("SELECT vehicle_type FROM fleet.vehicles WHERE vehicle_id = %s", (vehicle_id,))
        row = cur.fetchone()
        if row is None:
            return {"error": f"Vehicle {vehicle_id} does not exist."}
        cur.execute(
            "INSERT INTO fleet.maintenance_orders "
            "(work_order_id, vehicle_id, status, priority, description, opened_at, created_by) "
            "VALUES (%s, %s, 'OPEN', %s, %s, %s, %s)",
            (
                work_order_id,
                vehicle_id,
                priority,
                description,
                datetime.now(timezone.utc).replace(tzinfo=None),
                created_by,
            ),
        )
        return {
            "result": "created",
            "work_order_id": work_order_id,
            "vehicle_id": vehicle_id,
            "priority": priority,
            "note": "Written to SQL Server; visible in fleet risk context within seconds.",
        }

    return await mssql_execute(do)
