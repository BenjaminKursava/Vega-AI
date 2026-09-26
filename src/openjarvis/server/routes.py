"""Route handlers for the OpenAI-compatible API server."""

from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from openjarvis.core.types import Message, Role
from openjarvis.server.models import (
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    Choice,
    ChoiceMessage,
    ComplexityInfo,
    DeltaMessage,
    ModelListResponse,
    ModelObject,
    StreamChoice,
    UsageInfo,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Cloud API keys
# ---------------------------------------------------------------------------
# The Cloud Models dialog saves provider keys through these endpoints so the
# SERVER can use them for generation — cloud_router re-reads
# ~/.openjarvis/cloud-keys.env on every request, so a saved key takes effect
# immediately. Previously only the Tauri desktop wrapper persisted keys
# (its save_cloud_key command); in a plain browser the key lived solely in
# localStorage and cloud generation failed with "GEMINI_API_KEY not set".

_CLOUD_KEYS_FILE = Path.home() / ".openjarvis" / "cloud-keys.env"

_ALLOWED_CLOUD_KEY_NAMES = {
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENROUTER_API_KEY",
    "MINIMAX_API_KEY",
}


class CloudKeyRequest(BaseModel):
    name: str
    value: str = ""  # empty value removes the key


@router.post("/v1/cloud-keys")
async def save_cloud_key(req: CloudKeyRequest) -> dict[str, Any]:
    """Persist (or remove) a cloud provider API key for server-side use."""
    name = req.name.strip().upper()
    if name not in _ALLOWED_CLOUD_KEY_NAMES:
        raise HTTPException(status_code=400, detail=f"Unknown key name: {name}")

    value = req.value.strip()
    # Reject values that would corrupt the one-line-per-key env format.
    if any(c in value for c in ("\n", "\r")):
        raise HTTPException(status_code=400, detail="Invalid key value")

    _CLOUD_KEYS_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if _CLOUD_KEYS_FILE.exists():
        lines = [
            ln
            for ln in _CLOUD_KEYS_FILE.read_text().splitlines()
            if not ln.strip().startswith(f"{name}=")
        ]
    if value:
        lines.append(f"{name}={value}")
    _CLOUD_KEYS_FILE.write_text("\n".join(lines) + ("\n" if lines else ""))
    return {"status": "ok", "saved": bool(value), "name": name}


@router.get("/v1/cloud-keys")
async def list_cloud_keys() -> dict[str, Any]:
    """Names (never values) of the cloud keys the server can currently see."""
    from openjarvis.server.cloud_router import _load_keys

    return {"present": sorted(n for n, v in _load_keys().items() if v)}


# Obvious non-chat Gemini variants (TTS, image/video gen, robotics, agents,
# embeddings) — excluded from the chat-model list even though several of them
# technically expose generateContent.
_CLOUD_MODEL_EXCLUDES = (
    "-tts",
    "-image",
    "imagen",
    "veo-",
    "lyria",
    "banana",
    "robotics",
    "computer-use",
    "embedding",
    "aqa",
    "antigravity",
    "deep-research",
)


async def _google_models(api_key: str) -> list[dict[str, str]]:
    import httpx

    models: list[dict[str, str]] = []
    async with httpx.AsyncClient(timeout=10) as client:
        page_token = ""
        for _ in range(5):  # pagination safety cap
            params: dict[str, str] = {"key": api_key, "pageSize": "200"}
            if page_token:
                params["pageToken"] = page_token
            resp = await client.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            for m in data.get("models", []):
                name = str(m.get("name", "")).removeprefix("models/")
                if not name.startswith("gemini-"):
                    continue
                if any(x in name for x in _CLOUD_MODEL_EXCLUDES):
                    continue
                if "generateContent" not in m.get(
                    "supportedGenerationMethods", []
                ):
                    continue
                models.append({"id": name, "desc": m.get("displayName", name)})
            page_token = data.get("nextPageToken", "")
            if not page_token:
                break

    # Self-updating -latest aliases first, then newest families first
    # (reverse-alphabetical puts gemini-3.x above gemini-2.x).
    latest = [m for m in models if m["id"].endswith("-latest")]
    rest = sorted(
        (m for m in models if not m["id"].endswith("-latest")),
        key=lambda m: m["id"],
        reverse=True,
    )
    return latest + rest


async def _openai_models(api_key: str) -> list[dict[str, str]]:
    import httpx

    # Only ids the cloud router actually routes to OpenAI (see
    # cloud_router._OPENAI_PREFIXES) — and only CHAT models: the /v1/models
    # list also contains Whisper, TTS, DALL-E, embeddings and realtime
    # variants that would fail in a chat request.
    _chat_prefixes = ("gpt-", "o1-", "o3-", "o4-", "chatgpt-")
    _exclude = (
        "-audio",
        "-realtime",
        "-transcribe",
        "-tts",
        "-search",
        "instruct",
        "moderation",
        "embedding",
    )
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            "https://api.openai.com/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        resp.raise_for_status()
        data = resp.json()

    models: list[dict[str, str]] = []
    for m in data.get("data", []):
        mid = str(m.get("id", ""))
        if not mid.startswith(_chat_prefixes):
            continue
        if any(x in mid for x in _exclude):
            continue
        models.append({"id": mid, "desc": "OpenAI chat model", "_created": m.get("created", 0)})
    models.sort(key=lambda m: m.get("_created", 0), reverse=True)  # newest first
    for m in models:
        m.pop("_created", None)
    return models


async def _anthropic_models(api_key: str) -> list[dict[str, str]]:
    import httpx

    models: list[dict[str, str]] = []
    async with httpx.AsyncClient(timeout=10) as client:
        after_id = ""
        for _ in range(5):  # pagination safety cap
            params: dict[str, str] = {"limit": "100"}
            if after_id:
                params["after_id"] = after_id
            resp = await client.get(
                "https://api.anthropic.com/v1/models",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                },
                params=params,
            )
            resp.raise_for_status()
            data = resp.json()
            entries = data.get("data", [])
            for m in entries:
                mid = str(m.get("id", ""))
                # cloud_router routes "claude-" prefixed ids to Anthropic.
                if not mid.startswith("claude-"):
                    continue
                models.append(
                    {"id": mid, "desc": m.get("display_name", "Anthropic model")}
                )
            if not data.get("has_more") or not entries:
                break
            after_id = entries[-1].get("id", "")
    return models  # API already returns newest first


