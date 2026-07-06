"""UPS Hub Operations Copilot - LangGraph implementation.

A ReAct loop over the live context graph: the agent reasons, calls tools
that read pre-assembled context from Materialize (and write back to SQL
Server), and loops until it can answer.
"""

import asyncio
import json
import operator
from typing import Annotated, Literal, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, StateGraph
from langgraph.prebuilt import ToolNode

from src.config import get_settings
from src.tools import (
    acknowledge_alarm,
    create_maintenance_order,
    find_at_risk_packages,
    get_context_graph,
    get_equipment_status,
    get_fleet_risk,
    get_hub_health,
    list_active_alarms,
    lookup_package,
)


class AgentState(TypedDict):
    """State passed through the agent graph."""

    messages: Annotated[list[BaseMessage], operator.add]
    iteration: int


TOOLS = [
    get_context_graph,
    lookup_package,
    find_at_risk_packages,
    get_hub_health,
    list_active_alarms,
    get_equipment_status,
    get_fleet_risk,
    acknowledge_alarm,
    create_maintenance_order,
]

SYSTEM_PROMPT = """You are the UPS Hub Operations Copilot. You support hub workers — sortation \
supervisors, package-flow controllers, and fleet dispatchers — with live, cross-silo answers.

**You are NOT customer-facing.** You assist UPS staff working a shift.

## Your superpower: the live context graph

Your tools read a context graph maintained continuously by Materialize from the SQL Server \
historian and operational databases. It is never more than a few seconds behind the physical \
world, and it pre-joins three silos that workers normally have to correlate by hand:

1. **Sortation (historian)** — equipment telemetry and alarms
2. **Package flow** — packages, scans, trailers, routes
3. **Fleet** — vehicles, faults, drivers, maintenance

The high-value answers cross silos. Example: a package is at risk because the sorter in its \
sort plan has a JAM alarm (historian → package), or because the tractor pulling its trailer \
has a critical engine fault (fleet → package). Always explain risk through these connections.

## MANDATORY FIRST STEP - DO NOT SKIP

**ALWAYS call get_context_graph() FIRST before ANY other tool.**

This is NON-NEGOTIABLE. Your very first tool call for every user request must be \
get_context_graph(). It returns the ontology: entity classes, their relationships, and which \
live view answers what. Without it you cannot reason about how entities connect.

**CORRECT behavior:**
1. User asks anything → call get_context_graph() FIRST
2. Review the relationships to understand how entities connect
3. THEN call other tools as needed

## Common tasks

**"Why is package 1Z… at risk?" / "Where is my package?"**
1. lookup_package for the pre-assembled context row
2. Read the at-risk flags: equipment_at_risk (check equipment_alarm_message), \
tractor_at_risk (check tractor_fault_codes)
3. If needed, drill down: get_equipment_status for telemetry, get_fleet_risk for the vehicle
4. Explain the chain: package → sorter/trailer/tractor → the actual fault

**"What's happening at the hub?"**
1. get_hub_health for status, alarms, throughput
2. list_active_alarms and get_equipment_status(facility_id=...) for specifics
3. find_at_risk_packages to quantify the package impact

**"Which packages should we act on first?"**
Use find_at_risk_packages with approaching_promise=true — at-risk packages closest to their \
delivery promise matter most.

**Fleet questions** — get_fleet_risk. A HIGH risk vehicle attached to a loaded trailer is a \
package problem, not just a maintenance problem; say how many packages are on it.

## Write-backs (acting on the system of record)

You can act, not just observe:
- acknowledge_alarm(alarm_id, acknowledged_by) — marks a historian alarm as being handled; \
for jams this releases the equipment once cleared
- create_maintenance_order(vehicle_id, priority, description, created_by) — opens a work \
order for the shop

Rules:
1. **Confirm with the user before any write-back**, restating exactly what you will change.
2. Always pass the user's name/id as acknowledged_by / created_by; ask for it if unknown.
3. Look up current state first (list_active_alarms / get_fleet_risk) so you act on real ids.
4. After a write-back, tell the user the change is in SQL Server and will be visible in the \
live dashboard within seconds.

## Precision rules

- **Count accurately. Never generalize.** If 1 hub is CRITICAL and 2 are HEALTHY, say exactly \
that. Never say "everything is down" unless it literally is.
- **Cite entity ids**: tracking numbers, equipment ids (LOU-SORT-04), vehicle ids (TRC-110), \
alarm ids, work-order ids.
- **Freshness matters**: the data is live. Re-query rather than reuse numbers from earlier \
in the conversation.
- Severity vocabulary: alarms/faults are INFO/WARNING/CRITICAL; package and vehicle risk is \
LOW/MEDIUM/HIGH; hub health is HEALTHY/DEGRADED/CRITICAL. Do not mix them up.
- Be concise and operational: workers are on a shift, not reading a report.
"""


def get_llm():
    """Get the LLM based on available API keys (Anthropic preferred)."""
    settings = get_settings()

    if settings.anthropic_api_key:
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(model=settings.llm_model, anthropic_api_key=settings.anthropic_api_key)
    if settings.openai_api_key:
        from langchain_openai import ChatOpenAI

        return ChatOpenAI(
            model=settings.llm_model,
            openai_api_key=settings.openai_api_key,
            temperature=1,
        )
    raise ValueError("No LLM API key configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY")


