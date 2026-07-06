"""Shared SQL Server write-back helper for copilot tools.

Write-backs go to the system of record — the same historian/operational
database the CDC stream replicates — so every change the copilot makes
flows back through Materialize and shows up on the dashboard in seconds.

pymssql is synchronous; calls are pushed onto a worker thread so the
agent's event loop never blocks.
"""

import asyncio

import pymssql

from src.config import get_settings


def _run_sync(fn):
    settings = get_settings()
    conn = pymssql.connect(
        server=settings.mssql_host,
        port=settings.mssql_port,
        user=settings.mssql_user,
        password=settings.mssql_password,
        database=settings.mssql_database,
        autocommit=True,
        login_timeout=10,
    )
    try:
        with conn.cursor() as cur:
            return fn(cur)
    finally:
        conn.close()


async def mssql_execute(fn):
    """Run `fn(cursor)` on a worker thread against the ups database."""
    return await asyncio.to_thread(_run_sync, fn)