async def _openrouter_models(api_key: str) -> list[dict[str, str]]:
    import httpx

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            "https://openrouter.ai/api/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        )
        resp.raise_for_status()
        data = resp.json()

    models: list[dict[str, str]] = []
    for m in data.get("data", []):
        mid = str(m.get("id", ""))
        # cloud_router routes ids containing "/" to OpenRouter.
        if "/" not in mid:
            continue
        modality = str((m.get("architecture") or {}).get("modality", "text->text"))
        if not modality.endswith("->text"):
            continue  # image/audio generators are useless in the chat box
        models.append(
            {"id": mid, "desc": m.get("name", "via OpenRouter"), "_created": m.get("created", 0)}
        )
    # The catalogue holds 300+ models — an unscrollable wall in a dialog with
    # no search box. Keep the newest 30 (any other id still works if typed
    # into a config; this only bounds the picker list).
    models.sort(key=lambda m: m.get("_created", 0), reverse=True)
    models = models[:30]
    for m in models:
        m.pop("_created", None)
    return models


_CLOUD_MODEL_FETCHERS = {
    "google": (("GEMINI_API_KEY", "GOOGLE_API_KEY"), _google_models),
    "openai": (("OPENAI_API_KEY",), _openai_models),
    "anthropic": (("ANTHROPIC_API_KEY",), _anthropic_models),
    "openrouter": (("OPENROUTER_API_KEY",), _openrouter_models),
}


@router.get("/v1/cloud-models")
async def list_cloud_models(provider: str = "google") -> dict[str, Any]:
    """Chat models the STORED KEY can actually use, fetched live from the
    provider. Replaces the frontend's hardcoded wishlist (which listed models
    that 404'd and missed most real ones). Returns {"models": []} plus an
    "error" hint when no key is stored or the provider call fails — the UI
    falls back to its static list in that case."""
    from openjarvis.server.cloud_router import _load_keys

    entry = _CLOUD_MODEL_FETCHERS.get(provider)
    if entry is None:
        raise HTTPException(
            status_code=400,
            detail=f"Live model listing not implemented for provider: {provider}",
        )

    key_names, fetcher = entry
    keys = _load_keys()
    api_key = next((keys[n] for n in key_names if keys.get(n)), "")
    if not api_key:
        return {"models": [], "error": "no_key"}

    try:
        return {"models": await fetcher(api_key)}
    except Exception as exc:  # network/auth failure → UI falls back to static
        return {"models": [], "error": str(exc)}


