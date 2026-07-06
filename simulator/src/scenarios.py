"""Scenario engine: injectable failure stories shared across simulator loops.

Scenarios mutate a shared in-memory state that the historian / package /
fleet loops consult each tick, plus one-time writes to SQL Server (alarms,
equipment status, vehicle faults) so the failure is visible in the source
of record immediately.
"""

import logging
import random
import threading
import time
from datetime import datetime, timezone

from src.db import LoopConnection

logger = logging.getLogger(__name__)


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class ScenarioState:
    """Thread-safe registry of active scenarios."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # equipment_id -> {"kind": "jam"|"scanner", "until": epoch, "alarm_id": int}
        self.equipment_effects: dict[str, dict] = {}
        # vehicle_id -> {"until": epoch, "fault_id": int}
        self.vehicle_effects: dict[str, dict] = {}

    def add_equipment_effect(self, equipment_id: str, effect: dict) -> None:
        with self._lock:
            self.equipment_effects[equipment_id] = effect

    def add_vehicle_effect(self, vehicle_id: str, effect: dict) -> None:
        with self._lock:
            self.vehicle_effects[vehicle_id] = effect

    def effect_for_equipment(self, equipment_id: str) -> dict | None:
        with self._lock:
            eff = self.equipment_effects.get(equipment_id)
            return dict(eff) if eff else None

    def jammed_equipment(self) -> set[str]:
        with self._lock:
            return {eq for eq, eff in self.equipment_effects.items() if eff["kind"] == "jam"}

    def faulted_vehicles(self) -> set[str]:
        with self._lock:
            return set(self.vehicle_effects)

    def expire(self, conn: LoopConnection) -> None:
        """Clear effects past their deadline and their SQL Server artifacts."""
        now = time.time()
        with self._lock:
            expired_eq = [(eq, eff) for eq, eff in self.equipment_effects.items() if eff["until"] <= now]
            expired_veh = [(v, eff) for v, eff in self.vehicle_effects.items() if eff["until"] <= now]
            for eq, _ in expired_eq:
                del self.equipment_effects[eq]
            for v, _ in expired_veh:
                del self.vehicle_effects[v]

        for eq, eff in expired_eq:
            conn.execute(
                "UPDATE historian.alarms SET cleared_at = %s WHERE alarm_id = %s AND cleared_at IS NULL",
                (utcnow(), eff["alarm_id"]),
            )
            conn.execute(
                "UPDATE ops.equipment SET status = 'RUNNING' WHERE equipment_id = %s", (eq,)
            )
            logger.info("Scenario on %s expired; alarm %s cleared", eq, eff["alarm_id"])

        for v, eff in expired_veh:
            conn.execute(
                "UPDATE fleet.vehicle_faults SET cleared_at = %s WHERE fault_id = %s AND cleared_at IS NULL",
                (utcnow(), eff["fault_id"]),
            )
            logger.info("Scenario fault on vehicle %s expired", v)

    def clear_acknowledged(self, conn: LoopConnection) -> None:
        """A worker acknowledging a scenario alarm resolves the jam early —
        the copilot's write-back visibly un-sticks the hub."""
        with self._lock:
            alarm_ids = {eff["alarm_id"]: eq for eq, eff in self.equipment_effects.items()}
        if not alarm_ids:
            return
        placeholders = ",".join(["%s"] * len(alarm_ids))
        rows = conn.query(
            f"SELECT alarm_id FROM historian.alarms WHERE alarm_id IN ({placeholders}) AND acknowledged = 1",
            tuple(alarm_ids),
        )
        for (alarm_id,) in rows:
            eq = alarm_ids[alarm_id]
            with self._lock:
                self.equipment_effects.pop(eq, None)
            conn.execute(
                "UPDATE historian.alarms SET cleared_at = %s WHERE alarm_id = %s AND cleared_at IS NULL",
                (utcnow(), alarm_id),
            )
            conn.execute("UPDATE ops.equipment SET status = 'RUNNING' WHERE equipment_id = %s", (eq,))
            logger.info("Alarm %s acknowledged; clearing jam on %s", alarm_id, eq)


scenario_state = ScenarioState()


def reconcile_on_startup(conn: LoopConnection) -> None:
    """All failure state is owned by this simulator, and scenario effects
    live in memory. After a restart the memory is gone, so any leftover
    alarms/faults/downed equipment would be orphaned forever — reset the
    world to healthy and let scenarios re-break it."""
    conn.execute("UPDATE historian.alarms SET cleared_at = %s WHERE cleared_at IS NULL", (utcnow(),))
    conn.execute("UPDATE ops.equipment SET status = 'RUNNING' WHERE status <> 'RUNNING'")
    conn.execute("UPDATE fleet.vehicle_faults SET cleared_at = %s WHERE cleared_at IS NULL", (utcnow(),))
    logger.info("Reconciled leftover scenario state (alarms/faults cleared, equipment RUNNING)")


