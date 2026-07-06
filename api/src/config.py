"""API configuration from environment variables."""

import os


class Settings:
    MZ_HOST = os.getenv("MZ_HOST", "localhost")
    MZ_PORT = int(os.getenv("MZ_PORT", "6875"))
    MZ_USER = os.getenv("MZ_USER", "materialize")
    MZ_PASSWORD = os.getenv("MZ_PASSWORD", "materialize")
    MZ_DATABASE = os.getenv("MZ_DATABASE", "materialize")

    SIMULATOR_URL = os.getenv("SIMULATOR_URL", "http://localhost:8085")
    ONTOLOGY_PATH = os.getenv("ONTOLOGY_PATH", "ontology.yaml")
    ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173").split(",")


settings = Settings()