def _to_messages(chat_messages) -> list[Message]:
    """Convert Pydantic ChatMessage objects to core Message objects."""
    messages = []
    for m in chat_messages:
        role = Role(m.role) if m.role in {r.value for r in Role} else Role.USER
        metadata: dict[str, Any] = {}
        images = getattr(m, "images", None)
        if images:
            # Carried in metadata so the core Message dataclass stays
            # unchanged; engines opt in via messages_to_dicts(image_style=...).
            metadata["images"] = images
        messages.append(
            Message(
                role=role,
                content=m.content or "",
                name=m.name,
                tool_call_id=m.tool_call_id,
                metadata=metadata,
            )
        )
    return messages


@router.post("/v1/chat/completions")
async def chat_completions(request_body: ChatCompletionRequest, request: Request):
    """Handle chat completion requests (streaming and non-streaming)."""
    engine = request.app.state.engine
    agent = getattr(request.app.state, "agent", None)
    model = request_body.model

    # Inject memory context into messages before dispatching
    config = getattr(request.app.state, "config", None)
    memory_backend = getattr(request.app.state, "memory_backend", None)
    if (
        config is not None
        and memory_backend is not None
        and config.agent.context_from_memory
        and request_body.messages
    ):
        try:
            from openjarvis.tools.storage.context import ContextConfig, inject_context

            # Extract query from the last user message
            query_text = ""
            for m in reversed(request_body.messages):
                if m.role == "user" and m.content:
                    query_text = m.content
                    break

            if query_text:
                messages = _to_messages(request_body.messages)
                ctx_cfg = ContextConfig(
                    top_k=config.memory.context_top_k,
                    min_score=config.memory.context_min_score,
                    max_context_tokens=config.memory.context_max_tokens,
                )
                enriched = inject_context(
                    query_text,
                    messages,
                    memory_backend,
                    config=ctx_cfg,
                )
                # Rebuild request messages from enriched Message objects
                if len(enriched) > len(messages):
                    from openjarvis.server.models import ChatMessage

                    new_msgs = []
                    for msg in enriched:
                        new_msgs.append(
                            ChatMessage(
                                role=msg.role.value,
                                content=msg.content,
                                name=msg.name,
                                tool_call_id=getattr(msg, "tool_call_id", None),
                                # Preserve image attachments through the
                                # memory-enrichment rebuild.
                                images=(msg.metadata or {}).get("images"),
                            )
                        )
                    request_body.messages = new_msgs
        except Exception:
            logging.getLogger("openjarvis.server").debug(
                "Memory context injection failed",
                exc_info=True,
            )

    # Run complexity analysis on the last user message
    complexity_info = None
    query_text_for_complexity = ""
    for m in reversed(request_body.messages):
        if m.role == "user" and m.content:
            query_text_for_complexity = m.content
            break
    if query_text_for_complexity:
        try:
            from openjarvis.learning.routing.complexity import (
                adjust_tokens_for_model,
                score_complexity,
            )

            cr = score_complexity(query_text_for_complexity)
            suggested = adjust_tokens_for_model(
                cr.suggested_max_tokens,
                model,
            )
            complexity_info = ComplexityInfo(
                score=cr.score,
                tier=cr.tier,
                suggested_max_tokens=suggested,
            )
            # Bump max_tokens when complexity suggests more than what
            # the client requested — never reduce below the request value.
            if suggested > request_body.max_tokens:
                request_body.max_tokens = suggested
        except Exception:
            logging.getLogger("openjarvis.server").debug(
                "Complexity analysis failed",
                exc_info=True,
            )

    if request_body.stream:
        bus = getattr(request.app.state, "bus", None)
        # Use the agent stream bridge only when tools are present (the
        # bridge runs agent.run() synchronously and word-splits the result,
        # so it can't stream tokens in real-time).  For plain chat, stream
        # directly from the engine for true token-by-token output.
        if agent is not None and bus is not None and request_body.tools:
            return await _handle_agent_stream(agent, bus, model, request_body)
        return await _handle_stream(
            engine, model, request_body, complexity_info, bus=bus
        )

    # Non-streaming: use agent if available, otherwise direct engine call
    if agent is not None:
        return _handle_agent(agent, model, request_body, complexity_info)

    bus = getattr(request.app.state, "bus", None)
    return _handle_direct(
        engine,
        model,
        request_body,
        bus=bus,
        complexity_info=complexity_info,
    )


