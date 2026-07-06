"""Package lifecycle state machine.

Each package moves through:
    CREATED -> ARRIVED_ORIGIN -> INDUCTED -> SORTED -> LOADED
    -> IN_TRANSIT -> ARRIVED_DEST -> OUT_FOR_DELIVERY -> DELIVERED

Sortation transitions (INDUCT/SORT) are pinned to a specific piece of
equipment; a jam on that equipment freezes those packages in place, which
is exactly what surfaces as "at risk" in the context graph.
"""

import logging
import random
import string
from datetime import timedelta

from src.config import config
from src.db import LoopConnection
from src.scenarios import scenario_state, utcnow

logger = logging.getLogger(__name__)

SERVICE_LEVELS = ["NEXT_DAY_AIR", "2ND_DAY_AIR", "GROUND"]
# promised_delivery offset ranges (hours) — NEXT_DAY_AIR gets tight promises
# so the late-risk view always has interesting rows.
PROMISE_HOURS = {"NEXT_DAY_AIR": (2, 8), "2ND_DAY_AIR": (12, 30), "GROUND": (24, 72)}

# status -> (next_status, scan_type emitted on arrival at next status)
TRANSITIONS = {
    "CREATED": ("ARRIVED_ORIGIN", "ORIGIN"),
    "ARRIVED_ORIGIN": ("INDUCTED", "INDUCT"),
    "INDUCTED": ("SORTED", "SORT"),
    "SORTED": ("LOADED", "LOAD"),
    "LOADED": ("IN_TRANSIT", "DEPART"),      # handled at trailer granularity
    "IN_TRANSIT": ("ARRIVED_DEST", "ARRIVE"),  # handled at trailer granularity
    "ARRIVED_DEST": ("OUT_FOR_DELIVERY", None),
    "OUT_FOR_DELIVERY": ("DELIVERED", "DELIVER"),
}


def _tracking_number() -> str:
    body = "".join(random.choices(string.digits, k=10))
    return f"1Z999AA{body}"


