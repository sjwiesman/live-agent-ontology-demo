"""Ontology document sanity: the file the copilot and UI both consume."""

import os

import yaml

# Repo checkout: ../../ontology/ontology.yaml; API docker image: baked-in
# copy next to src (see api/Dockerfile).
_CANDIDATES = [
    os.environ.get("ONTOLOGY_PATH", ""),
    os.path.join(os.path.dirname(__file__), "..", "..", "ontology", "ontology.yaml"),
    "/app/ontology.yaml",
]


def load():
    for path in _CANDIDATES:
        if path and os.path.exists(path):
            with open(path) as f:
                return yaml.safe_load(f)
    raise FileNotFoundError(f"ontology.yaml not found in {_CANDIDATES}")


def test_ontology_parses_and_has_sections():
    o = load()
    assert set(o) >= {"domains", "classes", "relationships"}
    assert len(o["classes"]) >= 10
    assert len(o["relationships"]) >= 10


def test_every_class_is_backed_by_a_table():
    for c in load()["classes"]:
        assert c["backed_by"]["table"], f"{c['name']} missing table binding"
        assert "." in c["backed_by"]["table"], f"{c['name']} table should be schema-qualified"


def test_relationship_endpoints_are_declared_classes():
    o = load()
    names = {c["name"] for c in o["classes"]}
    for r in o["relationships"]:
        assert r["from"] in names, f"{r['name']}: unknown class {r['from']}"
        assert r["to"] in names, f"{r['name']}: unknown class {r['to']}"


def test_cross_silo_edges_exist():
    """The demo's whole point: edges that bridge silos."""
    o = load()
    rel_names = {r["name"] for r in o["relationships"]}
    assert "sort_planned_through" in rel_names  # historian -> package
    assert "pulled_by" in rel_names  # fleet -> package