def _handle_direct(
    engine,
    model: str,
    req: ChatCompletionRequest,
    bus=None,
    complexity_info=None,
) -> ChatCompletionResponse:
    """Direct engine call without agent."""
    messages = _to_messages(req.messages)
    kwargs: dict[str, Any] = {}
    if req.tools:
        kwargs["tools"] = req.tools
    if bus:
        from openjarvis.telemetry.wrapper import instrumented_generate

        result = instrumented_generate(
            engine,
            messages,
            model=model,
            bus=bus,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            **kwargs,
        )
    else:
        result = engine.generate(
            messages,
            model=model,
            temperature=req.temperature,
            max_tokens=req.max_tokens,
            **kwargs,
        )
    content = result.get("content", "")
    usage = result.get("usage", {})

    choice_msg = ChoiceMessage(role="assistant", content=content)
    # Include tool calls if present
    tool_calls = result.get("tool_calls")
    if tool_calls:
        choice_msg.tool_calls = [
            {
                "id": tc.get("id", ""),
                "type": "function",
                "function": {
                    "name": tc.get("name", ""),
                    "arguments": tc.get("arguments", "{}"),
                },
            }
            for tc in tool_calls
        ]

    return ChatCompletionResponse(
        model=model,
        choices=[
            Choice(
                message=choice_msg,
                finish_reason=result.get("finish_reason", "stop"),
            )
        ],
        usage=UsageInfo(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
        ),
        complexity=complexity_info,
    )


def _handle_agent(
    agent,
    model: str,
    req: ChatCompletionRequest,
    complexity_info=None,
) -> ChatCompletionResponse:
    """Run through agent."""
    from openjarvis.agents._stubs import AgentContext

    # Build context from prior messages
    ctx = AgentContext()
    if len(req.messages) > 1:
        prior = _to_messages(req.messages[:-1])
        for m in prior:
            ctx.conversation.add(m)

    # Last message is the input
    input_text = req.messages[-1].content if req.messages else ""

    # Override agent model for this request if the caller specified one
    original_model = agent._model
    if model:
        agent._model = model
    try:
        result = agent.run(input_text, context=ctx)
    finally:
        agent._model = original_model

    usage = UsageInfo(
        prompt_tokens=result.metadata.get("prompt_tokens", 0),
        completion_tokens=result.metadata.get("completion_tokens", 0),
        total_tokens=result.metadata.get("total_tokens", 0),
    )

    # Include audio metadata if the agent produced audio (e.g. morning digest)
    audio_meta = None
    audio_path = result.metadata.get("audio_path", "")
    if audio_path:
        from pathlib import Path

        from openjarvis.server.models import AudioMeta

        if Path(audio_path).exists():
            audio_meta = AudioMeta(url="/api/digest/audio")

    return ChatCompletionResponse(
        model=model,
        choices=[
            Choice(
                message=ChoiceMessage(
                    role="assistant",
                    content=result.content,
                    audio=audio_meta,
                ),
                finish_reason="stop",
            )
        ],
        usage=usage,
        complexity=complexity_info,
    )


async def _handle_agent_stream(agent, bus, model, req):
    """Stream agent response with EventBus events via SSE."""
    from openjarvis.server.stream_bridge import create_agent_stream

    return await create_agent_stream(agent, bus, model, req)


