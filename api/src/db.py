"""asyncpg pool against Materialize.

Every pooled connection is pinned to the `serving` cluster, where all the
indexes live — reads are indexed point lookups, not dataflow scans.
"""

import asyncpg

from src.config import settings

_pool: asyncpg.Pool | None = None


async def _init_connection(conn: asyncpg.Connection) -> None:
    await conn.execute("SET CLUSTER = serving")


async def _reset_connection(conn: asyncpg.Connection) -> None:
    # asyncpg's default reset issues UNLISTEN/RESET statements that
    # Materialize does not support; connections carry no session state we
    # care about beyond the cluster set at init, so resetting is a no-op.
    pass


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            host=settings.MZ_HOST,
            port=settings.MZ_PORT,
            user=settings.MZ_USER,
            password=settings.MZ_PASSWORD,
            database=settings.MZ_DATABASE,
            min_size=2,
            max_size=10,
            init=_init_connection,
            reset=_reset_connection,
        )
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def fetch_dicts(query: str, *args) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(query, *args)
    return [dict(r) for r in rows]
