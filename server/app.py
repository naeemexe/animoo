"""Animo World backend.

Run from the repo root:
    server/.venv/bin/uvicorn server.app:app --port 8000

It also serves `web/` at `/`, so one process is enough for the whole app.
Keys are read from `.env` into the environment and never sent to the browser.
"""

import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import llm
from .agents import AGENTS, run as run_agent
from .chat import chat_reply
from .tools.generate_prop import GenerateError, generate_prop

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")

app = FastAPI(title="Animo World")

# The static web server (a different localhost port) calls this API too.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["*"],
    allow_headers=["*"],
)


# Revalidate every file, so an edited ES module is never served stale from
# the browser's heuristic cache (unchanged files still come back as 304).
@app.middleware("http")
async def revalidate(request, call_next):
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


@app.get("/health")
def health() -> dict:
    # Report which settings exist, never their values.
    return {
        "ok": True,
        "service": "animo-world",
        "config": {
            "llm": llm.info(),
            "nvidia_api_key": bool(os.getenv("NVIDIA_API_KEY")),
            "hf_token": bool(os.getenv("HF_TOKEN")),
            "motion_url": os.getenv("MOTION_URL", "http://localhost:8101"),
            "asset_url": os.getenv("ASSET_URL", "http://localhost:8102"),
        },
    }


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]


# The Chat page: {messages} -> {reply, demonstrate: null | {prompt, duration}, source}.
# Plain `def` so the blocking Nemotron call runs in the thread pool.
@app.post("/api/chat")
def chat(req: ChatRequest) -> dict:
    return chat_reply([m.model_dump() for m in req.messages])


# An agent run as server-sent events: one `data: {agent, kind, text, ms, data?}`
# per step, then `event: done` with {steps, seconds, llm_calls, llm_seconds}.
# EventSource can only GET, so the task is a query parameter. The generator is
# sync, so Starlette runs each blocking step in the thread pool.
@app.get("/api/agents/{name}/run")
def agent_run(name: str, task: str = "") -> StreamingResponse:
    agent = AGENTS.get(name)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"no agent {name!r}; agents: {sorted(AGENTS)}")
    if not task.strip():
        from .agents.test_agent import DEFAULT_TASK
        task = DEFAULT_TASK if name == "test" else ""
    if not task.strip():
        raise HTTPException(status_code=400, detail="task is empty")

    def events():
        t0, n = time.perf_counter(), 0
        started = time.time()
        yield f": {name} agent started\n\n"
        for step in run_agent(agent, task):
            n += 1
            yield f"data: {json.dumps(step, ensure_ascii=False)}\n\n"
        calls = [c for c in list(llm.CALLS) if c["at"] >= started]
        summary = {"steps": n, "seconds": round(time.perf_counter() - t0, 2), "llm_calls": len(calls),
                   "llm_seconds": [c["seconds"] for c in calls], "backend": llm.backend(), "model": llm.model()}
        yield f"event: done\ndata: {json.dumps(summary)}\n\n"

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


class PropRequest(BaseModel):
    name: str
    prompt: str | None = None
    size_m: float | None = None
    category: str | None = None
    seed: int = 0


# The world agent's generate_prop tool over HTTP: {name, prompt?, size_m?, category?}
# -> {entry, cached, seconds}. A library hit returns at once; a new prop takes
# about 45 s on the pod. Plain `def`, so the wait runs in the thread pool.
@app.post("/api/props/generate")
def props_generate(req: PropRequest) -> dict:
    try:
        return generate_prop(req.name, req.prompt, req.size_m, req.category, seed=req.seed)
    except GenerateError as e:
        raise HTTPException(status_code=503, detail=str(e))


# The asset library (props, characters, motions, manifest.json).
app.mount("/library", StaticFiles(directory=ROOT / "library"), name="library")
# Mounted last so API routes win.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
