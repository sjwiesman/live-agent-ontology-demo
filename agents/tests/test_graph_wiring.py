"""Wiring tests that run without any services: tool registration, schemas,
and graph construction."""

from src.graphs.hub_copilot_graph import TOOLS, create_workflow, should_continue

EXPECTED_TOOLS = {
    "get_context_graph",
    "lookup_package",
    "find_at_risk_packages",
    "get_hub_health",
    "list_active_alarms",
    "get_equipment_status",
    "get_fleet_risk",
    "acknowledge_alarm",
    "create_maintenance_order",
}


def test_all_tools_registered():
    assert {t.name for t in TOOLS} == EXPECTED_TOOLS


def test_every_tool_has_docstring_description():
    for t in TOOLS:
        assert t.description and len(t.description) > 40, f"{t.name} needs a real description"


def test_write_back_tools_require_actor():
    ack = next(t for t in TOOLS if t.name == "acknowledge_alarm")
    assert "acknowledged_by" in ack.args
    wo = next(t for t in TOOLS if t.name == "create_maintenance_order")
    assert "created_by" in wo.args


def test_workflow_compiles():
    graph = create_workflow().compile()
    assert set(graph.nodes) >= {"agent", "tools"}


def test_should_continue_iteration_cap():
    class Msg:
        tool_calls = [{"name": "lookup_package", "args": {}}]

    assert should_continue({"messages": [Msg()], "iteration": 11}) == "end"
    assert should_continue({"messages": [Msg()], "iteration": 2}) == "tools"
