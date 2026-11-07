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


# Mounted last so API routes win.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
