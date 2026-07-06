"""Historian loop: emits one sample per tag per tick, like a plant historian
polling PLCs. Scenario effects bend the signals (jam => throughput collapses,
temperature and vibration climb)."""

import logging
import random
import time

from src.config import config
from src.db import LoopConnection
from src.scenarios import scenario_state, utcnow

logger = logging.getLogger(__name__)

BASELINES = {
    "belt_speed_fpm": (350.0, 15.0),
    "motor_temp_c": (55.0, 3.0),
    "vibration_mm_s": (2.0, 0.4),
    "throughput_pph": (8000.0, 600.0),
    "read_rate_pct": (98.5, 0.5),
}


def _sample(tag_name: str, equipment_id: str, elapsed_in_effect: float, effect: dict | None) -> float:
    base, noise = BASELINES[tag_name]
    value = random.gauss(base, noise)
    if effect is None:
        return round(value, 2)

    if effect["kind"] == "jam":
        ramp = min(1.0, elapsed_in_effect / 30.0)  # worsens over 30s
        if tag_name == "throughput_pph":
            value = random.gauss(150.0, 50.0)  # collapsed
        elif tag_name == "belt_speed_fpm":
            value = random.gauss(5.0, 3.0)     # stalled
        elif tag_name == "motor_temp_c":
            value = random.gauss(55.0 + 35.0 * ramp, 2.0)  # overheating
        elif tag_name == "vibration_mm_s":
            value = random.gauss(2.0 + 10.0 * ramp, 1.0)
    elif effect["kind"] == "scanner" and tag_name == "read_rate_pct":
        value = random.gauss(82.0, 3.0)
    return round(max(value, 0.0), 2)


def run() -> None:
    conn = LoopConnection()
    tags = conn.query("SELECT tag_id, tag_name, equipment_id FROM historian.tags")
    logger.info("Historian loop: %d tags every %.1fs", len(tags), config.HISTORIAN_INTERVAL)
    effect_started: dict[str, float] = {}

    while True:
        start = time.time()
        now = utcnow()
        rows = []
        for tag_id, tag_name, equipment_id in tags:
            effect = scenario_state.effect_for_equipment(equipment_id)
            if effect:
                effect_started.setdefault(equipment_id, start)
                elapsed = start - effect_started[equipment_id]
            else:
                effect_started.pop(equipment_id, None)
                elapsed = 0.0
            rows.append((tag_id, now, _sample(tag_name, equipment_id, elapsed, effect)))
        conn.executemany(
            "INSERT INTO historian.tag_values (tag_id, ts, value) VALUES (%s, %s, %s)", rows
        )
        time.sleep(max(0.1, config.HISTORIAN_INTERVAL - (time.time() - start)))
