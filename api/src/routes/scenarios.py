"""Proxy scenario triggers to the simulator so the browser only ever
talks to one origin."""

from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException

from src.config import settings

router = APIRouter(tags=["scenarios"])


@router.post("/scenarios/{name}")
async def trigger_scenario(
    name: str, target: Optional[str] = None, duration_s: float = 120.0
) -> dict:
    params: dict = {"duration_s": duration_s}
    if target:
        params["target"] = target
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{settings.SIMULATOR_URL}/scenario/{name}", params=params, timeout=15.0
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, resp.text)
    return resp.json()
