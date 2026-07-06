"""Copilot configuration from environment variables."""

import os
from functools import lru_cache


class Settings:
    def __init__(self) -> None:
        self.anthropic_api_key = os.getenv("ANTHROPIC_API_KEY", "")
        self.openai_api_key = os.getenv("OPENAI_API_KEY", "")
        # Sensible defaults per provider; override with AGENT_MODEL.
        default_model = "claude-sonnet-5" if self.anthropic_api_key else "gpt-4o"
        self.llm_model = os.getenv("AGENT_MODEL") or default_model

        self.api_base_url = os.getenv("API_BASE_URL", "http://localhost:8080")

        self.mz_host = os.getenv("MZ_HOST", "localhost")
        self.mz_port = int(os.getenv("MZ_PORT", "6875"))
        self.mz_user = os.getenv("MZ_USER", "materialize")
        self.mz_password = os.getenv("MZ_PASSWORD", "materialize")
        self.mz_database = os.getenv("MZ_DATABASE", "materialize")

        # Write-back to the system of record (SQL Server).
        self.mssql_host = os.getenv("MSSQL_HOST", "localhost")
        self.mssql_port = int(os.getenv("MSSQL_PORT", "1433"))
        self.mssql_user = os.getenv("MSSQL_USER", "sa")
        self.mssql_password = os.getenv("MSSQL_SA_PASSWORD", "")
        self.mssql_database = os.getenv("MSSQL_DATABASE", "ups")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
