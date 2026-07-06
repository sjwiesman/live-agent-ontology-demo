"""UPS Live Context Graph API.

Thin read layer over the Materialize context-graph views, plus the
ontology document and a proxy to the simulator's scenario triggers.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.config import settings
from src.db import close_pool, get_pool
from src.routes import dashboard, ontology, packages, scenarios

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await get_pool()
    logger.info("Connected to Materialize at %s:%s", settings.MZ_HOST, settings.MZ_PORT)
    yield
    await close_pool()


app = FastAPI(
    title="UPS Live Context Graph API",
    description="Live operational context served from Materialize",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    pool = await get_pool()
    await pool.fetchval("SELECT 1")
    return {"status": "ok"}


app.include_router(ontology.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(packages.router, prefix="/api")
app.include_router(scenarios.router, prefix="/api")
