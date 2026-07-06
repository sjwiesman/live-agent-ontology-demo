"""Fleet loop: odometer creep and background fault noise (auto-clearing)."""

import logging
import random
import time
from datetime import timedelta

from src.config import config
from src.db import LoopConnection
from src.scenarios import utcnow

logger = logging.getLogger(__name__)

# Background faults are mostly informational; scenario-injected CRITICAL
# faults come from scenarios.trigger_tractor_fault instead.
BACKGROUND_CODES = ["SPN-3226", "SPN-96", "SPN-520", "SPN-168", "SPN-639", "SPN-3251"]
FAULT_PROBABILITY_PER_TICK = 0.05


def run() -> None:
    conn = LoopConnection()
    vehicles = [r[0] for r in conn.query("SELECT vehicle_id FROM fleet.vehicles")]
    logger.info("Fleet loop: %d vehicles every %.1fs", len(vehicles), config.FLEET_INTERVAL)

    while True:
        start = time.time()
        try:
            now = utcnow()
            # Odometers creep on a few random vehicles.
            for vehicle_id in random.sample(vehicles, k=min(5, len(vehicles))):
                conn.execute(
                    "UPDATE fleet.vehicles SET odometer_miles = odometer_miles + %s WHERE vehicle_id = %s",
                    (random.randint(1, 5), vehicle_id),
                )
            # Occasional background fault.
            if random.random() < FAULT_PROBABILITY_PER_TICK:
                conn.execute(
                    "INSERT INTO fleet.vehicle_faults (vehicle_id, code, occurred_at) VALUES (%s, %s, %s)",
                    (random.choice(vehicles), random.choice(BACKGROUND_CODES), now),
                )
            # Auto-clear background faults after 1-5 minutes.
            conn.execute(
                "UPDATE fleet.vehicle_faults SET cleared_at = %s "
                "WHERE cleared_at IS NULL AND code IN ({}) AND occurred_at < %s".format(
                    ",".join(f"'{c}'" for c in BACKGROUND_CODES)
                ),
                (now, now - timedelta(minutes=random.randint(1, 5))),
            )
        except Exception:  # noqa: BLE001 - keep the loop alive
            logger.exception("fleet tick failed")
        time.sleep(max(0.1, config.FLEET_INTERVAL - (time.time() - start)))
