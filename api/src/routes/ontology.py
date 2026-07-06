"""Serves the ontology document: the map of the context graph."""

from functools import lru_cache

import yaml
from fastapi import APIRouter

from src.config import settings

router = APIRouter(tags=["ontology"])


@lru_cache(maxsize=1)
def _load_ontology() -> dict:
    with open(settings.ONTOLOGY_PATH) as f:
        return yaml.safe_load(f)


@router.get("/ontology")
async def get_ontology() -> dict:
    return _load_ontology()
