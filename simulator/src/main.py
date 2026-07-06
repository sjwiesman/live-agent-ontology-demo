"""Simulator entrypoint: seeds reference data, starts the write loops as
daemon threads, and serves the scenario control API."""

import logging
import threading
import time

import uvicorn
from fastapi import FastAPI, HTTPException

from src.config import config
from src.db import LoopConnection
from src.loops import fleet, historian, packages, retention
from src.scenarios import SCENARIOS, reconcile_on_startup
from src.seed import seed

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("simulator")

app = FastAPI(title="UPS Demo Simulator Control")

# One dedicated connection for control-plane writes (scenario triggers).
_control_conn: LoopConnection | None = None
_control_lock = threading.Lock()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/scenario/{name}")
def trigger_scenario(name: str, target: str | None = None, duration_s: float = 120.0) -> dict:
    trigger = SCENARIOS.get(name)
    if trigger is None:
        raise HTTPException(404, f"unknown scenario '{name}'; one of {sorted(SCENARIOS)}")
    with _control_lock:
        result = trigger(_control_conn, target, duration_s)
    if "error" in result:
        raise HTTPException(400, result["error"])
    return result


def _auto_jam_loop() -> None:
    """Periodically fire a jam so the dashboard always has a story."""
    while True:
        time.sleep(config.AUTO_JAM_INTERVAL)
        try:
            with _control_lock:
                SCENARIOS["conveyor_jam"](_control_conn, None, config.AUTO_JAM_DURATION)
        except Exception:  # noqa: BLE001 - keep the loop alive
            logger.exception("auto-jam failed")


def main() -> None:
    global _control_conn

    boot = LoopConnection()
    seed(boot)
    reconcile_on_startup(boot)
    _control_conn = boot

    loops = [historian.run, packages.run, fleet.run, retention.run]
    if config.AUTO_JAM_INTERVAL > 0:
        loops.append(_auto_jam_loop)
    for fn in loops:
        threading.Thread(target=fn, daemon=True, name=fn.__module__).start()

    uvicorn.run(app, host="0.0.0.0", port=config.CONTROL_PORT, log_level="warning")


if __name__ == "__main__":
    main()
