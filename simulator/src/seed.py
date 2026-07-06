"""Idempotent reference-data seeding for the UPS demo."""

import logging
import random
from datetime import datetime, timedelta, timezone

from src.db import LoopConnection

logger = logging.getLogger(__name__)

FACILITIES = [
    ("HUB-LOU", "Worldport", "Louisville", "KY", "HUB"),
    ("HUB-CHI", "Chicago Area Consolidation Hub", "Hodgkins", "IL", "HUB"),
    ("HUB-DFW", "Dallas/Fort Worth Hub", "Dallas", "TX", "HUB"),
]

# (suffix, type, count-per-facility)
EQUIPMENT_LAYOUT = [
    ("CONV", "CONVEYOR", 4),
    ("SCAN", "SCANNER", 2),
    ("SORT", "SORTER", 4),
]

# (tag_name, unit, baseline, applies_to_types)
TAG_DEFS = [
    ("belt_speed_fpm", "fpm", 350.0, {"CONVEYOR", "SORTER"}),
    ("motor_temp_c", "degC", 55.0, {"CONVEYOR", "SORTER"}),
    ("vibration_mm_s", "mm/s", 2.0, {"CONVEYOR", "SORTER"}),
    ("throughput_pph", "pph", 8000.0, {"SORTER"}),
    ("read_rate_pct", "pct", 98.5, {"SCANNER"}),
]

FAULT_CODES = [
    ("SPN-100", "Engine oil pressure low", "CRITICAL", "ENGINE"),
    ("SPN-110", "Engine coolant temperature high", "CRITICAL", "ENGINE"),
    ("SPN-157", "Fuel rail pressure abnormal", "WARNING", "ENGINE"),
    ("SPN-597", "Brake switch circuit fault", "CRITICAL", "BRAKES"),
    ("SPN-639", "J1939 datalink fault", "WARNING", "ELECTRICAL"),
    ("SPN-1569", "Engine protection torque derate", "WARNING", "ENGINE"),
    ("SPN-3226", "Aftertreatment NOx sensor", "INFO", "EMISSIONS"),
    ("SPN-3251", "DPF differential pressure", "WARNING", "EMISSIONS"),
    ("SPN-3719", "DPF soot load high", "WARNING", "EMISSIONS"),
    ("SPN-520", "Retarder oil temperature", "INFO", "ENGINE"),
    ("SPN-168", "Battery voltage low", "WARNING", "ELECTRICAL"),
    ("SPN-96", "Fuel level sensor fault", "INFO", "ELECTRICAL"),
]

DRIVER_NAMES = [
    "Marcus Webb", "Elena Rodriguez", "James Carter", "Aisha Thompson",
    "Dmitri Volkov", "Sarah Kim", "Terrell Jackson", "Nina Patel",
    "Robert Chen", "Gabriela Silva", "Kevin O'Brien", "Fatima Al-Sayed",
    "Derek Nguyen", "Monica Reyes", "Tyler Brooks", "Jasmine Lee",
    "Carl Peterson", "Amara Okafor", "Steve Muller", "Linda Park",
]


def seed(conn: LoopConnection) -> None:
    """Seed reference data if the database is empty."""
    count = conn.query("SELECT COUNT(*) FROM ops.facilities")[0][0]
    if count > 0:
        logger.info("Reference data already seeded (%d facilities); skipping", count)
        return

    logger.info("Seeding reference data...")
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    conn.executemany(
        "INSERT INTO ops.facilities VALUES (%s, %s, %s, %s, %s)", FACILITIES
    )

    # Equipment + historian tags
    equipment_rows = []
    tag_rows = []
    tag_id = 1
    for fac_id, *_ in FACILITIES:
        short = fac_id.split("-")[1]  # LOU
        for suffix, eq_type, n in EQUIPMENT_LAYOUT:
            for i in range(1, n + 1):
                eq_id = f"{short}-{suffix}-{i:02d}"
                equipment_rows.append(
                    (eq_id, fac_id, eq_type, f"{eq_type.title()} {i:02d} @ {fac_id}", "RUNNING")
                )
                for tag_name, unit, _, applies in TAG_DEFS:
                    if eq_type in applies:
                        tag_rows.append(
                            (tag_id, tag_name, eq_id, unit, f"{tag_name} for {eq_id}")
                        )
                        tag_id += 1
    conn.executemany("INSERT INTO ops.equipment VALUES (%s, %s, %s, %s, %s)", equipment_rows)
    conn.executemany("INSERT INTO historian.tags VALUES (%s, %s, %s, %s, %s)", tag_rows)

    # Routes between each pair of hubs, both directions, 2 per direction
    route_rows = []
    hub_ids = [f[0] for f in FACILITIES]
    distances = {("HUB-LOU", "HUB-CHI"): 300, ("HUB-LOU", "HUB-DFW"): 850, ("HUB-CHI", "HUB-DFW"): 925}
    for a in hub_ids:
        for b in hub_ids:
            if a == b:
                continue
            miles = distances.get((a, b)) or distances.get((b, a)) or 500
            for i in (1, 2):
                route_rows.append(
                    (f"RT-{a[4:]}-{b[4:]}-{i}", a, b, miles, miles // 10)
                )
    conn.executemany("INSERT INTO ops.routes VALUES (%s, %s, %s, %s, %s)", route_rows)

    # Vehicles: 15 tractors + 15 package cars spread across hubs
    vehicle_rows = []
    for i in range(15):
        vehicle_rows.append(
            (f"TRC-{100 + i}", "TRACTOR", hub_ids[i % 3], "IN_SERVICE", random.randint(50_000, 400_000))
        )
    for i in range(15):
        vehicle_rows.append(
            (f"PKG-{200 + i}", "PACKAGE_CAR", hub_ids[i % 3], "IN_SERVICE", random.randint(20_000, 150_000))
        )
    conn.executemany("INSERT INTO fleet.vehicles VALUES (%s, %s, %s, %s, %s)", vehicle_rows)

    conn.executemany("INSERT INTO fleet.fault_codes VALUES (%s, %s, %s, %s)", FAULT_CODES)

    driver_rows = [
        (f"DRV-{300 + i}", name, hub_ids[i % 3], "ON_DUTY", f"TRC-{100 + i}" if i < 15 else None)
        for i, name in enumerate(DRIVER_NAMES)
    ]
    conn.executemany("INSERT INTO fleet.drivers VALUES (%s, %s, %s, %s, %s)", driver_rows)

    # Trailers: ~20, distributed across routes, hooked to tractors where possible
    trailer_rows = []
    for i in range(20):
        route = route_rows[i % len(route_rows)]
        tractor = f"TRC-{100 + i}" if i < 15 else None
        trailer_rows.append(
            (f"TRL-{1000 + i}", route[0], route[2], f"D-{i + 1:02d}", "OPEN", tractor,
             now + timedelta(seconds=random.randint(60, 300)))
        )
    conn.executemany("INSERT INTO ops.trailers VALUES (%s, %s, %s, %s, %s, %s, %s)", trailer_rows)

    logger.info(
        "Seeded %d facilities, %d equipment, %d tags, %d routes, %d vehicles, %d trailers",
        len(FACILITIES), len(equipment_rows), len(tag_rows), len(route_rows),
        len(vehicle_rows), len(trailer_rows),
    )