def _supersede_alarms(conn: LoopConnection, equipment_id: str) -> None:
    """A new scenario on this equipment replaces any still-open alarm —
    without this, back-to-back jams on the same sorter leak forever-active
    alarms whose in-memory effect was overwritten."""
    conn.execute(
        "UPDATE historian.alarms SET cleared_at = %s WHERE equipment_id = %s AND cleared_at IS NULL",
        (utcnow(), equipment_id),
    )


def trigger_conveyor_jam(conn: LoopConnection, equipment_id: str | None, duration_s: float) -> dict:
    equipment_id = equipment_id or "LOU-SORT-04"
    row = conn.query(
        "SELECT facility_id FROM ops.equipment WHERE equipment_id = %s", (equipment_id,)
    )
    if not row:
        return {"error": f"unknown equipment {equipment_id}"}

    _supersede_alarms(conn, equipment_id)
    conn.execute(
        "INSERT INTO historian.alarms (equipment_id, alarm_type, severity, message, raised_at) "
        "VALUES (%s, 'JAM', 'CRITICAL', %s, %s)",
        (equipment_id, f"Package jam detected on {equipment_id}: belt stalled, motor overcurrent", utcnow()),
    )
    alarm_id = conn.query("SELECT MAX(alarm_id) FROM historian.alarms WHERE equipment_id = %s", (equipment_id,))[0][0]
    conn.execute("UPDATE ops.equipment SET status = 'DOWN' WHERE equipment_id = %s", (equipment_id,))
    scenario_state.add_equipment_effect(
        equipment_id, {"kind": "jam", "until": time.time() + duration_s, "alarm_id": alarm_id}
    )
    logger.info("JAM triggered on %s (alarm %s, %ss)", equipment_id, alarm_id, duration_s)
    return {"scenario": "conveyor_jam", "equipment_id": equipment_id, "alarm_id": alarm_id, "duration_s": duration_s}


def trigger_scanner_degraded(conn: LoopConnection, equipment_id: str | None, duration_s: float) -> dict:
    if equipment_id is None:
        scanners = conn.query("SELECT equipment_id FROM ops.equipment WHERE equipment_type = 'SCANNER'")
        equipment_id = random.choice(scanners)[0]

    _supersede_alarms(conn, equipment_id)
    conn.execute(
        "INSERT INTO historian.alarms (equipment_id, alarm_type, severity, message, raised_at) "
        "VALUES (%s, 'MISSORT', 'WARNING', %s, %s)",
        (equipment_id, f"Read rate degraded on {equipment_id}: labels rejected above threshold", utcnow()),
    )
    alarm_id = conn.query("SELECT MAX(alarm_id) FROM historian.alarms WHERE equipment_id = %s", (equipment_id,))[0][0]
    conn.execute("UPDATE ops.equipment SET status = 'DEGRADED' WHERE equipment_id = %s", (equipment_id,))
    scenario_state.add_equipment_effect(
        equipment_id, {"kind": "scanner", "until": time.time() + duration_s, "alarm_id": alarm_id}
    )
    logger.info("Scanner degraded on %s (alarm %s)", equipment_id, alarm_id)
    return {"scenario": "scanner_degraded", "equipment_id": equipment_id, "alarm_id": alarm_id, "duration_s": duration_s}


def trigger_tractor_fault(conn: LoopConnection, vehicle_id: str | None, duration_s: float) -> dict:
    if vehicle_id is None:
        # Prefer a tractor hooked to a trailer that is currently loading —
        # that's the cross-silo story (packages on it become at-risk).
        rows = conn.query(
            "SELECT t.tractor_vehicle_id FROM ops.trailers t "
            "WHERE t.tractor_vehicle_id IS NOT NULL AND t.status = 'LOADING'"
        )
        if not rows:
            rows = conn.query(
                "SELECT tractor_vehicle_id FROM ops.trailers WHERE tractor_vehicle_id IS NOT NULL"
            )
        if not rows:
            return {"error": "no tractor attached to any trailer"}
        vehicle_id = random.choice(rows)[0]

    conn.execute(
        "INSERT INTO fleet.vehicle_faults (vehicle_id, code, occurred_at) VALUES (%s, 'SPN-100', %s)",
        (vehicle_id, utcnow()),
    )
    fault_id = conn.query(
        "SELECT MAX(fault_id) FROM fleet.vehicle_faults WHERE vehicle_id = %s", (vehicle_id,)
    )[0][0]
    scenario_state.add_vehicle_effect(vehicle_id, {"until": time.time() + duration_s, "fault_id": fault_id})
    logger.info("Tractor fault on %s (fault %s)", vehicle_id, fault_id)
    return {"scenario": "tractor_fault", "vehicle_id": vehicle_id, "fault_id": fault_id, "duration_s": duration_s}


SCENARIOS = {
    "conveyor_jam": trigger_conveyor_jam,
    "scanner_degraded": trigger_scanner_degraded,
    "tractor_fault": trigger_tractor_fault,
}