async def agent_node(state: AgentState) -> AgentState:
    """Main agent node - reasons and decides on tool calls."""
    llm = get_llm()
    llm_with_tools = llm.bind_tools(TOOLS)

    # Anthropic requires non-empty message content except on the final
    # assistant message; normalize tool traffic accordingly.
    filtered_messages = []
    for msg in state["messages"]:
        if isinstance(msg, AIMessage):
            if not msg.content and getattr(msg, "tool_calls", None):
                msg = AIMessage(content="I'll use a tool to help with that.", tool_calls=msg.tool_calls)
        elif isinstance(msg, ToolMessage):
            content = msg.content
            if not content or (isinstance(content, list) and len(content) == 0):
                msg = ToolMessage(content="No results found.", tool_call_id=msg.tool_call_id)
            elif isinstance(content, list):
                msg = ToolMessage(content=json.dumps(content), tool_call_id=msg.tool_call_id)
        filtered_messages.append(msg)

    messages = [SystemMessage(content=SYSTEM_PROMPT)] + filtered_messages
    response = await llm_with_tools.ainvoke(messages)

    return {"messages": [response], "iteration": state["iteration"] + 1}


def should_continue(state: AgentState) -> Literal["tools", "end"]:
    """Decide whether to continue with tools or end."""
    if state["iteration"] > 10:
        return "end"
    last_message = state["messages"][-1]
    if getattr(last_message, "tool_calls", None):
        return "tools"
    return "end"


def create_workflow() -> StateGraph:
    """Create the agent workflow (without compiling)."""
    workflow = StateGraph(AgentState)
    workflow.add_node("agent", agent_node)
    workflow.add_node("tools", ToolNode(TOOLS))
    workflow.set_entry_point("agent")
    workflow.add_conditional_edges("agent", should_continue, {"tools": "tools", "end": END})
    workflow.add_edge("tools", "agent")
    return workflow


# Conversation memory is in-process: this demo has no Postgres, and thread
# history surviving an agent restart isn't worth a database.
_cached_graph = None
_init_lock = asyncio.Lock()


async def _get_graph():
    global _cached_graph
    async with _init_lock:
        if _cached_graph is None:
            _cached_graph = create_workflow().compile(checkpointer=InMemorySaver())
    return _cached_graph


async def cleanup_graph_resources():
    """Nothing to release with the in-memory checkpointer; kept for the
    server's lifespan symmetry."""
    global _cached_graph
    _cached_graph = None


async def run_assistant(user_message: str, thread_id: str = "default", stream_events: bool = False):
    """Run the copilot with a user message.

    Yields (event_type, data) tuples:
        - "tool_call": {"name": str, "args": dict}
        - "tool_result": {"content": str}
        - "error": {"message": str}
        - "response": str (always emitted last)
    """
    graph = await _get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    initial_state: AgentState = {"messages": [HumanMessage(content=user_message)], "iteration": 0}

    if stream_events:
        final_response = None
        try:
            async for event in graph.astream(initial_state, config):
                if "agent" in event:
                    agent_data = event["agent"]
                    if agent_data.get("messages"):
                        last_msg = agent_data["messages"][-1]
                        if isinstance(last_msg, AIMessage):
                            if getattr(last_msg, "tool_calls", None):
                                for tool_call in last_msg.tool_calls:
                                    name = tool_call.get("name", "unknown") if isinstance(tool_call, dict) else getattr(tool_call, "name", "unknown")
                                    args = tool_call.get("args", {}) if isinstance(tool_call, dict) else getattr(tool_call, "args", {})
                                    yield ("tool_call", {"name": name, "args": args})
                            elif last_msg.content:
                                final_response = last_msg.content
                elif "tools" in event:
                    tools_data = event["tools"]
                    for msg in tools_data.get("messages", []):
                        if isinstance(msg, ToolMessage):
                            content_str = str(msg.content)
                            preview = content_str[:150] + "..." if len(content_str) > 150 else content_str
                            yield ("tool_result", {"content": preview})

            yield ("response", final_response or "I couldn't complete that request.")
        except Exception as e:  # noqa: BLE001 - stream errors to the client
            error_msg = str(e)
            yield ("error", {"message": error_msg})
            if "API key" in error_msg or "api_key" in error_msg.lower():
                yield ("response", f"Configuration error: {error_msg}\n\nAdd ANTHROPIC_API_KEY or OPENAI_API_KEY to your .env file, then restart the agents container.")
            else:
                yield ("response", f"An error occurred: {error_msg}")
    else:
        try:
            final_state = await graph.ainvoke(initial_state, config)
            response = None
            for msg in reversed(final_state["messages"]):
                if isinstance(msg, AIMessage) and msg.content:
                    response = msg.content
                    break
            yield ("response", response or "I couldn't complete that request.")
        except Exception as e:  # noqa: BLE001 - surface errors as the response
            error_msg = str(e)
            yield ("error", {"message": error_msg})
            if "API key" in error_msg or "api_key" in error_msg.lower():
                yield ("response", f"Configuration error: {error_msg}\n\nAdd ANTHROPIC_API_KEY or OPENAI_API_KEY to your .env file, then restart the agents container.")
            else:
                yield ("response", f"An error occurred: {error_msg}")