async def _handle_stream(
    engine,
    model: str,
    req: ChatCompletionRequest,
    complexity_info=None,
    bus=None,
):
    """Stream response using SSE format."""
    from openjarvis.server.cloud_router import (
        is_cloud_model,
        stream_cloud,
        stream_local,
    )

    messages = _to_messages(req.messages)
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    # Route directly to the right backend — bypasses engine routing entirely
    # so broken MultiEngine state can never misdirect requests.
    use_cloud = is_cloud_model(model)

    async def generate():
        # Cloud streams bypass the instrumented engine wrapper entirely, so
        # nothing ever recorded them — the SYSTEM panel (requests, tokens,
        # cost comparison) stayed at zero whenever a cloud model answered.
        # Track the stream here and publish the same TelemetryRecord the
        # local wrapper publishes. Token counts are ESTIMATED (~4 chars per
        # token) because stream_cloud() does not surface provider usage.
        _t0 = time.time()
        _cloud_chars_out = 0

        # Send role chunk first
        first_chunk = ChatCompletionChunk(
            id=chunk_id,
            model=model,
            choices=[
                StreamChoice(
                    delta=DeltaMessage(role="assistant"),
                )
            ],
        )
        yield f"data: {first_chunk.model_dump_json()}\n\n"

        try:
            # Cloud models → direct cloud API (reads keys from disk).
            # Local models → engine.stream() first so mock engines work in
            # tests.  Fall back to stream_local() only when the engine would
            # mis-route the request to a cloud backend (MultiEngine routing
            # confusion), which is detected by checking the routed engine's
            # is_cloud attribute.
            if use_cloud:
                token_iter = stream_cloud(
                    model, messages, req.temperature, req.max_tokens
                )
            else:
                # Use engine.stream() by default (preserves mock-engine
                # compatibility in tests).  Only fall back to stream_local()
                # when a real MultiEngine would mis-route the local model to a
                # cloud backend — detected via isinstance so mocks are not
                # accidentally matched.
                _use_local_fallback = False
                try:
                    from openjarvis.engine.multi import MultiEngine

                    _inner = getattr(engine, "_inner", engine)
                    if isinstance(_inner, MultiEngine):
                        _routed = _inner._engine_for(model)
                        if _routed is not None and getattr(_routed, "is_cloud", False):
                            _use_local_fallback = True
                except Exception:
                    pass
                if _use_local_fallback:
                    token_iter = stream_local(
                        model, messages, req.temperature, req.max_tokens
                    )
                else:
                    token_iter = engine.stream(
                        messages,
                        model=model,
                        temperature=req.temperature,
                        max_tokens=req.max_tokens,
                    )
            async for token in token_iter:
                _cloud_chars_out += len(token)
                chunk = ChatCompletionChunk(
                    id=chunk_id,
                    model=model,
                    choices=[
                        StreamChoice(
                            delta=DeltaMessage(content=token),
                        )
                    ],
                )
                yield f"data: {chunk.model_dump_json()}\n\n"
        except Exception as exc:
            # Surface errors as a content chunk so the frontend can
            # display them instead of silently failing.
            import logging

            logging.getLogger("openjarvis.server").error(
                "Stream error: %s",
                exc,
                exc_info=True,
            )
            error_chunk = ChatCompletionChunk(
                id=chunk_id,
                model=model,
                choices=[
                    StreamChoice(
                        delta=DeltaMessage(
                            content=f"\n\nError during generation: {exc}",
                        ),
                        finish_reason="stop",
                    )
                ],
            )
            yield f"data: {error_chunk.model_dump_json()}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Record CLOUD usage so the SYSTEM panel counts it. Local streams are
        # already recorded by the instrumented engine wrapper (recording them
        # here too would double-count). Guarded so telemetry can never break
        # a response that already streamed successfully.
        if use_cloud and bus is not None:
            try:
                from openjarvis.core.events import EventType
                from openjarvis.core.types import TelemetryRecord

                _prompt_chars = sum(len(m.content or "") for m in messages)
                _prompt_tokens = _prompt_chars // 4 if _prompt_chars else 0
                _completion_tokens = (
                    max(1, _cloud_chars_out // 4) if _cloud_chars_out else 0
                )
                bus.publish(
                    EventType.TELEMETRY_RECORD,
                    {
                        "record": TelemetryRecord(
                            timestamp=_t0,
                            model_id=model,
                            engine="cloud",
                            prompt_tokens=_prompt_tokens,
                            completion_tokens=_completion_tokens,
                            total_tokens=_prompt_tokens + _completion_tokens,
                            latency_seconds=time.time() - _t0,
                            cost_usd=0.0,
                        )
                    },
                )
            except Exception:
                logging.getLogger("openjarvis.server").debug(
                    "Cloud telemetry record failed", exc_info=True
                )

        # Send finish chunk with usage data if available
        import json as _json

        finish_data = ChatCompletionChunk(
            id=chunk_id,
            model=model,
            choices=[
                StreamChoice(
                    delta=DeltaMessage(),
                    finish_reason="stop",
                )
            ],
        )
        finish_dict = _json.loads(finish_data.model_dump_json())

        # Tag the finish chunk with the correct engine label.
        # We use the routing decision (use_cloud) directly rather than
        # unwrapping the engine chain, which can be in a broken state.
        finish_dict.setdefault("telemetry", {})
        finish_dict["telemetry"]["engine"] = "cloud" if use_cloud else "ollama"

        if complexity_info is not None:
            finish_dict["complexity"] = complexity_info.model_dump()

        yield f"data: {_json.dumps(finish_dict)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.get("/v1/models")
async def list_models(request: Request) -> ModelListResponse:
    """List locally installed models (Ollama).

    Cloud models are not included here — they live in the Cloud Models tab
    of the UI and are selected there, not from this endpoint.
    """
    from openjarvis.server.cloud_router import is_cloud_model, list_local_models

    # Prefer engine.list_models() so mock engines work in tests.
    # Filter out any cloud model IDs that may appear via MultiEngine.
    # Fall back to direct Ollama query only when the engine returns nothing.
    engine = request.app.state.engine
    all_ids = engine.list_models()
    model_ids = [m for m in all_ids if not is_cloud_model(m)]
    if not model_ids:
        model_ids = await list_local_models()

    return ModelListResponse(
        data=[ModelObject(id=mid) for mid in model_ids],
    )


@router.get("/v1/ollama/library")
async def ollama_library(request: Request):
    """List every model in Ollama's public library.

    Ollama publishes no catalogue API, so this is scraped and cached
    server-side — see openjarvis.server.ollama_library. The browser cannot
    fetch ollama.com itself: the app's CSP is ``default-src 'self'``.

    Always 200. A failed refresh returns the last cached list with
    ``stale: true`` and an ``error`` string rather than an HTTP error, so
    the model browser keeps working offline.
    """
    from openjarvis.server.ollama_library import get_library_index

    refresh = str(request.query_params.get("refresh", "")).lower() in (
        "1",
        "true",
        "yes",
    )
    result = get_library_index().get(force_refresh=refresh)
    return {
        "models": result["models"],
        "count": len(result["models"]),
        "fetched_at": result["fetched_at"],
        "stale": result["stale"],
        "source": result["source"],
        "error": result["error"],
    }


@router.post("/v1/models/pull")
async def pull_model(request: Request):
    """Pull / download a model from the Ollama registry."""
    body = await request.json()
    model_name = body.get("model", "").strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="'model' field is required")

    engine = request.app.state.engine
    engine_name = getattr(request.app.state, "engine_name", "")
    # Only Ollama supports pulling
    if engine_name != "ollama" and getattr(engine, "engine_id", "") != "ollama":
        raise HTTPException(
            status_code=501,
            detail="Model pulling is only supported with the Ollama engine",
        )

    import httpx as _httpx

    host = getattr(engine, "_host", "http://localhost:11434")
    client = _httpx.Client(base_url=host, timeout=600.0)
    try:
        resp = client.post(
            "/api/pull",
            json={"name": model_name, "stream": False},
        )
        resp.raise_for_status()
    except (_httpx.ConnectError, _httpx.TimeoutException) as exc:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {exc}")
    except _httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"Ollama error: {exc.response.text[:300]}",
        )
    finally:
        client.close()

    return {"status": "ok", "model": model_name}


