"""FastAPI server for the UPS Hub Operations Copilot with SSE streaming."""

import json
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from src.config import get_settings
from src.graphs.hub_copilot_graph import cleanup_graph_resources, run_assistant

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown."""
    settings = get_settings()
    if settings.anthropic_api_key:
        logger.info("Anthropic API key: FOUND")
    if settings.openai_api_key:
        logger.info("OpenAI API key: FOUND")
    if not settings.anthropic_api_key and not settings.openai_api_key:
        logger.error("No LLM API key configured! Set ANTHROPIC_API_KEY or OPENAI_API_KEY")

    yield
    await cleanup_graph_resources()


limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="UPS Hub Operations Copilot",
    description="AI copilot over the live context graph, with SSE streaming",
    lifespan=lifespan,
)

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Thread-Id"],
)


class ChatRequest(BaseModel):
    """Request body for chat endpoints."""

    message: str = Field(..., min_length=1, max_length=10000, description="User message (1-10000 characters)")
    thread_id: Optional[str] = Field(None, max_length=100, description="Optional thread ID for conversation continuity")


class ChatResponse(BaseModel):
    """Response body for non-streaming chat endpoint."""

    response: str
    thread_id: str


async def event_generator(message: str, thread_id: str):
    """Generate SSE events from the copilot.

    Event types:
    - tool_call: {"name": str, "args": dict}
    - tool_result: {"content": str}
    - response: str (final complete response)
    - error: {"message": str}
    - done: {}  (stream complete)
    """
    try:
        async for event_type, data in run_assistant(message, thread_id=thread_id, stream_events=True):
            yield f"data: {json.dumps({'type': event_type, 'data': data})}\n\n"
        yield f"data: {json.dumps({'type': 'done', 'data': {}})}\n\n"
    except Exception as e:  # noqa: BLE001 - stream the error to the client
        yield f"data: {json.dumps({'type': 'error', 'data': {'message': str(e)}})}\n\n"


@app.post("/chat/stream")
@limiter.limit("10/minute")
async def chat_stream(chat_request: ChatRequest, request: Request):
    """SSE streaming chat. The thread_id is returned in the X-Thread-Id header."""
    if not chat_request.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    thread_id = chat_request.thread_id or f"chat-{uuid.uuid4().hex[:8]}"

    return StreamingResponse(
        event_generator(chat_request.message, thread_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Thread-Id": thread_id,
        },
    )


@app.post("/chat", response_model=ChatResponse)
@limiter.limit("10/minute")
async def chat(chat_request: ChatRequest, request: Request):
    """Non-streaming chat: returns the final response when complete."""
    if not chat_request.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    thread_id = chat_request.thread_id or f"api-{uuid.uuid4().hex[:8]}"

    response_text = None
    async for event_type, data in run_assistant(chat_request.message, thread_id=thread_id, stream_events=False):
        if event_type == "response":
            response_text = data
            break

    if not response_text:
        raise HTTPException(status_code=500, detail="No response generated")

    return ChatResponse(response=response_text, thread_id=thread_id)


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy"}
