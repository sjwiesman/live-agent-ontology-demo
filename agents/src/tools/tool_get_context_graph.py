"""Fetch the ontology: the copilot's map of the context graph."""

import httpx
from langchain_core.tools import tool

from src.config import get_settings


@tool
async def get_context_graph() -> dict:
    """Get the ontology of the UPS live context graph: entity classes,
    the relationships that connect them, and which live Materialize view
    serves each entity.

    ALWAYS call this first. The relationships are what let you connect
    facts across silos — e.g. Package --sort_planned_through--> Equipment
    (a jammed sorter strands its packages) and Trailer --pulled_by-->
    Vehicle (an engine fault grounds every package on the trailer).

    Returns:
        dict with 'domains', 'classes' (each with backed_by view bindings),
        and 'relationships'.
    """
    settings = get_settings()
    async with httpx.AsyncClient() as client:
        resp = await client.get(f"{settings.api_base_url}/api/ontology", timeout=10.0)
        resp.raise_for_status()
        return resp.json()