@router.delete("/v1/models/{model_name:path}")
async def delete_model(model_name: str, request: Request):
    """Delete a model from Ollama."""
    engine = request.app.state.engine
    engine_name = getattr(request.app.state, "engine_name", "")
    if engine_name != "ollama" and getattr(engine, "engine_id", "") != "ollama":
        raise HTTPException(status_code=501, detail="Only supported with Ollama engine")

    import httpx as _httpx

    host = getattr(engine, "_host", "http://localhost:11434")
    client = _httpx.Client(base_url=host, timeout=30.0)
    try:
        resp = client.request(
            "DELETE",
            "/api/delete",
            json={"name": model_name},
        )
        resp.raise_for_status()
    except (_httpx.ConnectError, _httpx.TimeoutException) as exc:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {exc}")
    except _httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"Ollama error: {exc.response.text[:300]}",
        )
    finally:
        client.close()

    return {"status": "deleted", "model": model_name}


@router.post("/v1/cloud/reload")
async def reload_cloud_engine(request: Request):
    """Hot-reload cloud API keys and (re-)initialize the cloud engine.

    Called by the desktop app immediately after the user saves a cloud API
    key so that cloud models become available without a full app restart.
    """
    import os
    from pathlib import Path

    # Re-read ~/.openjarvis/cloud-keys.env and update the running process env.
    keys_path = Path.home() / ".openjarvis" / "cloud-keys.env"
    if keys_path.exists():
        for raw_line in keys_path.read_text().splitlines():
            line = raw_line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()

    # Try to build a fresh CloudEngine.
    try:
        from openjarvis.engine.cloud import CloudEngine
        from openjarvis.engine.multi import MultiEngine

        cloud = CloudEngine()
        if not cloud.health():
            return {
                "status": "no_cloud",
                "message": "No cloud models available (check API keys)",
            }
    except Exception as exc:
        return {"status": "error", "message": str(exc)}

    # Locate the innermost engine, working through InstrumentedEngine layers.
    outer = request.app.state.engine
    inner = getattr(outer, "_inner", outer)

    if isinstance(inner, MultiEngine):
        # Replace or insert the cloud entry in the existing MultiEngine.
        new_engines = [(k, e) for k, e in inner._engines if k != "cloud"]
        new_engines.append(("cloud", cloud))
        inner._engines = new_engines
        inner._refresh_map()
    else:
        # Wrap the existing engine (which may be security-wrapped) with a new
        # MultiEngine that includes the cloud engine.
        engine_name = getattr(request.app.state, "engine_name", "local")
        new_multi = MultiEngine([(engine_name, inner), ("cloud", cloud)])
        if hasattr(outer, "_inner"):
            outer._inner = new_multi
        else:
            request.app.state.engine = new_multi
        request.app.state.engine_name = "multi"

    return {"status": "ok", "message": "Cloud engine reloaded"}