class PackageFlow:
    """Owns package creation, per-package transitions, and trailer cycles."""

    def __init__(self, conn: LoopConnection) -> None:
        self.conn = conn
        self.facilities = [r[0] for r in conn.query("SELECT facility_id FROM ops.facilities")]
        self.sorters = {}
        self.conveyors = {}
        self.scanners = {}
        for eq_id, fac, eq_type in conn.query(
            "SELECT equipment_id, facility_id, equipment_type FROM ops.equipment"
        ):
            bucket = {"SORTER": self.sorters, "CONVEYOR": self.conveyors, "SCANNER": self.scanners}[eq_type]
            bucket.setdefault(fac, []).append(eq_id)

    # -------------------------------------------------- creation

    def create_packages(self, n: int) -> int:
        active = self.conn.query(
            "SELECT COUNT(*) FROM ops.packages WHERE status NOT IN ('DELIVERED')"
        )[0][0]
        n = min(n, max(0, config.MAX_ACTIVE_PACKAGES - active))
        now = utcnow()
        rows = []
        for _ in range(n):
            origin, dest = random.sample(self.facilities, 2)
            service = random.choice(SERVICE_LEVELS)
            lo, hi = PROMISE_HOURS[service]
            package_id = _tracking_number()
            planned_sorter = self._equipment_for("SORT", origin, package_id)
            rows.append((
                package_id, origin, dest, service, "CREATED", origin, planned_sorter, None,
                now + timedelta(hours=random.uniform(lo, hi)), now, now,
            ))
        if rows:
            self.conn.executemany(
                "INSERT INTO ops.packages VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)", rows
            )
        return len(rows)

    # -------------------------------------------------- per-package transitions

    def _equipment_for(self, scan_type: str, facility: str, package_id: str) -> str | None:
        """Deterministic equipment assignment so a package is 'routed
        through' a stable machine — hash, not random, so a jam consistently
        affects the same packages."""
        pool = None
        if scan_type == "INDUCT":
            pool = self.conveyors.get(facility)
        elif scan_type == "SORT":
            pool = self.sorters.get(facility)
        if not pool:
            return None
        return pool[hash(package_id) % len(pool)]

    def advance_packages(self, limit: int) -> int:
        """Advance a random sample of individually-transitioning packages.

        Random rather than oldest-first: packages held by a jam would
        otherwise pin the front of an age-ordered queue and starve the
        rest of the network for the duration of the jam.
        """
        rows = self.conn.query(
            "SELECT TOP (%s) package_id, status, current_facility_id, dest_facility_id "
            "FROM ops.packages "
            "WHERE status IN ('CREATED','ARRIVED_ORIGIN','INDUCTED','SORTED','ARRIVED_DEST','OUT_FOR_DELIVERY') "
            "ORDER BY NEWID()",
            (limit * 3,),
        )
        jammed = scenario_state.jammed_equipment()
        now = utcnow()
        advanced = 0
        for package_id, status, facility, dest in rows:
            if advanced >= limit:
                break
            next_status, scan_type = TRANSITIONS[status]
            equipment = self._equipment_for(scan_type, facility, package_id) if scan_type else None

            # A DOWN machine holds its packages: the jam story.
            if equipment and equipment in jammed:
                continue
            # SORTED -> LOADED needs an open trailer to the destination.
            if status == "SORTED":
                trailer = self._pick_trailer(facility, dest)
                if trailer is None:
                    continue
                self.conn.execute(
                    "UPDATE ops.packages SET status = 'LOADED', assigned_trailer_id = %s, updated_at = %s "
                    "WHERE package_id = %s",
                    (trailer, now, package_id),
                )
                self.conn.execute(
                    "UPDATE ops.trailers SET status = 'LOADING' WHERE trailer_id = %s AND status = 'OPEN'",
                    (trailer,),
                )
            else:
                self.conn.execute(
                    "UPDATE ops.packages SET status = %s, updated_at = %s WHERE package_id = %s",
                    (next_status, now, package_id),
                )
            if scan_type:
                self.conn.execute(
                    "INSERT INTO ops.scan_events (package_id, facility_id, equipment_id, scan_type, ts) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (package_id, facility, equipment, scan_type, now),
                )
            advanced += 1
        return advanced

    def _pick_trailer(self, origin: str, dest: str) -> str | None:
        rows = self.conn.query(
            "SELECT TOP 1 t.trailer_id FROM ops.trailers t "
            "JOIN ops.routes r ON r.route_id = t.route_id "
            "WHERE r.origin_facility_id = %s AND t.dest_facility_id = %s "
            "AND t.status IN ('OPEN','LOADING') ORDER BY t.trailer_id",
            (origin, dest),
        )
        return rows[0][0] if rows else None

    # -------------------------------------------------- trailer cycles

    def dispatch_trailers(self) -> int:
        """Dispatch LOADING trailers whose departure time has come, unless
        their tractor has an active critical fault (the fleet story)."""
        faulted = scenario_state.faulted_vehicles()
        now = utcnow()
        rows = self.conn.query(
            "SELECT trailer_id, tractor_vehicle_id, route_id, dest_facility_id FROM ops.trailers "
            "WHERE status = 'LOADING' AND scheduled_departure <= %s",
            (now,),
        )
        dispatched = 0
        for trailer_id, tractor, route_id, dest in rows:
            if tractor in faulted:
                continue  # grounded until the fault clears
            self.conn.execute(
                "UPDATE ops.trailers SET status = 'DISPATCHED' WHERE trailer_id = %s", (trailer_id,)
            )
            packages = self.conn.query(
                "SELECT package_id, current_facility_id FROM ops.packages "
                "WHERE assigned_trailer_id = %s AND status = 'LOADED'",
                (trailer_id,),
            )
            for package_id, facility in packages:
                self.conn.execute(
                    "UPDATE ops.packages SET status = 'IN_TRANSIT', updated_at = %s WHERE package_id = %s",
                    (now, package_id),
                )
                self.conn.execute(
                    "INSERT INTO ops.scan_events (package_id, facility_id, equipment_id, scan_type, ts) "
                    "VALUES (%s, %s, NULL, 'DEPART', %s)",
                    (package_id, facility, now),
                )
            dispatched += 1
        return dispatched

    def arrive_trailers(self) -> int:
        """Arrive DISPATCHED trailers after a compressed transit time
        (~90s regardless of route length: demo time, not real time)."""
        now = utcnow()
        rows = self.conn.query(
            "SELECT t.trailer_id, t.dest_facility_id FROM ops.trailers t "
            "WHERE t.status = 'DISPATCHED' AND NOT EXISTS ("
            "  SELECT 1 FROM ops.packages p WHERE p.assigned_trailer_id = t.trailer_id "
            "  AND p.status = 'IN_TRANSIT' AND p.updated_at > DATEADD(second, -90, %s))",
            (now,),
        )
        arrived = 0
        for trailer_id, dest in rows:
            packages = self.conn.query(
                "SELECT package_id FROM ops.packages WHERE assigned_trailer_id = %s AND status = 'IN_TRANSIT'",
                (trailer_id,),
            )
            for (package_id,) in packages:
                self.conn.execute(
                    "UPDATE ops.packages SET status = 'ARRIVED_DEST', current_facility_id = %s, "
                    "assigned_trailer_id = NULL, updated_at = %s WHERE package_id = %s",
                    (dest, now, package_id),
                )
                self.conn.execute(
                    "INSERT INTO ops.scan_events (package_id, facility_id, equipment_id, scan_type, ts) "
                    "VALUES (%s, %s, NULL, 'ARRIVE', %s)",
                    (package_id, dest, now),
                )
            # Recycle the trailer for its return leg: new departure window.
            self.conn.execute(
                "UPDATE ops.trailers SET status = 'OPEN', scheduled_departure = %s WHERE trailer_id = %s",
                (now + timedelta(seconds=random.randint(60, 180)), trailer_id),
            )
            arrived += 1
        return arrived
