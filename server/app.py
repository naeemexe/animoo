"""Animo World backend.

Run from the repo root:
    server/.venv/bin/uvicorn server.app:app --port 8000

It also serves `web/` at `/`, so one process is enough for the whole app.
Keys are read from `.env` into the environment and never sent to the browser.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .chat import chat_reply

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


# The asset library (props, characters, motions, manifest.json).
app.mount("/library", StaticFiles(directory=ROOT / "library"), name="library")
# Mounted last so API routes win.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
