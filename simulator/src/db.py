"""SQL Server connection helpers (pymssql, one connection per loop thread)."""

import logging
import time

import pymssql

from src.config import config

logger = logging.getLogger(__name__)


def connect() -> pymssql.Connection:
    """Connect with retry; each simulator loop owns one connection."""
    while True:
        try:
            conn = pymssql.connect(
                server=config.MSSQL_HOST,
                port=config.MSSQL_PORT,
                user=config.MSSQL_USER,
                password=config.MSSQL_PASSWORD,
                database=config.MSSQL_DATABASE,
                autocommit=True,
                login_timeout=10,
            )
            return conn
        except Exception as exc:  # noqa: BLE001 - retry any connect failure
            logger.warning("SQL Server not ready (%s); retrying in 3s", exc)
            time.sleep(3)


class LoopConnection:
    """A connection wrapper that reconnects transparently after errors."""

    def __init__(self) -> None:
        self._conn = connect()

    def execute(self, sql: str, params=None) -> None:
        self._with_retry(lambda cur: cur.execute(sql, params) if params else cur.execute(sql))

    def executemany(self, sql: str, rows) -> None:
        self._with_retry(lambda cur: cur.executemany(sql, rows))

    def query(self, sql: str, params=None) -> list[tuple]:
        result: list[tuple] = []

        def run(cur):
            cur.execute(sql, params) if params else cur.execute(sql)
            result.extend(cur.fetchall())

        self._with_retry(run)
        return result

    def _with_retry(self, fn) -> None:
        for attempt in (1, 2):
            try:
                with self._conn.cursor() as cur:
                    fn(cur)
                return
            except Exception as exc:  # noqa: BLE001 - reconnect once, then raise
                if attempt == 2:
                    raise
                logger.warning("SQL error (%s); reconnecting", exc)
                try:
                    self._conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self._conn = connect()