@router.get("/v1/savings")
async def savings(request: Request):
    """Return savings summary compared to cloud providers.

    Only includes telemetry from the current server session so that
    counters start at zero each time a new model + agent is launched.
    """
    from openjarvis.core.config import DEFAULT_CONFIG_DIR
    from openjarvis.server.savings import compute_savings, savings_to_dict
    from openjarvis.telemetry.aggregator import TelemetryAggregator

    db_path = DEFAULT_CONFIG_DIR / "telemetry.db"
    if not db_path.exists():
        empty = compute_savings(0, 0, 0)
        return savings_to_dict(empty)

    session_start = getattr(request.app.state, "session_start", None)

    agg = TelemetryAggregator(db_path)
    try:
        summary = agg.summary(since=session_start)
        # Exclude cloud model tokens from savings — only local
        # inference counts toward cost savings.
        _cloud_prefixes = (
            "gpt-",
            "o1-",
            "o3-",
            "o4-",
            "claude-",
            "gemini-",
            "openrouter/",
        )

        def _is_cloud(model_stats) -> bool:
            return any(model_stats.model_id.startswith(p) for p in _cloud_prefixes)

        local_models = [m for m in summary.per_model if not _is_cloud(m)]
        # Complement of local_models, so local + cloud always covers every
        # recorded model exactly once — no gaps, no double counting.
        cloud_models = [m for m in summary.per_model if _is_cloud(m)]

        result = compute_savings(
            prompt_tokens=sum(m.prompt_tokens for m in local_models),
            completion_tokens=sum(m.completion_tokens for m in local_models),
            total_calls=sum(m.call_count for m in local_models),
            session_start=session_start if session_start else 0.0,
            prompt_tokens_evaluated=sum(
                m.prompt_tokens_evaluated for m in local_models
            ),
        )

        # Cloud half + combined session totals. Kept separate from the
        # savings maths above: these are reported activity, not savings.
        result.cloud_calls = sum(m.call_count for m in cloud_models)
        result.cloud_prompt_tokens = sum(m.prompt_tokens for m in cloud_models)
        result.cloud_completion_tokens = sum(
            m.completion_tokens for m in cloud_models
        )
        result.cloud_tokens = result.cloud_prompt_tokens + result.cloud_completion_tokens
        result.session_calls = result.total_calls + result.cloud_calls
        result.session_prompt_tokens = (
            result.total_prompt_tokens + result.cloud_prompt_tokens
        )
        result.session_completion_tokens = (
            result.total_completion_tokens + result.cloud_completion_tokens
        )
        result.session_tokens = (
            result.session_prompt_tokens + result.session_completion_tokens
        )

        return savings_to_dict(result)
    finally:
        agg.close()


