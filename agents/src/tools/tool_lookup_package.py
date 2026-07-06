"""Point lookup on the package context view."""

from langchain_core.tools import tool

from src.tools.mz import mz_fetch


@tool
async def lookup_package(package_id: str) -> dict:
    """Look up a package's full live context by tracking number.

    Returns one pre-assembled row: current status and facility, last scan,
    the sorter it is routed through (and that sorter's alarm state), its
    trailer, the tractor pulling that trailer (and the tractor's active
    fault codes), plus a computed risk_level (LOW/MEDIUM/HIGH) with the
    at-risk flags explaining which dependency is unhealthy.

    Args:
        package_id: Tracking number, e.g. "1Z999AA0123456789".

    Returns:
        dict: The package context row, or an error if not found.
    """
    rows = await mz_fetch(
        "SELECT * FROM package_context_mv WHERE package_id = $1", package_id.strip()
    )
    if not rows:
        return {
            "error": f"Package {package_id} not found (it may already be delivered).",
        }
    return rows[0]
