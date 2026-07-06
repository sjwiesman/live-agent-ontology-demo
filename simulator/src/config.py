"""Simulator configuration from environment variables."""

import os


class Config:
    MSSQL_HOST = os.getenv("MSSQL_HOST", "sqlserver")
    MSSQL_PORT = int(os.getenv("MSSQL_PORT", "1433"))
    MSSQL_USER = os.getenv("MSSQL_USER", "sa")
    MSSQL_PASSWORD = os.getenv("MSSQL_SA_PASSWORD", "")
    MSSQL_DATABASE = os.getenv("MSSQL_DATABASE", "ups")

    CONTROL_PORT = int(os.getenv("SIM_CONTROL_PORT", "8085"))

    # Loop cadences (seconds)
    HISTORIAN_INTERVAL = float(os.getenv("SIM_HISTORIAN_INTERVAL", "2.0"))
    PACKAGE_INTERVAL = float(os.getenv("SIM_PACKAGE_INTERVAL", "2.0"))
    FLEET_INTERVAL = float(os.getenv("SIM_FLEET_INTERVAL", "5.0"))
    RETENTION_INTERVAL = float(os.getenv("SIM_RETENTION_INTERVAL", "600.0"))

    # Package flow tuning
    NEW_PACKAGES_PER_TICK = int(os.getenv("SIM_NEW_PACKAGES_PER_TICK", "4"))
    TRANSITIONS_PER_TICK = int(os.getenv("SIM_TRANSITIONS_PER_TICK", "30"))
    MAX_ACTIVE_PACKAGES = int(os.getenv("SIM_MAX_ACTIVE_PACKAGES", "500"))

    # Auto-fire a conveyor jam every N seconds (0 disables), lasting M seconds.
    AUTO_JAM_INTERVAL = float(os.getenv("SIM_AUTO_JAM_INTERVAL", "240"))
    AUTO_JAM_DURATION = float(os.getenv("SIM_AUTO_JAM_DURATION", "90"))

    # Retention windows
    TAG_VALUES_RETENTION_MINUTES = int(os.getenv("SIM_TAG_RETENTION_MIN", "60"))
    SCAN_EVENTS_RETENTION_HOURS = int(os.getenv("SIM_SCAN_RETENTION_H", "24"))


config = Config()
