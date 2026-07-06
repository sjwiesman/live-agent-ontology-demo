"""Shared Materialize read helper for copilot tools.

Every read runs on the `serving` cluster where the context-graph indexes
live, so tool latency is milliseconds even while the graph churns.
"""

from datetime import date, datetime
from decimal import Decimal

import asyncpg

from src.config import get_settings


def _jsonable(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


async def mz_fetch(query: str, *args) -> list[dict]:
    settings = get_settings()
    conn = await asyncpg.connect(
        host=settings.mz_host,
        port=settings.mz_port,
        user=settings.mz_user,
        password=settings.mz_password,
        database=settings.mz_database,
    )
    try:
        await conn.execute("SET CLUSTER = serving")
        rows = await conn.fetch(query, *args)
        return [{k: _jsonable(v) for k, v in dict(r).items()} for r in rows]
    finally:
        await conn.close()
