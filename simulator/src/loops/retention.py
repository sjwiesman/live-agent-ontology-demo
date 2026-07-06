"""Retention loop: prunes append-only tables so the demo runs forever.

Safe because every Materialize view over these tables is temporal-filtered
to a window shorter than the retention period — the deletes flow through
CDC but never change a query result.
"""

import logging
import time

from src.config import config
from src.db import LoopConnection

logger = logging.getLogger(__name__)


def run() -> None:
    conn = LoopConnection()
    while True:
        try:
            conn.execute(
                "DELETE FROM historian.tag_values WHERE ts < DATEADD(minute, -%s, SYSUTCDATETIME())",
                (config.TAG_VALUES_RETENTION_MINUTES,),
            )
            conn.execute(
                "DELETE FROM ops.scan_events WHERE ts < DATEADD(hour, -%s, SYSUTCDATETIME())",
                (config.SCAN_EVENTS_RETENTION_HOURS,),
            )
            conn.execute(
                "DELETE FROM ops.packages WHERE status = 'DELIVERED' "
                "AND updated_at < DATEADD(hour, -1, SYSUTCDATETIME())"
            )
            logger.info("Retention pass complete")
        except Exception:  # noqa: BLE001 - keep the loop alive
            logger.exception("retention pass failed")
        time.sleep(config.RETENTION_INTERVAL)
