"""Package flow loop: creates packages and advances the lifecycle."""

import logging
import time

from src.config import config
from src.db import LoopConnection
from src.scenarios import scenario_state
from src.state import PackageFlow

logger = logging.getLogger(__name__)


def run() -> None:
    conn = LoopConnection()
    flow = PackageFlow(conn)
    logger.info("Package loop: ~%d new / %d transitions per %.1fs tick",
                config.NEW_PACKAGES_PER_TICK, config.TRANSITIONS_PER_TICK, config.PACKAGE_INTERVAL)

    # Prime the pipeline so the dashboard isn't empty on first load.
    created = flow.create_packages(150)
    logger.info("Primed %d packages", created)

    while True:
        start = time.time()
        try:
            scenario_state.expire(conn)
            scenario_state.clear_acknowledged(conn)
            flow.create_packages(config.NEW_PACKAGES_PER_TICK)
            flow.advance_packages(config.TRANSITIONS_PER_TICK)
            flow.dispatch_trailers()
            flow.arrive_trailers()
        except Exception:  # noqa: BLE001 - keep the loop alive
            logger.exception("package tick failed")
        time.sleep(max(0.1, config.PACKAGE_INTERVAL - (time.time() - start)))