@router.post("/v1/telemetry/reset")
async def reset_telemetry():
    """Clear all stored telemetry records.

    Useful after updating token-counting methodology — clears
    historical records that were computed under the old rules so
    that the savings dashboard and leaderboard submissions start
    fresh with corrected values.
    """
    from openjarvis.core.config import DEFAULT_CONFIG_DIR
    from openjarvis.telemetry.aggregator import TelemetryAggregator

    db_path = DEFAULT_CONFIG_DIR / "telemetry.db"
    if not db_path.exists():
        return {"status": "ok", "records_cleared": 0}

    agg = TelemetryAggregator(db_path)
    try:
        count = agg.clear()
    finally:
        agg.close()
    return {"status": "ok", "records_cleared": count}


@router.get("/v1/info")
async def server_info(request: Request):
    """Return server configuration: model, agent, engine."""
    agent = getattr(request.app.state, "agent", None)
    agent_id = getattr(agent, "agent_id", None) if agent else None
    # Fall back to configured agent name if agent didn't instantiate
    if agent_id is None:
        agent_id = getattr(request.app.state, "agent_name", None)
    return {
        "model": getattr(request.app.state, "model", ""),
        "agent": agent_id,
        "engine": getattr(request.app.state, "engine_name", ""),
    }


@router.get("/health")
async def health(request: Request):
    """Health check endpoint."""
    engine = request.app.state.engine
    healthy = engine.health()
    if not healthy:
        raise HTTPException(status_code=503, detail="Engine unhealthy")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Channel endpoints
# ---------------------------------------------------------------------------


@router.get("/v1/channels")
async def list_channels(request: Request):
    """List available messaging channels."""
    bridge = getattr(request.app.state, "channel_bridge", None)
    if bridge is None:
        return {"channels": [], "message": "Channel bridge not configured"}
    channels = bridge.list_channels()
    return {"channels": channels, "status": bridge.status().value}


@router.post("/v1/channels/send")
async def channel_send(request: Request):
    """Send a message to a channel."""
    bridge = getattr(request.app.state, "channel_bridge", None)
    if bridge is None:
        raise HTTPException(status_code=503, detail="Channel bridge not configured")

    body = await request.json()
    channel_name = body.get("channel", "")
    content = body.get("content", "")
    conversation_id = body.get("conversation_id", "")

    if not channel_name or not content:
        raise HTTPException(
            status_code=400,
            detail="'channel' and 'content' are required",
        )

    ok = bridge.send(channel_name, content, conversation_id=conversation_id)
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to send message")
    return {"status": "sent", "channel": channel_name}


@router.get("/v1/channels/status")
async def channel_status(request: Request):
    """Return channel bridge connection status."""
    bridge = getattr(request.app.state, "channel_bridge", None)
    if bridge is None:
        return {"status": "not_configured"}
    return {"status": bridge.status().value}


# ---------------------------------------------------------------------------
# Security scan endpoint
# ---------------------------------------------------------------------------


@router.get("/v1/security/scan")
async def security_scan():
    """Run a read-only security environment audit and return findings."""
    from openjarvis.cli.scan_cmd import PrivacyScanner

    scanner = PrivacyScanner()
    results = scanner.run_all()
    return {
        "has_warnings": any(r.status == "warn" for r in results),
        "has_failures": any(r.status == "fail" for r in results),
        "findings": [
            {
                "name": r.name,
                "status": r.status,
                "message": r.message,
                "platform": r.platform,
            }
            for r in results
        ],
    }


__all__ = ["router"]
